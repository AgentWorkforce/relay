//! The hook's permission rules going into and out of a Claude login's
//! `settings.json` (`permissions`).

use super::*;
use crate::relay::claude_dirs::ClaudeDirs;
use serde_json::json;

const PROBE: &str = "/tmp/arc/relay/bin/agent-relay-probe";
const SOCKET: &str = "/Users/me/Library/Application Support/com.agentrelay.desktop/run/relay.sock";

fn rules() -> PermissionRules {
    PermissionRules {
        probe: PathBuf::from(PROBE),
        socket: PathBuf::from(SOCKET),
    }
}

fn settings_with(root: &Path, rules: PermissionRules) -> ClaudeSessionHookSettings {
    let config = ClaudeConfig {
        home: root.join(".claude"),
        executable: None,
        app_sessions: None,
        dirs: ClaudeDirs::default(),
    };
    ClaudeSessionHookSettings::new(
        &config,
        ClaudeSessionHookSettings::command_for(Path::new(PROBE), false),
    )
    .with_permission_rules(rules, root.join("app-data"))
}

fn settings(root: &Path) -> ClaudeSessionHookSettings {
    settings_with(root, rules())
}

fn login(root: &Path) -> PathBuf {
    let dir = root.join(".claude");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(root.join(".claude.json"), "{}\n").unwrap();
    dir.join("settings.json")
}

fn read(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn allow(path: &Path) -> Vec<String> {
    read(path)["permissions"]["allow"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|rule| rule.as_str().map(str::to_string))
        .collect()
}

/// Every file under `dir`, relative, with its bytes.
fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in std::fs::read_dir(&next).unwrap().flatten() {
            let path = entry.path();
            let name = path.strip_prefix(dir).unwrap().display().to_string();
            if path.is_dir() {
                files.push((format!("{name}/"), Vec::new()));
                stack.push(path);
            } else {
                files.push((name, std::fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

// The relay init end-to-end run on 2026-10-29: Claude Code asked to approve
// both the pointer's read and the reply.
#[test]
fn the_hook_brings_the_rules_for_this_probes_read_and_reply() {
    let root = tempfile::tempdir().unwrap();
    let path = login(root.path());
    let settings = settings(root.path());
    assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
    let all = allow(&path);
    assert_eq!(all, rules().rules());
    assert_eq!(
        all[0],
        format!("Bash({PROBE} relay read --socket '{SOCKET}' *)")
    );
    assert_eq!(
        all[1],
        format!(
            "Bash({PROBE} relay socket-request --socket '{SOCKET}' --method POST --path '/send?*)"
        )
    );
    // Recorded as Agent Relay's, by file.
    let added = permissions::Added::load(&root.path().join("app-data"));
    assert_eq!(added.of(&path), rules().rules().as_slice());
    // On again: nothing is rewritten.
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

// The same run: --uninstall left `{}` behind in an isolated ~/.claude.
#[test]
fn a_fresh_install_taken_out_again_leaves_the_claude_folder_as_it_was() {
    let root = tempfile::tempdir().unwrap();
    let path = login(root.path());
    let claude = path.parent().unwrap().to_path_buf();
    let before = tree(&claude);
    let settings = settings(root.path());
    assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
    assert!(path.is_file());
    settings.refresh();
    assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
    assert_eq!(tree(&claude), before);
    assert!(!root
        .path()
        .join("app-data")
        .join(permissions::RECORD)
        .exists());
}

#[test]
fn the_persons_own_settings_and_rules_come_back_byte_for_byte() {
    let root = tempfile::tempdir().unwrap();
    let path = login(root.path());
    // Their own formatting, their own rules (one the same as Agent Relay's),
    // and an empty list a JSON round trip would keep but not as written.
    let mine = format!(
        "{{ \"model\": \"opus\",\n  \"permissions\": {{ \"allow\": [\"Bash(npm test *)\", \"Bash({PROBE} relay read --socket '{SOCKET}' *)\"], \"deny\": [] }},\n  \"hooks\": {{ \"Stop\": [ {{\"hooks\": [{{\"type\":\"command\",\"command\":\"notify.sh\"}}]}} ] }} }}"
    );
    std::fs::write(&path, &mine).unwrap();
    let claude = path.parent().unwrap().to_path_buf();
    let before = tree(&claude);
    let settings = settings(root.path());

    assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
    let installed = allow(&path);
    assert_eq!(installed.len(), 1 + rules().rules().len(), "{installed:?}");
    assert_eq!(installed[0], "Bash(npm test *)");
    // Only the rule that was not already theirs is Agent Relay's.
    let added = permissions::Added::load(&root.path().join("app-data"));
    assert_eq!(added.of(&path), &rules().rules()[1..]);

    assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
    assert_eq!(tree(&claude), before);
}

#[test]
fn a_file_the_person_changed_since_keeps_their_change_and_their_rules() {
    let root = tempfile::tempdir().unwrap();
    let path = login(root.path());
    std::fs::write(&path, "{\"permissions\":{\"allow\":[\"Bash(ls *)\"]}}\n").unwrap();
    let settings = settings(root.path());
    assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
    let mut value = read(&path);
    value["permissions"]["allow"]
        .as_array_mut()
        .unwrap()
        .push(json!("Bash(git status)"));
    value["model"] = json!("sonnet");
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();

    assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
    assert_eq!(
        read(&path),
        json!({"permissions": {"allow": ["Bash(ls *)", "Bash(git status)"]}, "model": "sonnet"})
    );
    // Their copy from before is kept: the file is not as it was.
    assert!(path
        .with_file_name("settings.json.relay-desktop-backup")
        .exists());
}

#[test]
fn a_moved_probe_or_socket_replaces_the_rules_agent_relay_added() {
    let root = tempfile::tempdir().unwrap();
    let path = login(root.path());
    let old = settings_with(
        root.path(),
        PermissionRules {
            probe: PathBuf::from("/old/agent-relay-probe"),
            socket: PathBuf::from("/old/relay.sock"),
        },
    );
    assert_eq!(old.set(SETTING, &json!(true)), Some(Ok(())));
    let settings = settings(root.path());
    settings.refresh();
    assert_eq!(allow(&path), rules().rules());
    assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
    assert!(!path.exists());
}

#[test]
fn a_permissions_value_of_another_shape_leaves_the_file_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let path = login(root.path());
    std::fs::write(&path, "{\"permissions\":[\"x\"]}\n").unwrap();
    let error = settings(root.path())
        .set(SETTING, &json!(true))
        .unwrap()
        .unwrap_err();
    assert!(error.contains("permissions"), "{error}");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        b"{\"permissions\":[\"x\"]}\n"
    );
}

// Review on #2021: a later login that fails while the hook is taken out
// rolls the earlier ones back, and those keep their copy for the retry.
#[test]
#[cfg(unix)]
fn a_failed_removal_keeps_each_logins_copy_for_the_retry() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let primary = login(root.path());
    std::fs::write(&primary, "{}\n").unwrap();
    let work = root.path().join(".claude-work");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(work.join(".claude.json"), "{}\n").unwrap();
    let settings = settings(root.path());
    assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
    assert!(work.join("settings.json").exists());
    let backup = primary.with_file_name("settings.json.relay-desktop-backup");
    assert!(backup.exists());

    let mode = |mode: u32| {
        let mut permissions = std::fs::metadata(&work).unwrap().permissions();
        permissions.set_mode(mode);
        std::fs::set_permissions(&work, permissions).unwrap();
    };
    mode(0o555);
    if std::fs::File::create(work.join(".probe-write")).is_ok() {
        mode(0o755);
        return; // Running as root: the folder cannot be made unwritable.
    }
    let failed = settings.set(SETTING, &json!(false)).unwrap();
    mode(0o755);
    assert!(failed.is_err(), "{failed:?}");
    assert!(backup.exists(), "the rolled-back login keeps its copy");

    assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
    assert_eq!(std::fs::read(&primary).unwrap(), b"{}\n");
    assert!(!backup.exists());
    assert!(!work.join("settings.json").exists());
}
