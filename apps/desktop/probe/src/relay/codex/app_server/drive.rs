//! Pending server-to-client requests for headless spawned Codex turns.
//! Only this process's live proxy connection may answer a request. Losing
//! the connection drops its pending refs; a reply cannot approve a new one.
//! Every request is answered by the verified machine owner only
//! (`spawn::drive`); no other agent, the spawn's requester included, can.

use super::{Client, ClientState};
use crate::relay::codex::runner::ProxyStream;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

const REQUEST_TTL: Duration = Duration::from_secs(300);
const POLL: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub reference: String,
    pub thread: String,
    pub description: &'static str,
    pub approvable: bool,
    /// Only fixed, non-sensitive choice labels are exposed over Relaycast.
    pub options: Vec<String>,
}

struct Pending {
    notice: Notice,
    id: Value,
    method: String,
    params: Value,
    deadline: Instant,
    forwarded: bool,
    answer: Option<Value>,
    connection: String,
}

/// A lock that a panicked holder does not poison for everyone else.
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn pending() -> MutexGuard<'static, HashMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    locked(PENDING.get_or_init(|| Mutex::new(HashMap::new())))
}

/// Threads claimed by a turn this process is starting or driving.
fn driving_threads() -> MutexGuard<'static, HashSet<String>> {
    static DRIVING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    locked(DRIVING.get_or_init(|| Mutex::new(HashSet::new())))
}

/// Whether this process is starting or driving a turn of `thread` (or
/// holds its unanswered requests): its rollout may not show it yet.
pub fn driving(thread: &str) -> bool {
    driving_threads().contains(&thread.to_ascii_lowercase())
}

/// One thread's turn, held from before `turn/start` until the connection
/// that drives it closes, so no second turn starts meanwhile.
#[derive(Debug)]
pub struct Claim(String);

impl Claim {
    pub fn thread(&self) -> &str {
        &self.0
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        driving_threads().remove(&self.0);
    }
}

/// Claims `thread`, unless a turn of it is already starting or driven.
pub fn claim(thread: &str) -> Option<Claim> {
    let key = thread.to_ascii_lowercase();
    let claimed = driving_threads().insert(key.clone());
    // Built only once claimed: dropping an unclaimed one would release the
    // holder's claim.
    claimed.then(|| Claim(key))
}

/// What the owner is told a request is. Never its command text or
/// parameters, which may hold credentials.
fn describe(method: &str) -> Option<&'static str> {
    Some(match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => {
            "Codex requests permission to run a command. Command text is withheld because it may contain credentials."
        }
        "item/fileChange/requestApproval" | "applyPatchApproval" => {
            "Codex requests permission to change files."
        }
        "item/permissions/requestApproval" => {
            "Codex requests additional filesystem or network permissions."
        }
        "mcpServer/elicitation/request" => {
            "An MCP server requests confirmation or input, possibly for third-party access."
        }
        "item/tool/requestUserInput" => {
            "Codex requests a decision during a tool action, possibly involving computer use or third-party access."
        }
        _ => return None,
    })
}

/// The answer for `approved`, or the refusal an expiry or a closed
/// connection gives. Codex has no cancel for a tool question: it takes an
/// error or empty answers alike as unanswered.
fn safe_answer(method: &str, approved: bool, params: &Value) -> Value {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            json!({"decision": if approved { "accept" } else { "decline" }})
        }
        "execCommandApproval" | "applyPatchApproval" => {
            json!({"decision": if approved { "approved" } else { "abort" }})
        }
        "item/permissions/requestApproval" if approved => {
            json!({"permissions": params["permissions"], "scope": "turn"})
        }
        "item/permissions/requestApproval" => json!({"permissions": {}}),
        "mcpServer/elicitation/request" => {
            json!({"action": if approved { "accept" } else { "cancel" }, "content": {}})
        }
        "item/tool/requestUserInput" => json!({"answers": {}}),
        _ => Value::Null,
    }
}

fn reference() -> Option<String> {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

const SAFE_LABELS: [&str; 10] = [
    "install", "cancel", "allow", "deny", "approve", "reject", "yes", "no", "continue", "stop",
];

fn choices(params: &Value) -> Vec<String> {
    let Some([question]) = params["questions"].as_array().map(Vec::as_slice) else {
        return Vec::new();
    };
    let options = question["options"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let safe = |option: &Value| {
        option["isOther"] != true
            && option["label"].as_str().is_some_and(|label| {
                SAFE_LABELS
                    .iter()
                    .any(|known| label.eq_ignore_ascii_case(known))
            })
    };
    if question["isSecret"] == true
        || options.is_empty()
        || options.len() > 10
        || !options.iter().all(safe)
    {
        return Vec::new();
    }
    options
        .iter()
        .enumerate()
        .map(|(index, option)| {
            format!(
                "{}: {}",
                index + 1,
                option["label"].as_str().unwrap_or_default()
            )
        })
        .collect()
}

fn belongs_to_thread(params: &Value, thread: &str) -> bool {
    // MCP elicitation has no thread id in the app-server protocol. It belongs
    // to the turn on this client connection; explicit ids must still match.
    params["threadId"]
        .as_str()
        .or_else(|| params["conversationId"].as_str())
        .is_none_or(|id| id.eq_ignore_ascii_case(thread))
}

fn register(thread: &str, connection: &str, request: Value) {
    let Some(method) = request["method"].as_str() else {
        return;
    };
    let id = request.get("id").filter(|id| id.is_string() || id.is_i64());
    let params = &request["params"];
    let (Some(id), Some(description), true, Some(reference)) = (
        id,
        describe(method),
        belongs_to_thread(params, thread),
        reference(),
    ) else {
        return;
    };
    let question = method == "item/tool/requestUserInput";
    let notice = Notice {
        reference: reference.clone(),
        thread: thread.into(),
        description,
        // MCP forms and device verification may require values or a proof
        // that must never be copied through Relay. They can be canceled.
        approvable: !question && method != "mcpServer/elicitation/request",
        options: if question {
            choices(params)
        } else {
            Vec::new()
        },
    };
    pending().insert(
        reference,
        Pending {
            notice,
            id: id.clone(),
            method: method.into(),
            params: params.clone(),
            deadline: Instant::now() + REQUEST_TTL,
            forwarded: false,
            answer: None,
            connection: connection.into(),
        },
    );
}

/// Notices not yet relayed. Mark each only after Relaycast confirms send.
pub fn unforwarded(thread: &str) -> Vec<Notice> {
    pending()
        .values()
        .filter(|entry| {
            entry.notice.thread == thread
                && !entry.forwarded
                && entry.answer.is_none()
                && Instant::now() < entry.deadline
        })
        .map(|entry| entry.notice.clone())
        .collect()
}

pub fn mark_forwarded(reference: &str) {
    if let Some(entry) = pending().get_mut(reference) {
        entry.forwarded = true;
    }
}

/// A request `thread` has open, as a live connection registers it.
#[cfg(test)]
pub(crate) fn open_request(thread: &str, request: Value) -> Notice {
    register(thread, "test-connection", request);
    unforwarded(thread).pop().expect("registered")
}

#[cfg(test)]
pub(super) fn expire(reference: &str) {
    if let Some(entry) = pending().get_mut(reference) {
        entry.deadline = Instant::now();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplyResult {
    Answered,
    Unauthorized,
    Unknown,
    InvalidChoice,
}

/// Records `answer` for the open request `reference` of `thread` when the
/// sender is the verified owner: the immutable Relaycast agent id from the
/// delivery, never the text's claimed author.
fn answer_with(
    thread: &str,
    reference: &str,
    sender_id: Option<&str>,
    owner_id: Option<&str>,
    answer: impl FnOnce(&Pending) -> Option<Value>,
) -> ReplyResult {
    let mut entries = pending();
    let Some(entry) = entries.get_mut(reference).filter(|entry| {
        entry.notice.thread == thread && entry.answer.is_none() && Instant::now() < entry.deadline
    }) else {
        return ReplyResult::Unknown;
    };
    if owner_id.is_none() || sender_id != owner_id {
        return ReplyResult::Unauthorized;
    }
    match answer(entry) {
        Some(value) => {
            entry.answer = Some(value);
            ReplyResult::Answered
        }
        None => ReplyResult::InvalidChoice,
    }
}

/// `approve <ref>` or `deny <ref>` from the owner.
pub fn answer(
    thread: &str,
    reference: &str,
    sender_id: Option<&str>,
    owner_id: Option<&str>,
    approved: bool,
) -> ReplyResult {
    answer_with(thread, reference, sender_id, owner_id, |entry| {
        (!approved || entry.notice.approvable)
            .then(|| safe_answer(&entry.method, approved, &entry.params))
    })
}

/// `choose <ref> <number>` from the owner, for a tool question with safe
/// choices.
pub fn answer_choice(
    thread: &str,
    reference: &str,
    sender_id: Option<&str>,
    owner_id: Option<&str>,
    choice: usize,
) -> ReplyResult {
    answer_with(thread, reference, sender_id, owner_id, |entry| {
        if entry.method != "item/tool/requestUserInput"
            || choice == 0
            || choice > entry.notice.options.len()
        {
            return None;
        }
        let question = &entry.params["questions"][0];
        let id = question["id"].as_str()?;
        let label = question["options"][choice - 1]["label"].as_str()?;
        let mut answers = serde_json::Map::new();
        answers.insert(id.to_string(), json!({"answers": [label]}));
        Some(json!({"answers": answers}))
    })
}

/// Whether `notifications` say `thread`'s turn completed.
fn turn_completed(notifications: Vec<Value>, thread: &str) -> bool {
    notifications.iter().any(|v| {
        v["method"] == "turn/completed"
            && v["params"]["threadId"]
                .as_str()
                .is_some_and(|id| id.eq_ignore_ascii_case(thread))
    })
}

/// Registers the requests that came in; one Agent Relay cannot answer is
/// refused at once.
fn take_requests(client: &mut Client<'_>, thread: &str, connection: &str) {
    for request in std::mem::take(&mut client.requests) {
        let ours = belongs_to_thread(&request["params"], thread);
        let known = request["method"].as_str().and_then(describe).is_some();
        if ours && !known {
            let _ = client.send(
                &json!({"id": request["id"], "error": {
                    "code": -32601, "message": "Agent Relay cannot answer this app-server request"
                }}),
                Instant::now() + POLL,
            );
        } else {
            register(thread, connection, request);
        }
    }
}

/// Takes this connection's answered or expired requests, with their
/// results; an expired one is refused.
fn settled(connection: &str) -> Vec<(Value, Value)> {
    let mut entries = pending();
    let now = Instant::now();
    let refs: Vec<_> = entries
        .iter()
        .filter(|(_, entry)| {
            entry.connection == connection && (entry.answer.is_some() || now >= entry.deadline)
        })
        .map(|(reference, _)| reference.clone())
        .collect();
    refs.iter()
        .filter_map(|reference| entries.remove(reference))
        .map(|entry| {
            let result = entry
                .answer
                .unwrap_or_else(|| safe_answer(&entry.method, false, &entry.params));
            (entry.id, result)
        })
        .collect()
}

fn holds_requests(connection: &str) -> bool {
    pending()
        .values()
        .any(|entry| entry.connection == connection)
}

/// Drives one connection until its turn completed and its requests are
/// settled, or it closes.
fn drive(client: &mut Client<'_>, thread: &str, connection: &str) {
    let mut completed = false;
    loop {
        // A completed turn can leave after all approvals have been answered;
        // the next turn has its own connection. Checked before each wait:
        // `turn/completed` may have come in the same read as the
        // `turn/start` response.
        completed |= turn_completed(std::mem::take(&mut client.notifications), thread);
        take_requests(client, thread, connection);
        for (id, result) in settled(connection) {
            if client
                .send(&json!({"id": id, "result": result}), Instant::now() + POLL)
                .is_err()
            {
                completed = true;
                break;
            }
        }
        if completed && !holds_requests(connection) {
            return;
        }
        match client.read(Instant::now() + POLL) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return,
        }
    }
}

/// Keeps the proxy that started the turn alive to answer its requests.
pub(super) fn start(mut stream: Box<dyn ProxyStream>, state: ClientState, claim: Claim) {
    std::thread::spawn(move || {
        let thread = claim.thread().to_string();
        let connection = reference().unwrap_or_default();
        let mut client = Client {
            stream: stream.as_mut(),
            decoder: state.decoder,
            responses: state.responses,
            requests: state.requests,
            notifications: state.notifications,
        };
        drive(&mut client, &thread, &connection);
        drop(client);
        drop(stream);
        // A closed connection invalidates every reference it created.
        pending().retain(|_, entry| entry.connection != connection);
        drop(claim);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Security decision: every request is answered by the verified
    // owner only; the spawn's requester, or any other agent, cannot.
    #[test]
    fn only_the_owner_answers_any_request() {
        let thread = "thread-test";
        for (id, method) in [
            (70, "item/commandExecution/requestApproval"),
            (71, "item/fileChange/requestApproval"),
            (72, "execCommandApproval"),
            (73, "item/permissions/requestApproval"),
        ] {
            register(
                thread,
                "test-connection",
                json!({"id": id, "method": method, "params": {"threadId": thread, "command": "cargo test"}}),
            );
        }
        let notices = unforwarded(thread);
        assert_eq!(notices.len(), 4);
        for notice in notices {
            assert!(!notice.description.contains("cargo test"));
            for sender in [Some("requester"), Some("other"), None] {
                assert_eq!(
                    answer(thread, &notice.reference, sender, Some("owner"), true),
                    ReplyResult::Unauthorized
                );
            }
            assert_eq!(
                answer(thread, &notice.reference, Some("owner"), None, true),
                ReplyResult::Unauthorized,
                "no verified owner, no answer"
            );
            assert_eq!(
                answer(
                    thread,
                    &notice.reference,
                    Some("owner"),
                    Some("owner"),
                    true
                ),
                ReplyResult::Answered
            );
        }
        pending().retain(|_, e| e.notice.thread != thread);
    }

    /// A proxy that never sends anything more, and says when it is dropped.
    struct Idle(std::sync::Arc<std::sync::atomic::AtomicBool>);

    impl ProxyStream for Idle {
        fn write_all(&mut self, _: &[u8], _: Instant) -> std::io::Result<()> {
            Ok(())
        }
        fn read(&mut self, deadline: Instant) -> std::io::Result<Vec<u8>> {
            std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
            Err(std::io::ErrorKind::TimedOut.into())
        }
    }

    impl Drop for Idle {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    // #550 review: `turn/completed` read with the `turn/start` response is
    // already buffered when the driver starts; it must not wait for more.
    #[test]
    fn a_turn_completed_before_the_driver_starts_closes_the_proxy() {
        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let state = ClientState {
            decoder: super::super::Decoder::default(),
            responses: Vec::new(),
            requests: Vec::new(),
            notifications: vec![json!({"method": "turn/completed",
                "params": {"threadId": "thread-fast", "turn": {"id": "t1"}}})],
        };
        start(
            Box::new(Idle(closed.clone())),
            state,
            claim("thread-fast").unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while !closed.load(std::sync::atomic::Ordering::SeqCst) || driving("thread-fast") {
            assert!(Instant::now() < deadline, "the proxy stayed open");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    // #550 review: a second delivery cannot start a turn while the first is
    // still starting; the claim is free again once its connection is gone.
    #[test]
    fn one_turn_at_a_time_per_thread() {
        let first = claim("Thread-Claim").unwrap();
        assert!(claim("thread-claim").is_none());
        assert!(driving("THREAD-CLAIM"));
        drop(first);
        assert!(!driving("thread-claim"));
        assert!(claim("thread-claim").is_some());
    }

    #[test]
    fn expiry_denies() {
        assert_eq!(
            safe_answer("item/commandExecution/requestApproval", false, &Value::Null),
            json!({"decision":"decline"})
        );
        assert_eq!(
            safe_answer("mcpServer/elicitation/request", false, &Value::Null)["action"],
            "cancel"
        );
    }

    #[test]
    fn owner_can_choose_a_non_secret_action_option_by_number() {
        let thread = "choice-thread";
        register(
            thread,
            "choice-connection",
            json!({"id": 72,
            "method": "item/tool/requestUserInput",
            "params": {"threadId": thread, "questions": [{"id":"install-decision",
                "header":"Confirm", "question":"Install the GitHub App?",
                "isSecret":false, "options":[
                    {"label":"Install", "description":"Proceed"},
                    {"label":"Cancel", "description":"Stop"}
                ]}]}}),
        );
        let notice = unforwarded(thread).pop().unwrap();
        assert_eq!(notice.options, ["1: Install", "2: Cancel"]);
        assert_eq!(
            answer_choice(
                thread,
                &notice.reference,
                Some("requester"),
                Some("owner"),
                1
            ),
            ReplyResult::Unauthorized
        );
        assert_eq!(
            answer_choice(thread, &notice.reference, Some("owner"), Some("owner"), 3),
            ReplyResult::InvalidChoice
        );
        assert_eq!(
            answer_choice(thread, &notice.reference, Some("owner"), Some("owner"), 1),
            ReplyResult::Answered
        );
        let entries = pending();
        assert_eq!(
            entries[&notice.reference].answer.as_ref().unwrap()["answers"]["install-decision"]
                ["answers"],
            json!(["Install"])
        );
        drop(entries);
        pending().remove(&notice.reference);
    }

    #[test]
    fn unscoped_mcp_elicitation_routes_to_connection_and_expired_reply_fails() {
        let thread = "mcp-thread";
        register(
            thread,
            "mcp-connection",
            json!({"id": 73, "method": "mcpServer/elicitation/request",
                "params": {"mode": "form", "message": "Potential secret", "requestedSchema": {}}}),
        );
        let notice = unforwarded(thread).pop().unwrap();
        assert!(!notice.approvable);
        assert!(!notice.description.contains("Potential secret"));
        assert_eq!(
            answer(
                thread,
                &notice.reference,
                Some("owner"),
                Some("owner"),
                true
            ),
            ReplyResult::InvalidChoice
        );
        expire(&notice.reference);
        assert_eq!(
            answer(
                thread,
                &notice.reference,
                Some("owner"),
                Some("owner"),
                false
            ),
            ReplyResult::Unknown
        );
        pending().remove(&notice.reference);
    }

    #[test]
    fn unknown_or_secret_choices_are_not_answerable() {
        assert!(choices(&json!({"questions": [{"options": [
            {"label":"Send credentials"}, {"label":"Cancel"}]}]}))
        .is_empty());
        assert!(choices(&json!({"questions": [{"isSecret":true,
            "options": [{"label":"Allow"}]}]}))
        .is_empty());
    }
}
