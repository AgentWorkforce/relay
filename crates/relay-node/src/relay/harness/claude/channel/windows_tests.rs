//! On Windows: a fake Claude speaking the stream-json control protocol
//! (a PowerShell script), started through the real launcher on the input
//! this core holds, stands in for `claude -p`.

use super::super::ClaudeAdapter;
use super::*;
use crate::relay::claude::ClaudeConfig;
use crate::relay::codex::app_server::drive::ReplyResult;
use crate::relay::harness::SpawnFacet;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::FakeProcesses;
use crate::relay::spawn::launch::{start_with_input, Message};
use crate::relay::store::{SessionKind, Target};
use std::collections::BTreeMap;
use std::sync::Arc;

/// Each user line starts a turn: echoed, then `running`. One asking for
/// permission sends a `can_use_tool` request and ends its turn with what
/// the answer was; any other ends at once with `turn <n>`. `quit` ends it.
const FAKE_CLAUDE: &str = r#"function say($text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }
function state($s) { say ('{"type":"system","subtype":"session_state_changed","state":"' + $s + '"}') }
$n = 0
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq 'quit') { break }
  if ($line.Contains('"type":"control_response"')) {
    $d = 'denied'
    if ($line.Contains('"behavior":"allow"')) { $d = 'allowed' }
    state 'running'
    say ('{"type":"result","subtype":"success","result":"' + $d + '"}')
    state 'idle'
  } elseif ($line.Contains('"type":"user"')) {
    $n++
    say $line
    state 'running'
    if ($line.Contains('ask-permission')) {
      state 'requires_action'
      say ('{"type":"control_request","request_id":"req-' + $n + '","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"curl -s https://example.com"},"tool_use_id":"t' + $n + '"}}')
    } else {
      say ('{"type":"result","subtype":"success","result":"turn ' + $n + '"}')
      state 'idle'
    }
  }
}
"#;

fn output(logs: &Path, session: &str) -> String {
    std::fs::read_to_string(log_path(logs, session)).unwrap_or_default()
}

fn wait_for(logs: &Path, session: &str, text: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !output(logs, session).contains(text) {
        assert!(
            Instant::now() < deadline,
            "no {text:?} in {}",
            output(logs, session)
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_permission_prompt_is_answered_through_the_input_the_core_holds() {
    let home = tempfile::tempdir().unwrap();
    let adapter = ClaudeAdapter {
        claude: ClaudeConfig::resolve(&|_| None, home.path(), &[]),
        table: Arc::new(FakeProcesses::default()),
        environment: None,
        logs: home
            .path()
            .join("app-data")
            .join(crate::relay::spawn::launch::SPAWN_LOGS),
        systemd_run: None,
    };
    let logs = adapter.logs.clone();
    std::fs::create_dir_all(&logs).unwrap();
    let session = "c0a1b2c3-0000-4000-8000-0000000000a1";
    let target = Target::new(SessionKind::ClaudeTerminal, session);
    let script = home.path().join("claude.ps1");
    std::fs::write(&script, FAKE_CLAUDE).unwrap();
    let mut environment: BTreeMap<String, String> = std::env::vars().collect();
    environment.insert(
        "AGENT_RELAY_SPAWN_INPUT".to_string(),
        super::super::first_message("the task"),
    );
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let powershell = Path::new(&system).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let input = input_path(&logs, session);
    start_with_input(
        None,
        &powershell,
        &[
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            script.display().to_string(),
        ],
        &input,
        &log_path(&logs, session),
        home.path(),
        &environment,
    )
    .unwrap();
    // No file is made for the input; the core holds it.
    assert!(!input.exists());
    assert!(has_input(&logs, session) && reading(&logs, session));
    wait_for(&logs, session, "turn 1");

    let message = Message {
        delivery_id: "d",
        message_id: "m",
        text: "please ask-permission",
        native: true,
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match adapter.deliver(&target, &message) {
            Some(InjectOutcome::Delivered) => break,
            Some(InjectOutcome::WaitingForTurn(_)) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            other => panic!("{other:?} in {}", output(&logs, session)),
        }
    }
    let notice = loop {
        assert_eq!(poll(&logs, session), Poll::Live);
        if let Some(notice) = requests::unforwarded(session).pop() {
            break notice;
        }
        assert!(
            Instant::now() < deadline,
            "no request in {}",
            output(&logs, session)
        );
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(notice.approvable);
    let reply = requests::answer(session, &notice.reference, Some("own"), Some("own"), true);
    assert_eq!(reply, ReplyResult::Answered);
    assert_eq!(poll(&logs, session), Poll::Live);
    wait_for(&logs, session, "\"result\":\"allowed\"");

    // Once it ends, the core lets go of its input and the channel is gone.
    send(&input, "quit").unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while has_input(&logs, session) {
        assert!(Instant::now() < deadline, "it did not end");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(send(&input, "late"), Err(SendError::Closed));
    assert_eq!(poll(&logs, session), Poll::Gone);
    assert!(!requests::waiting(session));
}

/// An input whose reader never takes anything until released.
struct Stuck(Arc<(Mutex<bool>, std::sync::Condvar)>);

impl std::io::Write for Stuck {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let (released, changed) = &*self.0;
        let mut released = released.lock().unwrap();
        while !*released {
            released = changed.wait(released).unwrap();
        }
        Ok(buffer.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// An input that takes everything at once.
struct Taken(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Taken {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buffer);
        Ok(buffer.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn a_claude_that_stops_reading_holds_up_no_other() {
    use crate::relay::spawn::launch::{hold_input, release_input};
    let home = tempfile::tempdir().unwrap();
    let stuck = input_path(home.path(), "c0a1b2c3-0000-4000-8000-0000000000a2");
    let other = input_path(home.path(), "c0a1b2c3-0000-4000-8000-0000000000a3");
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let taken = Arc::new(Mutex::new(Vec::new()));
    hold_input(&stuck, Stuck(gate.clone()));
    hold_input(&other, Taken(taken.clone()));
    let started = Instant::now();
    let blocked = {
        let stuck = stuck.clone();
        std::thread::spawn(move || send(&stuck, "never read"))
    };
    std::thread::sleep(Duration::from_millis(100));
    // The other agent's line waits at most for the stuck one's deadline.
    assert_eq!(send(&other, "read"), Ok(()));
    assert_eq!(taken.lock().unwrap().as_slice(), b"read\n");
    // The stuck line may still be read later: in doubt, never retried.
    let result = blocked.join().unwrap();
    assert!(matches!(result, Err(SendError::Partial(_))), "{result:?}");
    assert!(started.elapsed() < WRITE_WAIT + Duration::from_secs(3));
    // Its next line is never handed over, and returns by its deadline.
    assert!(matches!(
        send(&stuck, "still not read"),
        Err(SendError::NotWritten(_))
    ));
    *gate.0.lock().unwrap() = true;
    gate.1.notify_all();
    release_input(&stuck);
    release_input(&other);
}
