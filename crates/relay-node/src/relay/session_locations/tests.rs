use super::*;
use crate::relay::process::{FakeProcess, FakeProcesses};
fn processes() -> FakeProcesses {
    let table = FakeProcesses::default();
    table.insert(
        10,
        FakeProcess {
            uid: 501,
            start: 11,
            executable: Some("/Applications/Ghostty.app/Contents/MacOS/ghostty".into()),
            ..Default::default()
        },
    );
    table.insert(
        20,
        FakeProcess {
            uid: 501,
            start: 21,
            parent: 10,
            ..Default::default()
        },
    );
    table.insert(
        30,
        FakeProcess {
            uid: 501,
            start: 31,
            parent: 20,
            terminal_path: Some("/dev/ttys004".into()),
            ..Default::default()
        },
    );
    table
}
#[test]
fn identifies_exact_terminal_and_process_incarnation() {
    let table = processes();
    let location = from_process(&table, 501, 30).unwrap();
    assert_eq!(location.application, "Ghostty");
    assert_eq!(location.tty.as_deref(), Some("/dev/ttys004"));
    assert_eq!((location.pid, location.process_start), (30, 31));
    // Another pane in the very same app must stay distinct.
    table.insert(
        40,
        FakeProcess {
            uid: 501,
            start: 41,
            parent: 20,
            terminal_path: Some("/dev/ttys005".into()),
            ..Default::default()
        },
    );
    assert_ne!(from_process(&table, 501, 40).unwrap().tty, location.tty);
}
#[test]
fn rejects_missing_tty_cross_user_zombie_and_ancestry_cycles() {
    let table = processes();
    assert!(from_process(&table, 501, 20).is_none());
    assert!(from_process(&table, 502, 30).is_none());
    table.processes.lock().unwrap().get_mut(&30).unwrap().zombie = true;
    assert!(from_process(&table, 501, 30).is_none());
    table.processes.lock().unwrap().get_mut(&30).unwrap().zombie = false;
    table.processes.lock().unwrap().get_mut(&20).unwrap().parent = 30;
    assert!(from_process(&table, 501, 30).is_none());
}
#[test]
fn history_survives_restart_and_keeps_reused_pids_separate() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("origins.db");
    let open = || {
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE IF NOT EXISTS locations(source TEXT, session_id TEXT, pid INTEGER, start TEXT, location TEXT, PRIMARY KEY(source,session_id,pid,start))").unwrap();
        db
    };
    let mut location = from_process(&processes(), 501, 30).unwrap();
    save(&open(), "codex", "same-id", &[location.clone()]).unwrap();
    location.process_start = 32;
    location.tty = Some("/dev/ttys009".into());
    save(&open(), "codex", "same-id", &[location.clone()]).unwrap();
    save(&open(), "codex", "same-id", &[location]).unwrap();
    assert_eq!(history(&open(), "codex", "same-id").unwrap().len(), 2);
    assert!(history(&open(), "claude", "same-id").unwrap().is_empty());
}
#[test]
fn claude_maps_cli_identity_not_filename_title_or_directory() {
    let root = tempfile::tempdir().unwrap();
    let account = root.path().join("org/account");
    std::fs::create_dir_all(&account).unwrap();
    let write = |file: &str, cli: &str, local: &str, archived: bool| {
        std::fs::write(account.join(file),serde_json::json!({"sessionId":local,"cliSessionId":cli,"title":"same title","cwd":"/same/repo","isArchived":archived}).to_string()).unwrap()
    };
    write("unrelated-name.json", "cli-1", "local_exact", false);
    write("other.json", "cli-2", "local_other", false);
    assert_eq!(
        claude_desktop_id(root.path(), "cli-1").as_deref(),
        Some("local_exact")
    );
    write("duplicate.json", "cli-1", "local_ambiguous", false);
    assert!(claude_desktop_id(root.path(), "cli-1").is_none());
    write("duplicate.json", "cli-1", "local_ambiguous", true);
    assert!(claude_desktop_id(root.path(), "missing").is_none());
    assert_eq!(
        claude_desktop_id(root.path(), "cli-1").as_deref(),
        Some("local_exact")
    );
}

#[test]
fn incarnation_change_between_discovery_and_location_cannot_focus_recycled_pid() {
    let table = processes();
    let observed = table.process(30).unwrap();
    table.processes.lock().unwrap().get_mut(&30).unwrap().start += 1;
    assert!(locations(&table, 501, [observed].into_iter()).is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn discovery_records_terminal_and_report_preserves_it_after_exit_without_focus() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = LocalConfig::from_env(&|_| None, dir.path());
    config.uid = 501;
    config.probe_root = Some(dir.path().join("probe"));
    let table = processes();
    let id = "550e8400-e29b-41d4-a716-446655440000";
    {
        let mut processes = table.processes.lock().unwrap();
        let codex = processes.get_mut(&30).unwrap();
        codex.executable = Some("/tools/codex".into());
        codex.arguments = vec!["codex".into(), "resume".into(), id.into()];
    }
    table.trust("/tools/codex");
    observe(
        &config,
        &table,
        &[DiscoveredSession {
            target: crate::relay::store::Target::new(crate::relay::store::SessionKind::Codex, id),
            title: "Title is not identity".into(),
            directory: Some("/same/repo".into()),
            updated_at_ms: None,
            host: None,
            live: true,
            holder: None,
        }],
    );
    let current = report(&config, &table, "codex", id).unwrap();
    assert!(current.running);
    assert_eq!(current.current.len(), 1);
    assert_eq!(current.current[0].tty.as_deref(), Some("/dev/ttys004"));
    table.remove(30);
    let ended = report(&config.clone(), &table, "codex", id).unwrap();
    assert!(!ended.running);
    assert!(ended.current.is_empty());
    assert_eq!(ended.previous.len(), 1);
    assert_eq!(ended.previous[0].application, "Ghostty");
    // The same PID in another terminal without proof of this thread is not it.
    table.insert(
        30,
        FakeProcess {
            uid: 501,
            start: 32,
            parent: 20,
            executable: Some("/tools/codex".into()),
            arguments: vec!["codex".into()],
            terminal_path: Some("/dev/ttys009".into()),
            ..Default::default()
        },
    );
    let reused = report(&config, &table, "codex", id).unwrap();
    assert!(reused.current.is_empty());
    assert_eq!(reused.previous[0].tty.as_deref(), Some("/dev/ttys004"));
}

#[test]
fn terminal_recognition_is_independent_of_navigation_adapter_support() {
    let table = processes();
    for (exe, name) in [
        ("/Applications/Warp.app/Contents/MacOS/stable", "Warp"),
        ("/Applications/kitty.app/Contents/MacOS/kitty", "Kitty"),
        (
            "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
            "WezTerm",
        ),
        (
            "/Applications/Alacritty.app/Contents/MacOS/alacritty",
            "Alacritty",
        ),
        (
            "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
            "Visual Studio Code",
        ),
    ] {
        table
            .processes
            .lock()
            .unwrap()
            .get_mut(&10)
            .unwrap()
            .executable = Some(exe.into());
        let location = from_process(&table, 501, 30).unwrap();
        assert_eq!(location.application, name);
        assert_eq!(location.tty.as_deref(), Some("/dev/ttys004"));
    }
}
