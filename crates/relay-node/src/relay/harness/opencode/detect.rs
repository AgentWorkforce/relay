//! Whether OpenCode can be spawned here: its command line, and a version
//! whose server Agent Relay drives. OpenCode 1's server is what the managed
//! OpenCode route speaks (`opencode_existing`); OpenCode 2 changed it (Paseo
//! keeps a second adapter for it), and versions before 1.0 lack parts of it.
//!
//! Successful version reads are kept until the installed file changes.
//! A failed or unreadable version probe expires, so a cold-start timeout
//! does not hide an otherwise supported install until the core restarts.

use crate::relay::codex::runner::{RunOutcome, SystemRunner};
use crate::relay::existing_session::platform::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

/// Where OpenCode's command line is installed outside a home folder.
pub const SYSTEM_OPENCODE: [&str; 2] = ["/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"];

/// Why OpenCode is installed but cannot be spawned here, when it does not
/// say which version it is.
pub const OPENCODE_NO_VERSION: &str = "OpenCode here did not report its version (opencode --version), so Agent Relay cannot tell whether it can run it headless. Reinstall OpenCode (https://opencode.ai), then try again.";

/// `opencode --version` for an executable, the way detection asks it.
pub type VersionProbe = dyn Fn(&Path) -> Option<String> + Send + Sync;

/// How long `opencode --version` gets.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_RETRY: Duration = Duration::from_secs(30);

/// The `opencode` command line: `RELAY_DESKTOP_OPENCODE` (exactly that
/// file, or none), else the first installed of OpenCode's own installer's
/// `~/.opencode/bin`, `~/.local/bin`, Bun's `~/.bun/bin`, `system` and then
/// `PATH`. An app started from the desktop has no shell `PATH`, so the fixed
/// locations come first; a version manager's shim is never used.
pub fn find_executable(
    env: &dyn Fn(&str) -> Option<String>,
    home: &Path,
    system: &[PathBuf],
) -> Option<PathBuf> {
    let set = |key: &str| {
        env(key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    if let Some(path) = set("RELAY_DESKTOP_OPENCODE") {
        return Some(PathBuf::from(path)).filter(|path| path.is_absolute() && usable(path));
    }
    let path_entries: Vec<PathBuf> = set("PATH")
        .map(|path| {
            path.split(':')
                .filter(|dir| dir.starts_with('/'))
                .map(|dir| Path::new(dir).join("opencode"))
                .collect()
        })
        .unwrap_or_default();
    [".opencode/bin", ".local/bin", ".bun/bin"]
        .iter()
        .map(|dir| home.join(dir).join("opencode"))
        .chain(system.iter().cloned())
        .chain(path_entries)
        .find(|path| usable(path))
}

fn usable(path: &Path) -> bool {
    let shim = |path: &Path| path.to_string_lossy().contains("/mise/shims/");
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        && !shim(path)
        && !std::fs::canonicalize(path).is_ok_and(|real| shim(&real))
}

/// A version as `opencode --version` prints it (`1.18.30`, `v1.2.3`,
/// `opencode 1.2.3-beta.1`): its major, minor and patch.
pub fn parse_version(output: &str) -> Option<(u64, u64, u64)> {
    output.lines().find_map(|line| {
        let line = line.trim();
        let line = line
            .strip_prefix("opencode")
            .map(str::trim_start)
            .unwrap_or(line);
        let line = line.strip_prefix('v').unwrap_or(line);
        let release = line.split(['-', '+']).next()?;
        let mut numbers = release.split('.').map(|part| part.parse::<u64>().ok());
        let version = (numbers.next()??, numbers.next()??, numbers.next()??);
        numbers.next().is_none().then_some(version)
    })
}

/// Whether OpenCode with this `--version` output can be spawned here, else
/// why not.
pub fn supported(output: Option<&str>) -> Result<(), String> {
    let Some((major, minor, patch)) = output.and_then(parse_version) else {
        return Err(OPENCODE_NO_VERSION.into());
    };
    let version = format!("{major}.{minor}.{patch}");
    match major {
        0 => Err(format!(
            "OpenCode {version} is too old to spawn: Agent Relay drives the server of OpenCode 1.0 and later (opencode serve). Update OpenCode, then try again."
        )),
        1 => Ok(()),
        _ => Err(format!(
            "OpenCode {version} cannot be spawned yet: Agent Relay drives the server of OpenCode 1, and OpenCode {major} changed it. Install OpenCode 1 to spawn OpenCode agents here."
        )),
    }
}

/// The folders OpenCode creates on start (`xdg-basedir`), redirected for
/// the version probe.
const SCRATCH_XDG: [(&str, &str); 4] = [
    ("XDG_CONFIG_HOME", "config"),
    ("XDG_DATA_HOME", "data"),
    ("XDG_CACHE_HOME", "cache"),
    ("XDG_STATE_HOME", "state"),
];

/// mise's own folders, which it finds through the XDG variables: an npm
/// `opencode` starts with `#!/usr/bin/env node`, and a `node` mise provides
/// must still find its configured install under the redirected XDG folders.
/// Each one not set already is pinned to where mise would look without the
/// redirect.
const MISE_DIRS: [(&str, &str, &str); 4] = [
    ("MISE_CONFIG_DIR", "XDG_CONFIG_HOME", ".config"),
    ("MISE_DATA_DIR", "XDG_DATA_HOME", ".local/share"),
    ("MISE_CACHE_DIR", "XDG_CACHE_HOME", ".cache"),
    ("MISE_STATE_DIR", "XDG_STATE_HOME", ".local/state"),
];

/// [`MISE_DIRS`] as they are before the version probe redirects XDG.
fn kept_tool_dirs(env: &dyn Fn(&str) -> Option<String>) -> Vec<(&'static str, PathBuf)> {
    let set = |key: &str| env(key).filter(|value| !value.trim().is_empty());
    let Some(home) = set("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    MISE_DIRS
        .iter()
        .filter(|(mise, _, _)| set(mise).is_none())
        .map(|(mise, xdg, default)| {
            let base = set(xdg)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or_else(|| home.join(default));
            (*mise, base.join("mise"))
        })
        .collect()
}

/// `executable --version`, when it answers in time and succeeds.
///
/// OpenCode creates its config, data, cache and state folders whenever it
/// starts, `--version` included, so it is asked with those pointed at a
/// throwaway folder: detecting OpenCode never leaves an empty
/// `~/.config/opencode` (and the rest) for someone who has not set it up.
pub fn system_version(executable: &Path) -> Option<String> {
    // Never asked without a scratch folder: that would create the folders
    // this avoids. A failure is retried after `VERSION_RETRY`, like any
    // unreadable version.
    let scratch = tempfile::Builder::new()
        .prefix("agent-relay-opencode-version-")
        .tempdir()
        .ok()?;
    let mut env: Vec<(&str, PathBuf)> = SCRATCH_XDG
        .iter()
        .map(|(key, dir)| (*key, scratch.path().join(dir)))
        .collect();
    env.extend(kept_tool_dirs(&|key| std::env::var(key).ok()));
    match SystemRunner.run_with_env(executable, &["--version".into()], VERSION_TIMEOUT, &env) {
        RunOutcome::Exited {
            code: 0, stdout, ..
        } => Some(stdout.trim().to_string()),
        _ => None,
    }
}

/// A known version stays cached until the file changes; transient failures
/// stay cached only briefly to avoid probing on every status read.
#[derive(Default)]
pub struct VersionCache(Mutex<Option<CachedVersion>>);

struct CachedVersion {
    stamp: Stamp,
    version: Option<String>,
    checked: Instant,
}

/// What a file is: its real path, size and modification time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stamp(PathBuf, u64, Option<SystemTime>);

impl Stamp {
    fn of(path: &Path) -> Stamp {
        let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let metadata = std::fs::metadata(&real).ok();
        Stamp(
            real,
            metadata.as_ref().map_or(0, |m| m.len()),
            metadata.and_then(|m| m.modified().ok()),
        )
    }
}

impl VersionCache {
    /// `executable`'s version, retrying an unreadable result after backoff.
    pub fn get(
        &self,
        executable: &Path,
        probe: &dyn Fn(&Path) -> Option<String>,
    ) -> Option<String> {
        self.get_at(executable, probe, Instant::now())
    }

    fn get_at(
        &self,
        executable: &Path,
        probe: &dyn Fn(&Path) -> Option<String>,
        now: Instant,
    ) -> Option<String> {
        let stamp = Stamp::of(executable);
        let mut cached = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(seen) = cached.as_ref() {
            let known = seen.version.as_deref().and_then(parse_version).is_some();
            if seen.stamp == stamp
                && (known || now.saturating_duration_since(seen.checked) < VERSION_RETRY)
            {
                return seen.version.clone();
            }
        }
        let version = probe(executable);
        *cached = Some(CachedVersion {
            stamp,
            version: version.clone(),
            checked: now,
        });
        version
    }
}

#[cfg(test)]
#[path = "detect/tests.rs"]
mod tests;
