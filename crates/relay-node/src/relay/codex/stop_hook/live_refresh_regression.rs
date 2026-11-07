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
    expected_executable: PathBuf,
    expected_home: PathBuf,
    on_proxy: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl CodexRunner for Runner {
    fn run(&self, _: &Path, _: &[String], _: Duration) -> RunOutcome {
        RunOutcome::NotStarted("No daemon or CLI may be started in this test".into())
    }
    fn proxy(&self, _: &Path) -> std::io::Result<Box<dyn ProxyStream>> {
        Err(std::io::Error::other("unscoped proxy is forbidden"))
    }
    fn proxy_in_home(
        &self,
        executable: &Path,
        home: &Path,
        sqlite: &Path,
    ) -> std::io::Result<Box<dyn ProxyStream>> {
        if executable != self.expected_executable
            || home != self.expected_home
            || sqlite != self.expected_home
        {
            return Err(std::io::Error::other("wrong executable or home"));
        }
        self.proxies.fetch_add(1, Ordering::Relaxed);
        if let Some(change) = self
            .on_proxy
            .lock()
            .map_err(|_| std::io::Error::other("fixture poisoned"))?
            .take()
        {
            change();
        }
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
    let api_home = home.canonicalize()?;
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
                let disk = request["params"]["cwds"] == json!([api_home]);
                if !disk && request["params"]["threadId"] != THREAD {
                    return None;
                }
                let mut entries = entries.clone();
                if disk || trusted.load(Ordering::SeqCst) {
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
            executable: Some(executable.clone()),
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
        home: home.clone(),
        table,
        inbox: Arc::new(StopHookInbox::default()),
        runner: Arc::new(Runner {
            stream: Mutex::new(Some(server)),
            proxies: AtomicUsize::new(0),
            expected_executable: executable,
            expected_home: home.canonicalize()?,
            on_proxy: Mutex::new(None),
        }),
        live_trusted,
        seen,
    })
}

fn settings(f: &Fixture) -> anyhow::Result<CodexStopHookSettings> {
    let mut settings = CodexStopHookSettings::new(
        f.home.clone(),
        COMMAND.into(),
        Some("/old-path-cli/codex".into()),
        f.inbox.clone(),
    )
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
    assert!(f.inbox.is_ready(), "disk approval did not complete");
    assert!(
        f.live_trusted.load(Ordering::SeqCst),
        "approved disk hook left stale on the live daemon"
    );
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
    for mode in [
        "none",
        "stdio",
        "other_home",
        "other_user",
        "untrusted",
        "zombie",
    ] {
        let f = fixture(true)?;
        match mode {
            "none" => f.table.remove(10),
            "untrusted" => f.table.trusted_codex.lock().unwrap().clear(),
            "zombie" => {
                f.table
                    .processes
                    .lock()
                    .unwrap()
                    .get_mut(&10)
                    .unwrap()
                    .zombie = true
            }
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
                        daemon
                            .environment
                            .insert("CODEX_SQLITE_HOME".into(), "/missing/sqlite-home".into());
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

#[test]
fn codex_hook_upgrade_already_trusted_is_not_reloaded() -> anyhow::Result<()> {
    for legacy_other_plugin in [false, true] {
        let f = fixture(true)?;
        f.live_trusted.store(true, Ordering::SeqCst);
        if legacy_other_plugin {
            mutate_response(&f, "config/read", |_, response| {
                response["result"]["layers"][0]["config"]["hooks"]["state"]["other-plugin"] =
                    json!({"trusted_hash":"declaration/content"});
            })?;
        }
        settings(&f)?.refresh();
        assert!(
            f.inbox.is_ready(),
            "legacy other plugin: {legacy_other_plugin}"
        );
        assert!(!f
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["method"] == "config/batchWrite"));
    }
    Ok(())
}

#[test]
fn codex_hook_upgrade_rejects_ambiguous_or_changed_owner() -> anyhow::Result<()> {
    for mode in ["ambiguous", "unreadable", "changed", "zombie", "sqlite"] {
        let f = fixture(true)?;
        match mode {
            "ambiguous" => {
                let mut process = f.table.processes.lock().unwrap().get(&10).unwrap().clone();
                process.start = 11;
                f.table.insert(11, process);
            }
            "unreadable" => {
                f.table.unreadable_environment.lock().unwrap().insert(10);
            }
            "sqlite" => {
                f.table
                    .processes
                    .lock()
                    .unwrap()
                    .get_mut(&10)
                    .unwrap()
                    .environment
                    .insert("CODEX_SQLITE_HOME".into(), "/missing/sqlite-home".into());
            }
            _ => {
                let table = f.table.clone();
                *f.runner.on_proxy.lock().unwrap() = Some(Box::new(move || {
                    let mut processes = table.processes.lock().unwrap();
                    let owner = processes.get_mut(&10).unwrap();
                    if mode == "zombie" {
                        owner.zombie = true;
                    } else {
                        owner.start += 1;
                    }
                }));
            }
        }
        settings(&f)?.refresh();
        assert!(!f.inbox.is_ready(), "{mode}");
        assert!(f.seen.lock().unwrap().is_empty(), "{mode}");
    }
    Ok(())
}

/// Mutate a scripted provider reply using the production frame decoder.
fn mutate_response(
    f: &Fixture,
    method: &'static str,
    edit: impl Fn(&Value, &mut Value) + Send + 'static,
) -> anyhow::Result<()> {
    use crate::relay::codex::app_server::{tests::UPGRADED, Decoder};
    let mut guard = f
        .runner
        .stream
        .lock()
        .map_err(|_| anyhow::anyhow!("fixture poisoned"))?;
    let server = guard
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("missing fixture server"))?;
    let original = std::mem::replace(&mut server.answer, Box::new(|_| None));
    server.answer = Box::new(move |request| {
        let bytes = original(request)?;
        if request["method"] != method {
            return Some(bytes);
        }
        let mut decoder = Decoder::default();
        decoder.consume(UPGRADED).ok()?;
        let payload = decoder.consume(&bytes).ok()?.pop()?;
        let mut response: Value = serde_json::from_slice(&payload).ok()?;
        edit(request, &mut response);
        Some(server_frame(&response))
    });
    Ok(())
}

#[test]
fn codex_hook_upgrade_preserves_approval_and_configuration_boundaries() -> anyhow::Result<()> {
    for mode in [
        "other_home",
        "version",
        "approval",
        "disabled",
        "legacy",
        "rpc_error",
        "bytes",
    ] {
        let f = fixture(true)?;
        let method = if matches!(mode, "rpc_error" | "bytes") {
            "config/batchWrite"
        } else {
            "config/read"
        };
        let key = format!("{}:0", f.home.join("hooks.json").display());
        let config = f.home.join("config.toml");
        mutate_response(&f, method, move |_, response| {
            if mode == "rpc_error" {
                response.as_object_mut().unwrap().remove("result");
                response["error"] = json!({"code":-32000,"message":"private provider detail"});
                return;
            }
            if mode == "bytes" {
                std::fs::write(&config, "concurrent configuration change\n").unwrap();
                return;
            }
            let layer = &mut response["result"]["layers"][0];
            match mode {
                "other_home" => layer["name"]["file"] = json!("/unrelated/config.toml"),
                "version" => {
                    layer.as_object_mut().unwrap().remove("version");
                }
                "approval" => {
                    layer["config"]["hooks"]["state"][&key]["trusted_hash"] = json!("unapproved")
                }
                "disabled" => layer["config"]["hooks"]["state"][&key]["enabled"] = json!(false),
                "legacy" => {
                    layer["config"]["hooks"]["state"]["other-plugin"] =
                        json!({"trusted_hash":"declaration/content"})
                }
                _ => unreachable!("covered fixture mode"),
            }
        })?;
        settings(&f)?.refresh();
        assert!(!f.inbox.is_ready(), "{mode}");
        let writes = f
            .seen
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["method"] == "config/batchWrite")
            .count();
        assert_eq!(
            writes,
            usize::from(matches!(mode, "rpc_error" | "bytes")),
            "{mode}"
        );
    }
    Ok(())
}

#[test]
fn codex_hook_upgrade_refreshes_old_loaded_definitions() -> anyhow::Result<()> {
    for stale in ["command", "hash", "missing"] {
        let f = fixture(true)?;
        let trusted = f.live_trusted.clone();
        mutate_response(&f, "hooks/list", move |request, response| {
            if request["params"]["threadId"] != THREAD || trusted.load(Ordering::SeqCst) {
                return;
            }
            let hooks = response["result"]["data"][0]["hooks"]
                .as_array_mut()
                .unwrap();
            if stale == "missing" {
                hooks.clear();
            } else {
                for hook in hooks {
                    if stale == "command" {
                        hook["command"] = json!("'/old/agent-relay-node' relay codex-stop-hook");
                    } else {
                        hook["currentHash"] = json!("old-definition-hash");
                    }
                }
            }
        })?;
        settings(&f)?.refresh();
        assert!(f.inbox.is_ready(), "old loaded definition: {stale}");
        assert!(f.live_trusted.load(Ordering::SeqCst));
        assert_eq!(
            f.seen
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r["method"] == "config/batchWrite")
                .count(),
            1
        );
    }
    Ok(())
}

#[test]
fn codex_hook_upgrade_requires_stable_loaded_snapshot() -> anyhow::Result<()> {
    for initially_ready in [false, true] {
        let f = fixture(true)?;
        f.live_trusted.store(initially_ready, Ordering::SeqCst);
        let seen = f.seen.clone();
        mutate_response(&f, "thread/loaded/list", move |_, response| {
            // A second chat appears while the old chat is being inspected.
            if seen
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r["params"]["threadId"] == THREAD)
                .count()
                >= if initially_ready { 1 } else { 2 }
            {
                response["result"]["data"] = json!([THREAD, "newly-loaded-chat"]);
            }
        })?;
        settings(&f)?.refresh();
        assert!(
            !f.inbox.is_ready(),
            "loaded set changed; initially ready: {initially_ready}"
        );
    }
    Ok(())
}
