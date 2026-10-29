//! Opt-in real Grok adapter smoke test. Uses existing auth/model configuration.
//! Run only with RELAY_GROK_LIVE_ROOT set to a fresh private absolute folder:
//! cargo test --test grok_owned_live -- --ignored --nocapture
// Grok's leader is a Unix socket; Windows reports Grok unavailable.
#![cfg(unix)]
use agent_relay_probe::relay::harness::{grok, HarnessContext, SpawnFacet};
use agent_relay_probe::relay::inject::InjectOutcome;
use agent_relay_probe::relay::process::SystemProcesses;
use agent_relay_probe::relay::spawn::launch::{Launch, Message, SpawnedProcess};
use agent_relay_probe::relay::store::Target;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MARKER: &str = "AGENT_RELAY_MANAGED_SESSION_MARKER";
struct Cleanup<'a> {
    adapter: &'a grok::GrokAdapter,
    started: Mutex<Option<(Target, SpawnedProcess)>>,
}
impl Cleanup<'_> {
    fn same(&self, process: SpawnedProcess) -> bool {
        process.is(self.adapter.table.process(process.pid))
            && !self.adapter.table.zombie(process.pid)
    }
    fn signal(&self, process: SpawnedProcess, signal: &str) {
        if self.same(process)
            && self
                .adapter
                .table
                .process(process.pid)
                .is_some_and(|p| p.uid == self.adapter.uid)
        {
            let _ = Command::new("/bin/kill")
                .args([signal, &process.pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    fn stop(&self, fallback: bool) -> (bool, bool) {
        let Some((target, process)) = self
            .started
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        else {
            return (true, false);
        };
        // Only compare the opaque marker; never print or persist it.
        let marker = self.adapter.table.environment_var(process.pid, MARKER);
        self.adapter.stop(&target, Some(&process));
        if fallback {
            self.signal(process, "-TERM"); // Also covers failure before the session record exists.
        }
        let deadline = Instant::now() + Duration::from_secs(8);
        while self.same(process) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let forced = self.same(process);
        if forced {
            self.signal(process, "-KILL");
            std::thread::sleep(Duration::from_millis(200));
        }
        let residual = marker.is_some_and(|marker| {
            self.adapter.table.all_pids().into_iter().any(|pid| {
                !self.adapter.table.zombie(pid)
                    && self
                        .adapter
                        .table
                        .process(pid)
                        .is_some_and(|p| p.uid == self.adapter.uid)
                    && self.adapter.table.environment_var(pid, MARKER).as_deref() == Some(&marker)
            })
        });
        (!self.same(process) && !residual, forced)
    }
}
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        let _ = self.stop(true);
    }
}
fn wait_file(path: &Path, expected: &str) {
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if fs::read_to_string(path).is_ok_and(|value| value.trim() == expected) {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("Grok did not produce the expected disposable nonce file");
}
#[test]
#[ignore = "starts real Grok using the current user's existing authenticated profile"]
fn real_grok_owned_adapter_initial_followup_idempotency_and_cleanup() {
    let root = std::env::var_os("RELAY_GROK_LIVE_ROOT")
        .map(std::path::PathBuf::from)
        .expect("set RELAY_GROK_LIVE_ROOT to a fresh private absolute folder");
    assert!(root.is_absolute());
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .expect("live test root must not already exist");
    let workspace = root.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let environment: BTreeMap<String, String> = std::env::vars().collect();
    let home = std::path::PathBuf::from(environment.get("HOME").expect("HOME"));
    let cx = HarnessContext::system(
        &environment,
        &home,
        &root.join("app"),
        Arc::new(SystemProcesses::default()),
    );
    let adapter = grok::GrokAdapter::new(&cx);
    let cleanup = Cleanup {
        adapter: &adapter,
        started: Mutex::new(None),
    };
    let nonce = format!(
        "relay_grok_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let launch = Launch {
        harness: grok::ID, name: "grok-owned-live-test".into(),
        text: format!("This is an authorized disposable local smoke test. Write exactly {nonce} to first.txt in this working folder. Do not edit other files, read credentials, use external messaging, or change any configuration. Then finish."),
        directory: workspace.clone(), full_access: grok::DESCRIPTOR.full_access.unwrap().default,
        message_id: format!("{nonce}_initial"), session_id: "5f7c1f64-8f53-4c33-9d2f-7c1d2f1f0a11".into(),
    };
    let started = |target: &Target, process: Option<SpawnedProcess>| {
        if let Some(process) = process {
            *cleanup.started.lock().unwrap() = Some((target.clone(), process));
        }
    };
    let running = adapter.launch(&launch, &started).unwrap_or_else(|_| {
        panic!("Grok adapter launch failed; inspect only this test's private logs")
    });
    let process = running.process.expect("owned Grok leader identity");
    println!("Grok launch completed; waiting for initial nonce");
    wait_file(&workspace.join("first.txt"), &nonce);
    assert!(adapter.alive(&running.target, Some(&process)));
    let followup = format!("Authorized follow-up for the same disposable smoke test. Append exactly {nonce}_followup followed by one newline to second.txt. Do not edit other files, read credentials, use external messaging, or change configuration. Then finish.");
    let delivery_id = format!("{nonce}_delivery");
    let message_id = format!("{nonce}_message");
    let message = Message {
        delivery_id: &delivery_id,
        message_id: &message_id,
        text: &followup,
        native: false,
    };
    assert!(
        matches!(
            adapter.deliver(&running.target, &message),
            Some(InjectOutcome::Delivered)
        ),
        "follow-up transport did not confirm delivery"
    );
    wait_file(&workspace.join("second.txt"), &format!("{nonce}_followup"));
    let before = fs::read(workspace.join("second.txt")).unwrap();
    assert!(
        matches!(
            adapter.deliver(&running.target, &message),
            Some(InjectOutcome::Delivered)
        ),
        "same delivery id replay was not recognized"
    );
    std::thread::sleep(Duration::from_secs(5));
    assert_eq!(
        fs::read(workspace.join("second.txt")).unwrap(),
        before,
        "same delivery id reran the task"
    );
    assert!(
        adapter.alive(&running.target, Some(&process)),
        "same exact leader must remain live for both turns"
    );
    let (gone, forced) = cleanup.stop(false);
    assert!(
        gone,
        "exact owned leader or marker-bound process survived cleanup"
    );
    assert!(
        !forced,
        "normal adapter cleanup required a test-only SIGKILL fallback"
    );
    fs::write(root.join("result.txt"), format!("initial_nonce=true\nfollowup_nonce=true\nsame_delivery_id_replay=true\nsame_leader=true\ncleanup=true\nleader_pid={}\nleader_start={}\nsession_id={}\n", process.pid, process.start, running.target.id)).unwrap();
    println!("Grok initial, follow-up, idempotent replay and exact cleanup passed");
}
