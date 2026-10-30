//! A space-free name for this probe, for the commands Codex and Claude Code
//! run without asking.
//!
//! Codex lets a command out of its sandbox without a prompt only when its
//! rules match it, and its parser (`shell-command/src/bash.rs`, Codex 0.163)
//! reads a command only when the program is a plain, unquoted word: a quoted
//! program is never matched, so a probe at
//! `/Applications/Agent Relay.app/Contents/Helpers/Agent Relay Helper`,
//! which the reply hints must quote, asked for every read and reply. Quoted
//! arguments are read fine (a single- or double-quoted string is one word),
//! so the session socket under `Application Support` needs no other name.
//!
//! So while the Codex hook or the Claude Code hook is on, and this probe's
//! path needs quoting, the core keeps a link to it at
//! `~/.agentworkforce/desktop/bin/agent-relay-probe` (`agent-relay-probe-dev`
//! for Agent Relay Dev), and the reply hints, pointers and both tools' rules
//! name the link instead. The link is pointed at this executable again each
//! time a hook turns on and at each core start, so a moved or updated app
//! never leaves it at an old binary.
//!
//! The link is used only when it is safe to: its folder must be a real
//! folder this user owns that nobody else may write (it is made `0700`), and
//! its parent too; the link must be one this core recorded making
//! ([`RECORD`] in the core's data folder) and point at exactly this
//! executable. Anything else there is never replaced or used, and the hints
//! and rules name the probe's own path as before. When neither hook is on any
//! more, the link goes, with its folder once empty.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

/// The record, in the core's data folder, of the link this core made.
pub const RECORD: &str = "probe-alias.json";

/// The folder under the home folder that holds the link.
pub const DIR: &str = ".agentworkforce/desktop/bin";

/// Which rules need the link.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum User {
    /// Codex's sandbox rules (`codex::stop_hook::SandboxRules`).
    Codex,
    /// Claude Code's permission rules (`session_hook::PermissionRules`).
    Claude,
}

/// The name the hints use, once the core has a link (`probe_executable`).
static ACTIVE: RwLock<Option<PathBuf>> = RwLock::new(None);

/// The link this core keeps, if any, for `outbound::fetch::probe_executable`.
pub fn active() -> Option<PathBuf> {
    ACTIVE
        .read()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

/// Whether `path` is one plain shell word, which Codex's rules can match as
/// a program: nothing in it `outbound::shell_quote` would quote.
pub fn is_plain(path: &Path) -> bool {
    path.to_str()
        .is_some_and(|text| crate::relay::outbound::shell_quote(text) == text)
}

/// The link to this probe, and who needs it.
pub struct ProbeAlias {
    /// This probe's own executable.
    real: PathBuf,
    /// Where the link goes.
    link: PathBuf,
    /// [`RECORD`] in the core's data folder.
    record: PathBuf,
    /// Whether this is the core's own, whose link the hints use.
    publish: bool,
    users: Mutex<BTreeSet<User>>,
}

impl ProbeAlias {
    /// The core's link for `real`, under `home`, recorded in `app_data_dir`;
    /// the hints name it while it is kept.
    pub fn system(real: PathBuf, home: &Path, app_data_dir: &Path, development: bool) -> Self {
        let mut alias = ProbeAlias::new(real, home, app_data_dir, development);
        alias.publish = true;
        alias
    }

    /// A link the hints do not use (tests).
    pub fn new(real: PathBuf, home: &Path, app_data_dir: &Path, development: bool) -> Self {
        let name = if development {
            "agent-relay-probe-dev"
        } else {
            "agent-relay-probe"
        };
        ProbeAlias {
            real,
            link: home.join(DIR).join(name),
            record: app_data_dir.join(RECORD),
            publish: false,
            users: Mutex::new(BTreeSet::new()),
        }
    }

    /// The probe's own executable.
    pub fn real(&self) -> &Path {
        &self.real
    }

    /// Where the link goes.
    pub fn link(&self) -> &Path {
        &self.link
    }

    /// The probe the rules and hints name now, changing nothing: the link
    /// when it is in place and safe, else the probe's own path.
    pub fn probe(&self) -> PathBuf {
        if self.wanted() && self.usable() {
            self.link.clone()
        } else {
            self.real.clone()
        }
    }

    /// `user`'s rules need the link: it is made, or pointed at this probe
    /// again, when the probe's path needs quoting. Answers the probe the
    /// rules should name: the link, or the probe's own path when the link
    /// is not needed or cannot be made safely.
    pub fn acquire(&self, user: User) -> PathBuf {
        let mut users = self.users();
        users.insert(user);
        let probe = if self.wanted() {
            match self.ensure() {
                Ok(()) => self.link.clone(),
                Err(_) => self.real.clone(),
            }
        } else {
            // The probe moved to a path that needs no link: an old one goes.
            self.remove_ours();
            self.real.clone()
        };
        self.set_active(probe != self.real, &probe);
        probe
    }

    /// `user`'s rules are gone; the link goes once no rules need it.
    pub fn release(&self, user: User) {
        let mut users = self.users();
        users.remove(&user);
        if users.is_empty() {
            self.remove_ours();
            self.set_active(false, &self.real);
        }
    }

    fn users(&self) -> std::sync::MutexGuard<'_, BTreeSet<User>> {
        self.users
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn set_active(&self, kept: bool, probe: &Path) {
        if !self.publish {
            return;
        }
        let mut active = ACTIVE.write().unwrap_or_else(|poison| poison.into_inner());
        *active = kept.then(|| probe.to_path_buf());
    }

    /// Whether the probe's path needs a link, and a link could be matched.
    fn wanted(&self) -> bool {
        cfg!(unix) && !is_plain(&self.real) && is_plain(&self.link) && self.real.is_absolute()
    }

    /// Whether the link's folder and its parent are real folders this user
    /// owns that nobody else may write.
    fn safe_folders(&self) -> bool {
        let Some(folder) = self.link.parent() else {
            return false;
        };
        [Some(folder), folder.parent()].into_iter().all(|dir| {
            dir.and_then(|dir| std::fs::symlink_metadata(dir).ok())
                .is_some_and(|metadata| {
                    metadata.is_dir()
                        && crate::platform::fs::owned_by_current_user(&metadata)
                        && crate::platform::fs::private_to_owner(&metadata, 0o022)
                })
        })
    }

    /// Whether this core recorded making the link.
    fn recorded(&self) -> bool {
        std::fs::read(&self.record)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|value| value["link"].as_str() == self.link.to_str())
    }

    fn record_link(&self) -> std::io::Result<()> {
        if let Some(folder) = self.record.parent() {
            crate::platform::fs::create_private_dir_all(folder)?;
        }
        let text = serde_json::json!({"link": self.link.to_string_lossy()}).to_string();
        crate::relay::claude_settings::write_keeping_file(
            &self.record,
            None,
            text.as_bytes(),
            "",
            0o600,
        )
    }

    /// Whether the link is there, this core's, in safe folders, and at
    /// exactly this probe.
    fn usable(&self) -> bool {
        self.safe_folders()
            && self.recorded()
            && std::fs::symlink_metadata(&self.link).is_ok_and(|m| m.file_type().is_symlink())
            && std::fs::read_link(&self.link).is_ok_and(|target| target == self.real)
    }

    /// Makes the link, or points this core's link at the probe again.
    /// Something there this core did not make is left alone, as an error.
    fn ensure(&self) -> Result<(), String> {
        let folder = self.link.parent().ok_or("no folder")?;
        if !folder.exists() {
            crate::platform::fs::create_private_dir_all(folder)
                .map_err(|error| error.to_string())?;
        }
        if !self.safe_folders() {
            return Err("the link's folder is not private to this user".into());
        }
        match std::fs::symlink_metadata(&self.link) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Ok(metadata) if metadata.file_type().is_symlink() && self.recorded() => {
                if std::fs::read_link(&self.link).is_ok_and(|target| target == self.real) {
                    return Ok(());
                }
            }
            Ok(_) => return Err("something this core did not make is at the link".into()),
            Err(error) => return Err(error.to_string()),
        }
        // Recorded first, so a link is never left that this core does not
        // know it made; then made beside and renamed into place, so the
        // name never points at anything but a probe.
        self.record_link().map_err(|error| error.to_string())?;
        let mut staged = self.link.clone().into_os_string();
        staged.push(format!(".{}.new", std::process::id()));
        let staged = PathBuf::from(staged);
        let _ = std::fs::remove_file(&staged);
        crate::platform::fs::symlink(&self.real, &staged).map_err(|error| error.to_string())?;
        if let Err(error) = std::fs::rename(&staged, &self.link) {
            let _ = std::fs::remove_file(&staged);
            return Err(error.to_string());
        }
        let _ = crate::platform::fs::sync_dir(folder);
        if self.usable() {
            Ok(())
        } else {
            Err("the link did not read back as made".into())
        }
    }

    /// Removes the link if this core made it, its folder once empty, and
    /// the record.
    fn remove_ours(&self) {
        if !self.recorded() {
            return;
        }
        let ours = std::fs::symlink_metadata(&self.link).is_ok_and(|m| m.file_type().is_symlink());
        if ours {
            match std::fs::remove_file(&self.link) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return,
            }
        }
        if let Some(folder) = self.link.parent() {
            let _ = std::fs::remove_dir(folder);
        }
        let _ = std::fs::remove_file(&self.record);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture {
        _temp: tempfile::TempDir,
        home: PathBuf,
        data: PathBuf,
        apps: PathBuf,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        // A temp folder can itself be under a path the link would need to
        // quote; the tests need a plain one.
        let root = temp.path().canonicalize().unwrap();
        assert!(is_plain(&root), "{}", root.display());
        let home = root.join("home");
        let data = root.join("data");
        let apps = root.join("Apps");
        for dir in [&home, &data, &apps] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::create_dir_all(home.join(".agentworkforce/desktop")).unwrap();
        Fixture {
            _temp: temp,
            home,
            data,
            apps,
        }
    }

    fn probe_at(fixture: &Fixture, app: &str) -> PathBuf {
        let helpers = fixture.apps.join(app).join("Contents/Helpers");
        std::fs::create_dir_all(&helpers).unwrap();
        let probe = helpers.join("Agent Relay Helper");
        std::fs::write(&probe, b"#!/bin/sh\n").unwrap();
        probe
    }

    #[test]
    fn a_probe_path_with_a_space_gets_a_private_link() {
        let fixture = fixture();
        let real = probe_at(&fixture, "Agent Relay.app");
        let alias = ProbeAlias::new(real.clone(), &fixture.home, &fixture.data, false);
        assert_eq!(alias.probe(), real);
        let probe = alias.acquire(User::Codex);
        assert_eq!(probe, fixture.home.join(DIR).join("agent-relay-probe"));
        assert!(is_plain(&probe));
        assert_eq!(std::fs::read_link(&probe).unwrap(), real);
        let mode = std::fs::metadata(probe.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        assert_eq!(alias.probe(), probe);
        // Agent Relay Dev keeps its own.
        let dev = ProbeAlias::new(real, &fixture.home, &fixture.data.join("dev"), true);
        assert!(dev.acquire(User::Codex).ends_with("agent-relay-probe-dev"));
    }

    #[test]
    fn a_plain_probe_path_needs_no_link() {
        let fixture = fixture();
        let real = fixture.apps.join("agent-relay-probe");
        std::fs::write(&real, b"").unwrap();
        let alias = ProbeAlias::new(real.clone(), &fixture.home, &fixture.data, false);
        assert_eq!(alias.acquire(User::Claude), real);
        assert!(!fixture.home.join(DIR).exists());
    }

    #[test]
    fn a_moved_probe_moves_the_link() {
        let fixture = fixture();
        let old = probe_at(&fixture, "Agent Relay.app");
        let first = ProbeAlias::new(old.clone(), &fixture.home, &fixture.data, false);
        let link = first.acquire(User::Codex);
        assert_eq!(std::fs::read_link(&link).unwrap(), old);
        // The app moved: the next core start points the same link at it.
        let new = probe_at(&fixture, "Agent Relay 2.app");
        let second = ProbeAlias::new(new.clone(), &fixture.home, &fixture.data, false);
        // Until then, the old link is not this probe's: it is not named.
        assert_eq!(second.probe(), new);
        assert_eq!(second.acquire(User::Codex), link);
        assert_eq!(std::fs::read_link(&link).unwrap(), new);
        // Moved to a path that needs no link: the old one goes.
        let plain = fixture.apps.join("agent-relay-probe");
        std::fs::write(&plain, b"").unwrap();
        let third = ProbeAlias::new(plain.clone(), &fixture.home, &fixture.data, false);
        assert_eq!(third.acquire(User::Codex), plain);
        assert!(std::fs::symlink_metadata(&link).is_err());
    }

    #[test]
    fn anything_this_core_did_not_make_is_refused() {
        let fixture = fixture();
        let real = probe_at(&fixture, "Agent Relay.app");
        let folder = fixture.home.join(DIR);
        let link = folder.join("agent-relay-probe");
        let elsewhere = fixture.apps.join("evil");
        std::fs::write(&elsewhere, b"").unwrap();

        // A link someone else made, even to this probe.
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
        for target in [&elsewhere, &real] {
            let _ = std::fs::remove_file(&link);
            std::os::unix::fs::symlink(target, &link).unwrap();
            let alias = ProbeAlias::new(real.clone(), &fixture.home, &fixture.data, false);
            assert_eq!(alias.acquire(User::Codex), real);
            assert_eq!(&std::fs::read_link(&link).unwrap(), target);
            alias.release(User::Codex);
            assert!(std::fs::symlink_metadata(&link).is_ok(), "never removed");
        }
        // A plain file at the link's name.
        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, b"#!/bin/sh\n").unwrap();
        let alias = ProbeAlias::new(real.clone(), &fixture.home, &fixture.data, false);
        assert_eq!(alias.acquire(User::Codex), real);
        assert_eq!(std::fs::read(&link).unwrap(), b"#!/bin/sh\n");
        std::fs::remove_file(&link).unwrap();

        // A folder others may write.
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(alias.acquire(User::Codex), real);
        assert!(std::fs::symlink_metadata(&link).is_err());
        // Its parent others may write.
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
        let parent = folder.parent().unwrap();
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(alias.acquire(User::Codex), real);
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A folder that is a link.
        std::fs::remove_dir(&folder).unwrap();
        let other = fixture.apps.join("other-bin");
        std::fs::create_dir(&other).unwrap();
        std::fs::set_permissions(&other, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::os::unix::fs::symlink(&other, &folder).unwrap();
        assert_eq!(alias.acquire(User::Codex), real);
        assert!(std::fs::read_dir(&other).unwrap().next().is_none());

        // Its own link, changed behind its back, is not named either.
        std::fs::remove_file(&folder).unwrap();
        let ours = alias.acquire(User::Codex);
        assert_eq!(ours, link);
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        assert_eq!(alias.probe(), real);
    }

    #[test]
    fn the_link_goes_once_no_rules_need_it() {
        let fixture = fixture();
        let real = probe_at(&fixture, "Agent Relay.app");
        let alias = ProbeAlias::new(real, &fixture.home, &fixture.data, false);
        let link = alias.acquire(User::Codex);
        alias.acquire(User::Claude);
        alias.release(User::Codex);
        assert!(
            std::fs::symlink_metadata(&link).is_ok(),
            "Claude's rules use it"
        );
        alias.release(User::Claude);
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert!(!fixture.home.join(DIR).exists(), "its empty folder goes");
        assert!(fixture.home.join(".agentworkforce/desktop").exists());
        assert!(!fixture.data.join(RECORD).exists());
        // A file of the person's in the folder keeps it.
        alias.acquire(User::Codex);
        std::fs::write(fixture.home.join(DIR).join("mine"), b"").unwrap();
        alias.release(User::Codex);
        assert!(fixture.home.join(DIR).join("mine").exists());
    }
}
