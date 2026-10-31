//! Claude Code's `crossSessionInbound` setting, served as `direct_delivery`.
//!
//! The setting decides what a Claude Code session does with a message from
//! outside it: deliver it (`accept`), hold it for the user's approval
//! (`hold`), or drop it (`refuse`). With the default, a session that skips
//! permission prompts holds every message from a sender that does not
//! attest its own permission mode, which includes the relay. Setting
//! `accept` in the user's own Claude settings is Claude Code's documented
//! way to have relayed messages delivered directly; the core changes it
//! only when asked, keeps every other setting, and can remove it again.
//!
//! Organization-managed settings take precedence over the user's, and the
//! core never edits them: a managed value other than `accept` refuses
//! direct delivery.
//!
//! Direct delivery is on by default (`default_on`, the apps' first-run box
//! and the agent-led defaults), but only where the user has not chosen: the
//! key is absent from their own settings file. A key that is present,
//! whatever its value (`hold`, `refuse`, `accept`), is an explicit choice and
//! is left alone. "Ask again" writes `hold`, so it is such a choice too.

use crate::platform::fs as private_fs;
use crate::relay::agents::SettingsExtension;
use crate::relay::claude::ClaudeConfig;
use crate::relay::claude_dirs::{self, ClaudeDirs};
use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const INBOUND_KEY: &str = "crossSessionInbound";
/// Claude Code's own default: a message from an unattested sender is held.
const HOLD: &str = "hold";
pub const ACCEPT: &str = "accept";
/// The `settings.set` key this extension owns.
pub const SETTING: &str = "direct_delivery";
/// Claude Code's `crossSessionInbound` that refuses every relayed message.
const REFUSE: &str = "refuse";
/// Read-only: the organization-managed `crossSessionInbound`, which a user
/// setting cannot override, else null.
pub const MANAGED_SETTING: &str = "direct_delivery_managed";
/// Write-only: `true` turns direct delivery on unless the user's own
/// settings already name `crossSessionInbound`; `false` changes nothing.
pub const DEFAULT_SETTING: &str = "direct_delivery_default";
/// Appended to the settings file's name for the one-time copy of the
/// original.
pub const BACKUP_SUFFIX: &str = ".relay-desktop-backup";

/// Where Claude Code reads organization-managed settings.
#[cfg(target_os = "macos")]
pub const MANAGED_SETTINGS: &str = "/Library/Application Support/ClaudeCode/managed-settings.json";
#[cfg(not(target_os = "macos"))]
pub const MANAGED_SETTINGS: &str = "/etc/claude-code/managed-settings.json";

const MANAGED_REFUSAL: &str = "Managed Claude settings do not allow direct delivery.";

/// Why direct delivery could not be set. The messages are safe to show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DirectDeliveryError {
    /// Managed settings pin a value other than `accept`.
    ManagedPolicy,
    /// The user's settings file could not be read or written; it is
    /// unchanged.
    Failed(String),
}

impl std::fmt::Display for DirectDeliveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DirectDeliveryError::ManagedPolicy => f.write_str(MANAGED_REFUSAL),
            DirectDeliveryError::Failed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for DirectDeliveryError {}

/// The settings file is not a JSON object, so it is not rewritten.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unreadable;

impl std::fmt::Display for Unreadable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Your Claude settings file is not valid JSON, so it was left unchanged. \
             Fix it or add \"{INBOUND_KEY}\": \"{ACCEPT}\" by hand."
        )
    }
}

/// `crossSessionInbound` in a settings file, or `None` when the file, or a
/// string value under the key, is absent or unreadable.
pub fn inbound_value(settings: Option<&[u8]>) -> Option<String> {
    let object: Value = serde_json::from_slice(settings?).ok()?;
    object.get(INBOUND_KEY)?.as_str().map(str::to_string)
}

/// The settings file with `crossSessionInbound` set to `value`, or removed
/// when `value` is `None`. Every other key is kept; an absent or blank
/// file starts empty.
pub fn with_inbound(value: Option<&str>, settings: Option<&[u8]>) -> Result<Vec<u8>, Unreadable> {
    let mut object = match settings.filter(|s| !s.trim_ascii().is_empty()) {
        None => Map::new(),
        Some(settings) => match serde_json::from_slice(settings) {
            Ok(Value::Object(object)) => object,
            _ => return Err(Unreadable),
        },
    };
    match value {
        Some(value) => {
            object.insert(INBOUND_KEY.into(), Value::String(value.into()));
        }
        None => {
            object.remove(INBOUND_KEY);
        }
    }
    let mut bytes = serde_json::to_vec_pretty(&Value::Object(object)).map_err(|_| Unreadable)?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// The user's and the managed Claude settings files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeSettings {
    pub user_settings: PathBuf,
    pub managed_settings: PathBuf,
    /// The person's other Claude config folders; empty on another login's
    /// own settings.
    pub dirs: ClaudeDirs,
}

impl ClaudeSettings {
    pub fn new(claude: &ClaudeConfig) -> ClaudeSettings {
        ClaudeSettings {
            user_settings: claude.home.join("settings.json"),
            managed_settings: PathBuf::from(MANAGED_SETTINGS),
            dirs: claude.dirs.clone(),
        }
    }

    /// The user's own `crossSessionInbound`.
    pub fn user_value(&self) -> Option<String> {
        inbound_value(std::fs::read(&self.user_settings).ok().as_deref())
    }

    /// The organization-managed `crossSessionInbound`, which wins over the
    /// user's.
    pub fn managed_value(&self) -> Option<String> {
        inbound_value(std::fs::read(&self.managed_settings).ok().as_deref())
    }

    /// The user's own `crossSessionInbound` whenever their settings name
    /// the key, with any value (a value that is not a string as its JSON
    /// text): an explicit choice the first-run default never overrides.
    /// An absent key, or an absent, blank or unparseable file, is `None`.
    pub fn user_choice(&self) -> Option<String> {
        let settings: Value =
            serde_json::from_slice(&std::fs::read(&self.user_settings).ok()?).ok()?;
        let value = settings.get(INBOUND_KEY)?;
        Some(
            value
                .as_str()
                .map_or_else(|| value.to_string(), str::to_string),
        )
    }

    /// The user's own settings name `crossSessionInbound`.
    pub fn user_chose(&self) -> bool {
        self.user_choice().is_some()
    }

    /// The first-run default: direct delivery on unless the user already
    /// chose (`user_chose`), and never against a managed setting.
    fn apply_own_default(&self) -> Result<(), DirectDeliveryError> {
        if self.managed_value().is_some_and(|m| m != ACCEPT) {
            return Err(DirectDeliveryError::ManagedPolicy);
        }
        if self.user_chose() {
            return Ok(());
        }
        self.set_own_direct_delivery(true)
    }

    /// Relayed messages reach a Claude Code session without waiting for
    /// approval.
    fn own_delivers_directly(&self) -> bool {
        self.managed_value()
            .or_else(|| self.user_value())
            .as_deref()
            == Some(ACCEPT)
    }

    /// Turns direct delivery on (`crossSessionInbound: "accept"` in the
    /// user's settings) or off ("Ask again": `hold`). A file
    /// already as asked is not rewritten. The lock covers the read and the
    /// write, so the SessionStart hook cannot replace this file with a copy
    /// it read earlier.
    fn set_own_direct_delivery(&self, enabled: bool) -> Result<(), DirectDeliveryError> {
        let _edit = claude_settings_edit_lock();
        if enabled {
            if self.managed_value().is_some_and(|m| m != ACCEPT) {
                return Err(DirectDeliveryError::ManagedPolicy);
            }
            if self.own_delivers_directly() {
                return Ok(());
            }
            self.write_user(Some(ACCEPT))?;
            if !self.own_delivers_directly() {
                return Err(DirectDeliveryError::ManagedPolicy);
            }
            Ok(())
        } else {
            // Turning direct delivery off writes Claude Code's own default,
            // `hold`, rather than removing the key: the person's choice then
            // lives in Claude's settings too, so the on-by-default pass sees
            // it even if the desktop's record of it could not be saved.
            // Where Claude Code has never run there is nothing to keep, and
            // a value the person set that already stops direct delivery
            // (`hold`, `refuse`) is theirs: off never weakens `refuse`.
            let claude_home = self.user_settings.parent().is_some_and(Path::is_dir);
            if !claude_home || self.user_choice().is_some_and(|v| v != ACCEPT) {
                return Ok(());
            }
            self.write_user(Some(HOLD))
        }
    }

    /// The person's other Claude logins with settings of their own: every
    /// other watched config folder (`ClaudeDirs::watched`: sibling `.claude`
    /// and `.claude-<name>` folders, as account switchers for Conductor keep,
    /// folders named in `AGENT_RELAY_CLAUDE_CONFIG_DIRS` or added in
    /// Settings, and running sessions' `CLAUDE_CONFIG_DIR`) that holds a
    /// `.claude.json` and whose `settings.json` is not this one's (a login
    /// sharing it by a link is this login). Claude Code reads
    /// `crossSessionInbound` from each session's own login.
    pub fn other_logins(&self) -> Vec<ClaudeSettings> {
        let Some(home) = self.user_settings.parent() else {
            return Vec::new();
        };
        // `extra_homes` lists only shared folders: an unshared login's
        // settings are left as the person has them.
        self.logins_in(self.dirs.extra_homes(home))
    }

    /// This login, then every shared other login (`other_logins`). The
    /// SessionStart hook installs into this list. A folder the person has
    /// turned off is not here; `watched_logins` still lists it so a hook
    /// written earlier can be removed.
    pub fn login_settings(&self) -> Vec<ClaudeSettings> {
        std::iter::once(self.clone())
            .chain(self.other_logins())
            .collect()
    }

    /// Every watched login, shared or not, this one first when its
    /// directory exists. Other folders count only when they hold
    /// `.claude.json`. A login that shares this one's `settings.json` by a
    /// link is this login.
    pub fn watched_logins(&self) -> Vec<ClaudeSettings> {
        let Some(home) = self.user_settings.parent() else {
            return Vec::new();
        };
        let mut logins = Vec::new();
        if home.is_dir() {
            logins.push(self.clone());
        }
        let rest = self
            .dirs
            .watched(home)
            .into_iter()
            .skip(1)
            .map(|dir| dir.path);
        logins.extend(self.logins_in(rest));
        logins
    }

    fn logins_in(&self, folders: impl IntoIterator<Item = PathBuf>) -> Vec<ClaudeSettings> {
        let real =
            |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| resolve_symlinks(path));
        let mut seen = std::collections::HashSet::from([real(&self.user_settings)]);
        folders
            .into_iter()
            .filter(|folder| folder.join(".claude.json").is_file())
            .map(|folder| folder.join("settings.json"))
            .filter(|settings| seen.insert(real(settings)))
            .map(|settings| ClaudeSettings {
                user_settings: settings,
                managed_settings: self.managed_settings.clone(),
                dirs: ClaudeDirs::default(),
            })
            .collect()
    }

    /// The first-run default: direct delivery on unless the user already
    /// chose (`user_chose`) on this login, and never against a managed
    /// setting. Other logins follow (`set_direct_delivery`).
    pub fn apply_default(&self) -> Result<(), DirectDeliveryError> {
        self.apply_own_default()?;
        self.follow_default()
    }

    /// Relayed messages reach a Claude Code session without waiting for
    /// approval, on every login of this person's.
    pub fn delivers_directly(&self) -> bool {
        self.own_delivers_directly()
            && self
                .other_logins()
                .iter()
                .all(ClaudeSettings::own_delivers_directly)
    }

    /// Turns direct delivery on or off. Other logins follow this one,
    /// except that a login whose own settings say `refuse` is never
    /// weakened; turning off writes `hold` only where it was on.
    pub fn set_direct_delivery(&self, enabled: bool) -> Result<(), DirectDeliveryError> {
        self.set_own_direct_delivery(enabled)?;
        for login in self.other_logins() {
            if login.user_value().as_deref() == Some(REFUSE) {
                continue;
            }
            login.set_own_direct_delivery(enabled)?;
        }
        Ok(())
    }

    /// Brings other logins in line with this one where it delivers
    /// directly: a login added since (a new `~/.claude-<name>`) gets
    /// `accept` too, unless its own settings say `refuse`. Run at core start.
    pub fn follow_default(&self) -> Result<(), DirectDeliveryError> {
        if !self.own_delivers_directly() {
            return Ok(());
        }
        for login in self.other_logins() {
            if !login.own_delivers_directly() && login.user_value().as_deref() != Some(REFUSE) {
                login.set_own_direct_delivery(true)?;
            }
        }
        Ok(())
    }

    /// Rewrites the user's settings with `value`. A symlinked file (dotfiles
    /// kept in a repository) is rewritten at its target, so the link stays a
    /// link; the file's mode is kept; the original is copied once beside it.
    fn write_user(&self, value: Option<&str>) -> Result<(), DirectDeliveryError> {
        let failed = |e: std::io::Error| {
            DirectDeliveryError::Failed(format!("Could not save your Claude settings: {e}"))
        };
        let path = resolve_symlinks(&self.user_settings);
        let existing = match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(failed(e)),
        };
        let updated = with_inbound(value, existing.as_deref())
            .map_err(|e| DirectDeliveryError::Failed(e.to_string()))?;
        // A new file is private: settings can come to hold secrets (`env`).
        write_keeping_file(&path, existing.as_deref(), &updated, BACKUP_SUFFIX, 0o600)
            .map_err(failed)
    }
}

/// One lock for every read-modify-write of a Claude `settings.json`.
/// Direct delivery and the SessionStart hook both rewrite that file; without
/// a shared lock the one that writes last drops the other's key.
pub(crate) fn claude_settings_edit_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Replaces the file at `path` (already symlink-resolved) with `updated`,
/// atomically. The file's mode is kept (`default_mode` for a new file), its
/// parent is created private, and `existing`, the bytes read before, is
/// copied once beside it under `backup_suffix`, keeping the same mode since
/// the original may hold secrets. Shared by the Claude and Grok settings
/// editors.
pub(crate) fn write_keeping_file(
    path: &Path,
    existing: Option<&[u8]>,
    updated: &[u8],
    backup_suffix: &str,
    default_mode: u32,
) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    private_fs::create_private_dir_all(parent)?;
    // Windows has no mode to keep (`mode_of` is `None`): the files inherit
    // the profile's owner-only access list, as the original did.
    let mode = std::fs::metadata(path)
        .ok()
        .and_then(|m| private_fs::mode_of(&m))
        .map(|mode| mode & 0o777)
        .unwrap_or(default_mode);
    if let Some(existing) = existing {
        let mut backup = path.to_path_buf().into_os_string();
        backup.push(backup_suffix);
        let backup = PathBuf::from(backup);
        if std::fs::symlink_metadata(&backup).is_err() {
            let mut file = private_fs::with_mode(
                std::fs::OpenOptions::new().write(true).create_new(true),
                mode,
            )
            .open(&backup)?;
            file.write_all(existing)?;
        }
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".settings.")
        .tempfile_in(parent)?;
    temporary.write_all(updated)?;
    temporary.as_file().sync_all()?;
    private_fs::set_mode(temporary.path(), mode)?;
    temporary.persist(path).map_err(|e| e.error)?;
    Ok(())
}

/// `path` with every symlink followed, also when the final target does not
/// exist yet.
pub(crate) fn resolve_symlinks(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    for _ in 0..40 {
        let is_link = std::fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink());
        if !is_link {
            break;
        }
        let Ok(target) = std::fs::read_link(&current) else {
            break;
        };
        current = match current.parent() {
            Some(parent) => parent.join(target),
            None => target,
        };
    }
    current
}

/// The folders a `claude_config_dirs` value lists, if it is a list of them.
fn folder_list(value: &Value) -> Option<Vec<String>> {
    value.as_array().and_then(|folders| {
        folders
            .iter()
            .map(|f| f.as_str().map(str::to_string))
            .collect()
    })
}

impl SettingsExtension for ClaudeSettings {
    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        settings.insert(SETTING.into(), Value::Bool(self.delivers_directly()));
        settings.insert(
            MANAGED_SETTING.into(),
            self.managed_value().map_or(Value::Null, Value::String),
        );
        if let Some(home) = self.user_settings.parent() {
            settings.insert(
                claude_dirs::SETTING.into(),
                serde_json::to_value(self.dirs.watched(home)).unwrap_or(Value::Null),
            );
        }
        settings.insert(
            claude_dirs::CLOUD_SETTING.into(),
            Value::Bool(self.dirs.cloud_sessions()),
        );
        settings
    }

    fn refuse(&self, key: &str, value: &Value) -> Option<String> {
        if key == claude_dirs::CHOICE_SETTING {
            if value["path"].as_str().is_none() || value["shared"].as_bool().is_none() {
                return Some(format!(
                    "{} must name a folder's path and whether it is shared.",
                    claude_dirs::CHOICE_SETTING
                ));
            }
            if self.user_settings.parent().is_none() {
                return Some("Claude Code's folder is unknown.".into());
            }
        }
        if key == claude_dirs::SETTING && folder_list(value).is_none() {
            return Some(format!(
                "{} must be a list of folders.",
                claude_dirs::SETTING
            ));
        }
        if key == MANAGED_SETTING {
            return Some(format!(
                "{MANAGED_SETTING} is your organization's; it cannot be changed here."
            ));
        }
        None
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if let Some(refused) = self.refuse(key, value) {
            return Some(Err(refused));
        }
        if key == claude_dirs::CHOICE_SETTING {
            let (Some(path), Some(shared), Some(home)) = (
                value["path"].as_str(),
                value["shared"].as_bool(),
                self.user_settings.parent(),
            ) else {
                return Some(Err("Claude Code's folder is unknown.".into()));
            };
            return Some(self.dirs.set_shared(path, shared, home));
        }
        if key == claude_dirs::CLOUD_SETTING {
            let Some(on) = value.as_bool() else {
                return Some(Err(format!(
                    "{} must be true or false.",
                    claude_dirs::CLOUD_SETTING
                )));
            };
            return Some(self.dirs.set_cloud_sessions(on));
        }
        if key == claude_dirs::SETTING {
            let Some(folders) = folder_list(value) else {
                return Some(Err(format!(
                    "{} must be a list of folders.",
                    claude_dirs::SETTING
                )));
            };
            let home = crate::relay::paths::home().unwrap_or_default();
            return Some(self.dirs.set_added(&folders, &home));
        }
        if key == DEFAULT_SETTING {
            let Some(enabled) = value.as_bool() else {
                return Some(Err(format!("{DEFAULT_SETTING} must be true or false.")));
            };
            if !enabled {
                return Some(Ok(()));
            }
            return Some(self.apply_default().map_err(|e| e.to_string()));
        }
        if key != SETTING {
            return None;
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        Some(self.set_direct_delivery(enabled).map_err(|e| e.to_string()))
    }

    /// Direct delivery is on by default wherever Claude Code has run, unless
    /// the organization pins it or the person's own settings already name a
    /// `crossSessionInbound` value, which is their choice.
    ///
    fn default_on(&self) -> Vec<&'static str> {
        let installed = self.user_settings.parent().is_some_and(Path::is_dir);
        if installed && self.managed_value().is_none() && !self.user_chose() {
            vec![SETTING]
        } else {
            Vec::new()
        }
    }

    fn write_only(&self) -> &'static [&'static str] {
        &[DEFAULT_SETTING, claude_dirs::CHOICE_SETTING]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn settings(dir: &Path) -> ClaudeSettings {
        ClaudeSettings {
            user_settings: dir.join("claude/settings.json"),
            managed_settings: dir.join("managed-settings.json"),
            dirs: Default::default(),
        }
    }

    // A login under any name (`~/.seclaude`) that is watched follows
    // direct delivery like a sibling, and the watched folders are a setting.
    #[test]
    fn watched_config_folders_are_logins_and_a_setting() {
        let dir = tempfile::tempdir().unwrap();
        let default = ClaudeSettings {
            user_settings: dir.path().join(".claude/settings.json"),
            managed_settings: dir.path().join("managed-settings.json"),
            dirs: ClaudeDirs {
                environment: Vec::new(),
                file: Some(dir.path().join("relay").join(claude_dirs::FILE)),
            },
        };
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        std::fs::create_dir_all(dir.path().join(".seclaude")).unwrap();
        std::fs::write(dir.path().join(".seclaude/.claude.json"), "{}").unwrap();
        assert!(default.other_logins().is_empty());
        let listed = |settings: &ClaudeSettings| {
            settings.get()[claude_dirs::SETTING]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| {
                    (
                        d["path"].as_str().unwrap().to_string(),
                        d["origin"].as_str().unwrap().to_string(),
                    )
                })
                .collect::<Vec<_>>()
        };
        let path = |name: &str| dir.path().join(name).display().to_string();
        assert_eq!(listed(&default), [(path(".claude"), "default".to_string())]);

        let folders = Value::Array(vec![Value::String(path(".seclaude"))]);
        assert_eq!(default.set(claude_dirs::SETTING, &folders), Some(Ok(())));
        assert_eq!(
            listed(&default),
            [
                (path(".claude"), "default".to_string()),
                (path(".seclaude"), "added".to_string())
            ]
        );
        assert_eq!(
            default
                .other_logins()
                .iter()
                .map(|l| l.user_settings.clone())
                .collect::<Vec<_>>(),
            [dir.path().join(".seclaude/settings.json")]
        );
        default.set_direct_delivery(true).unwrap();
        assert_eq!(
            inbound_value(
                std::fs::read(dir.path().join(".seclaude/settings.json"))
                    .ok()
                    .as_deref()
            )
            .as_deref(),
            Some(ACCEPT)
        );
        // Unshared, a login's sessions stay off the relay and its settings
        // are left as they are.
        let choice = serde_json::json!({"path": path(".seclaude"), "shared": false});
        assert_eq!(
            default.set(claude_dirs::CHOICE_SETTING, &choice),
            Some(Ok(()))
        );
        assert_eq!(
            default.get()[claude_dirs::SETTING][1]["shared"],
            Value::Bool(false)
        );
        assert!(default.other_logins().is_empty());
        assert!(default.write_only().contains(&claude_dirs::CHOICE_SETTING));
        assert!(default
            .set(
                claude_dirs::CHOICE_SETTING,
                &serde_json::json!({"path": path(".seclaude")})
            )
            .is_some_and(|r| r.is_err()));
        assert!(default
            .set(claude_dirs::SETTING, &Value::Bool(true))
            .is_some_and(|r| r.is_err()));
        // Malformed values are refused before `settings.set` writes anything.
        assert!(default
            .refuse(
                claude_dirs::CHOICE_SETTING,
                &serde_json::json!({"path": path(".seclaude")})
            )
            .is_some());
        assert!(default
            .refuse(claude_dirs::SETTING, &Value::Bool(true))
            .is_some());
        assert!(default
            .refuse(MANAGED_SETTING, &Value::Bool(true))
            .is_some());
        assert_eq!(
            default.refuse(claude_dirs::SETTING, &serde_json::json!([path("a")])),
            None
        );
        assert!(default
            .set(
                claude_dirs::SETTING,
                &Value::Array(vec![Value::String(path("missing"))])
            )
            .is_some_and(|r| r.is_err()));
    }

    // Review on #388: other logins follow this one, but a login's own
    // `refuse` is never weakened, and a folder that only links `sessions/`
    // is not a login.
    #[test]
    #[cfg(unix)]
    fn other_logins_follow_but_keep_refuse_and_folders_that_are_not_logins_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let default = ClaudeSettings {
            user_settings: dir.path().join(".claude/settings.json"),
            managed_settings: dir.path().join("managed-settings.json"),
            dirs: Default::default(),
        };
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        std::fs::write(dir.path().join(".claude/settings.json"), "{}").unwrap();
        for login in [".claude-work", ".claude-own"] {
            std::fs::create_dir_all(dir.path().join(login)).unwrap();
            std::fs::write(dir.path().join(login).join(".claude.json"), "{}").unwrap();
        }
        std::fs::write(
            dir.path().join(".claude-own/settings.json"),
            r#"{"crossSessionInbound":"refuse"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join(".claude-registry-only")).unwrap();
        symlink(
            dir.path().join(".claude"),
            dir.path().join(".claude-registry-only/sessions"),
        )
        .unwrap();
        assert_eq!(
            default.other_logins().len(),
            2,
            "the registry-only folder is not a login"
        );
        let value = |login: &str| {
            ClaudeSettings {
                user_settings: dir.path().join(login).join("settings.json"),
                managed_settings: default.managed_settings.clone(),
                dirs: Default::default(),
            }
            .user_value()
        };
        default.apply_default().unwrap();
        assert_eq!(value(".claude").as_deref(), Some(ACCEPT));
        assert_eq!(value(".claude-work").as_deref(), Some(ACCEPT));
        assert_eq!(
            value(".claude-own").as_deref(),
            Some(REFUSE),
            "refuse is kept"
        );
        assert!(
            !default.delivers_directly(),
            "a refusing login is not direct"
        );
        // A login added later follows at the next start.
        std::fs::create_dir_all(dir.path().join(".claude-new")).unwrap();
        std::fs::write(dir.path().join(".claude-new/.claude.json"), "{}").unwrap();
        default.follow_default().unwrap();
        assert_eq!(value(".claude-new").as_deref(), Some(ACCEPT));
        // Off writes hold where it was on, and leaves refuse.
        default.set_direct_delivery(false).unwrap();
        assert_eq!(value(".claude-work").as_deref(), Some(HOLD));
        assert_eq!(value(".claude-own").as_deref(), Some(REFUSE));
    }

    // Review on #388: a second Claude login with settings of its own reads
    // `crossSessionInbound` there; one sharing the default's by a link is
    // the same login.
    #[test]
    #[cfg(unix)]
    fn direct_delivery_covers_every_login_with_settings_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let default = ClaudeSettings {
            user_settings: dir.path().join(".claude/settings.json"),
            managed_settings: dir.path().join("managed-settings.json"),
            dirs: Default::default(),
        };
        std::fs::create_dir_all(dir.path().join(".claude")).unwrap();
        std::fs::create_dir_all(dir.path().join(".claude-work")).unwrap();
        std::fs::write(dir.path().join(".claude-work/.claude.json"), "{}").unwrap();
        std::fs::create_dir_all(dir.path().join(".claude-linked/sessions")).unwrap();
        std::fs::write(dir.path().join(".claude/settings.json"), "{}").unwrap();
        symlink(
            dir.path().join(".claude/settings.json"),
            dir.path().join(".claude-linked/settings.json"),
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join(".claudex")).unwrap();
        let others = default.other_logins();
        assert_eq!(
            others
                .iter()
                .map(|login| login.user_settings.clone())
                .collect::<Vec<_>>(),
            [dir.path().join(".claude-work/settings.json")]
        );
        default.apply_default().unwrap();
        assert!(default.delivers_directly());
        assert_eq!(others[0].user_value().as_deref(), Some(ACCEPT));
        // The person turns the work login's off: direct is not promised.
        others[0].set_own_direct_delivery(false).unwrap();
        assert!(!default.delivers_directly());
        default.set_direct_delivery(true).unwrap();
        assert!(default.delivers_directly());
        // An explicit choice on another login is kept by the first-run default.
        std::fs::write(
            dir.path().join(".claude-work/settings.json"),
            r#"{"crossSessionInbound":"refuse"}"#,
        )
        .unwrap();
        default.apply_default().unwrap();
        assert_eq!(others[0].user_value().as_deref(), Some("refuse"));
    }

    #[test]
    fn direct_delivery_defaults_on_only_without_a_recorded_choice() {
        let dir = tempfile::tempdir().unwrap();
        let claude = settings(dir.path());
        // Claude Code has never run here.
        assert!(claude.default_on().is_empty());
        std::fs::create_dir_all(dir.path().join("claude")).unwrap();
        assert_eq!(claude.default_on(), vec![SETTING]);
        // The person's own value, or the organization's, is left alone.
        write(
            &dir.path().join("claude/settings.json"),
            r#"{"crossSessionInbound":"hold"}"#,
        );
        assert!(claude.default_on().is_empty());
        write(&dir.path().join("claude/settings.json"), "{}");
        assert_eq!(claude.default_on(), vec![SETTING]);
        write(
            &dir.path().join("managed-settings.json"),
            r#"{"crossSessionInbound":"refuse"}"#,
        );
        assert!(claude.default_on().is_empty());
    }

    fn object(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).unwrap()
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    // ClaudeInboundSettingTests.testReadsTheValueWhenPresent.
    #[test]
    fn reads_the_value_when_present() {
        assert_eq!(
            inbound_value(Some(br#"{"crossSessionInbound":"hold"}"#)).as_deref(),
            Some("hold")
        );
        assert_eq!(inbound_value(Some(br#"{"model":"opus"}"#)), None);
        assert_eq!(inbound_value(None), None);
        assert_eq!(inbound_value(Some(b"not json")), None);
        assert_eq!(inbound_value(Some(br#"{"crossSessionInbound":1}"#)), None);
    }

    // ClaudeInboundSettingTests.testSettingAcceptKeepsEveryOtherSetting.
    #[test]
    fn setting_accept_keeps_every_other_setting() {
        let original =
            br#"{"model":"opus","permissions":{"allow":["Bash(ls)"]},"env":{"URL":"https://x/y"}}"#;
        let updated = with_inbound(Some(ACCEPT), Some(original)).unwrap();
        let value = object(&updated);
        assert_eq!(value["crossSessionInbound"], "accept");
        assert_eq!(value["model"], "opus");
        assert_eq!(
            value["permissions"]["allow"],
            serde_json::json!(["Bash(ls)"])
        );
        assert_eq!(value["env"]["URL"], "https://x/y");
        assert!(String::from_utf8(updated).unwrap().contains("https://x/y"));
    }

    // ClaudeInboundSettingTests.testCreatesAFileWhenThereIsNone.
    #[test]
    fn creates_a_file_when_there_is_none() {
        let fresh = with_inbound(Some(ACCEPT), None).unwrap();
        let blank = with_inbound(Some(ACCEPT), Some(b"  \n")).unwrap();
        assert_eq!(inbound_value(Some(&fresh)).as_deref(), Some(ACCEPT));
        assert_eq!(inbound_value(Some(&blank)).as_deref(), Some(ACCEPT));
    }

    // ClaudeInboundSettingTests.testRemovingTheValueLeavesTheRest.
    #[test]
    fn removing_the_value_leaves_the_rest() {
        let updated = with_inbound(
            None,
            Some(br#"{"crossSessionInbound":"accept","model":"opus"}"#),
        )
        .unwrap();
        assert_eq!(inbound_value(Some(&updated)), None);
        assert_eq!(object(&updated), serde_json::json!({"model": "opus"}));
    }

    // ClaudeInboundSettingTests.testRefusesToRewriteAFileItCannotRead.
    #[test]
    fn refuses_to_rewrite_a_file_it_cannot_read() {
        assert_eq!(
            with_inbound(Some(ACCEPT), Some(b"{ broken")),
            Err(Unreadable)
        );
        assert_eq!(with_inbound(Some(ACCEPT), Some(b"[1,2]")), Err(Unreadable));
    }

    // test_injectable.SettingsTests.test_sets_cross_session_inbound_keeping_other_settings.
    #[test]
    fn sets_cross_session_inbound_keeping_other_settings() {
        let dir = tempfile::tempdir().unwrap();
        let settings = settings(dir.path());
        let path = &settings.user_settings;
        write(path, r#"{"skipDangerousModePermissionPrompt": true}"#);
        assert_eq!(settings.user_value(), None);
        assert!(!settings.delivers_directly());
        settings.set_direct_delivery(true).unwrap();
        assert_eq!(
            object(&std::fs::read(path).unwrap()),
            serde_json::json!({"crossSessionInbound": "accept", "skipDangerousModePermissionPrompt": true})
        );
        assert!(settings.delivers_directly());
        settings.set_direct_delivery(false).unwrap();
        // Off is Claude Code's own default, written explicitly.
        assert_eq!(
            object(&std::fs::read(path).unwrap()),
            serde_json::json!({"crossSessionInbound": "hold", "skipDangerousModePermissionPrompt": true})
        );
        write(path, "{not json");
        let error = settings.set_direct_delivery(true).unwrap_err();
        assert!(matches!(&error, DirectDeliveryError::Failed(m) if m.contains("not valid JSON")));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{not json");
    }

    // test_injectable.SettingsTests.test_managed_inbound_takes_precedence_over_the_user_setting.
    #[test]
    fn managed_inbound_takes_precedence_over_the_user_setting() {
        let dir = tempfile::tempdir().unwrap();
        let settings = settings(dir.path());
        write(
            &settings.user_settings,
            r#"{"crossSessionInbound": "accept"}"#,
        );
        write(
            &settings.managed_settings,
            r#"{"crossSessionInbound": "hold"}"#,
        );
        assert_eq!(settings.managed_value().as_deref(), Some("hold"));
        assert!(!settings.delivers_directly());
        write(
            &settings.user_settings,
            r#"{"crossSessionInbound": "hold"}"#,
        );
        write(
            &settings.managed_settings,
            r#"{"crossSessionInbound": "accept"}"#,
        );
        assert!(settings.delivers_directly());
    }

    #[test]
    fn settings_report_the_managed_value_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let settings = settings(dir.path());
        assert_eq!(
            SettingsExtension::get(&settings)[MANAGED_SETTING],
            Value::Null
        );
        write(
            &settings.managed_settings,
            r#"{"crossSessionInbound": "hold"}"#,
        );
        let reported = SettingsExtension::get(&settings);
        assert_eq!(reported[MANAGED_SETTING], "hold");
        assert_eq!(reported[SETTING], false);
        assert!(matches!(
            SettingsExtension::set(&settings, MANAGED_SETTING, &Value::Bool(true)),
            Some(Err(_))
        ));
    }

    // OutboundTests.testDirectDeliveryReportsManagedPolicyRefusal and
    // test_setup.test_agent_led_defaults_report_a_managed_direct_delivery_refusal
    // (the setting's half: refused, nothing written).
    #[test]
    fn a_managed_refusal_is_reported_and_nothing_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let settings = settings(dir.path());
        write(
            &settings.managed_settings,
            r#"{"crossSessionInbound": "hold"}"#,
        );
        assert_eq!(
            settings.set_direct_delivery(true),
            Err(DirectDeliveryError::ManagedPolicy)
        );
        assert_eq!(
            DirectDeliveryError::ManagedPolicy.to_string(),
            "Managed Claude settings do not allow direct delivery."
        );
        assert!(!settings.user_settings.exists());
        // Turning it off is never refused.
        write(
            &settings.user_settings,
            r#"{"crossSessionInbound": "accept"}"#,
        );
        assert_eq!(settings.set_direct_delivery(false), Ok(()));
        assert_eq!(settings.user_value().as_deref(), Some(HOLD));
        // A managed `accept` already delivers directly: nothing to write.
        std::fs::remove_file(&settings.user_settings).unwrap();
        write(
            &settings.managed_settings,
            r#"{"crossSessionInbound": "accept"}"#,
        );
        assert_eq!(settings.set_direct_delivery(true), Ok(()));
        assert!(!settings.user_settings.exists());
    }

    // test_setup.test_direct_delivery_can_be_enabled_before_registration
    // (the setting's half: no settings file yet).
    #[test]
    #[cfg(unix)]
    fn direct_delivery_can_be_enabled_without_a_settings_file() {
        let dir = tempfile::tempdir().unwrap();
        let settings = settings(dir.path());
        settings.set_direct_delivery(true).unwrap();
        assert_eq!(settings.user_value().as_deref(), Some(ACCEPT));
        let mode = std::fs::metadata(&settings.user_settings)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "a new settings file is private");
        let backup = dir.path().join("claude/settings.json.relay-desktop-backup");
        assert!(!backup.exists(), "there was no original to keep");
        // Where Claude Code has never run, off leaves no file behind.
        let empty = ClaudeSettings {
            user_settings: dir.path().join("none/settings.json"),
            ..settings.clone()
        };
        empty.set_direct_delivery(false).unwrap();
        assert!(!empty.user_settings.exists());
    }

    // test_injectable.SettingsTests.test_a_symlinked_settings_file_stays_a_symlink.
    #[test]
    #[cfg(unix)]
    fn a_symlinked_settings_file_stays_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let dotfiles = dir.path().join("dotfiles");
        std::fs::create_dir(&dotfiles).unwrap();
        let target = dotfiles.join("claude-settings.json");
        std::fs::write(&target, r#"{"theme": "dark"}"#).unwrap();
        let settings = settings(dir.path());
        std::fs::create_dir_all(settings.user_settings.parent().unwrap()).unwrap();
        symlink("../dotfiles/claude-settings.json", &settings.user_settings).unwrap();
        settings.set_direct_delivery(true).unwrap();
        assert!(std::fs::symlink_metadata(&settings.user_settings)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            object(&std::fs::read(&target).unwrap()),
            serde_json::json!({"crossSessionInbound": "accept", "theme": "dark"})
        );
        assert!(dotfiles
            .join("claude-settings.json.relay-desktop-backup")
            .exists());
    }

    // docs/injectable-agents.md: the mode is kept and the original is saved
    // once as settings.json.relay-desktop-backup.
    #[test]
    #[cfg(unix)]
    fn the_mode_is_kept_and_the_original_is_backed_up_once() {
        let dir = tempfile::tempdir().unwrap();
        let settings = settings(dir.path());
        let path = &settings.user_settings;
        write(path, r#"{"env": {"TOKEN": "x"}}"#);
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        settings.set_direct_delivery(true).unwrap();
        let backup = dir.path().join("claude/settings.json.relay-desktop-backup");
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            r#"{"env": {"TOKEN": "x"}}"#
        );
        for file in [path, &backup] {
            let mode = std::fs::metadata(file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{}", file.display());
        }
        settings.set_direct_delivery(false).unwrap();
        settings.set_direct_delivery(true).unwrap();
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            r#"{"env": {"TOKEN": "x"}}"#,
            "the first original is the one kept"
        );
    }

    // The `direct_delivery` setting served through settings.get / settings.set.
    #[test]
    fn serves_direct_delivery_as_a_setting() {
        let dir = tempfile::tempdir().unwrap();
        let settings = settings(dir.path());
        assert_eq!(settings.get().get(SETTING), Some(&Value::Bool(false)));
        assert_eq!(settings.set("auto_activate", &Value::Bool(true)), None);
        assert_eq!(settings.set(SETTING, &Value::Bool(true)), Some(Ok(())));
        assert_eq!(settings.get().get(SETTING), Some(&Value::Bool(true)));
        assert!(matches!(
            settings.set(SETTING, &Value::String("yes".into())),
            Some(Err(_))
        ));
        write(
            &settings.managed_settings,
            r#"{"crossSessionInbound": "refuse"}"#,
        );
        assert_eq!(settings.get().get(SETTING), Some(&Value::Bool(false)));
        assert_eq!(
            settings.set(SETTING, &Value::Bool(true)),
            Some(Err(
                "Managed Claude settings do not allow direct delivery.".into()
            ))
        );
    }

    // The first-run default accepts only where the user has not chosen.
    #[test]
    fn the_default_accepts_an_unset_value_and_keeps_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let settings = settings(dir.path());
        let path = settings.user_settings.clone();
        let backup = dir.path().join("claude/settings.json.relay-desktop-backup");

        // No file: the default creates one that accepts.
        assert!(!settings.user_chose());
        settings.apply_default().unwrap();
        assert_eq!(settings.user_value().as_deref(), Some(ACCEPT));
        std::fs::remove_file(&path).unwrap();

        // The key absent: set, the rest kept, the original backed up.
        write(&path, r#"{"model": "opus"}"#);
        assert!(!settings.user_chose());
        assert_eq!(
            settings.set(DEFAULT_SETTING, &Value::Bool(true)),
            Some(Ok(()))
        );
        assert_eq!(
            object(&std::fs::read(&path).unwrap()),
            serde_json::json!({"crossSessionInbound": "accept", "model": "opus"})
        );
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            r#"{"model": "opus"}"#
        );

        // An explicit value of any kind is never overwritten.
        for explicit in [
            r#"{"crossSessionInbound": "hold"}"#,
            r#"{"crossSessionInbound": "refuse"}"#,
            r#"{"crossSessionInbound": ""}"#,
            r#"{"crossSessionInbound": null}"#,
        ] {
            write(&path, explicit);
            assert!(settings.user_chose(), "{explicit}");
            settings.apply_default().unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), explicit);
            assert!(!settings.delivers_directly());
        }

        // Unticked: nothing changes.
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            settings.set(DEFAULT_SETTING, &Value::Bool(false)),
            Some(Ok(()))
        );
        assert!(!path.exists());
        assert!(matches!(
            settings.set(DEFAULT_SETTING, &Value::String("yes".into())),
            Some(Err(_))
        ));
    }

    // The default never fights an organization's managed setting.
    #[test]
    fn the_default_refuses_a_managed_setting() {
        let dir = tempfile::tempdir().unwrap();
        let settings = settings(dir.path());
        write(
            &settings.managed_settings,
            r#"{"crossSessionInbound": "hold"}"#,
        );
        assert_eq!(
            settings.apply_default(),
            Err(DirectDeliveryError::ManagedPolicy)
        );
        assert!(!settings.user_settings.exists());
        write(
            &settings.managed_settings,
            r#"{"crossSessionInbound": "accept"}"#,
        );
        settings.apply_default().unwrap();
        assert!(settings.delivers_directly());
        assert!(
            !settings.user_settings.exists(),
            "the managed accept is enough"
        );
    }

    // Turning direct delivery off (an unticked first-run box, Ask Again)
    // keeps a stricter value the person set.
    #[test]
    fn turning_off_keeps_an_existing_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let settings = settings(dir.path());
        let path = settings.user_settings.clone();
        write(&path, r#"{"crossSessionInbound": "refuse"}"#);
        settings.set_direct_delivery(false).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"crossSessionInbound": "refuse"}"#
        );
        write(&path, r#"{"crossSessionInbound": "accept"}"#);
        settings.set_direct_delivery(false).unwrap();
        assert_eq!(settings.user_value().as_deref(), Some("hold"));
    }
}
