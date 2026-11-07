//! Where the daemon's socket and single-instance lock live.
//!
//! Default: `~/.agentworkforce/desktop/core.sock` and `core.sock.lock` beside
//! it, in a 0700 directory. `AGENT_RELAY_CORE_SOCKET` (or `--socket`) moves
//! both; the lock is always the socket path plus `.lock`, so one socket has
//! exactly one owner. On Windows the socket path is only the key its named
//! pipe is derived from (`relay::transport::pipe_name`); the lock file is
//! real and keeps its path.

use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

/// Overrides the bridge socket path for clients and the daemon alike.
pub const SOCKET_ENV: &str = "AGENT_RELAY_CORE_SOCKET";

/// `sockaddr_un.sun_path` capacity including the terminating NUL.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const SUN_PATH_CAPACITY: usize = 104;
#[cfg(all(unix, not(any(target_os = "macos", target_os = "ios"))))]
const SUN_PATH_CAPACITY: usize = 108;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CorePaths {
    pub socket: PathBuf,
    pub lock: PathBuf,
}

impl CorePaths {
    /// The socket an explicit path, the environment, or the default names.
    pub fn resolve(
        explicit: Option<&Path>,
        env: impl Fn(&str) -> Option<String>,
        home: &Path,
    ) -> Result<CorePaths> {
        let socket = match explicit {
            Some(path) => path.to_path_buf(),
            None => match env(SOCKET_ENV).filter(|value| !value.trim().is_empty()) {
                Some(value) => PathBuf::from(value.trim()),
                None => default_socket(home),
            },
        };
        CorePaths::for_socket(beside_default_socket(&socket, home))
    }

    pub fn for_socket(socket: PathBuf) -> Result<CorePaths> {
        if !socket.is_absolute() {
            bail!("the bridge socket path must be absolute");
        }
        // A named pipe's name has no such limit.
        #[cfg(unix)]
        if socket.as_os_str().len() >= SUN_PATH_CAPACITY {
            bail!("the bridge socket path is too long for a Unix socket");
        }
        let mut lock = socket.clone().into_os_string();
        lock.push(".lock");
        Ok(CorePaths {
            socket,
            lock: PathBuf::from(lock),
        })
    }

    pub fn directory(&self) -> &Path {
        self.socket.parent().unwrap_or(Path::new("/"))
    }
}

pub fn default_socket(home: &Path) -> PathBuf {
    home.join(".agentworkforce/desktop/core.sock")
}

/// A socket path from `--socket` or the environment; a relative one lives
/// beside the default socket, so a launchd property list can name
/// `core.dev.sock` without `~`.
pub fn beside_default_socket(path: &Path, home: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    default_socket(home)
        .parent()
        .map_or_else(|| path.to_path_buf(), |directory| directory.join(path))
}

/// `$HOME`, which every per-user path hangs from.
#[cfg(not(windows))]
pub fn home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .context("HOME unavailable")
}

/// `%USERPROFILE%`, the profile Claude Code and Codex keep their files in,
/// which every per-user path hangs from; `%HOME%` only without one. A shell
/// such as MSYS2 or Git Bash sets `HOME` to a home of its own, which must
/// not move the core away from the sessions it reads.
#[cfg(windows)]
pub fn home() -> Result<PathBuf> {
    // The profile as Windows knows it, when the environment names none.
    crate::platform::home_dir()
        .map(Ok)
        .unwrap_or_else(|| home_from(|key| std::env::var_os(key)))
}

#[cfg(any(windows, test))]
fn home_from(env: impl Fn(&str) -> Option<std::ffi::OsString>) -> Result<PathBuf> {
    ["USERPROFILE", "HOME"]
        .into_iter()
        .find_map(|key| env(key).filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .context("Neither HOME nor USERPROFILE is set.")
}

/// Prepares the socket's directory. A missing one is created 0700; an
/// existing one is used as is, but only when this user owns it (and the
/// symlink naming it, if any) and no one else can write to it: the daemon
/// never changes permissions on a directory, so it can never be steered into
/// re-permissioning one it did not create (`/tmp`, `/`, a planted symlink).
#[cfg(unix)]
pub fn socket_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let uid = crate::relay::peer::current_uid();
    let entry = fs::symlink_metadata(path)?;
    let metadata = fs::metadata(path)?;
    if entry.uid() != uid
        || !metadata.is_dir()
        || metadata.uid() != uid
        || metadata.mode() & 0o022 != 0
    {
        bail!(
            "{} must be a directory only you can write to; choose another socket path.",
            path.display()
        );
    }
    Ok(())
}

/// Prepares the lock file's directory. Windows has no mode bits to check:
/// the directory inherits the user profile's ACL, which is already private,
/// and the pipe itself carries its own DACL.
#[cfg(windows)]
pub fn socket_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    if !fs::metadata(path)?.is_dir() {
        bail!(
            "{} must be a directory; choose another socket path.",
            path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A home directory that is absolute on this platform.
    fn home() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Users\a")
        } else {
            PathBuf::from("/Users/a")
        }
    }

    /// An absolute path outside the home directory.
    fn elsewhere(name: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\Temp").join(name)
        } else {
            PathBuf::from("/tmp").join(name)
        }
    }

    #[test]
    fn default_socket_lives_in_the_desktop_directory() {
        let paths = CorePaths::resolve(None, |_| None, &home()).unwrap();
        assert_eq!(
            paths.socket,
            home().join(".agentworkforce/desktop/core.sock")
        );
        assert_eq!(
            paths.lock,
            home().join(".agentworkforce/desktop/core.sock.lock")
        );
    }

    #[test]
    fn explicit_path_beats_environment_beats_default() {
        let from_env = elsewhere("env.sock");
        let env = |key: &str| (key == SOCKET_ENV).then(|| from_env.display().to_string());
        let home = home();
        assert_eq!(
            CorePaths::resolve(None, env, &home).unwrap().socket,
            from_env
        );
        assert_eq!(
            CorePaths::resolve(Some(elsewhere("flag.sock").as_path()), env, &home)
                .unwrap()
                .socket,
            elsewhere("flag.sock")
        );
    }

    #[test]
    fn relative_paths_live_beside_the_default() {
        assert!(CorePaths::for_socket(PathBuf::from("core.sock")).is_err());
        let home = home();
        let dev = |key: &str| (key == SOCKET_ENV).then(|| "core.dev.sock".to_string());
        let beside = home.join(".agentworkforce/desktop/core.dev.sock");
        assert_eq!(CorePaths::resolve(None, dev, &home).unwrap().socket, beside);
        assert_eq!(
            CorePaths::resolve(Some(Path::new("core.dev.sock")), |_| None, &home)
                .unwrap()
                .socket,
            beside
        );
        assert_eq!(
            beside_default_socket(Path::new("core.dev.sock"), &home),
            beside
        );
        assert_eq!(
            beside_default_socket(&elsewhere("x.sock"), &home),
            elsewhere("x.sock")
        );
    }

    #[cfg(unix)]
    #[test]
    fn overlong_unix_socket_paths_are_refused() {
        let long = format!("/{}/core.sock", "x".repeat(120));
        assert!(CorePaths::for_socket(PathBuf::from(long)).is_err());
    }

    #[test]
    fn home_prefers_the_user_profile_then_home() {
        use std::ffi::OsString;
        // MSYS2 and Git Bash set HOME to a home of their own; the profile
        // is where Claude Code and Codex keep their sessions.
        let both = |key: &str| match key {
            "HOME" => Some(OsString::from("/h")),
            "USERPROFILE" => Some(OsString::from(r"C:\Users\a")),
            _ => None,
        };
        assert_eq!(home_from(both).unwrap(), PathBuf::from(r"C:\Users\a"));
        let shell = |key: &str| match key {
            "HOME" => Some(OsString::from("/h")),
            _ => None,
        };
        assert_eq!(home_from(shell).unwrap(), PathBuf::from("/h"));
        let profile = |key: &str| match key {
            "HOME" => Some(OsString::new()),
            "USERPROFILE" => Some(OsString::from(r"C:\Users\a")),
            _ => None,
        };
        assert_eq!(home_from(profile).unwrap(), PathBuf::from(r"C:\Users\a"));
        assert!(home_from(|_| None).is_err());
    }
}

#[cfg(test)]
#[cfg(unix)]
mod directory_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_new_directory_is_private() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("a/b");
        socket_directory(&dir).unwrap();
        let mode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn an_existing_directory_is_never_rechmodded() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("shared");
        fs::create_dir(&shared).unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(socket_directory(&shared).is_err());
        assert_eq!(
            fs::metadata(&shared).unwrap().permissions().mode() & 0o777,
            0o777
        );
        let own = temp.path().join("own");
        fs::create_dir(&own).unwrap();
        fs::set_permissions(&own, fs::Permissions::from_mode(0o755)).unwrap();
        socket_directory(&own).unwrap();
        assert_eq!(
            fs::metadata(&own).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[test]
    fn a_symlink_to_this_users_private_directory_is_followed() {
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o700)).unwrap();
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        socket_directory(&link).unwrap();
        let shared = temp.path().join("shared");
        fs::create_dir(&shared).unwrap();
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o777)).unwrap();
        let to_shared = temp.path().join("to-shared");
        std::os::unix::fs::symlink(&shared, &to_shared).unwrap();
        assert!(socket_directory(&to_shared).is_err());
        assert_eq!(
            fs::metadata(&shared).unwrap().permissions().mode() & 0o777,
            0o777
        );
    }

    #[test]
    fn a_world_writable_system_directory_is_refused() {
        assert!(socket_directory(Path::new("/tmp")).is_err());
    }
}

#[cfg(test)]
#[cfg(windows)]
mod directory_tests {
    use super::*;

    #[test]
    fn a_missing_directory_is_created() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("a").join("b");
        socket_directory(&dir).unwrap();
        assert!(dir.is_dir());
        let file = temp.path().join("file");
        fs::write(&file, "").unwrap();
        assert!(socket_directory(&file).is_err());
    }
}
