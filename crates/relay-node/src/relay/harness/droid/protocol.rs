//! One serialized queue over Droid's native JSON-RPC session. An ambiguous
//! submission is retained and never resubmitted under the same delivery ID.
use super::super::relay_mcp;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

/// How long the core's lease on question escalation lasts. The core renews
/// it on every `questions` poll; with no lease (escalation off, signed out,
/// an older core, or no core at all) `droid.ask_user` is answered at once
/// as before.
pub(super) const QUESTION_LEASE: Duration = Duration::from_secs(3);

/// How long a held `droid.ask_user` waits for the core, from its arrival:
/// the core's send limit (`question::ROUTE_LIMIT`, 20 s) plus 3 s. Past it
/// the host answers it as before, whether or not the core ever asked.
pub(super) const QUESTION_HOLD: Duration = Duration::from_secs(23);

/// The most `droid.ask_user` requests held at once; more are answered as
/// before.
const QUESTIONS_HELD: usize = 8;

/// A `droid.ask_user` held for the core.
struct HeldQuestion {
    id: Value,
    params: Value,
    received: Instant,
    /// Handed to the core once (`questions`): never handed out again.
    claimed: bool,
}

/// The answer a host gives `droid.ask_user` without the core: unsupported,
/// as it always has.
pub(super) fn unsupported(id: &Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client method unsupported"}})
}

struct Turn {
    text: String,
}
pub(super) struct Engine {
    journal: super::dedup::Journal,
    turns: BTreeMap<String, Turn>,
    queue: VecDeque<String>,
    active: Option<String>,
    pub(super) relay_server: Option<String>,
    working: bool,
    session: Option<String>,
    blocked: bool,
    question_lease: Option<Instant>,
    held: Vec<HeldQuestion>,
    /// JSON-RPC responses to `droid.ask_user` waiting to be written.
    outbox: VecDeque<Value>,
}
impl Engine {
    pub(super) fn new(alias: &str, path: &std::path::Path) -> anyhow::Result<Self> {
        Ok(Self::with_journal(
            Some(alias.into()),
            super::dedup::Journal::create(path)?,
        ))
    }
    fn with_journal(relay_server: Option<String>, journal: super::dedup::Journal) -> Self {
        Self {
            journal,
            relay_server,
            turns: BTreeMap::new(),
            queue: VecDeque::new(),
            active: None,
            working: false,
            session: None,
            blocked: false,
            question_lease: None,
            held: Vec::new(),
            outbox: VecDeque::new(),
        }
    }

    /// Holds `frame`, a `droid.ask_user`, for the core: only while the core
    /// holds a lease, only a request with an id and questions, and at most
    /// `QUESTIONS_HELD` at once. Whether it was held; one not held is
    /// answered at once by the caller (`unsupported`).
    pub(super) fn hold_question(&mut self, frame: &Value, now: Instant) -> bool {
        let leased = self.question_lease.is_some_and(|until| now < until);
        let id = &frame["id"];
        let asks = frame["params"]["questions"]
            .as_array()
            .is_some_and(|questions| !questions.is_empty());
        if !leased
            || !asks
            || !(id.is_string() || id.is_number())
            || self.held.len() >= QUESTIONS_HELD
            || self.held.iter().any(|held| held.id == *id)
        {
            return false;
        }
        self.held.push(HeldQuestion {
            id: id.clone(),
            params: frame["params"].clone(),
            received: now,
            claimed: false,
        });
        true
    }

    /// Answers every held question past its hold as before, by itself.
    pub(super) fn expire_questions(&mut self, now: Instant) {
        let (expired, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.held)
            .into_iter()
            .partition(|held| now >= held.received + QUESTION_HOLD);
        self.held = kept;
        for held in expired {
            self.outbox.push_back(unsupported(&held.id));
        }
    }

    /// The next JSON-RPC response to write to Droid.
    pub(super) fn next_answer(&mut self) -> Option<Value> {
        self.outbox.pop_front()
    }

    /// `questions`: renews the core's lease and hands over the questions
    /// held and not handed over yet, each once.
    fn questions(&mut self, now: Instant) -> Value {
        self.question_lease = Some(now + QUESTION_LEASE);
        let questions: Vec<Value> = self
            .held
            .iter_mut()
            .filter(|held| !held.claimed)
            .map(|held| {
                held.claimed = true;
                json!({"id": held.id, "params": held.params})
            })
            .collect();
        json!({"status": "ok", "questions": questions})
    }

    /// `question_answer {id, result}` or `{id, declined: true}`: the one
    /// response to a held question. A question no longer held (answered,
    /// or past its hold) is `unknown`, and nothing is written.
    fn question_answer(&mut self, request: &Value) -> Value {
        let Some(index) = self
            .held
            .iter()
            .position(|held| held.claimed && held.id == request["id"])
        else {
            return json!({"status": "unknown"});
        };
        let response = if request["declined"] == true {
            unsupported(&self.held[index].id)
        } else if request["result"].is_object() {
            json!({"jsonrpc":"2.0","id":self.held[index].id,"result":request["result"]})
        } else {
            return json!({"status": "refused"});
        };
        self.held.remove(index);
        self.outbox.push_back(response);
        json!({"status": "answered"})
    }
    #[cfg(test)]
    pub(super) fn testing() -> Self {
        Self::with_journal(None, super::dedup::Journal::memory().unwrap())
    }
    pub(super) fn request(&mut self, request: &Value) -> Value {
        match request["op"].as_str() {
            Some("status") => {
                json!({"state":if self.blocked {"unknown"} else if self.active.is_some(){"working"}else{"idle"}})
            }
            Some("stop") => json!({"status":"stopped"}),
            Some("prompt") => self.enqueue(request),
            Some("questions") => self.questions(Instant::now()),
            Some("question_answer") => self.question_answer(request),
            _ => json!({"status":"refused"}),
        }
    }
    fn enqueue(&mut self, request: &Value) -> Value {
        let Some(id) = request["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
        else {
            return json!({"status":"refused"});
        };
        let Some(text) = request["text"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 65_536)
        else {
            return json!({"status":"refused"});
        };
        let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
        match self.journal.lookup(id) {
            Ok(Some((saved_hash, status))) => {
                let status = if saved_hash != hash {
                    "refused"
                } else if self.turns.contains_key(id) && !self.blocked {
                    "accepted"
                } else if self.blocked && status == "accepted" {
                    "in_doubt"
                } else {
                    &status
                };
                return json!({"status":status});
            }
            Err(_) => {
                self.blocked = true;
                return json!({"status":"refused"});
            }
            Ok(None) => {}
        }
        if self.blocked || self.turns.len() >= 4096 {
            return json!({"status":"refused"});
        }
        if self.journal.admit(id, &hash).is_err() {
            self.blocked = true;
            return json!({"status":"refused"});
        }
        self.turns.insert(id.into(), Turn { text: text.into() });
        self.queue.push_back(id.into());
        json!({"status":"accepted"})
    }
    pub(super) fn next(&mut self, session: &str) -> Option<Value> {
        if self.blocked
            || self.active.is_some()
            || self.session.as_deref().is_some_and(|id| id != session)
        {
            return None;
        }
        self.session = Some(session.into());
        let id = self.queue.pop_front()?;
        let text = self.turns.get(&id)?.text.clone();
        // Commit the ambiguity fence before writing any provider bytes.
        if self.journal.status(&id, "in_doubt").is_err() {
            self.queue.push_front(id);
            self.uncertain();
            return None;
        }
        let text = self.relay_server.as_ref().map_or_else(|| text.clone(), |server| format!("Agent Relay transport: use the private MCP server {server} tool send_relay_message for relay replies (to, text, optional numeric reply_to). This replaces shell reply instructions below. Preserve the requested recipient and reply_to.\n\n{text}"));
        self.active = Some(id.clone());
        self.working = false;
        Some(
            json!({"jsonrpc":"2.0","id":format!("prompt:{id}"),"method":"droid.add_user_message","params":{"text":text,"messageId":native_message_id(&id),"userMessageSource":"sdk"}}),
        )
    }
    pub(super) fn observe(&mut self, frame: &Value) {
        let Some(id) = self.active.as_ref() else {
            return;
        };
        if frame["id"].as_str() == Some(&format!("prompt:{id}")) && frame.get("method").is_none() {
            if frame.get("error").is_some() {
                self.uncertain();
            }
            // The response only acknowledges submission. Completion is a
            // later working-state event, so never start another turn here.
            return;
        }
        if frame["method"] != "droid.session_notification"
            || frame["params"]["sessionId"].as_str() != self.session.as_deref()
        {
            return;
        }
        let notification = &frame["params"]["notification"];
        if notification["type"] == "droid_working_state_changed" {
            if notification["newState"] == "idle" && self.working {
                self.finish("delivered");
            } else if notification["newState"] != "idle" {
                self.working = true;
            }
        }
    }
    fn finish(&mut self, status: &'static str) {
        if let Some(id) = self.active.take() {
            if self.journal.status(&id, status).is_err() {
                self.blocked = true;
            }
            self.turns.remove(&id);
        }
        self.working = false;
    }
    pub(super) fn uncertain(&mut self) {
        self.finish("in_doubt");
        self.blocked = true;
        for id in self.queue.drain(..) {
            if self.journal.status(&id, "refused").is_err() {
                // The blocked replay path maps any stale accepted receipt
                // to in_doubt when persistence cannot record the refusal.
                self.blocked = true;
            }
            self.turns.remove(&id);
        }
    }
    pub(super) fn permit(&self, frame: &Value) -> bool {
        let Some(alias) = self
            .relay_server
            .as_deref()
            .filter(|_| self.active.is_some())
        else {
            return false;
        };
        let Some(uses) = frame["params"]["toolUses"]
            .as_array()
            .filter(|v| !v.is_empty())
        else {
            return false;
        };
        uses.iter().all(|entry| {
            let tool = &entry["toolUse"];
            let exact =
                tool["name"].as_str() == Some(&format!("mcp__{alias}__{}", relay_mcp::TOOL));
            let namespaced =
                tool["namespace"].as_str() == Some(alias) && tool["name"] == relay_mcp::TOOL;
            (exact || namespaced) && relay_mcp::valid_arguments(&tool["input"])
        })
    }
}
fn native_message_id(id: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(id.as_bytes()));
    format!(
        "{}-{}-4{}-8{}-{}",
        &digest[..8],
        &digest[8..12],
        &digest[13..16],
        &digest[17..20],
        &digest[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask_user() -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../fixtures/questions/droid-sdk-0.11.0-ask-user.json"
        ))
        .unwrap();
        fixture["frame"].clone()
    }

    /// With no lease (escalation off, signed out, an older core, no core),
    /// `droid.ask_user` is never held: the host answers it at once.
    #[test]
    fn without_the_cores_lease_no_question_is_held() {
        let mut engine = Engine::testing();
        let now = Instant::now();
        assert!(!engine.hold_question(&ask_user(), now));
        engine.questions(now);
        assert!(!engine.hold_question(&ask_user(), now + QUESTION_LEASE));
        assert!(engine.next_answer().is_none());
    }

    /// A held question is handed to the core once and gets exactly one
    /// response: the core's answer, or a decline, never both.
    #[test]
    fn a_held_question_gets_one_response() {
        let mut engine = Engine::testing();
        let now = Instant::now();
        engine.questions(now);
        assert!(engine.hold_question(&ask_user(), now));
        assert!(!engine.hold_question(&ask_user(), now), "the same id once");
        let handed = engine.questions(now);
        assert_eq!(handed["questions"].as_array().unwrap().len(), 1);
        assert_eq!(handed["questions"][0]["id"], "ask-1");
        assert_eq!(
            handed["questions"][0]["params"]["toolCallId"],
            "call_ask_user_1"
        );
        assert_eq!(engine.questions(now)["questions"], json!([]), "once");
        let result = json!({"answers": [{"index": 1, "question": "Which?", "answer": "Sent."}]});
        assert_eq!(
            engine.request(&json!({"op":"question_answer","id":"ask-1","result":result}))["status"],
            "answered"
        );
        assert_eq!(
            engine.next_answer(),
            Some(json!({"jsonrpc":"2.0","id":"ask-1","result":result}))
        );
        assert_eq!(
            engine.request(&json!({"op":"question_answer","id":"ask-1","declined":true}))["status"],
            "unknown"
        );
        engine.expire_questions(now + QUESTION_HOLD);
        assert!(engine.next_answer().is_none(), "one response only");

        // Declined: unsupported, as before.
        engine.questions(now);
        let mut second = ask_user();
        second["id"] = json!(7);
        assert!(engine.hold_question(&second, now));
        engine.questions(now);
        assert_eq!(
            engine.request(&json!({"op":"question_answer","id":7,"declined":true}))["status"],
            "answered"
        );
        assert_eq!(engine.next_answer(), Some(unsupported(&json!(7))));
    }

    /// A question the core never answers, or never asks for, is answered by
    /// the host itself at the end of its hold, once; a late answer is not.
    #[test]
    fn the_host_answers_a_question_the_core_leaves_at_the_end_of_its_hold() {
        let mut engine = Engine::testing();
        let now = Instant::now();
        engine.questions(now);
        assert!(engine.hold_question(&ask_user(), now));
        engine.expire_questions(now + QUESTION_HOLD - Duration::from_millis(1));
        assert!(engine.next_answer().is_none(), "still within its hold");
        engine.expire_questions(now + QUESTION_HOLD);
        assert_eq!(engine.next_answer(), Some(unsupported(&json!("ask-1"))));
        assert!(engine.next_answer().is_none());
        engine.questions(now + QUESTION_HOLD);
        assert_eq!(
            engine.request(&json!({"op":"question_answer","id":"ask-1","result":{"answers":[]}}))
                ["status"],
            "unknown"
        );
        assert!(engine.next_answer().is_none());
        assert!(QUESTION_HOLD <= Duration::from_secs(23));
    }

    /// Only a request with questions is held, and only so many at once.
    #[test]
    fn only_so_many_well_formed_questions_are_held() {
        let mut engine = Engine::testing();
        let now = Instant::now();
        engine.questions(now);
        let mut empty = ask_user();
        empty["params"]["questions"] = json!([]);
        assert!(!engine.hold_question(&empty, now));
        let mut no_id = ask_user();
        no_id["id"] = Value::Null;
        assert!(!engine.hold_question(&no_id, now));
        for n in 0..QUESTIONS_HELD {
            let mut frame = ask_user();
            frame["id"] = json!(n);
            assert!(engine.hold_question(&frame, now));
        }
        let mut more = ask_user();
        more["id"] = json!("more");
        assert!(!engine.hold_question(&more, now));
    }

    /// A core asking a host from before question escalation is refused,
    /// which holds nothing: `questions_from` reads no questions there.
    #[test]
    fn an_older_host_holds_nothing_for_a_newer_core() {
        let mut older = Engine::testing();
        // An older host's `request` answered every unknown op this way.
        let refused = json!({"status":"refused"});
        assert_eq!(older.request(&json!({"op":"unknown-op"})), refused);
        assert_eq!(super::super::registry::questions_from(refused), None);
        assert_eq!(
            super::super::registry::questions_from(json!({"status":"ok","questions":[]})),
            Some(Vec::new())
        );
    }
    fn notification(session: &str, state: &str) -> Value {
        json!({"method":"droid.session_notification","params":{"sessionId":session,"notification":{"type":"droid_working_state_changed","newState":state}}})
    }
    #[test]
    fn serialization_deduplication_and_idle_wake_keep_native_session() {
        let mut engine = Engine::testing();
        let one = json!({"op":"prompt","id":"one","text":"hello"});
        assert_eq!(engine.request(&one)["status"], "accepted");
        assert_eq!(engine.request(&one)["status"], "accepted");
        engine.request(&json!({"op":"prompt","id":"two","text":"again"}));
        let frame = engine.next("native").unwrap();
        assert_eq!(frame["method"], "droid.add_user_message");
        assert_eq!(frame["params"]["text"], "hello");
        assert_eq!(frame["params"]["userMessageSource"], "sdk");
        assert!(crate::relay::store::is_uuid(
            frame["params"]["messageId"].as_str().unwrap()
        ));
        engine.observe(&json!({"id":"prompt:one","result":{}}));
        assert!(engine.next("native").is_none());
        engine.observe(&notification("native", "idle"));
        assert!(engine.next("native").is_none());
        engine.observe(&notification("foreign", "streaming"));
        engine.observe(&notification("foreign", "idle"));
        assert!(engine.next("native").is_none());
        engine.observe(&notification("native", "streaming"));
        engine.observe(&notification("native", "idle"));
        assert_eq!(engine.request(&one)["status"], "delivered");
        assert_eq!(engine.next("native").unwrap()["params"]["text"], "again");
        assert_eq!(
            engine.request(&json!({"op":"prompt","id":"one","text":"different"}))["status"],
            "refused"
        );
    }
    #[test]
    fn completed_receipts_do_not_exhaust_a_persistent_worker() {
        let mut engine = Engine::testing();
        for number in 0..4200 {
            let id = format!("turn-{number}");
            assert_eq!(
                engine.request(&json!({"op":"prompt","id":id,"text":"same text"}))["status"],
                "accepted"
            );
            assert!(engine.next("native").is_some());
            engine.observe(&notification("native", "streaming"));
            engine.observe(&notification("native", "idle"));
            assert!(engine.turns.is_empty());
        }
        assert_eq!(
            engine.request(&json!({"op":"prompt","id":"turn-0","text":"same text"}))["status"],
            "delivered"
        );
        assert_eq!(
            engine.request(&json!({"op":"prompt","id":"turn-0","text":"different"}))["status"],
            "refused"
        );
        assert!(engine.next("native").is_none());
    }
    #[test]
    fn an_uncertain_submission_is_never_repeated() {
        let mut engine = Engine::testing();
        let turn = json!({"op":"prompt","id":"one","text":"hello"});
        engine.request(&turn);
        engine.next("native");
        let queued = json!({"op":"prompt","id":"queued","text":"later"});
        engine.request(&queued);
        engine.uncertain();
        assert_eq!(engine.request(&turn)["status"], "in_doubt");
        assert_eq!(engine.request(&queued)["status"], "refused");
        assert_eq!(
            engine.request(&json!({"op":"prompt","id":"new","text":"no overlap"}))["status"],
            "refused"
        );
        assert_eq!(engine.request(&json!({"op":"status"}))["state"], "unknown");
        assert!(engine.next("native").is_none());
    }
    #[test]
    fn failed_journal_writes_never_replay_dropped_turns_as_accepted() {
        for failure_after_send in [false, true] {
            let mut engine = Engine::testing();
            let one = json!({"op":"prompt","id":"one","text":"hello"});
            let queued = json!({"op":"prompt","id":"queued","text":"later"});
            engine.request(&one);
            engine.request(&queued);
            if failure_after_send {
                assert!(engine.next("native").is_some());
            }
            engine.journal.fail_writes();
            if failure_after_send {
                engine.uncertain();
            } else {
                assert!(engine.next("native").is_none());
            }
            assert_eq!(engine.request(&one)["status"], "in_doubt");
            assert_eq!(engine.request(&queued)["status"], "in_doubt");
            assert!(engine.turns.is_empty());
            assert!(engine.queue.is_empty());
            assert!(engine.next("native").is_none());
            assert_eq!(engine.request(&json!({"op":"status"}))["state"], "unknown");
        }
    }
    #[test]
    fn only_exact_launch_pinned_relay_send_is_approved() {
        let mut engine = Engine::testing();
        engine.relay_server = Some("private-nonce".into());
        let request = json!({"params":{"toolUses":[{"toolUse":{"name":"mcp__private-nonce__send_relay_message","input":{"to":"ada","text":"hello"}}}]}});
        assert!(!engine.permit(&request));
        engine.request(&json!({"op":"prompt","id":"one","text":"hello"}));
        engine.next("native");
        assert!(engine.permit(&request));
        for (name, arguments) in [
            (
                "mcp__other__send_relay_message",
                json!({"to":"ada","text":"hello"}),
            ),
            ("Execute", json!({"command":"echo hello"})),
            (
                "mcp__private-nonce__send_relay_message",
                json!({"to":"ada","text":"hello","identity":"other"}),
            ),
        ] {
            let mut invalid = request.clone();
            invalid["params"]["toolUses"][0]["toolUse"] = json!({"name":name,"input":arguments});
            assert!(!engine.permit(&invalid));
        }
        let mut mixed = request.clone();
        mixed["params"]["toolUses"]
            .as_array_mut()
            .unwrap()
            .push(json!({"toolUse":{"name":"Execute","input":{"command":"echo hello"}}}));
        assert!(!engine.permit(&mixed));
    }
}
