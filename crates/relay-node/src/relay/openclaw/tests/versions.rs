//! Every supported OpenClaw release, played by the fake Gateway: what each
//! request carries, the dedupe and busy checks, the answers, and where
//! trusted and untrusted senders' messages go.
use super::*;

fn hello(version: &str, protocol: u64, methods: &[&str]) -> Value {
    json!({
        "type": "hello-ok",
        "protocol": protocol,
        "server": { "version": version, "connId": "c" },
        "features": { "methods": methods, "events": [] },
        "snapshot": { "uptimeMs": 1000 },
    })
}

const ALL: [&str; 7] = [
    "agents.list",
    "chat.send",
    "chat.history",
    "sessions.create",
    "sessions.patch",
    "sessions.list",
    "agent.wait",
];

#[test]
fn releases_are_read_from_the_version_the_gateway_reports() {
    assert_eq!(Release::parse("2026.3.13"), Some(Release::new(2026, 3, 13)));
    assert_eq!(
        Release::parse(" v2026.10.4 "),
        Some(Release::new(2026, 10, 4))
    );
    assert_eq!(
        Release::parse("2026.8.1+build.7"),
        Some(Release::new(2026, 8, 1))
    );
    // A prerelease is not yet its release.
    let beta = Release::parse("2026.8.1-beta.1").unwrap();
    assert!(beta < Release::new(2026, 8, 1) && beta > Release::new(2026, 7, 35));
    assert_eq!(beta.to_string(), "2026.8.1-pre");
    assert!(Release::new(2026, 10, 1) > Release::new(2026, 9, 9));
    for junk in ["", "dev", "unknown", "1.2", "2026.8", "2026.8.1.2", "0.0.1"] {
        assert_eq!(Release::parse(junk), None, "{junk}");
    }
}

#[test]
fn what_each_release_offers() {
    // (version, protocol, create, limits, displayName, suppress, user key,
    //  how a running turn shows)
    let table = [
        (
            "2026.3.13",
            3,
            false,
            false,
            false,
            false,
            false,
            ActiveRun::Waited,
        ),
        (
            "2026.3.22",
            3,
            true,
            false,
            false,
            false,
            false,
            ActiveRun::Waited,
        ),
        (
            "2026.5.2",
            3,
            true,
            false,
            false,
            false,
            false,
            ActiveRun::Listed,
        ),
        (
            "2026.5.7",
            3,
            true,
            false,
            false,
            false,
            false,
            ActiveRun::Listed,
        ),
        (
            "2026.5.12",
            4,
            true,
            false,
            false,
            false,
            false,
            ActiveRun::Listed,
        ),
        (
            "2026.5.26",
            4,
            true,
            false,
            false,
            false,
            true,
            ActiveRun::Listed,
        ),
        (
            "2026.6.1",
            4,
            true,
            false,
            false,
            false,
            true,
            ActiveRun::History,
        ),
        (
            "2026.6.5",
            4,
            true,
            false,
            false,
            true,
            true,
            ActiveRun::History,
        ),
        (
            "2026.7.35",
            4,
            true,
            false,
            false,
            true,
            true,
            ActiveRun::History,
        ),
        (
            "2026.8.1",
            4,
            true,
            true,
            false,
            true,
            true,
            ActiveRun::History,
        ),
        (
            "2026.9.1",
            4,
            true,
            true,
            true,
            true,
            true,
            ActiveRun::History,
        ),
        (
            "2026.10.4",
            4,
            true,
            true,
            true,
            true,
            true,
            ActiveRun::History,
        ),
    ];
    for (version, protocol, create, limits, name, suppress, key, active) in table {
        let methods: Vec<&str> = ALL
            .into_iter()
            .filter(|m| create || *m != "sessions.create")
            .collect();
        let f = Features::from_hello(&hello(version, protocol, &methods));
        assert_eq!(f.version, version);
        assert_eq!(f.protocol, protocol);
        assert_eq!(
            (
                f.sessions_create,
                f.session_limits,
                f.display_name,
                f.suppress_commands,
                f.user_turn_key,
                f.active_run
            ),
            (create, limits, name, suppress, key, active),
            "{version}"
        );
        assert!(f.started_at_ms.is_some_and(|at| at <= now_ms()));
    }
}

#[test]
fn a_build_without_a_release_counts_as_the_oldest_it_could_be() {
    // Protocol 4 is 2026.5.12 at the earliest: no session limits.
    let f = Features::from_hello(&hello("dev", 4, &ALL));
    assert!(!f.session_limits && f.sessions_create && f.active_run == ActiveRun::Listed);
    let f = Features::from_hello(&hello("", 3, &ALL));
    assert!(f.sessions_create && f.active_run == ActiveRun::Waited);
    assert_eq!(f.named_version(), "on this computer");
    let f = Features::from_hello(&hello("unknown", 3, &["chat.send", "chat.history"]));
    assert!(!f.sessions_create);
    // A release whose methods lack one Agent Relay needs never uses it.
    let f = Features::from_hello(&hello("2026.10.4", 4, &["chat.send", "chat.history"]));
    assert!(!f.session_limits && !f.sessions_create && f.active_run == ActiveRun::History);
}

pub(super) fn release(text: &str) -> Release {
    Release::parse(text).unwrap()
}

pub(super) fn route<'a>(
    delivery: &'a str,
    message: &'a str,
    sender: &'a str,
    address: &'a str,
) -> DeliveryRoute<'a> {
    DeliveryRoute {
        delivery_id: delivery,
        message_id: message,
        ..dm(sender, address)
    }
}

pub(super) fn text(message: &str, body: &str) -> String {
    format!(
        "[via Agent Relay — from @alice (alice@node-1) to @main · message {message} · ref {}]\n\n{body}",
        MessageRef::of(message)
    )
}

fn methods_of(frames: &[Value]) -> Vec<String> {
    frames
        .iter()
        .map(|f| f["method"].as_str().unwrap().to_string())
        .collect()
}

/// An untrusted sender's message on `version`: its own session, limited
/// only where the Gateway can, and answered.
fn untrusted_send_and_answer(version: &str) {
    let fake = FakeGateway::release(release(version));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let first = route("del_1", "m-1", "alice", "alice@node-1");
    assert_eq!(
        send(&config, "main", "ws", &first, &text("m-1", "What is 2+2?")),
        InjectOutcome::Delivered,
        "{version}"
    );
    let frames = fake.methods();
    let limited = fake.release >= Release::new(2026, 8, 1);
    let mut expected = vec!["connect", "chat.history"];
    if fake.release < Release::new(2026, 6, 1) && fake.release >= Release::new(2026, 3, 22) {
        expected.push("sessions.list");
    }
    if limited {
        expected.extend(["sessions.create", "sessions.patch"]);
    }
    expected.push("chat.send");
    assert_eq!(methods_of(&frames), expected, "{version}");
    let key = session_key("main", "ws", &first);
    assert_ne!(key, main_session_key("main"));
    let chat = frames.iter().find(|f| f["method"] == "chat.send").unwrap();
    assert_eq!(chat["params"]["sessionKey"], key.as_str());
    assert_eq!(chat["params"]["deliver"], false);
    assert_eq!(
        chat["params"]
            .get("suppressCommandInterpretation")
            .is_some(),
        fake.release >= Release::new(2026, 6, 5),
        "{version}"
    );
    if let Some(create) = frames.iter().find(|f| f["method"] == "sessions.create") {
        assert_eq!(create["params"]["permissionMode"], "read-only");
        assert_eq!(
            create["params"].get("displayName").is_some(),
            fake.release >= Release::new(2026, 9, 1),
            "{version}"
        );
    }
    // Settings names a Gateway that cannot limit relay sessions.
    assert_eq!(
        config.unlimited_version(),
        (!limited).then(|| version.to_string()),
        "{version}"
    );
    use crate::relay::agents::SettingsExtension;
    let shown = OpenClawSettings::new(&config).get();
    assert_eq!(
        shown.get(UNLIMITED_SETTING).and_then(Value::as_str),
        (!limited).then_some(version),
        "{version}"
    );
    // Turned off, the Gateway is not used: nothing to say.
    OpenClawSettings::new(&config)
        .set(SETTING, &json!(false))
        .unwrap()
        .unwrap();
    assert_eq!(config.unlimited_version(), None);
    OpenClawSettings::new(&config)
        .set(SETTING, &json!(true))
        .unwrap()
        .unwrap();
    assert_eq!(
        final_answer(&config, "main", &MessageRef::of("m-1")).as_deref(),
        Some("Answer: What is 2+2?"),
        "{version}"
    );
}

/// A resend, before and after a Gateway restart, never repeats the turn.
fn resends_never_repeat(version: &str) {
    let fake = FakeGateway::release(release(version));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let first = route("del_1", "m-1", "alice", "alice@node-1");
    let message = text("m-1", "hi");
    for _ in 0..2 {
        assert_eq!(
            send(&config, "main", "ws", &first, &message),
            InjectOutcome::Delivered
        );
    }
    fake.restart();
    assert_eq!(
        send(&config, "main", "ws", &first, &message),
        InjectOutcome::Delivered
    );
    assert_eq!(fake.runs(), ["del_1"], "{version}");
}

/// A sender whose session still runs its previous turn waits, and is
/// delivered once it ends.
fn a_busy_session_waits(version: &str) {
    let fake = FakeGateway::release(release(version));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    fake.hold();
    let first = route("del_1", "m-1", "alice", "alice@node-1");
    let second = route("del_2", "m-2", "alice", "alice@node-1");
    assert_eq!(
        send(&config, "main", "ws", &first, &text("m-1", "slow one")),
        InjectOutcome::Delivered
    );
    // The same delivery again is not "busy": the Gateway dedupes it.
    assert_eq!(
        send(&config, "main", "ws", &first, &text("m-1", "slow one")),
        InjectOutcome::Delivered
    );
    assert_eq!(final_answer(&config, "main", &MessageRef::of("m-1")), None);
    assert!(
        matches!(
            send(&config, "main", "ws", &second, &text("m-2", "next")),
            InjectOutcome::Waiting(_)
        ),
        "{version}"
    );
    fake.finish("del_1");
    assert_eq!(
        final_answer(&config, "main", &MessageRef::of("m-1")).as_deref(),
        Some("Answer: slow one")
    );
    assert_eq!(
        send(&config, "main", "ws", &second, &text("m-2", "next")),
        InjectOutcome::Delivered,
        "{version}"
    );
    fake.finish("del_2");
    assert_eq!(
        final_answer(&config, "main", &MessageRef::of("m-2")).as_deref(),
        Some("Answer: next"),
        "{version}"
    );
    assert_eq!(fake.runs(), ["del_1", "del_2"]);
}

/// An agent that chooses not to answer sends nothing back.
fn no_reply_is_no_answer(version: &str) {
    let fake = FakeGateway::release(release(version));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let first = route("del_1", "m-1", "alice", "alice@node-1");
    let _ = send(&config, "main", "ws", &first, &text("m-1", "SILENT please"));
    assert!(fake.runs() == ["del_1"]);
    assert_eq!(
        final_answer(&config, "main", &MessageRef::of("m-1")),
        None,
        "{version}"
    );
}

/// A trusted sender reaches the main session, never limited.
fn trusted_reaches_main(version: &str) {
    let fake = FakeGateway::release(release(version));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    config.trusted.set(&json!(["ada-lovelace"])).unwrap();
    let owner = route("del_1", "m-1", "ada-lovelace", "ada-lovelace@sf-mini");
    assert_eq!(
        send(&config, "main", "ws", &owner, &text("m-1", "remember ABC")),
        InjectOutcome::Delivered
    );
    let frames = fake.methods();
    assert!(!methods_of(&frames)
        .iter()
        .any(|m| m == "sessions.create" || m == "sessions.patch"));
    let chat = frames.iter().find(|f| f["method"] == "chat.send").unwrap();
    assert_eq!(chat["params"]["sessionKey"], "agent:main:main", "{version}");
    assert_eq!(
        final_answer(&config, "main", &MessageRef::of("m-1")).as_deref(),
        Some("Answer: remember ABC"),
        "{version}"
    );
}

fn every_check(version: &str) {
    untrusted_send_and_answer(version);
    resends_never_repeat(version);
    a_busy_session_waits(version);
    no_reply_is_no_answer(version);
    trusted_reaches_main(version);
}

#[test]
fn openclaw_2026_3_13() {
    every_check("2026.3.13");
}

#[test]
fn openclaw_2026_3_22() {
    every_check("2026.3.22");
}

#[test]
fn openclaw_2026_5_7() {
    every_check("2026.5.7");
}

#[test]
fn openclaw_2026_5_26() {
    every_check("2026.5.26");
}

#[test]
fn openclaw_2026_6_1() {
    every_check("2026.6.1");
}

#[test]
fn openclaw_2026_7_1() {
    every_check("2026.7.1");
}

#[test]
fn openclaw_2026_8_1() {
    every_check("2026.8.1");
}

#[test]
fn openclaw_2026_9_1() {
    every_check("2026.9.1");
}

#[test]
fn openclaw_current() {
    every_check("2026.10.4");
}

#[test]
fn a_turn_left_running_by_a_restart_does_not_hold_the_next_message() {
    // Before 2026.5.2 only `agent.wait` knows a run, and it forgets runs
    // when the Gateway restarts.
    let fake = FakeGateway::release(release("2026.3.13"));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    fake.hold();
    let first = route("del_1", "m-1", "alice", "alice@node-1");
    let second = route("del_2", "m-2", "alice", "alice@node-1");
    assert_eq!(
        send(&config, "main", "ws", &first, &text("m-1", "one")),
        InjectOutcome::Delivered
    );
    fake.restart();
    assert_eq!(
        send(&config, "main", "ws", &second, &text("m-2", "two")),
        InjectOutcome::Delivered
    );
}

#[test]
fn an_old_gateway_finds_the_turn_by_its_attribution_line() {
    let features = Features::from_hello(&hello("2026.3.13", 3, &ALL));
    let line = "[via Agent Relay — from @a (a@n) to @main · message m-1 · ref 0a1b2c3d4e5f]";
    assert_eq!(marker(&format!("{line}\n\nhi")).as_deref(), Some(line));
    assert_eq!(marker("hi there"), None);
    assert_eq!(marker("[via Agent Relay — no ref]\n\nhi"), None);
    // The Gateway may prefix a timestamp; the line is still found.
    let history = json!({ "messages": [
        { "role": "user", "content": "[Sun 2026-03-15 10:00 PDT] earlier" },
        { "role": "assistant", "content": [{ "type": "text", "text": "ok" }], "stopReason": "stop" },
        { "role": "user", "content": [{ "type": "text", "text": format!("[Sun 2026-03-15 10:01 PDT] {line}\n\nhi") }] },
        { "role": "assistant", "content": [{ "type": "toolCall" }], "stopReason": "toolUse" },
        { "role": "assistant", "content": [{ "type": "text", "text": "Done." }], "stopReason": "stop" },
    ] });
    assert_eq!(turn_at(&history, "del_1", Some(line), &features), Some(2));
    assert_eq!(turn_at(&history, "del_1", None, &features), None);
    let (entries, followed) = answer::turn(&history, 2);
    assert!(!followed && entries.len() == 2);
    assert!(!finishes(&entries[0]) && finishes(&entries[1]));
    // Without a stop reason, an entry that calls no tool ends its run.
    assert!(finishes(
        &json!({ "role": "assistant", "content": "plain" })
    ));
    assert!(!finishes(
        &json!({ "role": "assistant", "content": [{ "type": "tool_use" }] })
    ));
    assert!(!finishes(&json!({ "role": "user", "content": "x" })));
}
