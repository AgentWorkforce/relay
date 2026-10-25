//! A spawned Claude's control requests waiting for an answer through Relay:
//! `can_use_tool` (a permission prompt or an `AskUserQuestion`),
//! `elicitation` (an MCP server's form or URL) and `request_user_dialog`.
//!
//! Each gets a short random reference and a fixed summary; what Claude asked
//! (a command, a path, a form) is never copied into it, since it may hold a
//! credential. Only the verified machine owner may answer, by Relaycast's
//! immutable id for the signed-in person: never the agent that asked for the
//! spawn, nor any other. One not answered within five minutes is denied; when Claude's
//! input goes, so do its references, and a later reply finds nothing.

use crate::relay::codex::app_server::drive::ReplyResult;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

const REQUEST_TTL: Duration = Duration::from_secs(300);

/// Tools that only change files in Claude's folder.
const FILE_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// Choice labels fixed and harmless enough to show over Relaycast.
const SAFE_LABELS: [&str; 10] = [
    "install", "cancel", "allow", "deny", "approve", "reject", "yes", "no", "continue", "stop",
];

/// What the owner is told of one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub reference: String,
    /// The spawned Claude's session id.
    pub session: String,
    pub description: String,
    /// Whether `approve` may answer it; otherwise only `deny` (or `choose`).
    pub approvable: bool,
    pub options: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Tool,
    Question,
    Elicitation,
    Dialog,
}

struct Pending {
    notice: Notice,
    request_id: String,
    kind: Kind,
    /// A tool's input, given back unchanged when it is allowed.
    input: Value,
    deadline: Instant,
    forwarded: bool,
    answer: Option<Value>,
}

fn pending() -> MutexGuard<'static, HashMap<String, Pending>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    PENDING
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

struct Classified {
    kind: Kind,
    description: String,
    approvable: bool,
    options: Vec<String>,
}

impl Classified {
    /// One that can only be denied (cancelled) over Relay.
    fn cancel_only(kind: Kind, description: &str) -> Classified {
        Classified {
            kind,
            description: description.into(),
            approvable: false,
            options: Vec::new(),
        }
    }
}

fn classify(request: &Value) -> Option<Classified> {
    Some(match request["subtype"].as_str()? {
        "can_use_tool" => classify_tool(request),
        "elicitation" => Classified::cancel_only(
            Kind::Elicitation,
            "An MCP server requests confirmation or input, possibly for third-party access.",
        ),
        "request_user_dialog" => Classified::cancel_only(
            Kind::Dialog,
            "Claude asks for a decision in a dialog that cannot be answered through a Relay DM.",
        ),
        _ => return None,
    })
}

fn classify_tool(request: &Value) -> Classified {
    let tool = request["tool_name"].as_str().unwrap_or_default();
    let input = &request["input"];
    let description = match tool {
        "Bash" => "Claude requests permission to run a command. Command text is withheld because it may contain credentials.".to_string(),
        // A path outside Claude's folder widens what it may touch.
        tool if FILE_TOOLS.contains(&tool) && request["blocked_path"].is_string() => {
            "Claude requests permission to change files outside its folder.".into()
        }
        tool if FILE_TOOLS.contains(&tool) => "Claude requests permission to change files.".into(),
        "ExitPlanMode" => "Claude asks to leave plan mode and start making changes.".into(),
        "AskUserQuestion" => {
            return Classified {
                options: choices(input),
                ..Classified::cancel_only(Kind::Question, "Claude asks a question about its task.")
            }
        }
        tool => match safe_name(tool) {
            Some(name) => format!("Claude requests permission to use the {name} tool, possibly involving network or third-party access."),
            None => "Claude requests permission to use a tool, possibly involving network or third-party access.".into(),
        },
    };
    Classified {
        kind: Kind::Tool,
        description,
        approvable: true,
        options: Vec::new(),
    }
}

/// A tool's name, when it is short and plain enough to put in a message.
fn safe_name(tool: &str) -> Option<&str> {
    let plain = !tool.is_empty()
        && tool.len() <= 64
        && tool
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'));
    plain.then_some(tool)
}

/// An `AskUserQuestion`'s options, when it asks one single-choice question
/// whose every label is a fixed, harmless one.
fn choices(input: &Value) -> Vec<String> {
    let Some([question]) = input["questions"].as_array().map(Vec::as_slice) else {
        return Vec::new();
    };
    let Some(options) = question["options"]
        .as_array()
        .filter(|options| !options.is_empty() && options.len() <= 10)
        .filter(|_| question["multiSelect"] != true)
    else {
        return Vec::new();
    };
    let labels: Vec<&str> = options
        .iter()
        .map(|option| option["label"].as_str().unwrap_or_default())
        .collect();
    if !labels.iter().all(|label| {
        SAFE_LABELS
            .iter()
            .any(|safe| label.eq_ignore_ascii_case(safe))
    }) {
        return Vec::new();
    }
    labels
        .iter()
        .enumerate()
        .map(|(index, label)| format!("{}: {label}", index + 1))
        .collect()
}

fn reference() -> Option<String> {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Claude's input line answering `request_id` with `result`.
pub fn response(request_id: &str, result: Value) -> String {
    json!({"type": "control_response", "response": {
        "subtype": "success", "request_id": request_id, "response": result,
    }})
    .to_string()
}

/// Claude's input line refusing a request Agent Relay does not answer.
pub fn refusal(request_id: &str) -> String {
    json!({"type": "control_response", "response": {
        "subtype": "error", "request_id": request_id,
        "error": "Agent Relay cannot answer this request",
    }})
    .to_string()
}

/// Records `event`, a `control_request` from `session`'s output, under a new
/// reference. A request Agent Relay cannot answer gets its refusal back, to
/// write at once; one without an id is ignored.
pub fn register(session: &str, event: &Value) -> Option<String> {
    let request_id = event["request_id"].as_str()?;
    let request = &event["request"];
    let Some(classified) = classify(request) else {
        return Some(refusal(request_id));
    };
    let reference = reference()?;
    let mut entries = pending();
    // Read again after a restart: the same request keeps one reference.
    if entries
        .values()
        .any(|entry| entry.notice.session == session && entry.request_id == request_id)
    {
        return None;
    }
    entries.insert(
        reference.clone(),
        Pending {
            notice: Notice {
                reference,
                session: session.into(),
                description: classified.description,
                approvable: classified.approvable,
                options: classified.options,
            },
            request_id: request_id.into(),
            kind: classified.kind,
            input: request["input"].clone(),
            deadline: Instant::now() + REQUEST_TTL,
            forwarded: false,
            answer: None,
        },
    );
    None
}

/// Claude withdrew `request_id` (it was interrupted or answered otherwise).
pub fn cancel(session: &str, request_id: &str) {
    pending()
        .retain(|_, entry| !(entry.notice.session == session && entry.request_id == request_id));
}

/// Drops every reference of `session`: its input is gone.
pub fn forget(session: &str) {
    pending().retain(|_, entry| entry.notice.session != session);
}

/// Whether `session` has a request no one has answered yet.
pub fn waiting(session: &str) -> bool {
    pending()
        .values()
        .any(|entry| entry.notice.session == session)
}

/// Notices not yet relayed. Each is marked only once Relaycast took it.
pub fn unforwarded(session: &str) -> Vec<Notice> {
    let now = Instant::now();
    pending()
        .values()
        .filter(|entry| {
            entry.notice.session == session
                && !entry.forwarded
                && entry.answer.is_none()
                && now < entry.deadline
        })
        .map(|entry| entry.notice.clone())
        .collect()
}

pub fn mark_forwarded(reference: &str) {
    if let Some(entry) = pending().get_mut(reference) {
        entry.forwarded = true;
    }
}

/// The answers due for `session`, each with its reference, as input lines
/// in no particular order: those given, and a denial for each that expired.
/// One stays due until `settle` says Claude has it whole.
pub fn due(session: &str) -> Vec<(String, String)> {
    let now = Instant::now();
    pending()
        .iter()
        .filter(|(_, entry)| {
            entry.notice.session == session && (entry.answer.is_some() || now >= entry.deadline)
        })
        .map(|(reference, entry)| {
            let result = entry.answer.clone().unwrap_or_else(|| {
                safe_answer(entry, false, "Nobody answered through Agent Relay in time.")
            });
            (reference.clone(), response(&entry.request_id, result))
        })
        .collect()
}

/// The answer under `reference` was written whole: it is done.
pub fn settle(reference: &str) {
    pending().remove(reference);
}

fn safe_answer(entry: &Pending, approved: bool, reason: &str) -> Value {
    match entry.kind {
        Kind::Tool if approved => json!({"behavior": "allow", "updatedInput": entry.input}),
        Kind::Tool | Kind::Question => json!({"behavior": "deny", "message": reason}),
        Kind::Elicitation => json!({"action": "cancel"}),
        Kind::Dialog => json!({"behavior": "cancelled"}),
    }
}

fn live<'a>(
    entries: &'a mut HashMap<String, Pending>,
    session: &str,
    reference: &str,
) -> Option<&'a mut Pending> {
    let now = Instant::now();
    entries.get_mut(reference).filter(|entry| {
        entry.notice.session == session && entry.answer.is_none() && now < entry.deadline
    })
}

/// `approve` or `deny` from `sender_id`, Relaycast's immutable id for the
/// message's author, never a name the text claims. Only the verified owner.
pub fn answer(
    session: &str,
    reference: &str,
    sender_id: Option<&str>,
    owner_id: Option<&str>,
    approved: bool,
) -> ReplyResult {
    let mut entries = pending();
    let Some(entry) = live(&mut entries, session, reference) else {
        return ReplyResult::Unknown;
    };
    if owner_id.is_none() || sender_id != owner_id {
        return ReplyResult::Unauthorized;
    }
    if approved && !entry.notice.approvable {
        return ReplyResult::InvalidChoice;
    }
    entry.answer = Some(safe_answer(entry, approved, "Denied through Agent Relay."));
    ReplyResult::Answered
}

/// `choose <n>` for an `AskUserQuestion`, from the verified owner only.
pub fn answer_choice(
    session: &str,
    reference: &str,
    sender_id: Option<&str>,
    owner_id: Option<&str>,
    choice: usize,
) -> ReplyResult {
    let mut entries = pending();
    let Some(entry) = live(&mut entries, session, reference) else {
        return ReplyResult::Unknown;
    };
    if owner_id.is_none() || sender_id != owner_id {
        return ReplyResult::Unauthorized;
    }
    if entry.kind != Kind::Question || choice == 0 || choice > entry.notice.options.len() {
        return ReplyResult::InvalidChoice;
    }
    let question = &entry.input["questions"][0];
    let (Some(text), Some(label)) = (
        question["question"].as_str(),
        question["options"][choice - 1]["label"].as_str(),
    ) else {
        return ReplyResult::InvalidChoice;
    };
    let mut input = entry.input.as_object().cloned().unwrap_or_default();
    let mut answers = Map::new();
    answers.insert(text.to_string(), Value::from(label));
    input.insert("answers".into(), Value::Object(answers));
    entry.answer = Some(json!({"behavior": "allow", "updatedInput": input}));
    ReplyResult::Answered
}

#[cfg(test)]
pub(super) fn expire(reference: &str) {
    if let Some(entry) = pending().get_mut(reference) {
        entry.deadline = Instant::now();
    }
}

#[cfg(test)]
mod tests;
