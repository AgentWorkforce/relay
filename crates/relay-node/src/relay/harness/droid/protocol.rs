//! One serialized queue over Droid's native JSON-RPC session. An ambiguous
//! submission is retained and never resubmitted under the same delivery ID.
use super::super::relay_mcp;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};

struct Turn {
    hash: String,
    text: String,
    status: &'static str,
}
#[derive(Default)]
pub(super) struct Engine {
    turns: BTreeMap<String, Turn>,
    queue: VecDeque<String>,
    active: Option<String>,
    pub(super) relay_server: Option<String>,
    working: bool,
    session: Option<String>,
    blocked: bool,
}
impl Engine {
    pub(super) fn new(alias: &str) -> Self {
        Self {
            relay_server: Some(alias.into()),
            ..Self::default()
        }
    }
    pub(super) fn request(&mut self, request: &Value) -> Value {
        match request["op"].as_str() {
            Some("status") => {
                json!({"state":if self.blocked {"unknown"} else if self.active.is_some(){"working"}else{"idle"}})
            }
            Some("stop") => json!({"status":"stopped"}),
            Some("prompt") => self.enqueue(request),
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
        if let Some(turn) = self.turns.get(id) {
            return json!({"status":if turn.hash == hash {turn.status}else{"refused"}});
        }
        if self.blocked || self.turns.len() >= 4096 {
            return json!({"status":"refused"});
        }
        self.turns.insert(
            id.into(),
            Turn {
                hash,
                text: text.into(),
                status: "accepted",
            },
        );
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
        let text = self.relay_server.as_ref().map_or_else(|| text.clone(), |server| format!("Agent Relay transport: use the private MCP server {server} tool send_relay_message for relay replies (to, text, optional numeric reply_to). This replaces shell reply instructions below. Preserve the requested recipient and reply_to.\n\n{text}"));
        self.active = Some(id.clone());
        self.working = false;
        Some(
            json!({"jsonrpc":"2.0","id":format!("prompt:{id}"),"method":"droid.add_user_message","params":{"text":text,"messageId":native_message_id(&id)}}),
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
            if let Some(turn) = self.turns.get_mut(&id) {
                turn.status = status;
                turn.text.clear();
            }
        }
        self.working = false;
    }
    pub(super) fn uncertain(&mut self) {
        self.finish("in_doubt");
        self.blocked = true;
        for id in self.queue.drain(..) {
            if let Some(turn) = self.turns.get_mut(&id) {
                turn.status = "refused";
                turn.text.clear();
            }
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
    fn notification(session: &str, state: &str) -> Value {
        json!({"method":"droid.session_notification","params":{"sessionId":session,"notification":{"type":"droid_working_state_changed","newState":state}}})
    }
    #[test]
    fn serialization_deduplication_and_idle_wake_keep_native_session() {
        let mut engine = Engine::default();
        let one = json!({"op":"prompt","id":"one","text":"hello"});
        assert_eq!(engine.request(&one)["status"], "accepted");
        assert_eq!(engine.request(&one)["status"], "accepted");
        engine.request(&json!({"op":"prompt","id":"two","text":"again"}));
        let frame = engine.next("native").unwrap();
        assert_eq!(frame["method"], "droid.add_user_message");
        assert_eq!(frame["params"]["text"], "hello");
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
    fn an_uncertain_submission_is_never_repeated() {
        let mut engine = Engine::default();
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
    fn only_exact_launch_pinned_relay_send_is_approved() {
        let mut engine = Engine::new("private-nonce");
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
