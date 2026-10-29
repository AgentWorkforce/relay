//! A fake Claude speaking the stream-json control protocol, started through
//! the real launcher on a real input pipe, stands in for `claude -p`.

use super::super::ClaudeAdapter;
use super::*;
use crate::relay::claude::ClaudeConfig;
use crate::relay::codex::app_server::drive::ReplyResult;
use crate::relay::delivery::policy::MessageRef;
use crate::relay::harness::SpawnFacet;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::FakeProcesses;
use crate::relay::spawn::launch::{start_with_input, Message};
use crate::relay::store::{SessionKind, Target};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::Arc;

fn adapter_at(home: &Path) -> ClaudeAdapter {
    ClaudeAdapter {
        claude: ClaudeConfig::resolve(&|_| None, home, &[]),
        table: Arc::new(FakeProcesses::default()),
        environment: None,
        logs: home
            .join("app-data")
            .join(crate::relay::spawn::launch::SPAWN_LOGS),
        systemd_run: None,
    }
}

/// Each user line starts a turn: echoed, then `running`. One asking for
/// permission sends a `can_use_tool` request and ends its turn with what
/// the answer was; any other ends at once with `turn <n>`.
const FAKE_CLAUDE: &str = r#"state() { printf '{"type":"system","subtype":"session_state_changed","state":"%s"}\n' "$1"; }
n=0
while IFS= read -r line; do
  case "$line" in
    *'"type":"control_response"'*)
      case "$line" in *'"behavior":"allow"'*) d=allowed ;; *) d=denied ;; esac
      state running
      printf '{"type":"result","subtype":"success","result":"%s"}\n' "$d"
      state idle ;;
    *'"type":"user"'*)
      n=$((n+1))
      printf '%s\n' "$line"
      state running
      case "$line" in
        *ask-permission*)
          state requires_action
          printf '{"type":"control_request","request_id":"req-%s","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"curl -s https://example.com"},"tool_use_id":"t%s"}}\n' "$n" "$n" ;;
        *)
          printf '{"type":"result","subtype":"success","result":"turn %s"}\n' "$n"
          state idle ;;
      esac ;;
  esac
done
"#;

struct Fake {
    _home: tempfile::TempDir,
    adapter: ClaudeAdapter,
    target: Target,
    pid: i32,
}

impl Fake {
    fn start(session: &str) -> Fake {
        let home = tempfile::tempdir().unwrap();
        let adapter = adapter_at(home.path());
        std::fs::create_dir_all(&adapter.logs).unwrap();
        let script = home.path().join("claude.sh");
        std::fs::write(&script, FAKE_CLAUDE).unwrap();
        let mut environment = BTreeMap::new();
        environment.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
        environment.insert(
            "AGENT_RELAY_SPAWN_INPUT".to_string(),
            super::super::first_message("the task"),
        );
        let pid = start_with_input(
            None,
            Path::new("/bin/sh"),
            &[script.display().to_string()],
            &input_path(&adapter.logs, session),
            &log_path(&adapter.logs, session),
            home.path(),
            &environment,
        )
        .unwrap();
        let fake = Fake {
            _home: home,
            adapter,
            target: Target::new(SessionKind::ClaudeTerminal, session),
            pid,
        };
        fake.wait_for("turn 1");
        fake
    }

    fn session(&self) -> &str {
        &self.target.id
    }

    fn output(&self) -> String {
        std::fs::read_to_string(log_path(&self.adapter.logs, self.session())).unwrap_or_default()
    }

    fn wait_for(&self, text: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !self.output().contains(text) {
            assert!(
                Instant::now() < deadline,
                "no {text:?} in {}",
                self.output()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn deliver(&self, text: &str, native: bool) -> Option<InjectOutcome> {
        let message = Message {
            delivery_id: "d",
            message_id: "m",
            text,
            native,
        };
        self.adapter.deliver(&self.target, &message)
    }

    /// Polls until a request is pending and returns its notice.
    fn notice(&self) -> requests::Notice {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            assert_eq!(poll(&self.adapter.logs, self.session()), Poll::Live);
            if let Some(notice) = requests::unforwarded(self.session()).pop() {
                return notice;
            }
            assert!(Instant::now() < deadline, "no request in {}", self.output());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn stop(&self) {
        crate::relay::uploader::signal(self.pid as u32, libc::SIGTERM);
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.stop();
    }
}

#[test]
fn a_native_turn_waits_for_idle_and_its_permission_prompt_is_answered_remotely() {
    let fake = Fake::start("c0a1b2c3-0000-4000-8000-000000000001");
    assert!(fake.adapter.native_input(&fake.target));
    // Someone else's message keeps the peer inbox route.
    assert_eq!(fake.deliver("from a peer", false), None);

    assert_eq!(
        fake.deliver("please ask-permission", true),
        Some(InjectOutcome::Delivered)
    );
    // The turn written holds the next one back until its own output shows.
    assert!(matches!(
        fake.deliver("too soon", true),
        Some(InjectOutcome::WaitingForTurn(_))
    ));
    let notice = fake.notice();
    assert!(notice.approvable);
    assert!(!notice.description.contains("example.com"));
    assert!(matches!(
        fake.deliver("while it asks", true),
        Some(InjectOutcome::WaitingForTurn(_))
    ));

    let session = fake.session();
    let reference = &notice.reference;
    let reply = |sender| requests::answer(session, reference, sender, Some("own"), true);
    assert_eq!(reply(Some("stranger")), ReplyResult::Unauthorized);
    assert_eq!(reply(Some("req")), ReplyResult::Unauthorized);
    assert_eq!(reply(Some("own")), ReplyResult::Answered);
    assert_eq!(reply(Some("own")), ReplyResult::Unknown, "answered once");
    assert_eq!(poll(&fake.adapter.logs, session), Poll::Live);
    fake.wait_for("\"result\":\"allowed\"");

    // Idle again: the next native turn goes in, as the session's own.
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match fake.deliver("next", true) {
            Some(InjectOutcome::Delivered) => break,
            Some(InjectOutcome::WaitingForTurn(_)) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            other => panic!("{other:?}"),
        }
    }
    fake.wait_for("turn 3");
    assert!(fake.output().contains(r#""content":"next""#));
    // Its id carries its reference, for its final answer.
    let uuid = MessageRef::native_uuid(&MessageRef::of("m"));
    assert!(fake.output().contains(&format!(r#""uuid":"{uuid}""#)));
}

#[test]
fn only_its_own_echo_shows_a_written_turn_started() {
    let home = tempfile::tempdir().unwrap();
    let logs = home.path();
    let session = "c0a1b2c3-0000-4000-8000-000000000005";
    let log = log_path(logs, session);
    std::fs::write(&log, "{\"type\":\"result\"}\n").unwrap();
    let uuid = MessageRef::native_uuid(&MessageRef::of("m5"));
    let at = length(&log);
    submitted().insert(session.into(), (at, uuid.clone(), Instant::now()));
    assert!(starting(logs, session));
    // The turn before's late idle is not this turn starting.
    let idle = r#"{"type":"system","subtype":"session_state_changed","state":"idle"}"#;
    std::fs::write(&log, format!("{{\"type\":\"result\"}}\n{idle}\n")).unwrap();
    assert!(starting(logs, session));
    let echo = user_turn("hi", "m5");
    std::fs::write(&log, format!("{{\"type\":\"result\"}}\n{idle}\n{echo}\n")).unwrap();
    assert!(!starting(logs, session));
}

#[test]
fn a_pipe_nobody_reads_yet_is_waited_for_and_keeps_its_answers() {
    let home = tempfile::tempdir().unwrap();
    let logs = home.path();
    let session = "c0a1b2c3-0000-4000-8000-000000000006";
    let fifo = input_path(logs, session);
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let request = json!({"type": "control_request", "request_id": "r6",
        "request": {"subtype": "can_use_tool", "tool_name": "Edit", "input": {}}});
    std::fs::write(log_path(logs, session), format!("{request}\n")).unwrap();
    // No reader yet: still live, nothing taken or written.
    assert_eq!(poll(logs, session), Poll::Live);
    assert!(requests::unforwarded(session).is_empty());
    requests::register(session, &request);
    let notice = requests::unforwarded(session).pop().unwrap();
    requests::answer(session, &notice.reference, Some("own"), Some("own"), true);
    assert_eq!(poll(logs, session), Poll::Live);
    assert_eq!(requests::due(session).len(), 1, "kept to write again");
    // Its pipe gone, it has ended.
    std::fs::remove_file(&fifo).unwrap();
    assert_eq!(poll(logs, session), Poll::Gone);
    assert!(!requests::waiting(session));
}

#[test]
fn an_unanswered_request_is_denied_and_a_gone_claude_takes_its_references() {
    let fake = Fake::start("c0a1b2c3-0000-4000-8000-000000000002");
    let session = fake.session().to_string();
    assert_eq!(
        fake.deliver("ask-permission", true),
        Some(InjectOutcome::Delivered)
    );
    let notice = fake.notice();
    requests::expire(&notice.reference);
    assert_eq!(poll(&fake.adapter.logs, &session), Poll::Live);
    fake.wait_for("\"result\":\"denied\"");
    assert_eq!(
        requests::answer(&session, &notice.reference, Some("own"), Some("own"), true),
        ReplyResult::Unknown
    );

    // Another request, then Claude ends before anyone answers.
    let deadline = Instant::now() + Duration::from_secs(15);
    while fake.deliver("ask-permission again", true) != Some(InjectOutcome::Delivered) {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(20));
    }
    let pending = fake.notice();
    fake.stop();
    let deadline = Instant::now() + Duration::from_secs(15);
    while poll(&fake.adapter.logs, &session) == Poll::Live {
        assert!(Instant::now() < deadline, "the input outlived Claude");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!requests::waiting(&session));
    assert_eq!(
        requests::answer(&session, &pending.reference, Some("own"), Some("own"), true),
        ReplyResult::Unknown
    );
    assert!(matches!(
        fake.deliver("after", true),
        None | Some(InjectOutcome::Waiting(_))
    ));
}

#[test]
fn a_core_that_starts_again_takes_up_only_requests_claude_still_waits_for() {
    let session = "c0a1b2c3-0000-4000-8000-000000000003";
    let request = |id: &str| {
        json!({"type": "control_request", "request_id": id,
            "request": {"subtype": "can_use_tool", "tool_name": "Edit", "input": {}}})
    };
    let running = json!({"type": "system", "subtype": "session_state_changed", "state": "running"});
    let events = [
        request("answered"),
        running.clone(),
        request("cancelled"),
        json!({"type": "control_cancel_request", "request_id": "cancelled"}),
        request("open"),
    ];
    assert!(take_requests(session, &events, true).is_empty());
    let open = requests::unforwarded(session);
    assert_eq!(open.len(), 1, "{open:?}");
    requests::forget(session);

    // Read live, every request is taken up; one it cannot answer is refused.
    let unknown = json!({"type": "control_request", "request_id": "hook",
        "request": {"subtype": "hook_callback"}});
    let refused = take_requests(session, &[request("a"), running, unknown], false);
    assert_eq!(refused, [requests::refusal("hook")]);
    assert_eq!(requests::unforwarded(session).len(), 1);
    requests::forget(session);
}

#[test]
fn a_spawn_from_before_the_channel_keeps_the_peer_inbox() {
    let home = tempfile::tempdir().unwrap();
    let adapter = adapter_at(home.path());
    let target = Target::new(
        SessionKind::ClaudeTerminal,
        "c0a1b2c3-0000-4000-8000-000000000004",
    );
    assert!(!adapter.native_input(&target));
    let message = Message {
        delivery_id: "d",
        message_id: "m",
        text: "hi",
        native: true,
    };
    assert_eq!(adapter.deliver(&target, &message), None);
    assert_eq!(adapter.poll_requests(&target), Some(false));
    let codex = Target::new(SessionKind::Codex, "thread");
    assert_eq!(adapter.poll_requests(&codex), None);
}

#[test]
fn a_write_with_no_reader_fails_at_once_as_closed() {
    let folder = tempfile::tempdir().unwrap();
    let fifo = folder.path().join("in");
    assert_eq!(send(&fifo, "x"), Err(SendError::Closed));
    let made = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap();
    assert!(made.success());
    assert!(has_input(folder.path(), "in".trim_end_matches(".input")) || fifo.exists());
    assert_eq!(send(&fifo, "x"), Err(SendError::Closed));
}

#[test]
fn a_first_read_that_fails_leaves_the_next_one_first() {
    let home = tempfile::tempdir().unwrap();
    let session = "c0a1b2c3-0000-4000-8000-000000000007";
    let log = log_path(home.path(), session);
    assert_eq!(read_new(&log, session), (Vec::new(), true));
    let request = json!({"type": "control_request", "request_id": "old", "request": {}});
    let running = json!({"type": "system", "subtype": "session_state_changed", "state": "running"});
    std::fs::write(&log, format!("{request}\n{running}\n")).unwrap();
    let (events, first) = read_new(&log, session);
    assert!(first, "what Claude moved on from is not taken up");
    assert!(take_requests(session, &events, first).is_empty());
    assert!(requests::unforwarded(session).is_empty());
    let (_, first) = read_new(&log, session);
    assert!(!first);
    end(session);
}
