//! Where this core's session socket lives, and the pointer file that tells
//! clients outside the core.

use super::{fits_unix_socket, SOCKET_NAME};
use std::path::{Path, PathBuf};

/// Where the relay-send socket lives.
///
/// Linux: `$XDG_RUNTIME_DIR/agent-relay/relay.sock`, private to this user
/// and cleared at logout; without a runtime directory, or with one too long
/// for a Unix socket, as macOS.
/// macOS: `<app data>/run/relay.sock`, else a short per-user directory under
/// `$TMPDIR` (then `/tmp`) when that path is too long for a Unix socket.
/// Windows: `<app data>/run/relay.sock`, the key of its named pipe.
/// Agent Relay Dev (an app data directory ending `.dev`) has its own socket
/// in every location.
pub fn default_socket(
    env: &dyn Fn(&str) -> Option<String>,
    app_data_dir: &Path,
    uid: u32,
) -> PathBuf {
    socket_for(cfg!(target_os = "linux"), env, app_data_dir, uid)
}

pub(super) fn socket_for(
    linux: bool,
    env: &dyn Fn(&str) -> Option<String>,
    app_data_dir: &Path,
    uid: u32,
) -> PathBuf {
    let directory = if is_development(app_data_dir) {
        "agent-relay-dev"
    } else {
        "agent-relay"
    };
    let preferred = app_data_dir.join("run").join(SOCKET_NAME);
    if linux {
        if let Some(runtime) = env("XDG_RUNTIME_DIR").filter(|value| !value.trim().is_empty()) {
            let path = Path::new(runtime.trim()).join(directory).join(SOCKET_NAME);
            if fits_unix_socket(&path) {
                return path;
            }
        }
    }
    if fits_unix_socket(&preferred) {
        return preferred;
    }
    let short = format!("{directory}-{uid}");
    let temporary = env("TMPDIR")
        .filter(|value| !value.trim().is_empty())
        .map(|value| Path::new(value.trim()).join(&short).join(SOCKET_NAME));
    match temporary {
        Some(path) if fits_unix_socket(&path) => path,
        _ => Path::new("/tmp").join(short).join(SOCKET_NAME),
    }
}

/// `~/.agentworkforce/desktop/relay-socket`: the socket's path plus a
/// newline, for clients outside the core. Agent Relay Dev (an app data
/// directory ending `.dev`) writes `relay-socket.dev`, so the two builds
/// never point sessions at each other.
pub fn pointer_path(home: &Path, app_data_dir: &Path) -> PathBuf {
    let name = if is_development(app_data_dir) {
        "relay-socket.dev"
    } else {
        "relay-socket"
    };
    home.join(".agentworkforce/desktop").join(name)
}

/// Agent Relay Dev: an app data directory ending `.dev`.
pub(crate) fn is_development(app_data_dir: &Path) -> bool {
    app_data_dir
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".dev"))
}
