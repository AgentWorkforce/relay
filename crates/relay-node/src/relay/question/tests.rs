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
    assert!(text::resolve(&one, "3").unwrap_err().contains("1 to 2"));
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
        via: Via::Claude,
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
    let Err(Unchecked::Refused(unreadable)) = check(&reference, &asker, Some("agent-triage"), "7")
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
    assert_eq!(expire(&second), None, "already closed by the late reply");
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

/// A Relaycast that knows the agent `triage` and takes DMs (refusing them
/// when `refuse`), keeping each request's line and body.
fn relaycast(refuse: bool) -> (String, Arc<Mutex<Vec<String>>>) {
    let mode = Arc::new(std::sync::atomic::AtomicU8::new(if refuse {
        REFUSE
    } else {
        ACCEPT
    }));
    relaycast_in(mode)
}

/// `relaycast`, answering DMs as `mode` says at the time.
fn relaycast_in(mode: Arc<std::sync::atomic::AtomicU8>) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(Mutex::new(Vec::new()));
    let seen = hits.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let (seen, mode) = (seen.clone(), mode.clone());
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
                let (status, reply) = if line.starts_with("GET /v1/agents/triage") {
                    (
                        "200 OK",
                        r#"{"ok":true,"data":{"id":"agent-triage","name":"triage"}}"#,
                    )
                } else if line.starts_with("GET /v1/agents/") {
                    (
                        "404 Not Found",
                        r#"{"ok":false,"error":{"code":"agent_not_found","message":"no"}}"#,
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

fn core(base: &str, asker: &Registration, on: bool) -> (Arc<Core>, tempfile::TempDir) {
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
    let (core, _signals) = Core::new(config);
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
        via: Via::Claude,
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
