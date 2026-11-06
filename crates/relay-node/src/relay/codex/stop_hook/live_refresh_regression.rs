//! Disk approval must not report a stale, loaded daemon ready.

use super::*;
use crate::relay::codex::{
    app_server::tests::{server_frame, FakeAppServer},
    runner::{CodexRunner, ProxyStream, RunOutcome},
};
use crate::relay::process::{FakeProcess, FakeProcesses};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

const UID: u32 = 501;
const THREAD: &str = "550e8400-e29b-41d4-a716-000000000000";
const COMMAND: &str = "'/test/agent-relay-node' codex-stop-hook";

struct Runner {
    stream: Mutex<Option<FakeAppServer>>,
    proxies: AtomicUsize,
}
impl CodexRunner for Runner {
    fn run(&self, _: &Path, _: &[String], _: Duration) -> RunOutcome {
        RunOutcome::NotStarted("No daemon or CLI may be started in this test".into())
    }
    fn proxy(&self, _: &Path) -> std::io::Result<Box<dyn ProxyStream>> {
        self.proxies.fetch_add(1, Ordering::Relaxed);
        self.stream
            .lock()
            .map_err(|_| std::io::Error::other("fixture poisoned"))?
            .take()
            .map(|s| Box::new(s) as Box<dyn ProxyStream>)
            .ok_or_else(|| std::io::Error::other("unexpected extra proxy"))
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    inbox: Arc<StopHookInbox>,
    table: Arc<FakeProcesses>,
    runner: Arc<Runner>,
    live_trusted: Arc<AtomicBool>,
    seen: Arc<Mutex<Vec<Value>>>,
}

fn fixture(refresh_works: bool) -> anyhow::Result<Fixture> {
    let temp = tempfile::tempdir()?;
    let home = temp.path().join(".codex");
    std::fs::create_dir_all(&home)?;
    let file = home.join("config.toml");
    std::fs::write(
        &file,
        "# existing approved configuration, preserved exactly\n",
    )?;
    let hook_file = home.join("hooks.json");
    let mut approved = Map::new();
    let mut entries = Vec::new();
    for (index, event) in ["stop", "postToolUse", "sessionStart"]
        .into_iter()
        .enumerate()
    {
        let key = format!("{}:{index}", hook_file.display());
        let hash = format!("approved-{event}");
        approved.insert(key.clone(), json!({"trusted_hash":hash}));
        entries.push(
            json!({"key":key,"currentHash":hash,"eventName":event,"command":COMMAND,
            "sourcePath":hook_file,"enabled":true,"trustStatus":"modified"}),
        );
    }
    let live_trusted = Arc::new(AtomicBool::new(false));
    let trusted = live_trusted.clone();
    let api_file = file.clone();
    let server = FakeAppServer::new(move |request| {
        let result = match request["method"].as_str()? {
            "thread/loaded/list" => json!({"data":[THREAD],"nextCursor":null}),
            "config/read" => json!({"layers":[{"name":{"type":"user","file":api_file},
                "version":"authoritative-version","config":{"hooks":{"state":approved}}}]}),
            "config/batchWrite" => {
                let params = &request["params"];
                if params["edits"] != json!([])
                    || params["reloadUserConfig"] != true
                    || params["expectedVersion"] != "authoritative-version"
                {
                    return None;
                }
                trusted.store(refresh_works, Ordering::SeqCst);
                json!({"status":"ok","version":"authoritative-version"})
            }
            "hooks/list" => {
                if request["params"]["threadId"] != THREAD {
                    return None;
                }
                let mut entries = entries.clone();
                if trusted.load(Ordering::SeqCst) {
                    for entry in &mut entries {
                        entry["trustStatus"] = json!("trusted");
                    }
                }
                json!({"data":[{"hooks":entries,"warnings":[]}]})
            }
            _ => return None,
        };
        Some(server_frame(&json!({"id":request["id"],"result":result})))
    });
    let seen = server.seen.clone();
    let table = Arc::new(FakeProcesses::default());
    let executable = temp.path().join("managed/codex");
    table.trust(&executable);
    table.insert(
        10,
        FakeProcess {
            parent: 1,
            uid: UID,
            start: 10,
            executable: Some(executable),
            arguments: vec![
                "codex".into(),
                "app-server".into(),
                "--listen".into(),
                "unix://".into(),
            ],
            environment: [("CODEX_HOME".into(), home.to_string_lossy().into_owned())].into(),
            ..FakeProcess::default()
        },
    );
    Ok(Fixture {
        _temp: temp,
        home,
        table,
        inbox: Arc::new(StopHookInbox::default()),
        runner: Arc::new(Runner {
            stream: Mutex::new(Some(server)),
            proxies: AtomicUsize::new(0),
        }),
        live_trusted,
        seen,
    })
}

fn settings(f: &Fixture) -> anyhow::Result<CodexStopHookSettings> {
    let mut settings =
        CodexStopHookSettings::new(f.home.clone(), COMMAND.into(), None, f.inbox.clone())
            .with_trust(|_, _| Ok(()));
    // BEGIN_LIVE_RUNTIME_CONTEXT: the old setup had no live reconciliation stage.
    let table = f.table.clone();
    let runner = f.runner.clone();
    settings.live_refresh = Box::new(move |home, command| {
        super::trust::live::refresh_with(home, command, table.as_ref(), runner.as_ref(), UID, None)
    });
    // END_LIVE_RUNTIME_CONTEXT
    let entry = settings.entry();
    std::fs::write(
        f.home.join("hooks.json"),
        serde_json::to_vec(&json!({"hooks":{
            "Stop":[entry.clone()],"PostToolUse":[entry.clone()],"SessionStart":[entry]
        }}))?,
    )?;
    Ok(settings)
}

#[test]
fn codex_hook_upgrade_reconciles_loaded_approved_snapshot() -> anyhow::Result<()> {
    let f = fixture(true)?;
    let settings = settings(&f)?;
    let before = std::fs::read(f.home.join("config.toml"))?;
    settings.refresh();
    assert!(
        f.live_trusted.load(Ordering::SeqCst),
        "approved disk hook left stale on the live daemon"
    );
    assert!(f.inbox.is_ready());
    assert_eq!(before, std::fs::read(f.home.join("config.toml"))?);
    let seen = f.seen.lock().unwrap();
    assert_eq!(
        seen.iter()
            .filter(|r| r["method"] == "config/batchWrite")
            .count(),
        1
    );
    assert!(!seen.iter().any(|r| matches!(
        r["method"].as_str(),
        Some("thread/start" | "thread/resume" | "turn/start" | "config/value/write")
    )));
    Ok(())
}

#[test]
fn codex_hook_upgrade_acknowledgment_is_not_readiness() -> anyhow::Result<()> {
    let f = fixture(false)?;
    settings(&f)?.refresh();
    assert!(!f.inbox.is_ready());
    assert!(!f.live_trusted.load(Ordering::SeqCst));
    Ok(())
}

#[test]
fn codex_hook_upgrade_without_own_shared_daemon_stays_functional() -> anyhow::Result<()> {
    for mode in ["none", "stdio", "other_home", "other_user", "untrusted"] {
        let f = fixture(true)?;
        match mode {
            "none" => f.table.remove(10),
            "untrusted" => f.table.trusted_codex.lock().unwrap().clear(),
            _ => {
                let mut processes = f.table.processes.lock().unwrap();
                let daemon = processes.get_mut(&10).unwrap();
                match mode {
                    "stdio" => daemon.arguments = vec!["codex".into(), "app-server".into()],
                    "other_home" => {
                        daemon.environment.insert(
                            "CODEX_HOME".into(),
                            f._temp.path().to_string_lossy().into_owned(),
                        );
                    }
                    _ => daemon.uid = UID + 1,
                }
            }
        }
        settings(&f)?.refresh();
        assert!(f.inbox.is_ready(), "{mode}");
        assert_eq!(f.runner.proxies.load(Ordering::Relaxed), 0, "{mode}");
    }
    Ok(())
}
