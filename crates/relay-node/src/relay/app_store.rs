//! The desktop's own data directory and the workspace fields of its agent
//! store, `injectable-agents.json`.
//!
//! The data directory is `~/Library/Application Support/com.agentrelay.desktop`
//! on macOS and `$XDG_DATA_HOME/com.agentrelay.desktop` (default
//! `~/.local/share/…`) on Linux; `--app-data-dir` names another (Agent Relay
//! Dev keeps `com.agentrelay.desktop.dev`). Discovery reads only the
//! account's workspace here, decoded (and migrated in memory) by
//! `relay::store`; the file is never written by this module.

use crate::relay::store::Store;
use crate::relay::workspace::Secret;
use std::path::{Path, PathBuf};

pub const APP_ID: &str = "com.agentrelay.desktop";
pub const STORE_FILE: &str = "injectable-agents.json";

/// The platform's data directory for this app.
pub fn default_data_dir(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        return home.join("Library/Application Support").join(APP_ID);
    }
    let base = env("XDG_DATA_HOME")
        .filter(|value| Path::new(value.trim()).is_absolute())
        .map(|value| PathBuf::from(value.trim()))
        .unwrap_or_else(|| home.join(".local/share"));
    base.join(APP_ID)
}

/// An explicit data directory, else the default. A relative one is a
/// sibling of the default: a launchd property list names
/// `com.agentrelay.desktop.dev` without `~`.
pub fn resolve_data_dir(
    explicit: Option<&Path>,
    env: &dyn Fn(&str) -> Option<String>,
    home: &Path,
) -> PathBuf {
    let default = default_data_dir(env, home);
    match explicit {
        Some(dir) if dir.is_relative() => default
            .parent()
            .map_or_else(|| dir.to_path_buf(), |parent| parent.join(dir)),
        Some(dir) => dir.to_path_buf(),
        None => default,
    }
}

/// The signed-in account's Relaycast workspace.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CloudWorkspace {
    pub key: Secret,
    pub base_url: String,
    pub workspace_id: Option<String>,
    pub name: Option<String>,
}

/// Reads the account's workspace from the store in `data_dir`. A missing or
/// undecodable store has none; the store's owner reports and sets it aside.
pub fn load_cloud(data_dir: &Path) -> Option<CloudWorkspace> {
    decode_cloud(&std::fs::read(data_dir.join(STORE_FILE)).ok()?)
}

pub fn decode_cloud(bytes: &[u8]) -> Option<CloudWorkspace> {
    let cloud = Store::decode(bytes, "computer").ok()?.store.cloud?;
    Some(CloudWorkspace {
        key: cloud.key,
        base_url: cloud.base_url,
        workspace_id: cloud.workspace_id,
        name: cloud.name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_account_workspace_and_drops_a_pasted_key() {
        let cloud = decode_cloud(
            br#"{"registrations":[],"tokens":{},"workspaceKey":"rk_live_pasted000",
                "cloud":{"key":"rk_live_account00","baseURL":"https://cast.agentrelay.com","workspaceID":"rw_1","name":"Acme"}}"#,
        )
        .unwrap();
        assert_eq!(cloud.key.expose(), "rk_live_account00");
        assert_eq!(cloud.workspace_id.as_deref(), Some("rw_1"));
        assert_eq!(
            decode_cloud(br#"{"workspaceKey":"rk_live_pasted000"}"#),
            None
        );
    }

    // Ported from InjectableAgentsTests.testASignInKeyStoredBy2026_09_5MovesToTheAccountSlot.
    #[test]
    fn a_sign_in_key_stored_as_the_app_key_is_the_accounts() {
        let cloud = decode_cloud(
            br#"{"workspaceKey":"rk_live_signin000","workspaceKeySource":"your Agent Relay sign-in","workspaceBaseURL":"https://cast.agentrelay.com"}"#,
        );
        assert_eq!(cloud.unwrap().key.expose(), "rk_live_signin000");
    }

    #[test]
    fn keys_never_print() {
        let cloud = decode_cloud(br#"{"cloud":{"key":"rk_live_account00"}}"#);
        let printed = format!("{cloud:?}");
        assert!(!printed.contains("account00"), "{printed}");
    }

    #[test]
    fn a_missing_or_broken_store_has_no_workspace() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(load_cloud(temp.path()), None);
        std::fs::write(temp.path().join(STORE_FILE), b"{not json").unwrap();
        assert_eq!(load_cloud(temp.path()), None);
    }

    #[cfg(windows)]
    #[test]
    fn the_data_directory_is_under_the_profile_on_windows() {
        let home = Path::new(r"C:\Users\a");
        assert_eq!(
            default_data_dir(&|_| None, home),
            PathBuf::from(r"C:\Users\a")
                .join(".local/share")
                .join(APP_ID)
        );
        assert_eq!(
            resolve_data_dir(Some(Path::new(r"D:\d")), &|_| None, home),
            PathBuf::from(r"D:\d")
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_data_directory_is_per_platform() {
        let home = Path::new("/home/a");
        let relative = resolve_data_dir(
            Some(Path::new("com.agentrelay.desktop.dev")),
            &|_| None,
            home,
        );
        assert_eq!(
            relative.parent(),
            default_data_dir(&|_| None, home).parent()
        );
        assert!(relative.ends_with("com.agentrelay.desktop.dev"));
        assert_eq!(
            resolve_data_dir(Some(Path::new("/d")), &|_| None, home),
            PathBuf::from("/d")
        );
        let dir = default_data_dir(&|_| None, home);
        if cfg!(target_os = "macos") {
            assert_eq!(
                dir,
                PathBuf::from("/home/a/Library/Application Support/com.agentrelay.desktop")
            );
        } else {
            assert_eq!(
                dir,
                PathBuf::from("/home/a/.local/share/com.agentrelay.desktop")
            );
            let xdg = |key: &str| (key == "XDG_DATA_HOME").then(|| "/data".to_string());
            assert_eq!(
                default_data_dir(&xdg, home),
                PathBuf::from("/data/com.agentrelay.desktop")
            );
        }
    }
}
