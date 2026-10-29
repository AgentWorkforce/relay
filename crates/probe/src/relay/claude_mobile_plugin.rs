//! Installs the bundled, owner-gated Claude plugin in the user's skills folder,
//! on by default once the computer's ownership is verified.
//! A user-owned `skills` link is resolved to its private real directory before
//! writing, but the managed plugin and every managed asset must remain real.

use crate::relay::daemon::Core;
use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

mod installations;
mod scope;
pub(crate) use installations::Installations;

const MARKER: &str = ".agent-relay-managed";
const OWNER: &str = "agent-relay-mobile-v1";
const MANIFEST: &str = include_str!("claude_mobile_plugin/.claude-plugin/plugin.json");
const HOOKS: &str = include_str!("claude_mobile_plugin/hooks/hooks.json");
const REGISTER: &str = include_str!("claude_mobile_plugin/hooks/register.mjs");

pub(crate) fn supported() -> bool {
    cfg!(unix)
}

pub(crate) const UNAVAILABLE: &str = "Mobile Claude continuation is unavailable on this platform until a secure native connection is verified.";

impl Core {
    pub(crate) fn require_mobile_claude_owner_claim(&self) -> Result<(), String> {
        if !supported() {
            return Err(UNAVAILABLE.into());
        }
        let claimed = self
            .status()
            .spawn
            .and_then(|spawn| spawn.claim)
            .is_some_and(|claim| claim.state == crate::relay::state::SpawnClaimState::Claimed);
        if self.store.read(|store| store.accepts_spawns()) && claimed {
            return Ok(());
        }
        Err("First enable Accept spawns from Agent Relay in Settings and wait for this computer's ownership to be verified for your signed-in account.".into())
    }

    /// Installs or updates the owned plugin and its bridge on core startup
    /// and on every discovery pass. It is on unless turned off, so this
    /// also does the first install, but only once this computer's
    /// ownership is verified for the signed-in account: until then no
    /// turn could be admitted and nothing is written into Claude's folders.
    pub(crate) fn refresh_mobile_claude_plugin(&self) {
        if !supported() || !self.store.read(|store| store.mobile_claude_handoff_on()) {
            return;
        }
        if self.require_mobile_claude_owner_claim().is_err() {
            // A new core cannot prove the sharing choices an earlier core's
            // native generation ran under, so that generation ends once,
            // here as well as on the first claimed refresh below. Its
            // receipts stay, so leased input is never replayed.
            if self.mobile_claude_plugins.end_stale_generation_once() {
                let _ = self.mobile_handoff_disabled();
            }
            return;
        }
        let refresh = self.refresh_mobile_claude_installations(false);
        if refresh.attempted && !refresh.errors.is_empty() {
            self.hub.activity(crate::relay::state::Level::Warning,
                "Claude mobile continuation could not refresh a shared login's plugin. Turn the setting off and on in Relay Settings to retry.");
        }
        let registrations = self.store.read(|store| store.registrations.clone());
        for registration in registrations
            .iter()
            .filter(|row| refresh.initial || refresh.changed.contains(&row.target))
        {
            self.mobile_handoff_changed(registration);
        }
    }

    /// Refresh every affected roster row even when cleanup fails: the stored
    /// opt-out is already authoritative and old "ready" metadata must clear.
    pub(crate) fn mobile_claude_setting_changed(&self, enabled: bool) -> Result<(), String> {
        let result = if enabled {
            Ok(())
        } else {
            self.mobile_handoff_disabled()
        };
        let registrations = self.store.read(|store| store.registrations.clone());
        for registration in registrations
            .iter()
            .filter(|registration| crate::relay::mobile_handoff::eligible(registration))
        {
            self.mobile_handoff_changed(registration);
        }
        result
    }

    /// Installing is part of opt-in: failure leaves the stored flag untouched.
    pub(crate) fn install_mobile_claude_plugin(&self) -> Result<(), String> {
        let refresh = self.refresh_mobile_claude_installations(true);
        if refresh.errors.is_empty() {
            Ok(())
        } else {
            Err(refresh.errors.join("\n"))
        }
    }

    fn refresh_mobile_claude_installations(&self, force: bool) -> installations::Refresh {
        let _refresh = self.mobile_claude_plugins.lock_refresh();
        // A new core cannot prove the sharing choices used by an old native
        // generation. End it once, retaining receipt tombstones before enabling.
        if !self.mobile_claude_plugins.initialized() {
            if let Err(error) = self.mobile_handoff_disabled() {
                return self.mobile_claude_plugins.uncertain(error);
            }
        }
        let env = |key: &str| self.config.env.get(key).cloned();
        let default = crate::relay::claude_dirs::default_home(&env, &self.config.home);
        let relay_home = crate::relay::workspace::relay_home(&env, &self.config.home);
        let dirs =
            crate::relay::claude_dirs::ClaudeDirs::from_env(&env, &self.config.home, &relay_home);
        // Validate consent before provider discovery can record newly running
        // logins, then re-read the valid snapshot to include those additions.
        if let Err(error) = scope::shared_roots(&dirs, &default, &self.mobile_claude_plugins) {
            return self.mobile_claude_plugins.uncertain(error);
        }
        let targets = self.plugins.sessions.mobile_claude_config_roots();
        let roots = match scope::shared_roots(&dirs, &default, &self.mobile_claude_plugins) {
            Ok(roots) => roots,
            Err(error) => return self.mobile_claude_plugins.uncertain(error),
        };
        let socket = crate::relay::outbound::default_socket(
            &env,
            &self.config.app_data_dir,
            crate::relay::peer::current_uid(),
        );
        let mut refresh = self.mobile_claude_plugins.refresh(
            roots,
            targets,
            &socket,
            force,
            std::time::Instant::now(),
        );
        if !refresh.revoked.is_empty() {
            match self.mobile_handoff_roots_revoked(&refresh.revoked) {
                Ok(()) => self
                    .mobile_claude_plugins
                    .acknowledge_revoked(&refresh.revoked),
                Err(error) => {
                    refresh.errors.push(error);
                    refresh.attempted = true;
                }
            }
        }
        refresh
    }
}

/// Resolve only unique native session IDs; duplicate registries never choose
/// whichever login happened to be enumerated first.
pub(crate) fn session_roots(
    config: &crate::relay::claude::ClaudeConfig,
    sessions: &[crate::relay::claude::TerminalSession],
) -> std::collections::BTreeMap<crate::relay::store::Target, PathBuf> {
    let mut roots = std::collections::BTreeMap::new();
    for session in sessions {
        let target = crate::relay::store::Target::new(
            crate::relay::store::SessionKind::ClaudeTerminal,
            &session.session_id,
        );
        let root =
            matches!(session.kind.as_deref(), Some("interactive" | "background")).then(|| {
                session
                    .registry
                    .as_deref()
                    .and_then(Path::parent)
                    .unwrap_or(&config.home)
                    .to_path_buf()
            });
        roots
            .entry(target)
            .and_modify(|known| *known = None)
            .or_insert(root);
    }
    roots
        .into_iter()
        .filter_map(|(target, root)| root.map(|root| (target, root)))
        .collect()
}

pub(crate) fn install(config: &Path, socket: &Path) -> Result<(), String> {
    if !config.is_absolute() || !socket.is_absolute() {
        return Err("Claude's configuration and Agent Relay bridge paths must be absolute.".into());
    }
    directory(config, false)?;
    let skills = skills_directory(config)?;
    let root = skills.join("agent-relay-mobile");
    match fs::symlink_metadata(&root) {
        Ok(metadata) => {
            validate_directory(&root, &metadata)?;
            if owner(&root.join(MARKER))? != OWNER.as_bytes() {
                return Err(format!(
                    "{} already exists and is not managed by Agent Relay.",
                    root.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            new_directory(&root)?;
            atomic_file(&root.join(MARKER), OWNER.as_bytes())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    directory(&root, true)?;
    directory(&root.join(".claude-plugin"), true)?;
    directory(&root.join("hooks"), true)?;
    let bridge =
        serde_json::to_vec(&serde_json::json!({"socket": socket})).map_err(|e| e.to_string())?;
    // The manifest comes last, so a new plugin is discoverable only after its
    // hook and bridge files exist. The core gate remains off until install ends.
    let files = [
        ("bridge.json", bridge.as_slice()),
        ("hooks/register.mjs", REGISTER.as_bytes()),
        ("hooks/hooks.json", HOOKS.as_bytes()),
        (".claude-plugin/plugin.json", MANIFEST.as_bytes()),
    ];
    for (path, _) in &files {
        regular_file(&root.join(path))?;
    }
    for (path, contents) in files {
        atomic_file(&root.join(path), contents)?;
    }
    Ok(())
}

/// Claude users commonly share skills between separate logins by linking the
/// whole `skills` directory. It is a user-owned container, not a destination
/// Relay manages. Resolve that one link before constructing the managed path;
/// links at or below `agent-relay-mobile` remain refused by the normal checks.
fn skills_directory(config: &Path) -> Result<PathBuf, String> {
    let skills = config.join("skills");
    let metadata = match fs::symlink_metadata(&skills) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            directory(&skills, false)?;
            return Ok(skills);
        }
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_symlink() {
        directory(&skills, false)?;
        return Ok(skills);
    }
    #[cfg(unix)]
    if metadata.uid() != crate::relay::peer::current_uid() {
        return Err(format!(
            "The Claude skills link at {} must belong to this user.",
            skills.display()
        ));
    }
    let resolved = fs::canonicalize(&skills).map_err(|error| {
        format!(
            "The Claude skills link at {} does not resolve to an available directory: {error}",
            skills.display()
        )
    })?;
    let resolved_metadata = fs::symlink_metadata(&resolved).map_err(|error| error.to_string())?;
    validate_directory(&resolved, &resolved_metadata)?;
    #[cfg(unix)]
    if resolved_metadata.permissions().mode() & 0o022 != 0 {
        return Err(format!(
            "The Claude skills link at {} resolves to {}, which is writable by other users. Choose a skills directory only you can modify.",
            skills.display(),
            resolved.display()
        ));
    }
    Ok(resolved)
}

fn new_directory(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).map_err(|e| e.to_string())
}

fn validate_directory(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "{} must be a real directory, not a link.",
            path.display()
        ));
    }
    #[cfg(unix)]
    if metadata.uid() != crate::relay::peer::current_uid() {
        return Err(format!("{} must belong to this user.", path.display()));
    }
    Ok(())
}

fn directory(path: &Path, managed: bool) -> Result<(), String> {
    let created = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_directory(path, &metadata)?;
            false
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            new_directory(path)?;
            true
        }
        Err(error) => return Err(error.to_string()),
    };
    #[cfg(unix)]
    if created || managed {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    // Windows inherits the user's profile ACL; there are no Unix mode bits.
    #[cfg(windows)]
    let _ = (created, managed);
    Ok(())
}

fn regular_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => Err(format!(
            "Refusing to replace a non-file or link at {}.",
            path.display()
        )),
        Ok(metadata) => {
            #[cfg(unix)]
            if metadata.uid() != crate::relay::peer::current_uid() {
                return Err(format!("{} must belong to this user.", path.display()));
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn owner(path: &Path) -> Result<Vec<u8>, String> {
    regular_file(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options.open(path).map_err(|_| {
        "The existing Claude plugin is not marked as managed by Agent Relay.".to_string()
    })?;
    let mut bytes = Vec::new();
    file.take((OWNER.len() + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn atomic_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    regular_file(path)?;
    let parent = path
        .parent()
        .ok_or("The plugin file has no parent directory.")?;
    validate_directory(
        parent,
        &fs::symlink_metadata(parent).map_err(|e| e.to_string())?,
    )?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    file.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests;
