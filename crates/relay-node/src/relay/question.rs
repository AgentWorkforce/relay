//! Question escalation: a question a session asks its person (Claude's
//! `AskUserQuestion`, a spawned Codex's `item/tool/requestUserInput`) is
//! sent over Relaycast to an inbox instead, the owner's person identity
//! unless `question_escalation_inbox` names another agent, and the session
//! keeps working. The inbox answers with `answer <ref> <n|text>`; only the
//! inbox, by its immutable agent id, may. The answer reaches the session as
//! one line of native input. A question not answered within 30 minutes
//! expires: a session still running whose question a hook refused (Claude
//! Code, Codex, Devin, Grok, Copilot) is told to continue without it, and a
//! spawned Codex's `requestUserInput` is answered with no answers, as an
//! unanswered request always is.
//!
//! Unlike the spawn approval requests (`harness::claude::requests`), the
//! question's text and options are copied into the message: that is what
//! the inbox needs to answer it. The setting is on unless turned off; a
//! question that cannot be delivered is asked in the session as it would be
//! with the setting off.
//!
//! Records are kept in memory only, for an hour past their expiry so a late
//! reply still hears why it was not delivered. A record is kept before its
//! message is sent, under an idempotency key of its own (the session, what
//! was asked, and the record's reference). When the send fails outright the
//! record is dropped; when its outcome is unknown (a timeout, an answer that
//! could not be read) it is kept unsent: a reply to it is refused, and the
//! same question asked again is sent again under the same key, so Relaycast
//! keeps one message however many times it was tried.
//!
//! A record is sent by one caller at a time (`Record::sending`): the same
//! question asked again while its message is on the way waits for that
//! send's outcome instead of sending it again, and only a record still
//! unsent is opened by a send that finishes.
//!
//! A reply to a question is only taken as an answer while escalation is on
//! and the asking session has a record of that reference; any other
//! `answer q…` message is an ordinary direct message. While an answer is
//! being delivered the record is `Delivering`: a second reply and the expiry
//! timer wait for the outcome, so one question is never answered twice. An
//! answer the session cannot take yet (a spawned Claude still in its turn)
//! is not acknowledged: the question opens again and the same reply is read
//! again on a later pass. An answer that may have arrived is never typed
//! again, and the inbox is told it may not have.
//!
//! A question past its expiry tells its session so once, whichever
//! of the timer and a late reply closes it first (`Record::notified`).

pub mod coverage;
pub mod settings;
pub mod text;

use crate::relay::client;
use crate::relay::codex::app_server::drive::{self, ReplyResult};
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::Delivery;
use crate::relay::delivery::session_text::InputSource;
use crate::relay::inject::InjectOutcome;
use crate::relay::links::Endpoint;
use crate::relay::sdk_gaps;
use crate::relay::spawn::drive::{direct_from, OwnerReply};
use crate::relay::store::{Registration, Target};
use crate::relay::workspace::Secret;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};
use text::{Answer, Asker, Question};

/// How long a question waits for its answer.
pub const TTL: Duration = Duration::from_secs(30 * 60);
/// How long a closed question is remembered after it expires.
const KEEP: Duration = Duration::from_secs(60 * 60);
/// How often an expiry notice the session could not take yet is tried
/// again, and for how long.
const NOTICE_RETRY: Duration = Duration::from_secs(15);
const NOTICE_FOR: Duration = KEEP;
/// How often a caller waiting on another's send of the same question looks
/// again.
const IN_FLIGHT_POLL: Duration = Duration::from_millis(25);
/// The longest `POST /claude/question` takes to answer: shorter than the
/// PreToolUse hook's own timeout (`claude::session_hook::QUESTION_HOOK_TIMEOUT`,
/// 30 s), so the hook always hears the outcome before Claude gives up on it.
pub const ROUTE_LIMIT: Duration = Duration::from_secs(20);
/// The longest a spawned Codex's question is held for escalation before it
/// is forwarded as any other request: the same as `ROUTE_LIMIT`, well inside
/// the request's own five minutes (`drive::REQUEST_TTL`), so a slow
/// Relaycast never holds the session's other requests or lets one expire
/// unforwarded.
pub const CODEX_LIMIT: Duration = ROUTE_LIMIT;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// Kept before its message is sent, or after a send whose outcome is
    /// unknown: not answerable, and sent again under the same key when the
    /// same question is asked again.
    Unsent,
    Open,
    /// An answer is being delivered: neither another answer nor the expiry
    /// timer acts on it until the outcome is known.
    Delivering,
    Answered,
    Expired,
}

impl State {
    /// Sent and waiting for its answer, or having one delivered.
    fn pending(self) -> bool {
        matches!(self, State::Open | State::Delivering)
    }
}

/// Which harness asked, and how its answer goes back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Via {
    /// A question a hook refused before it was shown (Claude's
    /// `AskUserQuestion`, Codex's `request_user_input`): the answer is
    /// typed into the session as native input.
    Session,
    /// A spawned Codex's `item/tool/requestUserInput`: the answer is the
    /// request's result, by the drive's reference.
    Codex { request: String },
}

#[derive(Clone, Debug)]
struct Record {
    target: Target,
    /// The asking agent's immutable id.
    agent_id: String,
    agent: String,
    inbox: String,
    inbox_id: String,
    base_key: String,
    input_hash: String,
    expires: Instant,
    state: State,
    questions: Vec<Question>,
    via: Via,
    /// Its message is being sent now: nobody else sends it meanwhile.
    sending: bool,
    /// The session was told it expired, or never needs to be.
    notified: bool,
}

impl Record {
    /// The same question from the same agent: a session removed and added
    /// again is another agent, whose question is its own.
    fn same(&self, other: &Record) -> bool {
        self.base_key == other.base_key && self.agent_id == other.agent_id
    }
}

fn records() -> MutexGuard<'static, HashMap<String, Record>> {
    static RECORDS: OnceLock<Mutex<HashMap<String, Record>>> = OnceLock::new();
    let mut records = RECORDS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let now = Instant::now();
    records.retain(|_, record| now < record.expires + KEEP);
    records
}

fn new_reference() -> Option<String> {
    let mut bytes = [0u8; 4];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(format!(
        "q{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

/// How long a Codex hook's attempt that did not send a question is
/// remembered, so the `requestUserInput` the tool raises next for a spawned
/// Codex is forwarded as it would be without escalation, not tried again.
const HOOK_TRIED_FOR: Duration = Duration::from_secs(120);

/// What is remembered of each thread's last question a hook could not send:
/// its questions' ids and texts, and when.
fn hook_tried() -> MutexGuard<'static, HashMap<String, (String, Instant)>> {
    static TRIED: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    let mut tried = TRIED
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let now = Instant::now();
    tried.retain(|_, (_, at)| now < *at + HOOK_TRIED_FOR);
    tried
}

/// The same questions, as the hook's tool input and the app-server request
/// both give them.
fn signature(questions: &[Question]) -> String {
    questions
        .iter()
        .map(|question| format!("{}\u{1f}{}", question.id, question.text))
        .collect::<Vec<_>>()
        .join("\u{1e}")
}

/// Notes that the hook tried `questions` for `thread` and did not send them.
fn note_hook_attempt(thread: &str, questions: &[Question]) {
    hook_tried().insert(
        thread.to_ascii_lowercase(),
        (signature(questions), Instant::now()),
    );
}

/// Whether the hook already tried `questions` for `thread`: once only.
fn take_hook_attempt(thread: &str, questions: &[Question]) -> bool {
    let mut tried = hook_tried();
    let key = thread.to_ascii_lowercase();
    if tried
        .get(&key)
        .is_some_and(|(tried, _)| *tried == signature(questions))
    {
        tried.remove(&key);
        return true;
    }
    false
}

/// The first 16 hex digits of the sha256 of what was asked.
pub fn input_hash(input: &Value) -> String {
    let digest = Sha256::digest(serde_json::to_string(input).unwrap_or_default());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// What a session is told when its question was escalated.
pub fn reason(inbox: &str, reference: &str) -> String {
    format!(
        "Sent to @{inbox} over Agent Relay as question {reference}; keep working on what does \
not depend on it and act on the reply when it arrives as a message. It expires in {} min.",
        TTL.as_secs() / 60
    )
}

/// An open question the same agent already asked from the same session
/// with the same input: its reference and inbox.
fn open_for(base_key: &str, agent_id: &str) -> Option<(String, String)> {
    let now = Instant::now();
    records()
        .iter()
        .find(|(_, record)| {
            record.base_key == base_key
                && record.agent_id == agent_id
                && record.state.pending()
                && now < record.expires
        })
        .map(|(reference, record)| (reference.clone(), record.inbox.clone()))
}

/// The idempotency key a record's message is sent under: one per record, so
/// a question asked again after its first record closed is not dropped by
/// Relaycast as the first one sent again, and a record sent again after an
/// unknown outcome is.
fn send_key(base_key: &str, reference: &str) -> String {
    format!("{base_key}-{reference}")
}

#[derive(Debug)]
enum Reserved {
    /// A record to send, new or kept unsent after an unknown outcome, and
    /// the idempotency key to send it under.
    Send { reference: String, key: String },
    /// The same question is already open under this reference.
    Open { reference: String, inbox: String },
    /// The same question is being sent by another caller now: look again
    /// once that send's outcome is known.
    InFlight,
}

/// Keeps `record`, unsent, under a new reference before it is sent, unless
/// the same question is open or being sent. The same question kept unsent
/// for the same inbox is sent again under its own reference and key. The
/// record handed back to send is marked `sending` until `opened`, `release`
/// or the caller's `Sending` guard is dropped.
fn reserve(record: Record) -> Option<Reserved> {
    let mut records = records();
    let now = Instant::now();
    // The same session's question from an agent it no longer is (removed
    // and added again) can never be answered: closed, with nothing to tell.
    for earlier in records.values_mut() {
        if earlier.base_key == record.base_key
            && earlier.agent_id != record.agent_id
            && earlier.state == State::Open
        {
            earlier.state = State::Expired;
            earlier.notified = true;
        }
    }
    if let Some((reference, open)) = records
        .iter()
        .find(|(_, open)| open.same(&record) && open.state.pending() && now < open.expires)
    {
        return Some(Reserved::Open {
            reference: reference.clone(),
            inbox: open.inbox.clone(),
        });
    }
    if let Some((reference, unsent)) = records.iter_mut().find(|(_, unsent)| {
        unsent.same(&record)
            && unsent.state == State::Unsent
            && unsent.inbox_id == record.inbox_id
            && now < unsent.expires
    }) {
        if unsent.sending {
            return Some(Reserved::InFlight);
        }
        unsent.sending = true;
        unsent.expires = record.expires;
        return Some(Reserved::Send {
            key: send_key(&unsent.base_key, reference),
            reference: reference.clone(),
        });
    }
    let reference = std::iter::repeat_with(new_reference)
        .take(8)
        .flatten()
        .find(|reference| !records.contains_key(reference))?;
    let key = send_key(&record.base_key, &reference);
    records.insert(
        reference.clone(),
        Record {
            state: State::Unsent,
            sending: true,
            notified: false,
            ..record
        },
    );
    Some(Reserved::Send { reference, key })
}

/// Drops `reference`, whose message was not sent, while it is still unsent.
fn release(reference: &str) {
    let mut records = records();
    if records
        .get(reference)
        .is_some_and(|record| record.state == State::Unsent)
    {
        records.remove(reference);
    }
}

/// Opens `reference` once its message was sent, only from unsent: it waits
/// a full `TTL` from now. A record already open, answered or expired is
/// left as it is.
fn opened(reference: &str) {
    if let Some(record) = records().get_mut(reference) {
        record.sending = false;
        if record.state == State::Unsent {
            record.state = State::Open;
            record.expires = Instant::now() + TTL;
        }
    }
}

/// Clears `Record::sending` when the send it guards ends however it ends,
/// including a caller dropped at its time limit.
struct Sending(String);

impl Drop for Sending {
    fn drop(&mut self) {
        if let Some(record) = records().get_mut(&self.0) {
            record.sending = false;
        }
    }
}

/// Whether a send that failed with `error` may still have reached
/// Relaycast: a timeout or a dropped connection after the request went out,
/// a server error, or an answer that could not be read. A refusal, a
/// connection never made, or a request never built did not.
fn outcome_unknown(error: &relaycast::RelayError) -> bool {
    use relaycast::RelayError;
    match error {
        RelayError::Api { status, .. } => *status >= 500 || *status == 408,
        RelayError::Http(error) => !error.is_connect() && !error.is_builder(),
        RelayError::Json(_) | RelayError::InvalidResponse(_) => true,
        _ => false,
    }
}

/// Whether `registration`'s session has a record of `reference`, in any
/// state: only then is a reply naming it taken as an answer.
fn known(reference: &str, registration: &Registration) -> bool {
    records().get(reference).is_some_and(|record| {
        record.target == registration.target && record.agent_id == registration.agent_id
    })
}

/// Whether Claude's `session` has `input` escalated and open: the reason
/// its tool call is refused with. A spawned Claude's `can_use_tool` for an
/// `AskUserQuestion` the hook already escalated finds it, so the question
/// is never forwarded twice.
pub fn escalated(session: &str, input: &Value) -> Option<String> {
    let hash = input_hash(input);
    let now = Instant::now();
    records()
        .iter()
        .find(|(_, record)| {
            record.via == Via::Session
                && record.target.id.eq_ignore_ascii_case(session)
                && record.input_hash == hash
                && record.state.pending()
                && now < record.expires
        })
        .map(|(reference, record)| reason(&record.inbox, reference))
}

/// A reply that may be acted on.
#[derive(Debug)]
struct Checked {
    agent: String,
    questions: Vec<Question>,
    answers: Vec<Answer>,
    via: Via,
}

/// Why a reply is not acted on.
#[derive(Debug, PartialEq, Eq)]
enum Unchecked {
    /// The session has no record of the reference: not an answer at all.
    Unknown,
    /// Another answer to it is being delivered: ask again later.
    Delivering,
    /// What the sender is told.
    Refused(String),
}

/// Reads `rest` as the answer to `reference`, asked by `registration`'s
/// session, from `sender_id`; or why not. An answer that may be acted on
/// leaves the record `Delivering` until `settle` or `reopen`.
fn check(
    reference: &str,
    registration: &Registration,
    sender_id: Option<&str>,
    rest: &str,
) -> Result<Checked, Unchecked> {
    let mut records = records();
    let record = records.get_mut(reference).filter(|record| {
        record.target == registration.target && record.agent_id == registration.agent_id
    });
    let Some(record) = record else {
        return Err(Unchecked::Unknown);
    };
    if sender_id != Some(record.inbox_id.as_str()) {
        return Err(Unchecked::Refused(format!(
            "Only the agent question {reference} was sent to may answer it."
        )));
    }
    if record.state == State::Open && Instant::now() >= record.expires {
        record.state = State::Expired;
    }
    let refused = |text: String| Err(Unchecked::Refused(text));
    match record.state {
        State::Unsent => {
            return refused(format!(
                "Question {reference} is not open: @{} was not told it was sent, and asked it \
itself.",
                record.agent
            ))
        }
        State::Delivering => return Err(Unchecked::Delivering),
        State::Answered => return refused(format!("Question {reference} was already answered.")),
        State::Expired => {
            return refused(format!(
                "Question {reference} expired; @{} continued without it.",
                record.agent
            ))
        }
        State::Open => {}
    }
    let answers = text::resolve(&record.questions, rest)
        .map_err(|why| Unchecked::Refused(format!("Question {reference} is still open: {why}.")))?;
    record.state = State::Delivering;
    Ok(Checked {
        agent: record.agent.clone(),
        questions: record.questions.clone(),
        answers,
        via: record.via.clone(),
    })
}

/// Marks `reference` answered.
fn settle(reference: &str) {
    if let Some(record) = records().get_mut(reference) {
        record.state = State::Answered;
    }
}

/// Opens `reference` again when the answer being delivered was not: true
/// when it is past its expiry, which the timer left to this call.
fn reopen(reference: &str) -> bool {
    let mut records = records();
    let Some(record) = records.get_mut(reference) else {
        return false;
    };
    if record.state != State::Delivering {
        return false;
    }
    record.state = State::Open;
    Instant::now() >= record.expires
}

/// Marks `reference` expired when it is still open past its expiry, and
/// hands back the session and harness to tell, once: whether the timer or
/// a late reply (`check`) closed it. One with an answer being delivered is
/// left to that delivery (`reopen`).
fn expire(reference: &str) -> Option<(Target, Via)> {
    let mut records = records();
    let record = records.get_mut(reference)?;
    if record.state == State::Open && Instant::now() >= record.expires {
        record.state = State::Expired;
    }
    if record.state != State::Expired || record.notified {
        return None;
    }
    record.notified = true;
    Some((record.target.clone(), record.via.clone()))
}

#[cfg(test)]
fn expire_now(reference: &str) {
    if let Some(record) = records().get_mut(reference) {
        record.expires = Instant::now();
    }
}

/// Codex's answer to `requestUserInput` for `answers`.
fn codex_answer(questions: &[Question], answers: &[Answer]) -> Value {
    let mut map = Map::new();
    for (question, answer) in questions.iter().zip(answers) {
        map.insert(question.id.clone(), json!({ "answers": answer.values }));
    }
    json!({ "answers": map })
}

/// What escalating a question did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Escalation {
    /// The setting is off: the session asks as it would.
    Off,
    Sent {
        reference: String,
        inbox: String,
    },
    Failed(String),
    /// Not sent within the route's time limit: the session asks as it would,
    /// and a late answer is refused.
    TimedOut(String),
}

impl Escalation {
    /// The `POST /claude/question` answer.
    pub fn response(&self) -> Value {
        match self {
            Escalation::Off => json!({ "escalated": false }),
            Escalation::Sent { reference, inbox } => json!({
                "escalated": true,
                "ref": reference,
                "inbox": inbox,
                "reason": reason(inbox, reference),
            }),
            Escalation::Failed(error) => json!({ "escalated": false, "error": error }),
            Escalation::TimedOut(reason) => json!({ "escalated": false, "reason": reason }),
        }
    }
}

/// A question to escalate.
pub struct Asked<'a> {
    pub questions: Vec<Question>,
    /// What was asked, as the harness gave it: hashed for idempotency.
    pub input: &'a Value,
    pub cwd: &'a str,
    pub via: Via,
}

impl Core {
    /// `escalate_question` within `limit`. Past it the escalation is dropped
    /// where it was: a record whose message was being sent stays unsent, so
    /// an answer to it is refused and the same question asked again is sent
    /// under the same idempotency key.
    pub(crate) async fn escalate_question_within(
        &self,
        registration: &Registration,
        asked: Asked<'_>,
        limit: Duration,
    ) -> Escalation {
        match tokio::time::timeout(limit, self.escalate_question(registration, asked)).await {
            Ok(escalation) => escalation,
            Err(_) => {
                crate::relay::diagnostics::write(format_args!(
                    "question from @{} not escalated within {limit:?}",
                    registration.name,
                ));
                Escalation::TimedOut(format!(
                    "the question was not sent within {limit:?}; ask it here instead"
                ))
            }
        }
    }

    /// Sends `asked`, from `registration`'s session, to the question inbox
    /// when escalation is on. The same question asked again while it is open
    /// is not sent again.
    pub(crate) async fn escalate_question(
        &self,
        registration: &Registration,
        asked: Asked<'_>,
    ) -> Escalation {
        if !self.store.read(settings::on) || asked.questions.is_empty() {
            return Escalation::Off;
        }
        // An answer the session could never take strands the question: it
        // is asked in the session instead.
        if asked.via == Via::Session && !self.answer_reaches(registration).await {
            return Escalation::Off;
        }
        let input_hash = input_hash(asked.input);
        let session = &registration.target.id;
        let base_key = format!("question-{session}-{input_hash}");
        if let Some((reference, inbox)) = open_for(&base_key, &registration.agent_id) {
            return Escalation::Sent { reference, inbox };
        }
        // A launched agent acts through its relaygate registration.
        let Some((acting, token)) = self
            .agent_credential(&registration.name)
            .filter(|(current, _)| current.agent_id == registration.agent_id)
        else {
            return Escalation::Failed(format!("@{} is not registered", registration.name));
        };
        let (inbox, inbox_id) = match self
            .question_inbox(registration, (&acting.base_url, &token))
            .await
        {
            Ok(inbox) => inbox,
            Err(error) => return Escalation::Failed(error),
        };
        let record = Record {
            target: registration.target.clone(),
            agent_id: registration.agent_id.clone(),
            agent: registration.name.clone(),
            inbox: inbox.clone(),
            inbox_id,
            base_key,
            input_hash,
            expires: Instant::now() + TTL,
            state: State::Open,
            questions: asked.questions.clone(),
            via: asked.via,
            sending: false,
            notified: false,
        };
        let (reference, key) = loop {
            match reserve(record.clone()) {
                Some(Reserved::Send { reference, key }) => break (reference, key),
                Some(Reserved::Open { reference, inbox }) => {
                    return Escalation::Sent { reference, inbox }
                }
                // Another call is sending the same question: its outcome
                // decides this one's (open, or sent again when it failed).
                Some(Reserved::InFlight) => tokio::time::sleep(IN_FLIGHT_POLL).await,
                None => return Escalation::Failed("no question reference could be made".into()),
            }
        };
        let _sending = Sending(reference.clone());
        let message = text::render(
            &Asker {
                reference: &reference,
                agent: &registration.name,
                host: &self.config.host_name,
                cwd: asked.cwd,
                session,
            },
            &asked.questions,
            TTL.as_secs() / 60,
        );
        let sent = client::send_dm(
            &acting.base_url,
            &token,
            &Endpoint::Name(inbox.clone()),
            &message,
            Some(key),
        )
        .await;
        if let Err(error) = sent {
            if outcome_unknown(&error) {
                // It may have been sent: kept unsent, so a reply to it is
                // refused and asking again sends it under the same key.
                return Escalation::Failed(format!(
                    "the question may not have reached @{inbox}: {error}"
                ));
            }
            release(&reference);
            return Escalation::Failed(format!("the question was not sent to @{inbox}: {error}"));
        }
        opened(&reference);
        crate::relay::diagnostics::write(format_args!(
            "question {reference} from @{} sent to @{inbox}",
            registration.name
        ));
        if let Some(core) = self.arc() {
            let reference = reference.clone();
            tokio::spawn(async move {
                tokio::time::sleep(TTL).await;
                core.expire_question(&reference).await;
            });
        }
        Escalation::Sent { reference, inbox }
    }

    /// The inbox's name and immutable id: the owner's person identity, or
    /// the agent `question_escalation_inbox` names, in the asking agent's
    /// workspace. `acting` is the base and token the question is sent with.
    async fn question_inbox(
        &self,
        registration: &Registration,
        (acting_base, acting_token): (&str, &Secret),
    ) -> Result<(String, String), String> {
        let Some(name) = self.store.read(settings::inbox) else {
            let owner = self.person_identity(false).await.map_err(|error| {
                format!("the owner's identity is unavailable: {}", error.message)
            })?;
            let elsewhere = || "the owner's identity is in another Relaycast workspace".to_string();
            if owner.base_url != registration.base_url && owner.base_url != acting_base {
                return Err(elsewhere());
            }
            // The question is sent by name with the asking agent's own
            // credential, so the name must find the owner's identity in the
            // asking agent's workspace: one origin holds many workspaces,
            // and another may have an agent of that name.
            let http = sdk_gaps::http(acting_base, acting_token)
                .map_err(|error| format!("the workspace is unreachable: {error}"))?;
            let found = sdk_gaps::get_agent(&http, &owner.name)
                .await
                .map_err(|error| format!("@{} could not be looked up: {error}", owner.name))?;
            if found
                .as_ref()
                .and_then(|agent| agent["id"].as_str())
                .is_none_or(|id| id != owner.agent_id)
            {
                return Err(elsewhere());
            }
            return Ok((owner.name, owner.agent_id));
        };
        if name.eq_ignore_ascii_case(&registration.name) {
            return Err(format!("@{name} cannot answer its own questions"));
        }
        let workspace = self.workspace().ok_or("no workspace is connected")?;
        // The inbox is named in the person's workspace: the asking agent must
        // be in it, by its key, or (registered through relaygate, which
        // keeps no key) the workspace is that gate's.
        let same_workspace = workspace.base_url == registration.base_url
            && match registration.workspace_key.as_ref() {
                Some(key) => *key == workspace.key,
                None => workspace.is_gate_only(),
            };
        if !same_workspace {
            return Err(
                "the asking agent is in a different workspace from the question inbox".into(),
            );
        }
        // Found as the question is sent: by name, with the asking agent's own
        // credential.
        let http = sdk_gaps::http(acting_base, acting_token)
            .map_err(|error| format!("the workspace is unreachable: {error}"))?;
        let agent = sdk_gaps::get_agent(&http, &name)
            .await
            .map_err(|error| format!("@{name} could not be looked up: {error}"))?
            .ok_or_else(|| format!("no agent is named @{name}"))?;
        let id = agent["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("@{name} has no agent id"))?;
        Ok((name, id.to_string()))
    }

    /// Answers a spawned Codex's `requestUserInput` `notice` through the
    /// question inbox when escalation is on: true once it was sent, and the
    /// request now waits as long as the question does. False when it was not
    /// sent within `CODEX_LIMIT`, or not at all: the request is then
    /// forwarded as it would be with escalation off.
    pub(crate) async fn escalate_codex_question(
        &self,
        registration: &Registration,
        notice: &drive::Notice,
    ) -> bool {
        self.escalate_codex_question_within(registration, notice, CODEX_LIMIT)
            .await
    }

    /// `escalate_codex_question` within `limit`.
    pub(crate) async fn escalate_codex_question_within(
        &self,
        registration: &Registration,
        notice: &drive::Notice,
        limit: Duration,
    ) -> bool {
        if !self.store.read(settings::on) {
            return false;
        }
        let Some(params) = drive::user_input(&notice.reference) else {
            return false;
        };
        let Some(questions) = text::codex_questions(&params) else {
            return false;
        };
        // The question hook already tried it, and could not send it: it is
        // asked as it would be without escalation, with no second wait.
        if take_hook_attempt(&registration.target.id, &questions) {
            return false;
        }
        let cwd = registration
            .spawn
            .as_ref()
            .and_then(|spawn| spawn.worker_cwd.clone())
            .unwrap_or_default();
        let asked = Asked {
            questions,
            input: &params,
            cwd: &cwd,
            via: Via::Codex {
                request: notice.reference.clone(),
            },
        };
        match self
            .escalate_question_within(registration, asked, limit)
            .await
        {
            Escalation::Sent { .. } => {
                drive::escalate(&notice.reference, TTL);
                true
            }
            Escalation::Off => false,
            Escalation::Failed(error) | Escalation::TimedOut(error) => {
                crate::relay::diagnostics::write(format_args!(
                    "question from @{} not escalated: {error}",
                    registration.name
                ));
                false
            }
        }
    }

    /// Codex's question hook: `input` is `request_user_input`'s arguments,
    /// from `registration`'s session. The reason its tool call is refused
    /// with when the question went to the inbox; `None` when it did not, and
    /// Codex shows it as it would without escalation. A spawned Codex's
    /// `requestUserInput` for a question the hook could not send is not
    /// tried again (`escalate_codex_question`).
    pub(crate) async fn escalate_codex_hook_question(
        &self,
        registration: &Registration,
        input: &Value,
        cwd: &str,
    ) -> Option<String> {
        self.escalate_codex_hook_question_within(registration, input, cwd, ROUTE_LIMIT)
            .await
    }

    /// `escalate_codex_hook_question` within `limit`.
    pub(crate) async fn escalate_codex_hook_question_within(
        &self,
        registration: &Registration,
        input: &Value,
        cwd: &str,
        limit: Duration,
    ) -> Option<String> {
        let questions = text::codex_tool_questions(input)?;
        let asked = Asked {
            questions: questions.clone(),
            input,
            cwd,
            via: Via::Session,
        };
        match self
            .escalate_question_within(registration, asked, limit)
            .await
        {
            Escalation::Sent { reference, inbox } => Some(reason(&inbox, &reference)),
            Escalation::Off => None,
            Escalation::Failed(error) | Escalation::TimedOut(error) => {
                note_hook_attempt(&registration.target.id, &questions);
                crate::relay::diagnostics::write(format_args!(
                    "question from @{} not escalated: {error}",
                    registration.name
                ));
                None
            }
        }
    }

    /// Copilot's `ask_user` (`args`), from `registration`'s session: the
    /// reason its tool call is denied with once the question went to the
    /// inbox; `None` otherwise, and Copilot asks as usual.
    pub(crate) async fn escalate_copilot_question(
        &self,
        registration: &Registration,
        args: &Value,
        cwd: &str,
    ) -> Option<String> {
        self.escalate_copilot_question_within(registration, args, cwd, ROUTE_LIMIT)
            .await
    }

    /// `escalate_copilot_question` within `limit`.
    pub(crate) async fn escalate_copilot_question_within(
        &self,
        registration: &Registration,
        args: &Value,
        cwd: &str,
        limit: Duration,
    ) -> Option<String> {
        let questions = text::copilot_questions(args)?;
        let asked = Asked {
            questions,
            input: args,
            cwd,
            via: Via::Session,
        };
        match self
            .escalate_question_within(registration, asked, limit)
            .await
        {
            Escalation::Sent { reference, inbox } => Some(reason(&inbox, &reference)),
            Escalation::Off => None,
            Escalation::Failed(error) | Escalation::TimedOut(error) => {
                crate::relay::diagnostics::write(format_args!(
                    "question from @{} not escalated: {error}",
                    registration.name
                ));
                None
            }
        }
    }

    /// A direct message `answer <ref> ...` to `registration`, the agent that
    /// asked: delivered as the answer when the inbox sent it, and refused
    /// with a short reply otherwise. `base` and `token` are what the asking
    /// agent acts with.
    pub(crate) async fn question_reply(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        (base, token): (&str, &Secret),
    ) -> OwnerReply {
        let token = (base, token);
        if !direct_from(delivery, delivery.sender_id.as_deref()) {
            return OwnerReply::NotOne;
        }
        let Some((reference, rest)) =
            text::parse_answer(delivery.text.as_deref().unwrap_or_default())
        else {
            return OwnerReply::NotOne;
        };
        // Only a reply to a question this session asked is an answer; any
        // other `answer q…` is an ordinary message.
        if !self.store.read(settings::on) || !known(&reference, registration) {
            return OwnerReply::NotOne;
        }
        if self.store.read(|store| store.was_injected(&delivery.id)) {
            return OwnerReply::Settled(format!("question {reference} reply already handled"));
        }
        let checked = match check(
            &reference,
            registration,
            delivery.sender_id.as_deref(),
            &rest,
        ) {
            Ok(checked) => checked,
            Err(Unchecked::Unknown) => return OwnerReply::NotOne,
            Err(Unchecked::Delivering) => return OwnerReply::Unsaved,
            Err(Unchecked::Refused(refusal)) => {
                let refused = self.refuse_reply(delivery, token, &refusal).await;
                // A late reply may be what closed it: the session hears too.
                self.expire_question(&reference).await;
                return refused;
            }
        };
        let delivered = format!(
            "Answer to question {reference} delivered to @{}.",
            checked.agent
        );
        match &checked.via {
            // A spawned agent whose process ended cannot take it: the
            // question closes, and the inbox is told.
            Via::Session if self.spawned_process_alive(registration).await == Some(false) => {
                if let Some(record) = records().get_mut(&reference) {
                    record.state = State::Expired;
                    record.notified = true;
                }
                let refusal = format!(
                    "Question {reference} is closed: @{} has ended.",
                    checked.agent
                );
                self.refuse_reply(delivery, token, &refusal).await
            }
            Via::Session => {
                let line = text::answer_line(&reference, &checked.questions, &checked.answers);
                match self
                    .deliver_session_text(registration, delivery, line, InputSource::Requester)
                    .await
                {
                    // Not taken: a spawned Claude in its turn or waiting on a
                    // request writes nothing (`WaitingForTurn`). Not
                    // acknowledged, so the same reply is read again.
                    InjectOutcome::Retry(_)
                    | InjectOutcome::Waiting(_)
                    | InjectOutcome::WaitingForTurn(_) => {
                        self.reopen_question(&reference).await;
                        OwnerReply::Unsaved
                    }
                    InjectOutcome::Refused(why) => {
                        self.reopen_question(&reference).await;
                        let refusal =
                            format!("The answer to question {reference} was not delivered: {why}");
                        self.refuse_reply(delivery, token, &refusal).await
                    }
                    // It may have arrived: never typed again, and the inbox
                    // is told it may not have.
                    InjectOutcome::InDoubt(why) => {
                        let unsure = format!(
                            "The answer to question {reference} may not have reached @{}: {why}. \
It is not sent again.",
                            checked.agent
                        );
                        self.answered(&reference, delivery, token, &unsure).await
                    }
                    InjectOutcome::Delivered => {
                        self.answered(&reference, delivery, token, &delivered).await
                    }
                    // Queued in the session (a Devin session's hooks drain
                    // it at its next turn): it is kept, never typed again,
                    // and the inbox is not told it arrived.
                    InjectOutcome::Accepted(_) => {
                        let queued = format!(
                            "Answer to question {reference} is queued for @{}: it reaches the \
session at its next turn.",
                            checked.agent
                        );
                        self.answered(&reference, delivery, token, &queued).await
                    }
                }
            }
            Via::Codex { request } => {
                // The answer is the request's result first, and the reply
                // recorded handled only after: a record that could not be
                // saved never leaves a reply handled that Codex never had.
                let value = codex_answer(&checked.questions, &checked.answers);
                match drive::answer_question(&registration.target.id, request, value) {
                    ReplyResult::Answered => {
                        self.answered(&reference, delivery, token, &delivered).await
                    }
                    _ => {
                        if let Some(record) = records().get_mut(&reference) {
                            record.state = State::Expired;
                            record.notified = true;
                        }
                        let refusal = format!(
                            "Question {reference} expired; @{} continued without it.",
                            checked.agent
                        );
                        self.refuse_reply(delivery, token, &refusal).await
                    }
                }
            }
        }
    }

    /// Settles `reference`, whose answer reached the session (or may have),
    /// records the reply handled, and tells the inbox `told`. When the
    /// record cannot be saved the reply is left unacknowledged: its
    /// redelivery finds it handled in memory and is acknowledged then. The
    /// inbox is told either way; its reply is sent once by its key.
    async fn answered(
        &self,
        reference: &str,
        delivery: &Delivery,
        token: (&str, &Secret),
        told: &str,
    ) -> OwnerReply {
        settle(reference);
        let saved = self
            .store
            .remember(|store| store.record_injected(&delivery.id))
            .is_ok();
        self.reply_to_sender(delivery, token, told).await;
        if !saved {
            return OwnerReply::Unsaved;
        }
        OwnerReply::Settled(format!("question {reference} answered"))
    }

    async fn refuse_reply(
        &self,
        delivery: &Delivery,
        token: (&str, &Secret),
        refusal: &str,
    ) -> OwnerReply {
        if self
            .store
            .remember(|store| store.record_injected(&delivery.id))
            .is_err()
        {
            return OwnerReply::Unsaved;
        }
        self.reply_to_sender(delivery, token, refusal).await;
        OwnerReply::Settled(format!("question reply refused: {refusal}"))
    }

    /// Opens `reference` again after an answer that was not delivered,
    /// expiring it when the timer passed while it was being delivered.
    async fn reopen_question(&self, reference: &str) {
        if reopen(reference) {
            self.expire_question(reference).await;
        }
    }

    /// Tells a reply's sender what became of it, once: by its exact address,
    /// or by name only while that name is still the sender's agent id, so a
    /// renamed or reused name never receives it.
    async fn reply_to_sender(
        &self,
        delivery: &Delivery,
        (base, token): (&str, &Secret),
        text: &str,
    ) {
        let Some(endpoint) = sender_endpoint(delivery, (base, token)).await else {
            return;
        };
        let _ = client::send_dm(
            base,
            token,
            &endpoint,
            text,
            Some(format!("question-reply-{}", delivery.id)),
        )
        .await;
    }

    /// Closes `reference` when it is still open past its expiry; a session
    /// still running whose question a hook refused (`Via::Session`) is told
    /// to continue without it. A spawned Codex's request expires in the
    /// drive, to no answers.
    pub(crate) async fn expire_question(&self, reference: &str) {
        let Some((target, via)) = expire(reference) else {
            return;
        };
        crate::relay::diagnostics::write(format_args!("question {reference} expired"));
        if via != Via::Session {
            return;
        }
        match self.arc() {
            // A session that cannot take it yet (a spawned agent in its
            // turn) is told once it can, for as long as it is remembered.
            Some(core) => {
                let reference = reference.to_string();
                tokio::spawn(async move {
                    let until = Instant::now() + NOTICE_FOR;
                    while !core.tell_expired(&target, &reference).await && Instant::now() < until {
                        tokio::time::sleep(NOTICE_RETRY).await;
                    }
                });
            }
            None => {
                self.tell_expired(&target, reference).await;
            }
        }
    }

    /// Tells `target`'s session that `reference` expired: false only when
    /// the session is running and could not take it yet. A session that has
    /// ended (a spawned agent's process gone, or one the directory no longer
    /// finds) is not told.
    async fn tell_expired(&self, target: &Target, reference: &str) -> bool {
        let Some(registration) = self
            .store
            .read(|store| store.registration_for(target).cloned())
        else {
            return true;
        };
        if !self.question_session_running(&registration).await {
            return true;
        }
        let id = format!("question-expired-{reference}");
        let delivery = Delivery {
            id: id.clone(),
            message_id: id,
            reason: Some("dm".into()),
            ..Delivery::default()
        };
        !matches!(
            self.deliver_session_text(
                &registration,
                &delivery,
                text::expired_line(reference),
                InputSource::Requester,
            )
            .await,
            InjectOutcome::Retry(_) | InjectOutcome::Waiting(_) | InjectOutcome::WaitingForTurn(_)
        )
    }

    /// Whether `registration`'s session is still running: a spawned
    /// agent's own process, whatever its harness, or else a session the
    /// directory still finds.
    async fn question_session_running(&self, registration: &Registration) -> bool {
        if let Some(alive) = self.spawned_process_alive(registration).await {
            return alive;
        }
        let (sessions, target) = (self.plugins.sessions.clone(), registration.target.clone());
        tokio::task::spawn_blocking(move || sessions.find_session(&target).is_some())
            .await
            .unwrap_or(false)
    }
}

impl Core {
    /// Whether an answer typed into `registration`'s session can reach it:
    /// a Devin session only while Agent Relay's Devin hooks are on (they
    /// carry it in), an already-open Grok session only while Grok lists it.
    /// Every other session takes its answer as it takes any message.
    async fn answer_reaches(&self, registration: &Registration) -> bool {
        match registration.target.kind {
            crate::relay::store::SessionKind::Devin => {
                self.settings().get(crate::relay::devin::SETTING) != Some(&Value::Bool(false))
            }
            crate::relay::store::SessionKind::GrokOpen => {
                let (sessions, target) =
                    (self.plugins.sessions.clone(), registration.target.clone());
                tokio::task::spawn_blocking(move || sessions.find_session(&target).is_some())
                    .await
                    .unwrap_or(false)
            }
            _ => true,
        }
    }

    /// Whether a spawned agent's own process still runs, by the spawner
    /// that started it; `None` for a session with no process of its own (a
    /// person's session, or a spawned Codex thread in Codex's daemon).
    async fn spawned_process_alive(&self, registration: &Registration) -> Option<bool> {
        let process = registration
            .spawn
            .as_ref()
            .and_then(|spawn| spawn.process)?;
        let (spawner, target) = (self.plugins.spawner.clone(), registration.target.clone());
        Some(
            tokio::task::spawn_blocking(move || spawner.alive(&target, Some(&process)))
                .await
                .unwrap_or(true),
        )
    }
}

/// Where a reply to `delivery`'s sender goes: its exact `agent@machine`
/// address, or its name when looking the name up still finds the sender's
/// immutable agent id.
async fn sender_endpoint(delivery: &Delivery, (base, token): (&str, &Secret)) -> Option<Endpoint> {
    if let Some(address) = delivery
        .sender_address
        .as_deref()
        .filter(|address| !address.is_empty())
    {
        return Some(Endpoint::Address(address.to_string()));
    }
    let (name, id) = (delivery.sender.as_deref()?, delivery.sender_id.as_deref()?);
    let http = sdk_gaps::http(base, token).ok()?;
    let agent = sdk_gaps::get_agent(&http, name).await.ok()??;
    (agent["id"].as_str() == Some(id)).then(|| Endpoint::Name(name.to_string()))
}

#[cfg(test)]
pub(crate) mod tests;
