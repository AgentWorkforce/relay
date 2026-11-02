// In the editor tests' world: window 650's extension host, with Cursor's
// hooks (700 and on) directly under it. The route is not available on
// Windows (`windows_tests`).
#![cfg(unix)]

use super::super::editor_tests::{hook_payload, host, shell, uid, world, HOST_PID, SESSION};
use super::super::inbox::pending;
use super::super::{record_editor_hook, run_hook, send, CursorConfig};
use super::*;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::{FakeProcess, FakeProcesses};
use serde_json::json;
use std::sync::atomic::AtomicBool;

const HOOK: i32 = 700;
const LONG: Duration = Duration::from_secs(30);

/// The world with turn gen-1 started, as its prompt's `beforeSubmitPrompt`
/// hook names it.
fn editor() -> (tempfile::TempDir, CursorConfig, FakeProcesses) {
    let (temp, config, table) = world();
    for pid in HOOK..HOOK + 3 {
        table.insert(pid, shell(HOST_PID, &[]));
    }
    start(&config, "gen-1");
    (temp, config, table)
}

fn start(config: &CursorConfig, generation: &str) {
    turn_seen(config, &turn("beforeSubmitPrompt", generation));
}

fn turn(event: &str, generation: &str) -> Value {
    let mut payload = hook_payload(event, SESSION);
    payload["generation_id"] = json!(generation);
    payload["loop_count"] = json!(0);
    payload
}

fn stop(generation: &str) -> Value {
    turn("stop", generation)
}

/// What a waiting hook is told besides its inbox: whether it was asked to
/// stop, and whether its entry is still installed, as it reads that while
/// there is nothing to claim and as a claim does (`claims`).
struct Flags {
    stopping: AtomicBool,
    installed: AtomicBool,
    claims: AtomicBool,
}

impl Flags {
    fn new() -> Flags {
        Flags {
            stopping: AtomicBool::new(false),
            installed: AtomicBool::new(true),
            claims: AtomicBool::new(true),
        }
    }

    fn claiming(&self, claim: &mut dyn FnMut() -> Option<Ended>) -> Option<Ended> {
        if self.installed.load(Ordering::SeqCst) && self.claims.load(Ordering::SeqCst) {
            claim()
        } else {
            Some(Ended::Removed)
        }
    }
}

fn watching<'a>(
    pid: i32,
    wait: Duration,
    stopping: &'a dyn Fn() -> bool,
    installed: &'a dyn Fn() -> bool,
    claiming: &'a Claiming<'a>,
) -> Watch<'a> {
    Watch {
        pid,
        until: Instant::now() + wait,
        poll: Duration::from_millis(10),
        stopping,
        installed,
        claiming,
    }
}

/// Agent Relay's hook in `pid` for `payload`, as the waiting `stop` entry
/// runs it when `wait` is set: whether it answered, and what it wrote.
fn run(
    config: &CursorConfig,
    table: &FakeProcesses,
    flags: &Flags,
    pid: i32,
    payload: &Value,
    wait: Option<Duration>,
) -> (bool, Vec<Value>) {
    let stopping = || flags.stopping.load(Ordering::SeqCst);
    let installed = || flags.installed.load(Ordering::SeqCst);
    let claiming = |claim: &mut dyn FnMut() -> Option<Ended>| flags.claiming(claim);
    let watch = wait.map(|wait| watching(pid, wait, &stopping, &installed, &claiming));
    let mut written = Vec::new();
    let answered = run_hook(config, table, pid, payload, watch.as_ref(), &mut |output| {
        written.push(output.clone());
        true
    });
    (answered, written)
}

/// The hook in `pid` waiting after the completed turn `payload`, once it
/// recorded the conversation as its window's: how it ended and what it
/// wrote, which `writes` says whether it got out.
fn park(
    config: &CursorConfig,
    table: &FakeProcesses,
    flags: &Flags,
    pid: i32,
    payload: &Value,
    wait: Duration,
    writes: bool,
) -> (Ended, Vec<Value>) {
    assert!(record_editor_hook(config, table, pid, HOST_PID, payload));
    let stopping = || flags.stopping.load(Ordering::SeqCst);
    let installed = || flags.installed.load(Ordering::SeqCst);
    let claiming = |claim: &mut dyn FnMut() -> Option<Ended>| flags.claiming(claim);
    let watch = watching(pid, wait, &stopping, &installed, &claiming);
    let mut written = Vec::new();
    let ended = super::wait(config, table, HOST_PID, payload, &watch, &mut |output| {
        written.push(output.clone());
        writes
    });
    (ended, written)
}

fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !check() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn waiting(config: &CursorConfig) -> bool {
    waiter_file(config, SESSION).exists()
}

/// Whether a hook waits and is past its first checks, which it makes under
/// the conversation's lock after naming itself the waiting hook.
fn parked(config: &CursorConfig) -> bool {
    waiting(config) && locked(config, SESSION, || ()).is_some()
}

fn staged(config: &CursorConfig) -> usize {
    pending(config, SESSION).len()
}

fn message(config: &CursorConfig, table: &FakeProcesses, id: &str, text: &str) {
    assert!(matches!(
        send(config, table, uid(), SESSION, id, text),
        InjectOutcome::Accepted(_)
    ));
}

/// A message placed in the inbox without `send`, which needs the window.
fn place(config: &CursorConfig, id: &str, text: &str) {
    std::fs::create_dir_all(config.inbox()).unwrap();
    std::fs::write(config.inbox().join(format!("{SESSION}.{id}.msg")), text).unwrap();
}

#[test]
fn a_finished_turn_waits_for_its_next_message() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    std::thread::scope(|scope| {
        let hook = scope.spawn(|| run(&config, &table, &flags, HOOK, &stop("gen-1"), Some(LONG)));
        eventually("the hook waits", || parked(&config));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!hook.is_finished());
        let sent = Instant::now();
        message(&config, &table, "m-1", "ping");
        assert_eq!(
            hook.join().unwrap(),
            (true, vec![json!({"followup_message": "ping"})])
        );
        assert!(sent.elapsed() < Duration::from_secs(5));
    });
    // Handed over once, and the hook left nothing behind.
    assert_eq!(
        send(&config, &table, uid(), SESSION, "m-1", "ping"),
        InjectOutcome::Delivered
    );
    assert!(!waiting(&config));
}

#[test]
fn what_is_pending_as_the_turn_ends_is_answered_at_once() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    // The turn's tool call records the conversation as its window's.
    assert_eq!(
        run(
            &config,
            &table,
            &flags,
            HOOK,
            &turn("postToolUse", "gen-1"),
            None
        ),
        (false, vec![])
    );
    message(&config, &table, "m-1", "ping");
    let started = Instant::now();
    assert_eq!(
        run(
            &config,
            &table,
            &flags,
            HOOK + 1,
            &stop("gen-1"),
            Some(LONG)
        ),
        (true, vec![json!({"followup_message": "ping"})])
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!waiting(&config));
}

#[test]
fn only_a_completed_turn_with_its_id_waits() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    let mut aborted = stop("gen-1");
    aborted["status"] = json!("aborted");
    let mut unnamed = stop("gen-1");
    unnamed["generation_id"] = Value::Null;
    for payload in [aborted, unnamed, turn("postToolUse", "gen-1")] {
        let started = Instant::now();
        assert_eq!(
            run(&config, &table, &flags, HOOK, &payload, Some(LONG)),
            (false, vec![]),
            "{payload}"
        );
        assert!(started.elapsed() < Duration::from_secs(5), "{payload}");
        assert!(!waiting(&config), "{payload}");
    }
}

#[test]
fn a_hook_whose_window_went_away_ends_without_claiming() {
    let cases: [(&str, fn(&FakeProcesses)); 4] = [
        ("its parent exited", |table| {
            table.insert(HOOK, shell(1, &[]))
        }),
        ("the extension host exited", |table| table.remove(HOST_PID)),
        ("the window reloaded", |table| {
            table.insert(HOST_PID, host(21))
        }),
        ("the extension host is a zombie", |table| {
            table.insert(
                HOST_PID,
                FakeProcess {
                    zombie: true,
                    ..host(20)
                },
            )
        }),
    ];
    for (case, orphan) in cases {
        let (_temp, config, table) = editor();
        let flags = Flags::new();
        let ended = std::thread::scope(|scope| {
            let hook =
                scope.spawn(|| park(&config, &table, &flags, HOOK, &stop("gen-1"), LONG, true));
            eventually(case, || parked(&config));
            orphan(&table);
            place(&config, "m-1", "ping");
            hook.join().unwrap()
        });
        assert_eq!(ended, (Ended::Orphaned, vec![]), "{case}");
        assert_eq!(staged(&config), 1, "{case}");
        assert!(!waiting(&config), "{case}");
    }
}

#[test]
fn the_newest_waiting_hook_takes_the_message() {
    // The same turn's hook run again, and the next turn's once it started.
    for newer in ["gen-1", "gen-2"] {
        let (_temp, config, table) = editor();
        let flags = Flags::new();
        std::thread::scope(|scope| {
            let older =
                scope.spawn(|| park(&config, &table, &flags, HOOK, &stop("gen-1"), LONG, true));
            eventually("the older hook waits", || parked(&config));
            let first = read(&config, SESSION).unwrap();
            if newer != "gen-1" {
                start(&config, newer);
            }
            let newest =
                scope.spawn(|| run(&config, &table, &flags, HOOK + 1, &stop(newer), Some(LONG)));
            eventually("the newer hook takes over", || {
                read(&config, SESSION).is_some_and(|waiter| waiter != first)
            });
            assert_eq!(older.join().unwrap(), (Ended::Retired, vec![]), "{newer}");
            message(&config, &table, "m-1", "ping");
            assert_eq!(
                newest.join().unwrap(),
                (true, vec![json!({"followup_message": "ping"})]),
                "{newer}"
            );
        });
    }
}

#[test]
fn a_newer_hook_answering_at_once_retires_the_older_one_first() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    // The older hook is held between two of its checks while the newer one
    // of the same turn runs.
    let hold = AtomicBool::new(false);
    let held = AtomicBool::new(false);
    let stopping = || {
        while hold.load(Ordering::SeqCst) {
            held.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    };
    let installed = || true;
    let claiming = |claim: &mut dyn FnMut() -> Option<Ended>| claim();
    std::thread::scope(|scope| {
        let older = scope.spawn(|| {
            assert!(record_editor_hook(
                &config,
                &table,
                HOOK,
                HOST_PID,
                &stop("gen-1")
            ));
            let watch = watching(HOOK, LONG, &stopping, &installed, &claiming);
            let mut written = Vec::new();
            let ended = super::wait(
                &config,
                &table,
                HOST_PID,
                &stop("gen-1"),
                &watch,
                &mut |output| {
                    written.push(output.clone());
                    true
                },
            );
            (ended, written)
        });
        eventually("the older hook waits", || parked(&config));
        hold.store(true, Ordering::SeqCst);
        eventually("the older hook is held", || held.load(Ordering::SeqCst));
        message(&config, &table, "m-1", "ping");
        assert_eq!(
            run(
                &config,
                &table,
                &flags,
                HOOK + 1,
                &stop("gen-1"),
                Some(LONG)
            ),
            (true, vec![json!({"followup_message": "ping"})])
        );
        message(&config, &table, "m-2", "pong");
        hold.store(false, Ordering::SeqCst);
        assert_eq!(older.join().unwrap(), (Ended::Retired, vec![]));
    });
    assert_eq!(staged(&config), 1);
    assert!(!waiting(&config));
}

#[test]
fn a_prompt_starting_a_newer_turn_retires_the_waiting_hook() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    std::thread::scope(|scope| {
        let hook = scope.spawn(|| park(&config, &table, &flags, HOOK, &stop("gen-1"), LONG, true));
        eventually("the hook waits", || parked(&config));
        // Its hook only retires the waiting one, and says nothing.
        assert_eq!(
            run(
                &config,
                &table,
                &flags,
                HOOK + 1,
                &turn("beforeSubmitPrompt", "gen-2"),
                None
            ),
            (false, vec![])
        );
        assert_eq!(hook.join().unwrap(), (Ended::Retired, vec![]));
    });
    // The newer turn gets the message at its own next boundary.
    message(&config, &table, "m-1", "ping");
    assert_eq!(
        run(
            &config,
            &table,
            &flags,
            HOOK + 2,
            &turn("postToolUse", "gen-2"),
            None
        ),
        (true, vec![json!({"additional_context": "ping"})])
    );
}

#[test]
fn a_stop_hook_of_an_older_turn_run_late_neither_claims_nor_waits() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    // Newer turns start, one after another, while gen-1's stop hook is
    // still starting.
    for number in 1..=40 {
        assert_eq!(
            run(
                &config,
                &table,
                &flags,
                HOOK,
                &turn("beforeSubmitPrompt", &format!("gen-{number}")),
                None
            ),
            (false, vec![])
        );
    }
    place(&config, "m-1", "ping");
    let started = Instant::now();
    assert_eq!(
        run(
            &config,
            &table,
            &flags,
            HOOK + 2,
            &stop("gen-1"),
            Some(LONG)
        ),
        (false, vec![])
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(staged(&config), 1);
    assert!(!waiting(&config));
    // The newest turn's own stop hook takes it.
    assert_eq!(
        run(
            &config,
            &table,
            &flags,
            HOOK + 2,
            &stop("gen-40"),
            Some(LONG)
        ),
        (true, vec![json!({"followup_message": "ping"})])
    );
}

#[test]
fn a_late_hook_of_an_older_turn_leaves_the_current_turns_hook_waiting() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    start(&config, "gen-2");
    std::thread::scope(|scope| {
        let hook = scope.spawn(|| park(&config, &table, &flags, HOOK, &stop("gen-2"), LONG, true));
        eventually("the hook waits", || parked(&config));
        assert_eq!(
            run(
                &config,
                &table,
                &flags,
                HOOK + 1,
                &turn("postToolUse", "gen-1"),
                None
            ),
            (false, vec![])
        );
        assert!(waiting(&config));
        // It still wakes the chat.
        message(&config, &table, "m-1", "ping");
        assert_eq!(
            hook.join().unwrap(),
            (Ended::Answered, vec![json!({"followup_message": "ping"})])
        );
    });
}

#[test]
fn a_prompt_records_a_new_conversation_and_hands_nothing_over() {
    let (_temp, config, table) = world();
    table.insert(HOOK, shell(HOST_PID, &[]));
    let flags = Flags::new();
    place(&config, "m-1", "ping");
    assert!(super::super::editor::live(&config, &table, uid(), SESSION).is_none());
    assert_eq!(
        run(
            &config,
            &table,
            &flags,
            HOOK,
            &turn("beforeSubmitPrompt", "gen-1"),
            None
        ),
        (false, vec![])
    );
    assert!(super::super::editor::live(&config, &table, uid(), SESSION).is_some());
    assert_eq!(staged(&config), 1);
}

#[test]
fn an_unknown_current_turn_takes_nothing_until_the_next_turn_starts() {
    let cases: [(&str, fn(&CursorConfig)); 6] = [
        ("its file is missing", |config| {
            std::fs::remove_file(turn_file(config, SESSION)).unwrap()
        }),
        ("its file is corrupt", |config| {
            std::fs::write(turn_file(config, SESSION), "{\"version\": 1, \"gen").unwrap()
        }),
        ("its file is of another version", |config| {
            let later = json!({"version": TURN_VERSION + 1, "generation": "gen-1"});
            std::fs::write(turn_file(config, SESSION), later.to_string()).unwrap()
        }),
        ("its file has no version", |config| {
            let unversioned = json!({"generation": "gen-1"});
            std::fs::write(turn_file(config, SESSION), unversioned.to_string()).unwrap()
        }),
        ("its file is a list", |config| {
            std::fs::write(turn_file(config, SESSION), r#"["gen-1"]"#).unwrap()
        }),
        ("a turn started with no id", |config| {
            let mut unnamed = turn("beforeSubmitPrompt", "gen-2");
            unnamed["generation_id"] = Value::Null;
            turn_seen(config, &unnamed);
        }),
    ];
    for (case, change) in cases {
        let (_temp, config, table) = editor();
        let flags = Flags::new();
        change(&config);
        place(&config, "m-1", "ping");
        let started = Instant::now();
        assert_eq!(
            run(&config, &table, &flags, HOOK, &stop("gen-1"), Some(LONG)),
            (false, vec![]),
            "{case}"
        );
        assert!(started.elapsed() < Duration::from_secs(5), "{case}");
        assert_eq!(staged(&config), 1, "{case}");
        assert!(!waiting(&config), "{case}");
        // The next turn to start writes it again, and its stop hook takes
        // the message.
        start(&config, "gen-3");
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(turn_file(&config, SESSION)).unwrap())
                .unwrap(),
            json!({"version": TURN_VERSION, "generation": "gen-3"}),
            "{case}"
        );
        assert_eq!(
            run(
                &config,
                &table,
                &flags,
                HOOK + 1,
                &stop("gen-3"),
                Some(LONG)
            ),
            (true, vec![json!({"followup_message": "ping"})]),
            "{case}"
        );
    }
}

#[test]
fn a_waiting_hook_whose_current_turn_became_unknown_takes_nothing() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    let ended = std::thread::scope(|scope| {
        let hook = scope.spawn(|| park(&config, &table, &flags, HOOK, &stop("gen-1"), LONG, true));
        eventually("the hook waits", || parked(&config));
        std::fs::write(turn_file(&config, SESSION), "not a turn").unwrap();
        place(&config, "m-1", "ping");
        hook.join().unwrap()
    });
    assert_eq!(ended, (Ended::Retired, vec![]));
    assert_eq!(staged(&config), 1);
}

#[test]
fn a_hook_past_its_wait_takes_nothing() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    place(&config, "m-1", "ping");
    assert_eq!(
        park(
            &config,
            &table,
            &flags,
            HOOK,
            &stop("gen-1"),
            Duration::ZERO,
            true
        ),
        (Ended::TimedOut, vec![])
    );
    assert_eq!(staged(&config), 1);
    assert!(!waiting(&config));
}

#[test]
fn a_message_is_handed_over_once_while_a_newer_turn_starts() {
    for round in 0..25 {
        let (_temp, config, table) = editor();
        let flags = Flags::new();
        let (waited, newer) = std::thread::scope(|scope| {
            let hook =
                scope.spawn(|| park(&config, &table, &flags, HOOK, &stop("gen-1"), LONG, true));
            eventually("the hook waits", || parked(&config));
            let newer = scope.spawn(|| {
                run(
                    &config,
                    &table,
                    &flags,
                    HOOK + 1,
                    &turn("postToolUse", "gen-2"),
                    None,
                )
            });
            message(&config, &table, "m-1", "ping");
            (hook.join().unwrap(), newer.join().unwrap())
        });
        let handed = waited.1.len() + newer.1.len();
        assert_eq!(handed + staged(&config), 1, "round {round}");
        assert_eq!(
            waited.0,
            if waited.1.is_empty() {
                Ended::Retired
            } else {
                Ended::Answered
            },
            "round {round}"
        );
    }
}

#[test]
fn an_answer_that_did_not_get_out_puts_the_message_back() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    let (ended, written) = std::thread::scope(|scope| {
        let hook = scope.spawn(|| park(&config, &table, &flags, HOOK, &stop("gen-1"), LONG, false));
        eventually("the hook waits", || parked(&config));
        message(&config, &table, "m-1", "ping");
        hook.join().unwrap()
    });
    assert_eq!(ended, Ended::Failed);
    assert_eq!(written, vec![json!({"followup_message": "ping"})]);
    assert_eq!(staged(&config), 1);
    assert!(!waiting(&config));
}

#[test]
fn a_waiting_hook_ends_when_its_wait_runs_out_or_it_is_told_to() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    let started = Instant::now();
    let ended = park(
        &config,
        &table,
        &flags,
        HOOK,
        &stop("gen-1"),
        Duration::from_millis(100),
        true,
    );
    assert_eq!(ended, (Ended::TimedOut, vec![]));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!waiting(&config));
    // A message staged afterwards waits for the conversation's next hook.
    message(&config, &table, "m-1", "ping");
    assert_eq!(staged(&config), 1);
    std::fs::remove_file(config.inbox().join(format!("{SESSION}.m-1.msg"))).unwrap();

    for (case, flag) in [
        (Ended::Stopped, &flags.stopping),
        (Ended::Removed, &flags.installed),
    ] {
        std::thread::scope(|scope| {
            let hook =
                scope.spawn(|| park(&config, &table, &flags, HOOK, &stop("gen-1"), LONG, true));
            eventually("the hook waits", || parked(&config));
            flag.store(case == Ended::Stopped, Ordering::SeqCst);
            assert_eq!(hook.join().unwrap(), (case, vec![]));
        });
        assert!(!waiting(&config), "{case:?}");
        flags.stopping.store(false, Ordering::SeqCst);
        flags.installed.store(true, Ordering::SeqCst);
    }
}

#[test]
fn a_hook_whose_entry_was_taken_out_hands_nothing_over() {
    let (_temp, config, table) = editor();
    let flags = Flags::new();
    // Taken out as the turn ended, with a message pending: only the claim
    // sees it gone.
    flags.claims.store(false, Ordering::SeqCst);
    place(&config, "m-1", "ping");
    assert_eq!(
        run(&config, &table, &flags, HOOK, &stop("gen-1"), Some(LONG)),
        (false, vec![])
    );
    assert_eq!(staged(&config), 1);
    assert!(!waiting(&config));
    // Taken out while the hook waits, as a message arrives.
    flags.claims.store(true, Ordering::SeqCst);
    std::fs::remove_file(config.inbox().join(format!("{SESSION}.m-1.msg"))).unwrap();
    let ended = std::thread::scope(|scope| {
        let hook = scope.spawn(|| park(&config, &table, &flags, HOOK, &stop("gen-1"), LONG, true));
        eventually("the hook waits", || parked(&config));
        flags.claims.store(false, Ordering::SeqCst);
        place(&config, "m-2", "pong");
        hook.join().unwrap()
    });
    assert_eq!(ended, (Ended::Removed, vec![]));
    assert_eq!(staged(&config), 1);
    assert!(!waiting(&config));
}

/// A real Cursor editor conversation, `RELAY_CURSOR_EDITOR_SESSION`, whose
/// window runs this checkout's hooks with the inbox in the disposable home
/// `RELAY_CURSOR_LIVE_HOME`, its waiting `stop` entry included. For each of
/// `RELAY_CURSOR_WAKE_ROUNDS` rounds (6 by default, one more than Cursor's
/// default limit on follow-ups in a row): once its finished turn's hook
/// waits, the conversation is left idle for `RELAY_CURSOR_WAKE_AFTER`
/// seconds (20), then one message is staged and must be handed over at
/// once, recorded once as a user turn, and followed by a new waiting hook.
#[test]
#[ignore = "needs a Cursor editor conversation running this checkout's waiting hook"]
fn live_editor_conversation_is_woken_by_its_messages() {
    let home = std::path::PathBuf::from(std::env::var("RELAY_CURSOR_LIVE_HOME").unwrap());
    let session = std::env::var("RELAY_CURSOR_EDITOR_SESSION").unwrap();
    let number = |key: &str, default: u64| {
        std::env::var(key)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let rounds = number("RELAY_CURSOR_WAKE_ROUNDS", 6);
    let idle = Duration::from_secs(number("RELAY_CURSOR_WAKE_AFTER", 20));
    let config = CursorConfig::from_env(&|key| std::env::var(key).ok(), &home);
    let table = crate::relay::process::SystemProcesses::default();
    let wait = |what: &str, limit: Duration, check: &dyn Fn() -> bool| {
        let started = Instant::now();
        while !check() {
            assert!(started.elapsed() < limit, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
        started.elapsed()
    };
    let run = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        % 1_000_000;
    let mut previous = None;
    for round in 1..=rounds {
        let parked = wait("a hook waits", Duration::from_secs(300), &|| {
            read(&config, &session).is_some_and(|waiter| Some(&waiter) != previous.as_ref())
        });
        let waiter = read(&config, &session).unwrap();
        let process = table.process(waiter.pid);
        std::thread::sleep(idle);
        assert_eq!(
            read(&config, &session).as_ref(),
            Some(&waiter),
            "round {round}"
        );
        assert!(table.process(waiter.pid) == process && process.is_some());
        let reference = format!("livewake{run:06}{round:02}");
        let text = format!(
            "[via Agent Relay — from @relay-live-test-nobody to @cursor-editor-live · ref {reference}]\nA note from a peer, for a test: reply with only the word PAPAYA-{round} and end your turn. No other action is needed.\n[end of Agent Relay message · ref {reference}]"
        );
        let id = format!("live-wake-{run}-{round}");
        let sent = Instant::now();
        let outcome = send(&config, &table, uid(), &session, &id, &text);
        assert!(
            matches!(outcome, InjectOutcome::Accepted(_)),
            "round {round}: {outcome:?}"
        );
        wait(
            "the message is handed over",
            Duration::from_secs(30),
            &|| send(&config, &table, uid(), &session, &id, &text) == InjectOutcome::Delivered,
        );
        let handed = sent.elapsed();
        wait("the waiting hook ends", Duration::from_secs(30), &|| {
            table.process(waiter.pid) != process
        });
        wait(
            "its transcript records the turn",
            Duration::from_secs(120),
            &|| super::super::inbox::transcript_records(&config, &session, &text),
        );
        let recorded = sent.elapsed();
        let turns = super::super::inbox::transcripts(&config, &session)
            .iter()
            .map(|path| {
                std::fs::read_to_string(path)
                    .unwrap_or_default()
                    .matches(&format!("· ref {reference}]\\nA note"))
                    .count()
            })
            .sum::<usize>();
        assert_eq!(turns, 1, "round {round}: recorded once");
        assert!(pending(&config, &session).is_empty());
        eprintln!(
            "round {round}: hook {} waited {parked:?} before this round, idle {idle:?}; handed over {handed:?} after staging, recorded {recorded:?} after staging",
            waiter.pid
        );
        previous = Some(waiter);
    }
}

fn record(config: &CursorConfig) -> std::path::PathBuf {
    config
        .home
        .join(".agentworkforce/desktop/cursor/editor")
        .join(format!("{SESSION}.json"))
}

#[test]
fn what_is_pending_is_left_when_the_window_went_away_before_the_claim() {
    // Between the hook recording the conversation and its first claim.
    let cases: [(&str, fn(&FakeProcesses, &CursorConfig), Ended); 3] = [
        (
            "its parent exited",
            |table, _| table.insert(HOOK, shell(1, &[])),
            Ended::Orphaned,
        ),
        (
            "the window reloaded",
            |table, _| table.insert(HOST_PID, host(21)),
            Ended::Moved,
        ),
        (
            "its record is gone",
            |_, config| std::fs::remove_file(record(config)).unwrap(),
            Ended::Moved,
        ),
    ];
    for (case, change, expected) in cases {
        let (_temp, config, table) = editor();
        assert!(record_editor_hook(
            &config,
            &table,
            HOOK,
            HOST_PID,
            &stop("gen-1")
        ));
        place(&config, "m-1", "ping");
        change(&table, &config);
        let (never, always) = (|| false, || true);
        let claiming = |claim: &mut dyn FnMut() -> Option<Ended>| claim();
        let watch = watching(HOOK, LONG, &never, &always, &claiming);
        let mut written = Vec::new();
        let ended = super::wait(
            &config,
            &table,
            HOST_PID,
            &stop("gen-1"),
            &watch,
            &mut |output| {
                written.push(output.clone());
                true
            },
        );
        assert_eq!((ended, written), (expected, vec![]), "{case}");
        assert_eq!(staged(&config), 1, "{case}");
        assert!(!waiting(&config), "{case}");
    }
}

#[test]
fn a_conversation_no_longer_given_to_its_window_ends_the_wait() {
    let cases: [(&str, fn(&std::path::Path)); 2] = [
        ("its record is gone", |path| {
            std::fs::remove_file(path).unwrap()
        }),
        ("no hook of it ran within the idle window", |path| {
            let mut record: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            record["seen_ms"] =
                json!(record["seen_ms"].as_i64().unwrap() - editor::IDLE.as_millis() as i64 - 1);
            std::fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
        }),
    ];
    for (case, change) in cases {
        let (_temp, config, table) = editor();
        let flags = Flags::new();
        let ended = std::thread::scope(|scope| {
            let hook =
                scope.spawn(|| park(&config, &table, &flags, HOOK, &stop("gen-1"), LONG, true));
            eventually("the hook waits", || parked(&config));
            change(&record(&config));
            place(&config, "m-1", "ping");
            hook.join().unwrap()
        });
        assert_eq!(ended, (Ended::Moved, vec![]), "{case}");
        assert_eq!(staged(&config), 1, "{case}");
    }
}
