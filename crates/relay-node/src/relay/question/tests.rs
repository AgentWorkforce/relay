//! Question escalation: the message, the reply grammar, the records, and a
//! question escalated and answered through a stub Relaycast.

use super::text::{self, Asker, Choice, Question};
use super::*;
use crate::relay::store::{Registration, SessionKind, Target};
use std::io::{Read, Write};
use std::sync::Arc;

/// A registration for `target`, in the stub workspace at `base`.
pub(crate) fn registration(name: &str, target: Target, base: &str) -> Registration {
    serde_json::from_value(json!({
        "name": name,
        "agentID": format!("agent-{name}"),
        "target": target,
        "baseURL": base,
        "registeredAt": "2026-11-17T12:00:00Z",
        "workspaceKey": "rk_live_test",
    }))
    .unwrap()
}

fn choice(label: &str, description: &str) -> Choice {
    Choice {
        label: label.into(),
        description: description.into(),
    }
}

fn pick(multi: bool) -> Question {
    Question {
        id: "pick".into(),
        header: "Database".into(),
        text: "Which database should I use?".into(),
        options: vec![
            choice("Postgres", "Relational, already deployed"),
            choice("SQLite", ""),
        ],
        multi,
        free: true,
    }
}

fn input() -> Value {
    json!({"questions": [{
        "question": "Which database should I use?",
        "header": "Database",
        "options": [
            {"label": "Postgres", "description": "Relational, already deployed"},
            {"label": "SQLite", "description": ""},
        ],
        "multiSelect": false,
    }]})
}

#[test]
fn claude_and_codex_questions_are_read() {
    let claude = Question {
        id: String::new(),
        ..pick(false)
    };
    assert_eq!(text::claude_questions(&input()), vec![claude]);
    assert!(text::claude_questions(&json!({})).is_empty());
    let codex = json!({"threadId": "t", "questions": [{
        "id": "q1", "header": "Mode", "question": "Fast or safe?",
        "options": [{"label": "Fast", "description": "d"}], "isOther": true,
    }]});
    let read = text::codex_questions(&codex).unwrap();
    assert_eq!(read[0].id, "q1");
    assert!(read[0].free && !read[0].multi);
    // A secret question's answer never travels over Relaycast.
    let secret = json!({"questions": [{"id": "q1", "question": "Token?", "isSecret": true}]});
    assert_eq!(text::codex_questions(&secret), None);
}

#[test]
fn the_message_says_who_asks_what_and_how_to_answer() {
    let asker = Asker {
        reference: "q0123abcd",
        agent: "builder",
        host: "Desk.local",
        cwd: "",
        session: "sess-1",
    };
    let message = text::render(&asker, &[pick(false)], 30);
    assert_eq!(
        message,
        "[Question q0123abcd from @builder on Desk.local]\n\
         Working on: unknown\n\
         session sess-1\n\
         Database: Which database should I use?\n\
         1. Postgres — Relational, already deployed\n\
         2. SQLite\n\
         Choose a number, or answer in free text.\n\
         Reply: answer q0123abcd <n|text>. Expires in 30 min; the agent continues without it."
    );
    let free = Question {
        options: Vec::new(),
        header: String::new(),
        ..pick(false)
    };
    let message = text::render(&asker, &[pick(true), free], 30);
    assert!(message.contains("(1/2) Database: Which database should I use?"));
    assert!(
        message.contains("Choose one or more (comma-separated numbers), or answer in free text.")
    );
    assert!(message.contains("(2/2) Which database should I use?\nfree text"));
    assert!(message.contains("answer q0123abcd <n|text>; <n|text> (one per question, in order)"));
}

#[test]
fn the_repository_and_branch_are_read_from_git() {
    let temp = tempfile::tempdir().unwrap();
    let top = temp.path().join("checkout");
    std::fs::create_dir_all(top.join(".git")).unwrap();
    std::fs::create_dir_all(top.join("src/deep")).unwrap();
    std::fs::write(top.join(".git/HEAD"), "ref: refs/heads/feature/x\n").unwrap();
    std::fs::write(
        top.join(".git/config"),
        "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@github.com:AgentWorkforce/relay.git\n",
    )
    .unwrap();
    assert_eq!(
        text::repository(&top.join("src/deep")),
        Some(("relay".into(), "feature/x".into()))
    );
    // A detached HEAD shows its short commit; without origin, the folder.
    std::fs::write(top.join(".git/HEAD"), "0123456789abcdef\n").unwrap();
    std::fs::write(top.join(".git/config"), "[core]\n").unwrap();
    assert_eq!(
        text::repository(&top),
        Some(("checkout".into(), "0123456".into()))
    );
    let asker = Asker {
        reference: "q0123abcd",
        agent: "builder",
        host: "Desk",
        cwd: top.to_str().unwrap(),
        session: "s",
    };
    let message = text::render(&asker, &[pick(false)], 30);
    assert!(message.contains(&format!(
        "Working on: {} (checkout @ 0123456)",
        top.display()
    )));
    assert_eq!(text::repository(&temp.path().join("elsewhere")), None);
}

#[test]
fn replies_are_parsed_in_either_form_and_any_case() {
    let parsed = |text: &str| text::parse_answer(text);
    assert_eq!(
        parsed("answer q0123ABCD 2"),
        Some(("q0123abcd".into(), "2".into()))
    );
    assert_eq!(
        parsed("  ANSWER q0123abcd: use the old one "),
        Some(("q0123abcd".into(), "use the old one".into()))
    );
    assert_eq!(
        parsed("Answer q0123abcd : 1, 2"),
        Some(("q0123abcd".into(), "1, 2".into()))
    );
    assert_eq!(
        parsed("answer q0123abcd"),
        Some(("q0123abcd".into(), "".into()))
    );
    assert_eq!(parsed("answer the question"), None);
    assert_eq!(parsed("answers q0123abcd 1"), None);
    assert_eq!(parsed("approve q0123abcd"), None);
    assert_eq!(parsed("answer q0123abcg 1"), None);
}

#[test]
fn numbers_map_to_labels_and_text_is_taken_as_written() {
    let one = [pick(false)];
    let answers = text::resolve(&one, "2").unwrap();
    assert_eq!(answers[0].values, vec!["SQLite"]);
    assert_eq!(
        text::answer_line("q0123abcd", &one, &answers),
        "[Answer to question q0123abcd] 2. SQLite"
    );
    let answers = text::resolve(&one, "whatever is cheaper").unwrap();
    assert_eq!(
        text::answer_line("q0123abcd", &one, &answers),
        "[Answer to question q0123abcd] whatever is cheaper"
    );
    assert!(text::resolve(&one, "1,2")
        .unwrap_err()
        .contains("one choice"));
    assert!(text::resolve(&one, "").is_err());
    let several = [pick(true)];
    let answers = text::resolve(&several, "2, 1,2").unwrap();
    assert_eq!(answers[0].values, vec!["SQLite", "Postgres"]);
    assert_eq!(answers[0].shown, "2. SQLite, 1. Postgres");
    let strict = [Question {
        free: false,
        ..pick(false)
    }];
    assert!(text::resolve(&strict, "maybe").is_err());
    assert!(text::resolve(&strict, "3").unwrap_err().contains("1 to 2"));
    let two = [
        pick(false),
        Question {
            header: "Port".into(),
            ..pick(false)
        },
    ];
    let answers = text::resolve(&two, "1; my own").unwrap();
    assert_eq!(
        text::answer_line("q0123abcd", &two, &answers),
        "[Answer to question q0123abcd] Database: 1. Postgres; Port: my own"
    );
    assert!(text::resolve(&two, "1").is_err());
}

/// A number that names no option is free text when the question takes free
/// text, and refused when it does not.
#[test]
fn a_number_out_of_range_is_free_text_when_the_question_takes_text() {
    let one = [pick(false)];
    for answer in ["3", "0", "1,3"] {
        let answers = text::resolve(&one, answer).unwrap();
        assert_eq!(answers[0].values, vec![answer], "{answer}");
        assert_eq!(answers[0].shown, answer);
    }
    let strict = [Question {
        free: false,
        ..pick(false)
    }];
    for answer in ["3", "0"] {
        assert!(
            text::resolve(&strict, answer)
                .unwrap_err()
                .contains("1 to 2"),
            "{answer}"
        );
    }
}

fn record(registration: &Registration, base_key: &str) -> Record {
    Record {
        target: registration.target.clone(),
        agent_id: registration.agent_id.clone(),
        agent: registration.name.clone(),
        inbox: "triage".into(),
        inbox_id: "agent-triage".into(),
        base_key: base_key.into(),
        input_hash: input_hash(&input()),
        expires: Instant::now() + TTL,
        state: State::Open,
        questions: vec![pick(false)],
        via: Via::Session,
        sending: false,
        notified: false,
    }
}

/// A record reserved and sent: its reference and key.
fn reserved(registration: &Registration, base_key: &str) -> (String, String) {
    match reserve(record(registration, base_key)).unwrap() {
        Reserved::Send { reference, key } => {
            opened(&reference);
            (reference, key)
        }
        Reserved::Open { .. } => panic!("already open"),
        Reserved::InFlight => panic!("being sent"),
    }
}

#[test]
fn only_the_inbox_answers_an_open_question_once_before_it_expires() {
    let asker = registration(
        "asker-checks",
        Target::new(SessionKind::ClaudeTerminal, "sess-checks"),
        "https://cast.test",
    );
    let (reference, key) = reserved(&asker, "question-sess-checks-1");
    assert_eq!(key, format!("question-sess-checks-1-{reference}"));
    assert!(text::is_reference(&reference));
    // The same question while it is open keeps its reference.
    assert!(matches!(
        reserve(record(&asker, "question-sess-checks-1")),
        Some(Reserved::Open { reference: open, .. }) if open == reference
    ));
    let wrong = check(&reference, &asker, Some("agent-other"), "1").unwrap_err();
    assert_eq!(
        wrong,
        Unchecked::Refused(format!(
            "Only the agent question {reference} was sent to may answer it."
        ))
    );
    let unknown = check("q00000000", &asker, Some("agent-triage"), "1").unwrap_err();
    assert_eq!(unknown, Unchecked::Unknown);
    let other = registration(
        "other",
        Target::new(SessionKind::ClaudeTerminal, "sess-other"),
        "https://cast.test",
    );
    assert!(check(&reference, &other, Some("agent-triage"), "1").is_err());
    let Err(Unchecked::Refused(unreadable)) =
        check(&reference, &asker, Some("agent-triage"), "1,2")
    else {
        panic!("an unreadable answer is refused");
    };
    assert!(unreadable.contains("still open"), "{unreadable}");
    let checked = check(&reference, &asker, Some("agent-triage"), "1").unwrap();
    assert_eq!(checked.answers[0].values, vec!["Postgres"]);
    settle(&reference);
    let again = check(&reference, &asker, Some("agent-triage"), "1").unwrap_err();
    assert_eq!(
        again,
        Unchecked::Refused(format!("Question {reference} was already answered."))
    );
    // Asked again once closed: a key of its own, so it is not deduplicated.
    let (second, key) = reserved(&asker, "question-sess-checks-1");
    assert_ne!(second, reference);
    assert_eq!(key, format!("question-sess-checks-1-{second}"));
    expire_now(&second);
    let late = check(&second, &asker, Some("agent-triage"), "1").unwrap_err();
    assert_eq!(
        late,
        Unchecked::Refused(format!(
            "Question {second} expired; @asker-checks continued without it."
        ))
    );
    // Closed by the late reply, the session is still told, once.
    assert!(expire(&second).is_some());
    assert_eq!(expire(&second), None);
}

#[test]
fn an_escalated_claude_question_is_refused_not_forwarded_again() {
    let asker = registration(
        "asker-guard",
        Target::new(SessionKind::ClaudeTerminal, "sess-guard"),
        "https://cast.test",
    );
    let (reference, _) = reserved(&asker, "question-sess-guard-1");
    let reason = escalated("SESS-GUARD", &input()).unwrap();
    assert!(reason.starts_with(&format!(
        "Sent to @triage over Agent Relay as question {reference};"
    )));
    assert!(reason.ends_with("It expires in 30 min."));
    assert_eq!(escalated("sess-guard", &json!({"questions": []})), None);
    let event = json!({"request_id": "r1", "request": {
        "subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": input(),
    }});
    assert_eq!(
        crate::relay::harness::claude::requests::register("sess-guard", &event),
        None
    );
    assert!(crate::relay::harness::claude::requests::unforwarded("sess-guard").is_empty());
    let due = crate::relay::harness::claude::requests::due("sess-guard");
    assert_eq!(due.len(), 1);
    assert!(due[0].1.contains("\"behavior\":\"deny\""), "{}", due[0].1);
    assert!(due[0].1.contains(&reference));
}

/// How the stub Relaycast answers a DM.
const ACCEPT: u8 = 0;
const REFUSE: u8 = 1;
/// Reads the DM, then answers nothing for a while: a send that times out.
const HANG: u8 = 2;
/// Takes the DM after a short while: a send still in flight.
const SLOW: u8 = 3;
/// Answers the DM with a server error: a send whose outcome is unknown.
const BROKEN: u8 = 4;

/// A Relaycast that knows the agent `triage` and takes DMs (refusing them
/// when `refuse`), keeping each request's line and body.
pub(crate) fn relaycast(refuse: bool) -> (String, Arc<Mutex<Vec<String>>>) {
    let mode = Arc::new(std::sync::atomic::AtomicU8::new(if refuse {
        REFUSE
    } else {
        ACCEPT
    }));
    relaycast_in(mode)
}

/// `relaycast`, answering DMs as `mode` says at the time.
fn relaycast_in(mode: Arc<std::sync::atomic::AtomicU8>) -> (String, Arc<Mutex<Vec<String>>>) {
    relaycast_with(mode, &[("triage", "agent-triage")])
}

/// `relaycast_in`, where looking up a name in the asking agent's workspace
/// finds the agent ids `agents` gives.
fn relaycast_with(
    mode: Arc<std::sync::atomic::AtomicU8>,
    agents: &[(&str, &str)],
) -> (String, Arc<Mutex<Vec<String>>>) {
    let agents: Arc<HashMap<String, String>> = Arc::new(
        agents
            .iter()
            .map(|(name, id)| (name.to_string(), id.to_string()))
            .collect(),
    );
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(Mutex::new(Vec::new()));
    let seen = hits.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let (seen, mode, agents) = (seen.clone(), mode.clone(), agents.clone());
            std::thread::spawn(move || {
                let mut request = Vec::new();
                let mut buffer = [0_u8; 8192];
                let (head, body) = loop {
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    if read == 0 {
                        break (
                            String::from_utf8_lossy(&request).into_owned(),
                            String::new(),
                        );
                    }
                    request.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&request).into_owned();
                    let Some((head, body)) = text.split_once("\r\n\r\n") else {
                        continue;
                    };
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if body.len() >= length {
                        break (head.to_string(), body.to_string());
                    }
                };
                let line = head.lines().next().unwrap_or_default().to_string();
                let key = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("idempotency-key:")
                            .map(|v| v.trim().to_string())
                    })
                    .unwrap_or_default();
                seen.lock()
                    .unwrap()
                    .push(format!("{line} key={key} {body}"));
                let mode = mode.load(std::sync::atomic::Ordering::SeqCst);
                if mode == HANG && line.starts_with("POST /v1/dm") {
                    std::thread::sleep(Duration::from_secs(5));
                    return;
                }
                if mode == SLOW && line.starts_with("POST /v1/dm") {
                    std::thread::sleep(Duration::from_millis(400));
                }
                let found = line
                    .strip_prefix("GET /v1/agents/")
                    .and_then(|rest| rest.split([' ', '?']).next())
                    .and_then(|name| agents.get(name).map(|id| (name.to_string(), id.clone())));
                let found = found.map(|(name, id)| {
                    json!({"ok": true, "data": {"id": id, "name": name}}).to_string()
                });
                let (status, reply) = if let Some(found) = found.as_deref() {
                    ("200 OK", found)
                } else if line.starts_with("GET /v1/agents/") {
                    (
                        "404 Not Found",
                        r#"{"ok":false,"error":{"code":"agent_not_found","message":"no"}}"#,
                    )
                } else if mode == BROKEN && line.starts_with("POST /v1/dm") {
                    (
                        "500 Internal Server Error",
                        r#"{"ok":false,"error":{"code":"internal","message":"boom"}}"#,
                    )
                } else if mode == REFUSE {
                    (
                        "403 Forbidden",
                        r#"{"ok":false,"error":{"code":"forbidden","message":"refused"}}"#,
                    )
                } else {
                    (
                        "200 OK",
                        r#"{"ok":true,"data":{"id":"msg_1","conversation_id":"conv_1"}}"#,
                    )
                };
                let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            });
        }
    });
    (base, hits)
}

/// A core whose store has `asker` registered, with escalation turned on
/// (inbox `triage`) or explicitly off.
fn core(base: &str, asker: &Registration, on: bool) -> (Arc<Core>, tempfile::TempDir) {
    core_with(base, asker, on, crate::relay::daemon::Plugins::default())
}

/// `core`, built with `plugins`.
fn core_with(
    base: &str,
    asker: &Registration,
    on: bool,
    plugins: crate::relay::daemon::Plugins,
) -> (Arc<Core>, tempfile::TempDir) {
    let temp = tempfile::tempdir().unwrap();
    let config = crate::relay::daemon::Config {
        paths: crate::relay::paths::CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
        home: temp.path().into(),
        app_data_dir: temp.path().join("app-data"),
        env: std::collections::BTreeMap::new(),
        version: "0.0.0-test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: crate::relay::push::PushTiming::default(),
        delivery_timing: crate::relay::delivery::DeliveryTiming::default(),
    };
    let (core, _signals) = Core::with_plugins(config, plugins);
    *core.workspace.lock().unwrap() = Some(crate::relay::workspace::Workspace {
        key: Secret::new("rk_live_test"),
        base_url: base.into(),
        workspace_id: None,
        source: crate::relay::workspace::WorkspaceSource::Cloud,
        control_url: None,
        gate_url: None,
    });
    let asker = asker.clone();
    core.store
        .remember(|store| {
            store
                .tokens
                .insert(asker.name.clone(), Secret::new("at_live_asker"));
            store.registrations.push(asker);
            if on {
                store.extras.question_escalation = Some(true);
                store.extras.question_escalation_inbox = Some("triage".into());
            } else {
                // Escalation is on unless turned off: off is explicit.
                store.extras.question_escalation = Some(false);
            }
        })
        .unwrap();
    (core, temp)
}

fn asked(input: &Value) -> Asked<'_> {
    Asked {
        questions: text::claude_questions(input),
        input,
        cwd: "",
        via: Via::Session,
    }
}

#[tokio::test]
async fn off_the_question_is_asked_as_it_would_be() {
    let (base, hits) = relaycast(false);
    let asker = registration(
        "asker-off",
        Target::new(SessionKind::ClaudeTerminal, "sess-off"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, false);
    let escalation = core.escalate_question(&asker, asked(&input())).await;
    assert_eq!(escalation.response(), json!({"escalated": false}));
    assert!(hits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn on_the_question_goes_to_the_inbox_once() {
    let (base, hits) = relaycast(false);
    let asker = registration(
        "asker-on",
        Target::new(SessionKind::ClaudeTerminal, "sess-on"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    let question = input();
    let escalation = core.escalate_question(&asker, asked(&question)).await;
    let Escalation::Sent { reference, inbox } = escalation.clone() else {
        panic!("{escalation:?}");
    };
    assert_eq!(inbox, "triage");
    let response = escalation.response();
    assert_eq!(response["escalated"], true);
    assert_eq!(response["ref"], reference.as_str());
    assert_eq!(response["inbox"], "triage");
    assert_eq!(
        response["reason"],
        format!(
            "Sent to @triage over Agent Relay as question {reference}; keep working on what does \
not depend on it and act on the reply when it arrives as a message. It expires in 30 min."
        )
    );
    let sent: Vec<String> = hits
        .lock()
        .unwrap()
        .iter()
        .filter(|hit| hit.starts_with("POST /v1/dm"))
        .cloned()
        .collect();
    assert_eq!(sent.len(), 1, "{sent:?}");
    let key = format!("question-sess-on-{}-{reference}", input_hash(&question));
    assert!(sent[0].contains(&format!("key={key}")), "{}", sent[0]);
    assert!(sent[0].contains(&format!(
        "[Question {reference} from @asker-on on Test Desk.local]"
    )));
    assert!(sent[0].contains("\"to\":\"triage\""), "{}", sent[0]);
    // The hook firing again for the same question sends nothing more.
    let again = core.escalate_question(&asker, asked(&question)).await;
    assert_eq!(again, Escalation::Sent { reference, inbox });
    let dms = hits
        .lock()
        .unwrap()
        .iter()
        .filter(|hit| hit.starts_with("POST /v1/dm"))
        .count();
    assert_eq!(dms, 1);
}

#[tokio::test]
async fn a_question_that_cannot_be_sent_says_why() {
    let (base, _hits) = relaycast(true);
    let asker = registration(
        "asker-refused",
        Target::new(SessionKind::ClaudeTerminal, "sess-refused"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    let question = input();
    let escalation = core.escalate_question(&asker, asked(&question)).await;
    let response = escalation.response();
    assert_eq!(response["escalated"], false);
    assert!(
        response["error"]
            .as_str()
            .unwrap()
            .starts_with("the question was not sent to @triage"),
        "{response}"
    );
    // Nothing is left open: the hook lets the dialog through.
    assert_eq!(escalated("sess-refused", &question), None);
    // An inbox no agent holds, or an agent that is not registered.
    core.store
        .remember(|store| store.extras.question_escalation_inbox = Some("nobody".into()))
        .unwrap();
    let response = core
        .escalate_question(&asker, asked(&question))
        .await
        .response();
    assert_eq!(response["error"], "no agent is named @nobody");
    let stranger = registration(
        "stranger",
        Target::new(SessionKind::ClaudeTerminal, "sess-stranger"),
        &base,
    );
    let response = core
        .escalate_question(&stranger, asked(&question))
        .await
        .response();
    assert_eq!(response["error"], "@stranger is not registered");
}

/// A direct message from the agent `sender_id` names (`agent-<name>`), at
/// its address `<name>@desk`.
fn reply(id: &str, sender_id: &str, text: &str) -> Delivery {
    let name = sender_id.trim_start_matches("agent-");
    Delivery {
        id: id.into(),
        message_id: id.into(),
        reason: Some("dm".into()),
        sender: Some(name.into()),
        sender_id: Some(sender_id.into()),
        sender_address: Some(format!("{name}@desk")),
        text: Some(text.into()),
        ..Delivery::default()
    }
}

#[tokio::test]
async fn a_spawned_codex_question_is_answered_by_the_inbox() {
    let (base, hits) = relaycast(false);
    let thread = "019a0000-0000-7000-8000-00000000c0de";
    let asker = registration(
        "asker-codex",
        Target::new(SessionKind::Codex, thread),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    let notice = drive::open_request(
        thread,
        json!({"id": 7, "method": "item/tool/requestUserInput", "params": {
            "threadId": thread, "turnId": "t", "itemId": "i",
            "questions": [{"id": "db", "header": "Database", "question": "Which?",
                "options": [{"label": "Postgres", "description": ""},
                            {"label": "SQLite", "description": ""}]}],
        }}),
    );
    assert!(core.escalate_codex_question(&asker, &notice).await);
    // Escalated: it is not forwarded as an approval request too.
    assert!(drive::unforwarded(thread).is_empty());
    let reference = records()
        .iter()
        .find(|(_, record)| record.target.id == thread)
        .map(|(reference, _)| reference.clone())
        .unwrap();
    let token = Secret::new("at_live_asker");
    let acting = (base.as_str(), &token);
    // Anyone else is refused, and nothing is answered.
    let wrong = reply("d-wrong", "agent-mallory", &format!("answer {reference} 1"));
    assert!(matches!(
        core.question_reply(&asker, &wrong, acting).await,
        OwnerReply::Settled(_)
    ));
    assert_eq!(drive::recorded_answer(&notice.reference), None);
    // The inbox's answer is the request's result, and the inbox hears so.
    let right = reply("d-right", "agent-triage", &format!("Answer {reference}: 2"));
    assert!(matches!(
        core.question_reply(&asker, &right, acting).await,
        OwnerReply::Settled(_)
    ));
    assert_eq!(
        drive::recorded_answer(&notice.reference),
        Some(json!({"answers": {"db": {"answers": ["SQLite"]}}}))
    );
    // A second answer finds it answered; a message that is no answer is
    // not one.
    let late = reply("d-late", "agent-triage", &format!("answer {reference} 1"));
    assert!(matches!(
        core.question_reply(&asker, &late, acting).await,
        OwnerReply::Settled(_)
    ));
    let chat = reply("d-chat", "agent-triage", "thanks");
    assert!(matches!(
        core.question_reply(&asker, &chat, acting).await,
        OwnerReply::NotOne
    ));
    let replies: Vec<String> = hits
        .lock()
        .unwrap()
        .iter()
        .filter(|hit| hit.contains("key=question-reply-"))
        .cloned()
        .collect();
    assert_eq!(replies.len(), 3, "{replies:?}");
    // The refusal goes to the sender's address and does not name the inbox.
    assert!(
        replies[0].contains("Only the agent question")
            && replies[0].contains("\"address\":\"mallory@desk\"")
            && !replies[0].contains("triage"),
        "{}",
        replies[0]
    );
    assert!(replies[1].contains("\"address\":\"triage@desk\""));
    assert!(replies[1].contains(&format!(
        "Answer to question {reference} delivered to @asker-codex."
    )));
    assert!(replies[2].contains("was already answered"));
}

/// Each record is sent under a key of its own; a send whose outcome is
/// unknown keeps its record unsent, not answerable, and the same question
/// asked again is sent under the same key, so Relaycast keeps one message.
#[tokio::test]
async fn a_send_that_timed_out_is_kept_and_sent_again_under_its_key() {
    let mode = Arc::new(std::sync::atomic::AtomicU8::new(HANG));
    let (base, hits) = relaycast_in(mode.clone());
    let asker = registration(
        "asker-timeout",
        Target::new(SessionKind::ClaudeTerminal, "sess-timeout"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    let question = input();
    let late = core
        .escalate_question_within(&asker, asked(&question), Duration::from_millis(500))
        .await;
    let response = late.response();
    assert_eq!(response["escalated"], false, "{response}");
    assert_eq!(
        response["reason"],
        "the question was not sent within 500ms; ask it here instead"
    );
    // Kept unsent: the hook lets the dialog through, and an answer to the
    // message that may have gone out is refused.
    assert_eq!(escalated("sess-timeout", &question), None);
    let (reference, state) = records()
        .iter()
        .find(|(_, record)| record.target.id == "sess-timeout")
        .map(|(reference, record)| (reference.clone(), record.state))
        .unwrap();
    assert_eq!(state, State::Unsent);
    mode.store(ACCEPT, std::sync::atomic::Ordering::SeqCst);
    let token = Secret::new("at_live_asker");
    let acting = (base.as_str(), &token);
    let answer = reply(
        "d-timeout",
        "agent-triage",
        &format!("answer {reference} 1"),
    );
    let OwnerReply::Settled(detail) = core.question_reply(&asker, &answer, acting).await else {
        panic!("a late answer is refused");
    };
    assert!(detail.contains("is not open"), "{detail}");
    // Asked again, it is sent again under the same reference and key.
    let again = core.escalate_question(&asker, asked(&question)).await;
    assert!(
        matches!(&again, Escalation::Sent { reference: sent, .. } if *sent == reference),
        "{again:?}"
    );
    let key = format!(
        "key=question-sess-timeout-{}-{reference}",
        input_hash(&question)
    );
    let dms: Vec<String> = hits
        .lock()
        .unwrap()
        .iter()
        .filter(|hit| hit.starts_with("POST /v1/dm") && hit.contains("[Question"))
        .cloned()
        .collect();
    assert_eq!(dms.len(), 2, "{dms:?}");
    assert!(dms.iter().all(|dm| dm.contains(&key)), "{dms:?}");
    assert!(escalated("sess-timeout", &question).is_some());
}

#[test]
fn only_a_send_that_may_have_arrived_is_kept() {
    use relaycast::RelayError;
    assert!(outcome_unknown(&RelayError::api("internal", "boom", 500)));
    assert!(outcome_unknown(&RelayError::api("timeout", "slow", 408)));
    assert!(outcome_unknown(&RelayError::InvalidResponse("cut".into())));
    assert!(!outcome_unknown(&RelayError::api("forbidden", "no", 403)));
    assert!(!outcome_unknown(&RelayError::api(
        "rate_limited",
        "later",
        429
    )));
    assert!(!outcome_unknown(&RelayError::NotConnected));
}

/// `answer q…` is an answer only while escalation is on and the session
/// has a record of that reference; otherwise it is an ordinary message.
#[tokio::test]
async fn an_answer_to_no_question_here_passes_through() {
    let (base, hits) = relaycast(false);
    let asker = registration(
        "asker-pass",
        Target::new(SessionKind::ClaudeTerminal, "sess-pass"),
        &base,
    );
    let (reference, _) = reserved(&asker, "question-sess-pass-1");
    let token = Secret::new("at_live_asker");
    let acting = (base.as_str(), &token);
    let answer = reply("d-pass", "agent-triage", &format!("answer {reference} 1"));
    // Off: even a question this session asked is not answered this way.
    let (off, _off_temp) = core(&base, &asker, false);
    assert!(matches!(
        off.question_reply(&asker, &answer, acting).await,
        OwnerReply::NotOne
    ));
    // On: a reference this session has no record of, or another session's.
    let (on, _on_temp) = core(&base, &asker, true);
    let unknown = reply("d-unknown", "agent-triage", "answer q00000000 1");
    assert!(matches!(
        on.question_reply(&asker, &unknown, acting).await,
        OwnerReply::NotOne
    ));
    let other = registration(
        "other-pass",
        Target::new(SessionKind::ClaudeTerminal, "sess-other-pass"),
        &base,
    );
    assert!(matches!(
        on.question_reply(&other, &answer, acting).await,
        OwnerReply::NotOne
    ));
    assert!(hits.lock().unwrap().is_empty(), "nobody is told anything");
}

/// While an answer is being delivered, a second answer waits and the
/// expiry timer leaves it to the delivery.
#[tokio::test]
async fn an_answer_being_delivered_is_not_delivered_twice() {
    let (base, _hits) = relaycast(false);
    let asker = registration(
        "asker-twice",
        Target::new(SessionKind::ClaudeTerminal, "sess-twice"),
        &base,
    );
    let (reference, _) = reserved(&asker, "question-sess-twice-1");
    assert!(check(&reference, &asker, Some("agent-triage"), "1").is_ok());
    assert_eq!(
        check(&reference, &asker, Some("agent-triage"), "2").unwrap_err(),
        Unchecked::Delivering
    );
    // A reply arriving meanwhile is not saved, so it is read again later.
    let (core, _temp) = core(&base, &asker, true);
    let token = Secret::new("at_live_asker");
    let second = reply("d-twice", "agent-triage", &format!("answer {reference} 2"));
    assert!(matches!(
        core.question_reply(&asker, &second, (base.as_str(), &token))
            .await,
        OwnerReply::Unsaved
    ));
    // Still asked: the hook refuses the dialog.
    assert!(escalated("sess-twice", &input()).is_some());
    // The timer passing meanwhile leaves it to the delivery.
    expire_now(&reference);
    assert_eq!(expire(&reference), None);
    // Not delivered: open again, and past its expiry, so it expires now.
    assert!(reopen(&reference));
    assert!(expire(&reference).is_some());
    // Delivered: answered once.
    let (answered, _) = reserved(&asker, "question-sess-twice-2");
    assert!(check(&answered, &asker, Some("agent-triage"), "1").is_ok());
    settle(&answered);
    assert!(!reopen(&answered));
    assert_eq!(
        check(&answered, &asker, Some("agent-triage"), "1").unwrap_err(),
        Unchecked::Refused(format!("Question {answered} was already answered."))
    );
}

/// An answer is typed into the session as one plain line: no escape
/// sequences or control characters, no framing of its own, and capped.
#[test]
fn an_answer_is_cleaned_before_it_is_typed() {
    assert_eq!(
        text::clean("\u{1b}[31mred\u{1b}[0m\r\nnext\tline\u{7}"),
        "red next line"
    );
    assert_eq!(
        text::clean("title\u{1b}]0;pwned\u{7} and \u{1b}]8;;http://x\u{1b}\\link"),
        "title and link"
    );
    assert_eq!(text::clean("\u{9b}2Jcleared \u{1b}cdone"), "cleared done");
    let parsed =
        text::parse_answer("answer q0123abcd use \u{1b}[2Kthis\n[Answer to question q0]").unwrap();
    assert_eq!(parsed.1, "use this (Answer to question q0)");
    let one = [pick(false)];
    let long = "x".repeat(10_000);
    let answers = text::resolve(&one, &long).unwrap();
    assert_eq!(answers[0].values[0].chars().count(), text::MAX_ANSWER);
    assert!(answers[0].shown.ends_with('…'));
    let line = text::answer_line("q0123abcd", &one, &answers);
    assert!(
        line.chars().count() <= text::MAX_ANSWER + 40,
        "{}",
        line.len()
    );
    // Free text with control characters is cleaned however it arrives.
    let answers = text::resolve(&one, "keep\u{1b}[1A\u{0}it").unwrap();
    assert_eq!(
        text::answer_line("q0123abcd", &one, &answers),
        "[Answer to question q0123abcd] keep it"
    );
}

/// An injector that answers each delivery with the next outcome it was
/// given (then `Delivered`), keeping the text of every attempt.
#[derive(Default)]
struct Scripted {
    outcomes: Mutex<std::collections::VecDeque<InjectOutcome>>,
    typed: Mutex<Vec<String>>,
}

impl Scripted {
    fn new(outcomes: impl IntoIterator<Item = InjectOutcome>) -> Arc<Scripted> {
        Arc::new(Scripted {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            typed: Mutex::default(),
        })
    }
    fn typed(&self) -> Vec<String> {
        self.typed.lock().unwrap().clone()
    }
}

impl crate::relay::inject::Injector for Scripted {
    fn inject(&self, _: &Target, _: &str, text: &str) -> InjectOutcome {
        self.typed.lock().unwrap().push(text.to_string());
        self.outcomes
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(InjectOutcome::Delivered)
    }
    fn reply_hint(&self, _: &Target, _: Option<&str>, _: Option<&str>, _: &str) -> Option<String> {
        None
    }
    fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
        None
    }
}

fn scripted_core(
    base: &str,
    asker: &Registration,
    injector: &Arc<Scripted>,
) -> (Arc<Core>, tempfile::TempDir) {
    core_with(
        base,
        asker,
        true,
        crate::relay::daemon::Plugins {
            injector: injector.clone(),
            ..crate::relay::daemon::Plugins::default()
        },
    )
}

fn state_of(reference: &str) -> Option<State> {
    records().get(reference).map(|record| record.state)
}

fn replies_to_inbox(hits: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
    hits.lock()
        .unwrap()
        .iter()
        .filter(|hit| hit.contains("key=question-reply-"))
        .cloned()
        .collect()
}

/// A Claude that is working, or waiting on a request, takes no input: the
/// answer is kept, not reported delivered, and typed once it is idle.
#[tokio::test]
async fn a_busy_claude_gets_the_answer_once_it_is_idle() {
    let (base, hits) = relaycast(false);
    let asker = registration(
        "asker-busy",
        Target::new(SessionKind::ClaudeTerminal, "sess-busy"),
        &base,
    );
    let (reference, _) = reserved(&asker, "question-sess-busy-1");
    let injector = Scripted::new([InjectOutcome::WaitingForTurn(
        "Claude is finishing its current turn".into(),
    )]);
    let (core, _temp) = scripted_core(&base, &asker, &injector);
    let token = Secret::new("at_live_asker");
    let acting = (base.as_str(), &token);
    let answer = reply("d-busy", "agent-triage", &format!("answer {reference} 1"));
    assert!(matches!(
        core.question_reply(&asker, &answer, acting).await,
        OwnerReply::Unsaved
    ));
    assert_eq!(state_of(&reference), Some(State::Open));
    assert!(
        replies_to_inbox(&hits).is_empty(),
        "nothing is reported yet"
    );
    assert!(!core.store.read(|store| store.was_injected("d-busy")));
    // Read again on the next pass, once Claude is idle: typed, and settled.
    let OwnerReply::Settled(detail) = core.question_reply(&asker, &answer, acting).await else {
        panic!("delivered on the next pass");
    };
    assert!(detail.ends_with("answered"), "{detail}");
    assert_eq!(state_of(&reference), Some(State::Answered));
    let typed = injector.typed();
    assert_eq!(typed.len(), 2, "{typed:?}");
    assert!(
        typed.iter().all(|line| line.contains("Postgres")),
        "{typed:?}"
    );
    let replies = replies_to_inbox(&hits);
    assert_eq!(replies.len(), 1, "{replies:?}");
    assert!(
        replies[0].contains("delivered to @asker-busy"),
        "{}",
        replies[0]
    );
}

/// An answer that may or may not have arrived is never typed again, and the
/// inbox is not told it was delivered.
#[tokio::test]
async fn an_answer_in_doubt_is_not_reported_delivered_or_typed_again() {
    let (base, hits) = relaycast(false);
    let asker = registration(
        "asker-doubt",
        Target::new(SessionKind::ClaudeTerminal, "sess-doubt"),
        &base,
    );
    let (reference, _) = reserved(&asker, "question-sess-doubt-1");
    let injector = Scripted::new([InjectOutcome::InDoubt("cut off".into())]);
    let (core, _temp) = scripted_core(&base, &asker, &injector);
    let token = Secret::new("at_live_asker");
    let acting = (base.as_str(), &token);
    let answer = reply("d-doubt", "agent-triage", &format!("answer {reference} 1"));
    assert!(matches!(
        core.question_reply(&asker, &answer, acting).await,
        OwnerReply::Settled(_)
    ));
    let replies = replies_to_inbox(&hits);
    assert_eq!(replies.len(), 1, "{replies:?}");
    assert!(
        replies[0].contains("may not have reached @asker-doubt")
            && !replies[0].contains("delivered to"),
        "{}",
        replies[0]
    );
    // A second answer is not typed.
    let again = reply(
        "d-doubt-2",
        "agent-triage",
        &format!("answer {reference} 2"),
    );
    assert!(matches!(
        core.question_reply(&asker, &again, acting).await,
        OwnerReply::Settled(_)
    ));
    assert_eq!(injector.typed().len(), 1);
}

/// Two hook calls for the same question at once send it once, and a send
/// finishing late never opens a question that was answered meanwhile.
#[tokio::test]
async fn the_same_question_asked_twice_at_once_is_sent_once() {
    let mode = Arc::new(std::sync::atomic::AtomicU8::new(SLOW));
    let (base, hits) = relaycast_in(mode);
    let asker = registration(
        "asker-race",
        Target::new(SessionKind::ClaudeTerminal, "sess-race"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    let question = input();
    let (first, second) = tokio::join!(
        core.escalate_question(&asker, asked(&question)),
        core.escalate_question(&asker, asked(&question)),
    );
    let Escalation::Sent { reference, .. } = &first else {
        panic!("{first:?}");
    };
    assert_eq!(first, second);
    let dms = hits
        .lock()
        .unwrap()
        .iter()
        .filter(|hit| hit.starts_with("POST /v1/dm"))
        .count();
    assert_eq!(dms, 1, "one message for one question");
    // A late `opened` (a send that finished after the answer) does nothing.
    assert!(check(reference, &asker, Some("agent-triage"), "1").is_ok());
    settle(reference);
    opened(reference);
    assert_eq!(state_of(reference), Some(State::Answered));
}

/// A record kept unsent is sent by one caller at a time.
#[test]
fn an_unsent_record_is_sent_by_one_caller_at_a_time() {
    let asker = registration(
        "asker-inflight",
        Target::new(SessionKind::ClaudeTerminal, "sess-inflight"),
        "https://cast.test",
    );
    let Some(Reserved::Send { reference, .. }) =
        reserve(record(&asker, "question-sess-inflight-1"))
    else {
        panic!("reserved");
    };
    assert!(
        !matches!(
            reserve(record(&asker, "question-sess-inflight-1")),
            Some(Reserved::Send { .. })
        ),
        "a second caller does not send {reference} while it is being sent"
    );
}

/// The same Claude session removed and added again is another agent: its
/// question is sent again for it, not suppressed by the old agent's.
#[tokio::test]
async fn a_session_added_again_asks_as_its_new_agent() {
    let (base, hits) = relaycast(false);
    let target = Target::new(SessionKind::ClaudeTerminal, "sess-readded");
    let old = registration("asker-readded", target.clone(), &base);
    let question = input();
    let base_key = format!("question-sess-readded-{}", input_hash(&question));
    let (old_reference, _) = reserved(&old, &base_key);
    let mut new = old.clone();
    new.agent_id = "agent-asker-readded-2".into();
    let (core, _temp) = core(&base, &new, true);
    let escalation = core.escalate_question(&new, asked(&question)).await;
    let Escalation::Sent { reference, .. } = escalation else {
        panic!("{escalation:?}");
    };
    assert_ne!(reference, old_reference);
    assert!(known(&reference, &new));
    assert_eq!(
        hits.lock()
            .unwrap()
            .iter()
            .filter(|hit| hit.starts_with("POST /v1/dm"))
            .count(),
        1
    );
    // The old agent's question no longer stands for the session.
    let reason = escalated("sess-readded", &question).unwrap();
    assert!(reason.contains(&reference), "{reason}");
}

/// A Codex answer whose record could not be saved is still the request's
/// result: the redelivery finds it handled, and Codex has its answer.
#[tokio::test]
async fn a_codex_answer_survives_a_failed_save() {
    let (base, hits) = relaycast(false);
    let thread = "019a0000-0000-7000-8000-00000000c0df";
    let asker = registration(
        "asker-codex-save",
        Target::new(SessionKind::Codex, thread),
        &base,
    );
    let (core, temp) = core(&base, &asker, true);
    let notice = drive::open_request(
        thread,
        json!({"id": 8, "method": "item/tool/requestUserInput", "params": {
            "threadId": thread, "turnId": "t", "itemId": "i",
            "questions": [{"id": "db", "header": "Database", "question": "Which?",
                "options": [{"label": "Postgres", "description": ""},
                            {"label": "SQLite", "description": ""}]}],
        }}),
    );
    assert!(core.escalate_codex_question(&asker, &notice).await);
    let reference = records()
        .iter()
        .find(|(_, record)| record.target.id == thread)
        .map(|(reference, _)| reference.clone())
        .unwrap();
    // The store can no longer be saved.
    let store = temp
        .path()
        .join("app-data")
        .join(crate::relay::app_store::STORE_FILE);
    std::fs::write(&store, b"not a store").unwrap();
    let token = Secret::new("at_live_asker");
    let acting = (base.as_str(), &token);
    let answer = reply(
        "d-codex-save",
        "agent-triage",
        &format!("answer {reference} 2"),
    );
    let _ = core.question_reply(&asker, &answer, acting).await;
    // Redelivered while the store still cannot be saved: never acknowledged
    // without Codex having the answer.
    let _ = core.question_reply(&asker, &answer, acting).await;
    assert_eq!(
        drive::recorded_answer(&notice.reference),
        Some(json!({"answers": {"db": {"answers": ["SQLite"]}}}))
    );
    assert_eq!(state_of(&reference), Some(State::Answered));
    let replies = replies_to_inbox(&hits);
    assert!(
        replies
            .iter()
            .all(|reply| !reply.contains("already answered")),
        "{replies:?}"
    );
}

/// A late reply that closes an expired question first still leaves the
/// session its expiry notice, given once.
#[test]
fn an_expiry_closed_by_a_late_reply_still_tells_the_session() {
    let asker = registration(
        "asker-late",
        Target::new(SessionKind::ClaudeTerminal, "sess-late"),
        "https://cast.test",
    );
    let (reference, _) = reserved(&asker, "question-sess-late-1");
    expire_now(&reference);
    assert!(check(&reference, &asker, Some("agent-triage"), "1").is_err());
    assert!(expire(&reference).is_some(), "the timer still tells Claude");
    assert_eq!(expire(&reference), None, "once");
}

/// Signed in as the person `owner` (`agent-owner`), whose identity is in the
/// Relaycast at `base`.
struct Owner(String);

impl crate::relay::cloud_session::CloudAccess for Owner {
    fn account(&self) -> Option<crate::relay::cloud_session::CloudAccount> {
        Some(crate::relay::cloud_session::CloudAccount {
            site_url: "https://agentrelay.example".into(),
            workspace_id: "cloud-workspace".into(),
            user_id: Some("user-owner".into()),
        })
    }
    fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
        None
    }
    fn request(
        &self,
        _: &'static str,
        path: String,
        _: Option<Value>,
    ) -> futures_util::future::BoxFuture<'_, Result<Value, crate::relay::cloud_session::CloudError>>
    {
        let base = self.0.clone();
        Box::pin(async move {
            Ok(if path.ends_with("/messaging/identity/credential") {
                json!({"identity": {"name": "owner", "agentId": "agent-owner",
                    "token": "at_live_owner", "relaycastUrl": base}})
            } else {
                Value::Null
            })
        })
    }
}

/// With no inbox set, the question goes to the owner's person identity only
/// when the asking agent's workspace holds that identity: the name alone,
/// on the same Relaycast origin, may be another workspace's agent.
#[tokio::test]
async fn the_owner_is_the_inbox_only_in_its_own_workspace() {
    for (found, sent) in [("agent-impostor", false), ("agent-owner", true)] {
        let mode = Arc::new(std::sync::atomic::AtomicU8::new(ACCEPT));
        let (base, hits) = relaycast_with(mode, &[("owner", found)]);
        let session = format!("sess-owner-{sent}");
        let asker = registration(
            &format!("asker-owner-{sent}"),
            Target::new(SessionKind::ClaudeTerminal, &session),
            &base,
        );
        let (core, _temp) = core_with(
            &base,
            &asker,
            true,
            crate::relay::daemon::Plugins {
                cloud: Arc::new(Owner(base.clone())),
                ..crate::relay::daemon::Plugins::default()
            },
        );
        core.store
            .remember(|store| store.extras.question_escalation_inbox = None)
            .unwrap();
        let escalation = core.escalate_question(&asker, asked(&input())).await;
        let dms: Vec<String> = hits
            .lock()
            .unwrap()
            .iter()
            .filter(|hit| hit.starts_with("POST /v1/dm"))
            .cloned()
            .collect();
        if sent {
            assert!(
                matches!(&escalation, Escalation::Sent { inbox, .. } if inbox == "owner"),
                "{escalation:?}"
            );
            assert_eq!(dms.len(), 1, "{dms:?}");
        } else {
            assert!(
                matches!(&escalation, Escalation::Failed(why) if why.contains("another Relaycast workspace")),
                "{escalation:?}"
            );
            assert!(dms.is_empty(), "nothing reaches @owner there: {dms:?}");
        }
    }
}

/// An agent registered through relaygate keeps no workspace key: the named
/// inbox is found with the agent's own credential, in its own workspace.
#[tokio::test]
async fn a_gate_agent_asks_the_named_inbox() {
    let (base, hits) = relaycast(false);
    let mut asker = registration(
        "asker-gate",
        Target::new(SessionKind::ClaudeTerminal, "sess-gate"),
        &base,
    );
    asker.workspace_key = None;
    let (core, _temp) = core(&base, &asker, true);
    // Without a key, the agent is not taken to be in a keyed workspace.
    assert_eq!(
        core.escalate_question(&asker, asked(&input())).await,
        Escalation::Failed(
            "the asking agent is in a different workspace from the question inbox".into()
        )
    );
    // The daemon's workspace is the gate's: the inbox is found and asked.
    core.workspace.lock().unwrap().as_mut().unwrap().gate_url = Some(base.clone());
    let escalation = core.escalate_question(&asker, asked(&input())).await;
    assert!(
        matches!(&escalation, Escalation::Sent { inbox, .. } if inbox == "triage"),
        "{escalation:?}"
    );
    let lookups: Vec<String> = hits
        .lock()
        .unwrap()
        .iter()
        .filter(|hit| hit.starts_with("GET /v1/agents/triage"))
        .cloned()
        .collect();
    assert_eq!(lookups.len(), 1, "{lookups:?}");
}

/// Escalation is on unless turned off: a store that never set it sends the
/// question to the inbox, and only an explicit off asks it in the session.
#[tokio::test]
async fn unset_escalation_is_on() {
    let (base, hits) = relaycast(false);
    let asker = registration(
        "asker-unset",
        Target::new(SessionKind::ClaudeTerminal, "sess-unset"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    core.store
        .remember(|store| store.extras.question_escalation = None)
        .unwrap();
    assert!(core.store.read(settings::on));
    let question = input();
    let escalation = core.escalate_question(&asker, asked(&question)).await;
    assert!(
        matches!(&escalation, Escalation::Sent { inbox, .. } if inbox == "triage"),
        "{escalation:?}"
    );
    assert!(escalated("sess-unset", &question).is_some());
    let dms = hits
        .lock()
        .unwrap()
        .iter()
        .filter(|hit| hit.starts_with("POST /v1/dm"))
        .count();
    assert_eq!(dms, 1);
}

/// What the question hook prints for `response`, served as the route
/// serves it: `{"ok":true,"data":…}` with 200.
fn hook_prints(escalation: &Escalation) -> Value {
    let body = json!({"ok": true, "data": escalation.response()});
    crate::relay::claude::session_hook::question_hook_output(200, body.to_string().as_bytes())
}

/// With escalation on by default, a question that is not delivered is
/// asked in the session exactly as with escalation off: the route answers
/// `escalated: false`, the hook prints `{}`, nothing is left open for the
/// spawned Claude's `can_use_tool` to refuse, and a Codex request is
/// forwarded as any other.
#[tokio::test]
async fn an_undelivered_question_is_asked_in_the_session() {
    let mode = Arc::new(std::sync::atomic::AtomicU8::new(ACCEPT));
    let (base, hits) = relaycast_in(mode.clone());
    let asker = registration(
        "asker-undelivered",
        Target::new(SessionKind::ClaudeTerminal, "sess-undelivered"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    core.store
        .remember(|store| store.extras.question_escalation = None)
        .unwrap();
    let question = input();
    let dms = || {
        hits.lock()
            .unwrap()
            .iter()
            .filter(|hit| hit.starts_with("POST /v1/dm"))
            .count()
    };
    // Explicitly off: the baseline every other case must match.
    let mut off_store = core.store.read(Clone::clone);
    off_store.extras.question_escalation = Some(false);
    assert!(!settings::on(&off_store));
    assert_eq!(hook_prints(&Escalation::Off), json!({}));

    // 1. No questions in the input.
    let empty = json!({"questions": []});
    let none = core
        .escalate_question(
            &asker,
            Asked {
                questions: Vec::new(),
                input: &empty,
                cwd: "",
                via: Via::Session,
            },
        )
        .await;
    assert_eq!(none, Escalation::Off);
    assert_eq!(hook_prints(&none), json!({}));

    // 2. The agent is not registered (no credential).
    let stranger = registration(
        "stranger-undelivered",
        Target::new(SessionKind::ClaudeTerminal, "sess-stranger-undelivered"),
        &base,
    );
    let unregistered = core.escalate_question(&stranger, asked(&question)).await;
    assert!(
        matches!(&unregistered, Escalation::Failed(why) if why.contains("is not registered")),
        "{unregistered:?}"
    );
    assert_eq!(hook_prints(&unregistered), json!({}));

    // 3. No workspace connected (signed out) for a named inbox, and no
    // signed-in account for the owner's inbox.
    let workspace = core.workspace.lock().unwrap().take();
    let signed_out = core.escalate_question(&asker, asked(&question)).await;
    assert_eq!(
        signed_out,
        Escalation::Failed("no workspace is connected".into())
    );
    assert_eq!(hook_prints(&signed_out), json!({}));
    core.store
        .remember(|store| store.extras.question_escalation_inbox = None)
        .unwrap();
    let no_owner = core.escalate_question(&asker, asked(&question)).await;
    assert!(
        matches!(&no_owner, Escalation::Failed(why) if why.starts_with("the owner's identity is unavailable")),
        "{no_owner:?}"
    );
    assert_eq!(hook_prints(&no_owner), json!({}));
    *core.workspace.lock().unwrap() = workspace;

    // 4. The inbox cannot be resolved.
    core.store
        .remember(|store| store.extras.question_escalation_inbox = Some("nobody".into()))
        .unwrap();
    let unresolved = core.escalate_question(&asker, asked(&question)).await;
    assert_eq!(
        unresolved,
        Escalation::Failed("no agent is named @nobody".into())
    );
    assert_eq!(hook_prints(&unresolved), json!({}));
    core.store
        .remember(|store| store.extras.question_escalation_inbox = Some("triage".into()))
        .unwrap();
    assert_eq!(dms(), 0, "nothing was sent so far");

    // 5. The send is refused.
    mode.store(REFUSE, std::sync::atomic::Ordering::SeqCst);
    let refused = core.escalate_question(&asker, asked(&question)).await;
    assert!(
        matches!(&refused, Escalation::Failed(why) if why.starts_with("the question was not sent to @triage")),
        "{refused:?}"
    );
    assert_eq!(hook_prints(&refused), json!({}));

    // 6. The send's outcome is unknown (a server error).
    mode.store(BROKEN, std::sync::atomic::Ordering::SeqCst);
    let unknown = core.escalate_question(&asker, asked(&question)).await;
    assert!(
        matches!(&unknown, Escalation::Failed(why) if why.starts_with("the question may not have reached @triage")),
        "{unknown:?}"
    );
    assert_eq!(hook_prints(&unknown), json!({}));

    // 7. The time limit passes.
    mode.store(HANG, std::sync::atomic::Ordering::SeqCst);
    let late = core
        .escalate_question_within(&asker, asked(&question), Duration::from_millis(300))
        .await;
    assert!(matches!(late, Escalation::TimedOut(_)), "{late:?}");
    assert_eq!(hook_prints(&late), json!({}));

    // None of them left the question open: a spawned Claude's
    // `can_use_tool` for it is forwarded, not refused.
    assert_eq!(escalated("sess-undelivered", &question), None);
}

/// A spawned Codex's question that is not sent within the limit is
/// forwarded as any other request, as with escalation off; one sent is not.
#[tokio::test]
async fn a_codex_question_not_sent_in_time_is_forwarded() {
    let mode = Arc::new(std::sync::atomic::AtomicU8::new(HANG));
    let (base, _hits) = relaycast_in(mode.clone());
    let thread = "019a0000-0000-7000-8000-0000000071e0";
    let asker = registration(
        "asker-codex-late",
        Target::new(SessionKind::Codex, thread),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    core.store
        .remember(|store| store.extras.question_escalation = None)
        .unwrap();
    let notice = drive::open_request(
        thread,
        json!({"id": 9, "method": "item/tool/requestUserInput", "params": {
            "threadId": thread, "turnId": "t", "itemId": "i",
            "questions": [{"id": "db", "header": "Database", "question": "Which?",
                "options": [{"label": "Postgres", "description": ""}]}],
        }}),
    );
    let started = Instant::now();
    assert!(
        !core
            .escalate_codex_question_within(&asker, &notice, Duration::from_millis(300))
            .await
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "held past the limit"
    );
    // Still waiting to be forwarded, as with escalation off.
    let waiting: Vec<String> = drive::unforwarded(thread)
        .into_iter()
        .map(|notice| notice.reference)
        .collect();
    assert_eq!(waiting, vec![notice.reference.clone()]);
    // A refused send, an unknown outcome and an explicit off forward it too.
    for failing in [REFUSE, BROKEN] {
        mode.store(failing, std::sync::atomic::Ordering::SeqCst);
        assert!(!core.escalate_codex_question(&asker, &notice).await);
        assert_eq!(drive::unforwarded(thread).len(), 1);
    }
    core.store
        .remember(|store| store.extras.question_escalation = Some(false))
        .unwrap();
    assert!(!core.escalate_codex_question(&asker, &notice).await);
    assert_eq!(drive::unforwarded(thread).len(), 1);
    assert!(CODEX_LIMIT < Duration::from_secs(300));
}

/// The question hook's input as Codex 0.154 gives it
/// (`fixtures/questions/codex-0.154-pre-tool-use-request-user-input.json`).
fn codex_hook_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../fixtures/questions/codex-0.154-pre-tool-use-request-user-input.json"
    ))
    .unwrap()
}

/// The `requestUserInput` a spawned Codex raises for the fixture's question
/// when its tool runs (`app-server-protocol` v2 `ToolRequestUserInputParams`).
fn codex_request_for(thread: &str, id: u64) -> Value {
    json!({"id": id, "method": "item/tool/requestUserInput", "params": {
        "threadId": thread, "turnId": "t", "itemId": "call_question_1",
        "questions": [{"id": "database", "header": "Database",
            "question": "Which database should the service use?",
            "isOther": true, "isSecret": false,
            "options": [{"label": "Postgres", "description": "Shared server"},
                        {"label": "SQLite", "description": "One file"}]}],
    }})
}

/// How many questions were sent: DMs by idempotency key, since the SDK
/// retries a server error under the same key.
fn dm_count(hits: &Arc<Mutex<Vec<String>>>) -> usize {
    hits.lock()
        .unwrap()
        .iter()
        .filter(|hit| hit.starts_with("POST /v1/dm"))
        .filter_map(|hit| {
            hit.split(" key=")
                .nth(1)?
                .split(' ')
                .next()
                .map(str::to_string)
        })
        .collect::<std::collections::BTreeSet<_>>()
        .len()
}

/// Codex's question hook, with escalation on by default: the question goes
/// to the inbox once, the tool call is refused with the reason, and the
/// inbox's answer is typed into the session.
#[tokio::test]
async fn a_codex_hook_question_goes_to_the_inbox() {
    let (base, hits) = relaycast(false);
    let fixture = codex_hook_fixture();
    let thread = fixture["input"]["session_id"].as_str().unwrap();
    let asker = registration(
        "asker-codex-hook",
        Target::new(SessionKind::Codex, thread),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    core.store
        .remember(|store| store.extras.question_escalation = None)
        .unwrap();
    let input = &fixture["input"]["tool_input"];
    let reason = core
        .escalate_codex_hook_question(&asker, input, "/work/project")
        .await
        .expect("sent");
    assert!(
        reason.starts_with("Sent to @triage over Agent Relay as question q"),
        "{reason}"
    );
    assert_eq!(dm_count(&hits), 1);
    let sent = hits
        .lock()
        .unwrap()
        .iter()
        .find(|hit| hit.starts_with("POST /v1/dm"))
        .cloned()
        .unwrap();
    assert!(
        sent.contains("Which database should the service use?"),
        "{sent}"
    );
    // Asked again by the same turn: the open question, not a second DM.
    let again = core
        .escalate_codex_hook_question(&asker, input, "/work/project")
        .await;
    assert_eq!(again.as_deref(), Some(reason.as_str()));
    assert_eq!(dm_count(&hits), 1);
    let (reference, via) = records()
        .iter()
        .find(|(_, record)| record.target.id == thread)
        .map(|(reference, record)| (reference.clone(), record.via.clone()))
        .unwrap();
    assert_eq!(via, Via::Session, "the answer is typed into the session");
    assert!(reason.contains(&reference));
    // Codex lets the person type their own answer: free text is taken.
    let questions = text::codex_tool_questions(input).unwrap();
    assert!(questions.iter().all(|question| question.free));
}

/// A question the hook cannot send is asked as usual: the hook answers no
/// reason (Codex runs the tool and shows its dialog), and a spawned Codex's
/// `requestUserInput` that follows goes to the session's owner as any other
/// request, without a second inbox attempt or wait. Off, nothing is sent.
#[tokio::test]
async fn a_codex_hook_question_that_cannot_be_sent_is_asked_once_as_usual() {
    let mode = Arc::new(std::sync::atomic::AtomicU8::new(REFUSE));
    let (base, hits) = relaycast_in(mode.clone());
    let fixture = codex_hook_fixture();
    let input = fixture["input"]["tool_input"].clone();
    for (n, failing) in [REFUSE, BROKEN, HANG].into_iter().enumerate() {
        mode.store(failing, std::sync::atomic::Ordering::SeqCst);
        let thread = format!("019a0000-0000-7000-8000-0000000071{n:02}");
        let asker = registration(
            &format!("asker-codex-hook-{n}"),
            Target::new(SessionKind::Codex, &thread),
            &base,
        );
        let (core, _temp) = core(&base, &asker, true);
        let before = dm_count(&hits);
        let reason = core
            .escalate_codex_hook_question_within(&asker, &input, "", Duration::from_millis(300))
            .await;
        assert_eq!(reason, None, "mode {failing}");
        let attempted = dm_count(&hits);
        assert!(attempted <= before + 1, "one attempt");
        // The tool runs: a spawned Codex raises requestUserInput, which is
        // forwarded, not escalated again.
        let notice = drive::open_request(&thread, codex_request_for(&thread, 40 + n as u64));
        assert!(!core.escalate_codex_question(&asker, &notice).await);
        assert_eq!(dm_count(&hits), attempted, "no second inbox attempt");
        assert_eq!(drive::unforwarded(&thread).len(), 1, "forwarded as usual");
        assert_eq!(
            escalated(&thread, &input),
            None,
            "nothing is left open for the question"
        );
    }
    // Off: the hook answers nothing and sends nothing.
    mode.store(ACCEPT, std::sync::atomic::Ordering::SeqCst);
    let asker = registration(
        "asker-codex-hook-off",
        Target::new(SessionKind::Codex, "019a0000-0000-7000-8000-00000000710f"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, false);
    let before = dm_count(&hits);
    assert_eq!(
        core.escalate_codex_hook_question(&asker, &input, "").await,
        None
    );
    assert_eq!(dm_count(&hits), before);
}

/// Input that is not `request_user_input`'s, or that names no question,
/// is never escalated: Codex shows whatever it is as usual.
#[tokio::test]
async fn a_codex_hook_input_that_does_not_parse_is_asked_as_usual() {
    let (base, hits) = relaycast(false);
    let asker = registration(
        "asker-codex-hook-bad",
        Target::new(SessionKind::Codex, "019a0000-0000-7000-8000-0000000071bb"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    for bad in [
        json!({}),
        json!({"questions": []}),
        json!({"questions": "Which?"}),
        json!({"questions": [{"question": "No id"}]}),
        json!({"command": "ls"}),
    ] {
        assert_eq!(
            core.escalate_codex_hook_question(&asker, &bad, "").await,
            None,
            "{bad}"
        );
    }
    // A session that is not on the relay is not asked for either.
    let stranger = registration(
        "stranger-codex-hook",
        Target::new(SessionKind::Codex, "019a0000-0000-7000-8000-0000000071cc"),
        &base,
    );
    let input = codex_hook_fixture()["input"]["tool_input"].clone();
    assert_eq!(
        core.escalate_codex_hook_question(&stranger, &input, "")
            .await,
        None
    );
    assert_eq!(dm_count(&hits), 0);
}

/// A spawner whose agents still run.
struct Running;

impl crate::relay::spawn::launch::Spawner for Running {
    fn available(&self) -> Vec<crate::relay::harness::HarnessId> {
        Vec::new()
    }
    fn launch(
        &self,
        _: &crate::relay::spawn::launch::Launch,
        _: crate::relay::spawn::launch::Started,
    ) -> Result<crate::relay::spawn::launch::Launched, crate::relay::spawn::launch::LaunchError>
    {
        Err(crate::relay::spawn::launch::LaunchError::Unavailable(
            "a test spawner".into(),
        ))
    }
    fn alive(&self, _: &Target, _: Option<&crate::relay::spawn::launch::SpawnedProcess>) -> bool {
        true
    }
    fn stop(&self, _: &Target, _: Option<&crate::relay::spawn::launch::SpawnedProcess>) {}
}

/// `name` spawned here with a process of its own, as a spawned Devin or
/// Claude has.
fn spawned_with_process(name: &str, target: Target, base: &str) -> Registration {
    let mut registration = registration(name, target, base);
    registration.spawn = Some(
        serde_json::from_value(json!({"nodeID": "node-1", "nodeName": "desk",
            "invocationID": format!("inv-{name}"), "harness": "devin",
            "process": {"pid": 4242, "start": 7}}))
        .unwrap(),
    );
    registration
}

/// A spawned agent whose process ended is not told its question expired,
/// whatever its harness, and the inbox's late answer is refused with the
/// question closed; one whose process runs is told.
#[tokio::test]
async fn an_ended_spawned_agent_is_not_told_and_its_late_answer_is_refused() {
    let (base, hits) = relaycast(false);
    let ended = spawned_with_process(
        "asker-ended",
        Target::new(SessionKind::Devin, "spawned-ended"),
        &base,
    );
    let injector = Scripted::new([]);
    // The default spawner answers that nothing it started still runs.
    let (core, _temp) = scripted_core(&base, &ended, &injector);
    let input = input();
    let Escalation::Sent { reference, .. } = core.escalate_question(&ended, asked(&input)).await
    else {
        panic!("sent");
    };
    assert!(core.tell_expired(&ended.target, &reference).await);
    assert!(injector.typed().is_empty(), "an ended agent is not told");
    let token = Secret::new("at_live_asker");
    let answer = reply("d-ended", "agent-triage", &format!("answer {reference} 1"));
    let OwnerReply::Settled(detail) = core
        .question_reply(&ended, &answer, (base.as_str(), &token))
        .await
    else {
        panic!("refused");
    };
    assert!(detail.contains("is closed"), "{detail}");
    assert!(injector.typed().is_empty(), "nothing is typed into it");
    assert_eq!(state_of(&reference), Some(State::Expired));
    assert!(replies_to_inbox(&hits)
        .iter()
        .any(|reply| reply.contains("has ended")));

    let running = spawned_with_process(
        "asker-running",
        Target::new(SessionKind::Devin, "spawned-running"),
        &base,
    );
    let typed = Scripted::new([]);
    let (core, _temp) = core_with(
        &base,
        &running,
        true,
        crate::relay::daemon::Plugins {
            injector: typed.clone(),
            spawner: Arc::new(Running),
            ..crate::relay::daemon::Plugins::default()
        },
    );
    let Escalation::Sent { reference, .. } = core.escalate_question(&running, asked(&input)).await
    else {
        panic!("sent");
    };
    assert!(core.tell_expired(&running.target, &reference).await);
    assert_eq!(typed.typed().len(), 1, "a running agent is told");
}

/// Cases 3 and 4 with a Codex target, through the hook's own entry:
/// signed out (no workspace for a named inbox, no account for the owner's)
/// and an inbox that cannot be found each answer no reason, so Codex shows
/// the question.
#[tokio::test]
async fn a_codex_hook_question_is_asked_as_usual_when_signed_out_or_unresolved() {
    let (base, hits) = relaycast(false);
    let input = codex_hook_fixture()["input"]["tool_input"].clone();
    let asker = registration(
        "asker-codex-hook-34",
        Target::new(SessionKind::Codex, "019a0000-0000-7000-8000-0000000071ee"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    let workspace = core.workspace.lock().unwrap().take();
    assert_eq!(
        core.escalate_codex_hook_question(&asker, &input, "").await,
        None
    );
    core.store
        .remember(|store| store.extras.question_escalation_inbox = None)
        .unwrap();
    assert_eq!(
        core.escalate_codex_hook_question(&asker, &input, "").await,
        None
    );
    *core.workspace.lock().unwrap() = workspace;
    core.store
        .remember(|store| store.extras.question_escalation_inbox = Some("nobody".into()))
        .unwrap();
    assert_eq!(
        core.escalate_codex_hook_question(&asker, &input, "").await,
        None
    );
    assert_eq!(dm_count(&hits), 0);
}

/// Devin's question hook, through the route's shared path: the question in
/// Devin's shape goes to the inbox once, and its answer is typed into the
/// session; refused, it is asked in Devin as usual.
#[tokio::test]
async fn a_devin_question_goes_to_the_inbox() {
    let mode = Arc::new(std::sync::atomic::AtomicU8::new(ACCEPT));
    let (base, hits) = relaycast_in(mode.clone());
    let fixture: Value = serde_json::from_str(include_str!(
        "../fixtures/questions/devin-3000.12.57-pre-tool-use-ask-user-question.json"
    ))
    .unwrap();
    let input = fixture["input"]["tool_input"].clone();
    let asker = registration(
        "asker-devin",
        Target::new(SessionKind::Devin, "real-gallium"),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    let devin = |input: &Value| Asked {
        questions: text::hook_questions(input),
        input: &fixture["input"]["tool_input"],
        cwd: "",
        via: Via::Session,
    };
    let sent = core.escalate_question(&asker, devin(&input)).await;
    assert!(
        matches!(&sent, Escalation::Sent { inbox, .. } if inbox == "triage"),
        "{sent:?}"
    );
    assert_eq!(dm_count(&hits), 1);
    let dm = hits
        .lock()
        .unwrap()
        .iter()
        .find(|hit| hit.starts_with("POST /v1/dm"))
        .cloned()
        .unwrap();
    assert!(dm.contains("Which auth method should the API use?"), "{dm}");
    // Another session's question, refused by Relaycast: no reason, so
    // Devin's hook prints nothing and Devin shows it.
    mode.store(REFUSE, std::sync::atomic::Ordering::SeqCst);
    let other = registration(
        "asker-devin-2",
        Target::new(SessionKind::Devin, "real-argon"),
        &base,
    );
    let (second, _second_temp) = self::core(&base, &other, true);
    let refused = second.escalate_question(&other, devin(&input)).await;
    let body = json!({"ok": true, "data": refused.response()});
    assert_eq!(
        crate::relay::devin::question_hook_output(200, body.to_string().as_bytes()),
        None
    );
}

/// Copilot's `ask_user` (`fixtures/questions/copilot-1.0.94-...`): sent once
/// to the inbox with its choices; refused, or of another shape, Copilot
/// asks as usual.
#[tokio::test]
async fn a_copilot_question_goes_to_the_inbox() {
    let mode = Arc::new(std::sync::atomic::AtomicU8::new(ACCEPT));
    let (base, hits) = relaycast_in(mode.clone());
    let fixture: Value = serde_json::from_str(include_str!(
        "../fixtures/questions/copilot-1.0.94-pre-tool-use-ask-user.json"
    ))
    .unwrap();
    let args = fixture["input"]["toolArgs"].clone();
    let sid = fixture["input"]["sessionId"].as_str().unwrap();
    let asker = registration(
        "asker-copilot",
        Target::new(SessionKind::Copilot, sid),
        &base,
    );
    let (core, _temp) = core(&base, &asker, true);
    let reason = core
        .escalate_copilot_question(&asker, &args, "")
        .await
        .expect("sent");
    assert!(reason.starts_with("Sent to @triage"), "{reason}");
    assert_eq!(dm_count(&hits), 1);
    let dm = hits
        .lock()
        .unwrap()
        .iter()
        .find(|hit| hit.starts_with("POST /v1/dm"))
        .cloned()
        .unwrap();
    assert!(dm.contains("After the deploy"), "{dm}");
    for bad in [
        json!({}),
        json!({"question": ""}),
        json!({"question": "Which?", "choices": [1]}),
        json!({"question": "Which?", "choices": "A"}),
        json!({"question": "Which?", "allowFreeform": "yes"}),
        json!({"message": "Which?"}),
    ] {
        assert_eq!(
            core.escalate_copilot_question(&asker, &bad, "").await,
            None,
            "{bad}"
        );
    }
    assert_eq!(dm_count(&hits), 1);
    mode.store(REFUSE, std::sync::atomic::Ordering::SeqCst);
    let other = registration(
        "asker-copilot-2",
        Target::new(SessionKind::Copilot, "019a0000-0000-7000-8000-00000000c012"),
        &base,
    );
    let (second, _second_temp) = self::core(&base, &other, true);
    assert_eq!(
        second
            .escalate_copilot_question_within(&other, &args, "", Duration::from_millis(300))
            .await,
        None
    );
    let questions = text::copilot_questions(&args).unwrap();
    assert_eq!(questions[0].options.len(), 2);
    assert!(questions[0].free);
}

/// A hook's question in the shared shape.
fn hook_asked(input: &Value) -> Asked<'_> {
    Asked {
        questions: text::hook_questions(input),
        input,
        cwd: "",
        via: Via::Session,
    }
}

/// The Devin hooks' setting, turned off since the hook was installed.
struct DevinHooksOff;

impl crate::relay::agents::SettingsExtension for DevinHooksOff {
    fn get(&self) -> Map<String, Value> {
        Map::from_iter([(crate::relay::devin::SETTING.to_string(), json!(false))])
    }
    fn set(&self, _: &str, _: &Value) -> Option<Result<(), String>> {
        None
    }
}

/// A question whose answer could never reach its session is not sent: a
/// Devin session whose hooks were turned off, an already-open Grok session
/// Grok no longer lists. It is asked in the session as usual.
#[tokio::test]
async fn a_question_whose_answer_cannot_reach_the_session_is_asked_as_usual() {
    let (base, hits) = relaycast(false);
    let input = json!({"questions": [{"question": "Which?", "options": ["A", "B"]}]});
    let devin = registration(
        "asker-devin-off",
        Target::new(SessionKind::Devin, "real-off"),
        &base,
    );
    let (core, _temp) = core_with(
        &base,
        &devin,
        true,
        crate::relay::daemon::Plugins {
            settings: vec![Arc::new(DevinHooksOff)],
            ..crate::relay::daemon::Plugins::default()
        },
    );
    assert_eq!(
        core.escalate_question(&devin, hook_asked(&input)).await,
        Escalation::Off
    );
    let grok = registration(
        "asker-grok-gone",
        Target::new(
            SessionKind::GrokOpen,
            "019a0000-0000-7000-8000-00000000c0d0",
        ),
        &base,
    );
    let (core, _temp) = self::core(&base, &grok, true);
    assert_eq!(
        core.escalate_question(&grok, hook_asked(&input)).await,
        Escalation::Off
    );
    assert_eq!(dm_count(&hits), 0);
}

/// An answer the session only queued (a Devin session whose hooks drain it
/// at its next turn) is not reported delivered: the inbox is told it waits
/// for the session's next turn.
#[tokio::test]
async fn a_queued_answer_is_not_reported_delivered() {
    let (base, hits) = relaycast(false);
    let asker = registration(
        "asker-queued",
        Target::new(SessionKind::Devin, "real-queued"),
        &base,
    );
    let (reference, _) = reserved(&asker, "question-real-queued-1");
    let injector = Scripted::new([InjectOutcome::Accepted(
        "in the session's inbox; its next lifecycle hook boundary drains it".into(),
    )]);
    let (core, _temp) = scripted_core(&base, &asker, &injector);
    let token = Secret::new("at_live_asker");
    let answer = reply("d-queued", "agent-triage", &format!("answer {reference} 1"));
    let OwnerReply::Settled(_) = core
        .question_reply(&asker, &answer, (base.as_str(), &token))
        .await
    else {
        panic!("settled");
    };
    let replies = replies_to_inbox(&hits);
    assert_eq!(replies.len(), 1, "{replies:?}");
    assert!(!replies[0].contains("delivered to"), "{}", replies[0]);
    assert!(replies[0].contains("next turn"), "{}", replies[0]);
    assert_eq!(
        state_of(&reference),
        Some(State::Answered),
        "not typed again"
    );
}

/// The caps hold on every question shape: Codex's (hook and spawned
/// request) and Copilot's.
#[test]
fn every_question_shape_keeps_the_caps() {
    let codex = |questions: usize, options: usize| {
        json!({"questions": (0..questions).map(|i| json!({"id": format!("q{i}"), "header": "H",
            "question": format!("Q{i}?"),
            "options": (0..options).map(|j| json!({"label": format!("o{j}"), "description": ""}))
                .collect::<Vec<_>>()})).collect::<Vec<_>>()})
    };
    assert!(text::codex_questions(&codex(text::MAX_QUESTIONS, text::MAX_OPTIONS)).is_some());
    assert!(text::codex_questions(&codex(text::MAX_QUESTIONS + 1, 2)).is_none());
    assert!(text::codex_questions(&codex(1, text::MAX_OPTIONS + 1)).is_none());
    assert!(text::codex_tool_questions(&codex(text::MAX_QUESTIONS + 1, 2)).is_none());
    let copilot = |choices: usize| json!({"question": "Which?", "choices": (0..choices).map(|j| format!("c{j}")).collect::<Vec<_>>()});
    assert!(text::copilot_questions(&copilot(text::MAX_OPTIONS)).is_some());
    assert!(text::copilot_questions(&copilot(text::MAX_OPTIONS + 1)).is_none());
}
