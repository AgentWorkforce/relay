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
//! its parent too; the link must be the one this core recorded making
//! ([`RECORD`] in the core's data folder: its name, target and inode) and
//! point at exactly this executable. Anything else there, a link someone
//! replaced it with included, is never replaced, removed or used, and the
//! hints and rules name the probe's own path as before. Every hint checks the
//! link again (`active`), so one deleted or replaced since is never handed
//! out.
//!
//! When neither hook is on any more (turned off, or `relay init
//! --uninstall`), the link goes, with its folder once empty, and hints name
//! the probe's own path again. A hint handed out while a hook was on that
//! still names the link then no longer runs; without the hook's rules it
//! would have asked for approval anyway, and the session's next message has
//! a working one. Keeping the link for those would leave it after the person
//! asked for Agent Relay's files to go.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

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

/// The core's own link, whose hints `probe_executable` names.
static SYSTEM: RwLock<Option<Arc<ProbeAlias>>> = RwLock::new(None);

fn system() -> Option<Arc<ProbeAlias>> {
    SYSTEM
        .read()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

/// The link the hints name now, for `outbound::fetch::probe_executable`:
/// only while rules use it and it is still this core's, at this probe.
pub fn active() -> Option<PathBuf> {
    system()?.published()
}

/// Whether `path` is one plain shell word, which Codex's rules can match as
/// a program: nothing in it `outbound::shell_quote` would quote.
pub fn is_plain(path: &Path) -> bool {
    path.to_str()
        .is_some_and(|text| crate::relay::outbound::shell_quote(text) == text)
}

/// The link this core made, as [`RECORD`] keeps it.
#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Made {
    link: PathBuf,
    target: PathBuf,
    /// The link's own inode, so a link put in its place is not taken for it.
    inode: u64,
    /// The link this one replaces, while it is being replaced: a core that
    /// stops between recording the new link and renaming it into place
    /// still knows the old one as its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replacing: Option<(PathBuf, u64)>,
}

/// The link to this probe, and who needs it.
pub struct ProbeAlias {
    /// This probe's own executable.
    real: PathBuf,
    /// Where the link goes.
    link: PathBuf,
    /// [`RECORD`] in the core's data folder.
    record: PathBuf,
    users: Mutex<BTreeSet<User>>,
}

impl ProbeAlias {
    /// The core's link for `real`, under `home`, recorded in `app_data_dir`;
    /// the hints name it while it is kept.
    pub fn system(
        real: PathBuf,
        home: &Path,
        app_data_dir: &Path,
        development: bool,
    ) -> Arc<ProbeAlias> {
        let alias = Arc::new(ProbeAlias::new(real, home, app_data_dir, development));
        *SYSTEM.write().unwrap_or_else(|poison| poison.into_inner()) = Some(alias.clone());
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
            users: Mutex::new(BTreeSet::new()),
        }
    }

    /// The probe the rules name now, changing nothing: the link when it is
    /// in place and safe, else the probe's own path.
    pub fn probe(&self) -> PathBuf {
        if self.wanted() && self.usable() {
            self.link.clone()
        } else {
            self.real.clone()
        }
    }

    /// The link the hints name: only while rules use it, and only while it
    /// is in place and safe.
    pub fn published(&self) -> Option<PathBuf> {
        let users = self.users();
        (!users.is_empty() && self.wanted() && self.usable()).then(|| self.link.clone())
    }

    /// `user`'s rules need the link: it is made, or pointed at this probe
    /// again, when the probe's path needs quoting. Answers the probe the
    /// rules should name: the link, or the probe's own path when the link
    /// is not needed or cannot be made safely.
    pub fn acquire(&self, user: User) -> PathBuf {
        let mut users = self.users();
        users.insert(user);
        if !self.wanted() {
            // The probe moved to a path that needs no link: an old one goes.
            self.remove_ours();
            return self.real.clone();
        }
        match self.ensure() {
            Ok(()) => self.link.clone(),
            Err(_) => self.real.clone(),
        }
    }

    /// `user`'s rules are gone; the link goes once no rules need it.
    pub fn release(&self, user: User) {
        let mut users = self.users();
        users.remove(&user);
        if users.is_empty() {
            self.remove_ours();
        }
    }

    fn users(&self) -> std::sync::MutexGuard<'_, BTreeSet<User>> {
        self.users
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
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

    /// The link this core recorded making, at this name.
    fn made(&self) -> Option<Made> {
        let bytes = std::fs::read(&self.record).ok()?;
        serde_json::from_slice::<Made>(&bytes)
            .ok()
            .filter(|made| made.link == self.link)
    }

    /// Whether the link there now is the one this core made: the same link
    /// (inode) at the same target. A link put in its place is someone
    /// else's.
    fn ours_on_disk(&self) -> bool {
        let Some(made) = self.made() else {
            return false;
        };
        let Ok(metadata) = std::fs::symlink_metadata(&self.link) else {
            return false;
        };
        let (Some(inode), Ok(target)) = (
            crate::platform::fs::inode(&metadata),
            std::fs::read_link(&self.link),
        ) else {
            return false;
        };
        metadata.file_type().is_symlink()
            && std::iter::once((&made.target, made.inode))
                .chain(
                    made.replacing
                        .as_ref()
                        .map(|(target, inode)| (target, *inode)),
                )
                .any(|(made_target, made_inode)| *made_target == target && made_inode == inode)
    }

    /// The link there now, as `(target, inode)`, when it is this core's.
    fn current(&self) -> Option<(PathBuf, u64)> {
        if !self.ours_on_disk() {
            return None;
        }
        let metadata = std::fs::symlink_metadata(&self.link).ok()?;
        Some((
            std::fs::read_link(&self.link).ok()?,
            crate::platform::fs::inode(&metadata)?,
        ))
    }

    /// Whether the link is there, this core's, in safe folders, and at
    /// exactly this probe.
    fn usable(&self) -> bool {
        self.safe_folders()
            && self.ours_on_disk()
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
        let replacing = match std::fs::symlink_metadata(&self.link) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Ok(_) => match self.current() {
                Some((target, inode)) if target == self.real => {
                    // In place; a replacement this core finished is
                    // recorded without the link it replaced.
                    if self.made().is_some_and(|made| made.replacing.is_some()) {
                        let _ = self.record_made(&Made {
                            link: self.link.clone(),
                            target,
                            inode,
                            replacing: None,
                        });
                    }
                    return Ok(());
                }
                Some(current) => Some(current),
                None => return Err("something this core did not make is at the link".into()),
            },
            Err(error) => return Err(error.to_string()),
        };
        // Made beside and renamed into place, so the name never points at
        // anything but a probe; recorded (with the new link's inode, which
        // the rename keeps) before it is in place, so a link is never left
        // that this core does not know it made.
        let mut staged = self.link.clone().into_os_string();
        staged.push(format!(".{}.new", std::process::id()));
        let staged = PathBuf::from(staged);
        let _ = std::fs::remove_file(&staged);
        crate::platform::fs::symlink(&self.real, &staged).map_err(|error| error.to_string())?;
        let placed = (|| {
            let inode = std::fs::symlink_metadata(&staged)
                .ok()
                .and_then(|metadata| crate::platform::fs::inode(&metadata))
                .ok_or("the new link cannot be read")?;
            self.record_made(&Made {
                link: self.link.clone(),
                target: self.real.clone(),
                inode,
                replacing: replacing.clone(),
            })
            .map_err(|error| error.to_string())?;
            std::fs::rename(&staged, &self.link).map_err(|error| error.to_string())?;
            Ok::<u64, String>(inode)
        })();
        let inode = match placed {
            Ok(inode) => inode,
            Err(error) => {
                let _ = std::fs::remove_file(&staged);
                return Err(error);
            }
        };
        let _ = crate::platform::fs::sync_dir(folder);
        // Placed: the old link is gone, so the record no longer names it.
        let _ = self.record_made(&Made {
            link: self.link.clone(),
            target: self.real.clone(),
            inode,
            replacing: None,
        });
        if self.usable() {
            Ok(())
        } else {
            Err("the link did not read back as made".into())
        }
    }

    fn record_made(&self, made: &Made) -> std::io::Result<()> {
        if let Some(folder) = self.record.parent() {
            crate::platform::fs::create_private_dir_all(folder)?;
        }
        let bytes = serde_json::to_vec(made).map_err(std::io::Error::other)?;
        crate::relay::claude_settings::write_keeping_file(&self.record, None, &bytes, "", 0o600)
    }

    /// Removes the link if it is still the one this core made, its folder
    /// once empty, and the record. A link put in its place stays.
    fn remove_ours(&self) {
        if self.made().is_none() {
            return;
        }
        if self.ours_on_disk() {
            match std::fs::remove_file(&self.link) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return,
            }
            if let Some(folder) = self.link.parent() {
                let _ = std::fs::remove_dir(folder);
            }
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
        assert_eq!(alias.published(), Some(link.clone()));
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        assert_eq!(alias.probe(), real);
        // The hints stop naming it at once, and the replacement is never
        // pointed back at the probe or removed.
        assert_eq!(alias.published(), None);
        assert_eq!(alias.acquire(User::Codex), real);
        assert_eq!(std::fs::read_link(&link).unwrap(), elsewhere);
        alias.release(User::Codex);
        assert_eq!(std::fs::read_link(&link).unwrap(), elsewhere);
    }

    // Review on #2024: the record names the link this core made (its
    // inode), not just the name, so a link put in its place, even one to
    // the same probe, is someone else's.
    #[test]
    fn a_link_put_in_place_of_ours_is_never_overwritten_or_removed() {
        let fixture = fixture();
        let real = probe_at(&fixture, "Agent Relay.app");
        let alias = ProbeAlias::new(real.clone(), &fixture.home, &fixture.data, false);
        let link = alias.acquire(User::Codex);
        let script = fixture.apps.join("mine.sh");
        std::fs::write(&script, b"").unwrap();
        for target in [&script, &real] {
            std::fs::remove_file(&link).unwrap();
            std::os::unix::fs::symlink(target, &link).unwrap();
            assert_eq!(alias.published(), None);
            // A core start (or the hook turned on again) leaves it alone.
            let moved = probe_at(&fixture, "Agent Relay 2.app");
            let next = ProbeAlias::new(moved.clone(), &fixture.home, &fixture.data, false);
            assert_eq!(next.acquire(User::Codex), moved);
            assert_eq!(&std::fs::read_link(&link).unwrap(), target);
            next.release(User::Codex);
            alias.release(User::Codex);
            assert_eq!(&std::fs::read_link(&link).unwrap(), target);
        }
    }

    // Review on #2024: a core that stops after recording a new link but
    // before renaming it into place still knows the old link as its own.
    #[test]
    fn an_interrupted_move_is_finished_by_the_next_start() {
        let fixture = fixture();
        let old = probe_at(&fixture, "Agent Relay.app");
        let first = ProbeAlias::new(old.clone(), &fixture.home, &fixture.data, false);
        let link = first.acquire(User::Codex);
        let made = first.made().unwrap();
        // The move's record went down, its rename did not.
        let new = probe_at(&fixture, "Agent Relay 2.app");
        let record = fixture.data.join(RECORD);
        std::fs::write(
            &record,
            serde_json::to_vec(&Made {
                link: link.clone(),
                target: new.clone(),
                inode: made.inode + 1_000_000,
                replacing: Some((old.clone(), made.inode)),
            })
            .unwrap(),
        )
        .unwrap();
        let second = ProbeAlias::new(new.clone(), &fixture.home, &fixture.data, false);
        assert_eq!(second.acquire(User::Codex), link);
        assert_eq!(std::fs::read_link(&link).unwrap(), new);
        assert_eq!(second.made().unwrap().replacing, None);
        second.release(User::Codex);
        assert!(std::fs::symlink_metadata(&link).is_err());
    }

    #[test]
    fn the_link_goes_once_no_rules_need_it() {
        let fixture = fixture();
        let real = probe_at(&fixture, "Agent Relay.app");
        let alias = ProbeAlias::new(real, &fixture.home, &fixture.data, false);
        let link = alias.acquire(User::Codex);
        alias.acquire(User::Claude);
        assert_eq!(alias.published(), Some(link.clone()));
        alias.release(User::Codex);
        assert!(
            std::fs::symlink_metadata(&link).is_ok(),
            "Claude's rules use it"
        );
        alias.release(User::Claude);
        assert_eq!(alias.published(), None);
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
