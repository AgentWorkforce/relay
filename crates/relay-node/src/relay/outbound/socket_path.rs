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
/// Agent Relay Dev (an app data directory ending `.dev`) and each profile
/// build (`Build`) have their own socket in every location:
/// `agent-relay-dev` and `agent-relay-<profile id>` in place of
/// `agent-relay`.
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
    let directory = match Build::of(app_data_dir) {
        Build::Production => "agent-relay".to_string(),
        Build::Development => "agent-relay-dev".to_string(),
        Build::Profile(id) => format!("agent-relay-{id}"),
    };
    let directory = directory.as_str();
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

/// Which build of Agent Relay a core is, told from its app data directory's
/// name, the one thing every build is started with
/// (`--app-data-dir <bundle id>` from the LaunchAgent a coexisting build
/// writes; the default directory otherwise):
///
/// - `com.agentrelay.desktop` (`app_store::APP_ID`): Agent Relay, the
///   production build.
/// - a name ending `.dev`: Agent Relay Dev.
/// - any other name: a profile build sitting beside them (`build-app.sh
///   --coexist`), named by `Build::profile_id`.
///
/// The build names its session pointer, its session socket's directory and
/// the marker its hooks carry, so two builds never point sessions at each
/// other or take each other's hooks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Build {
    Production,
    Development,
    Profile(String),
}

/// The longest profile id used as written; a longer one is hashed.
const PROFILE_ID_MAX: usize = 40;

impl Build {
    pub fn of(app_data_dir: &Path) -> Build {
        let name = app_data_dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name == crate::relay::app_store::APP_ID {
            Build::Production
        } else if name.ends_with(".dev") {
            Build::Development
        } else {
            Build::Profile(Build::profile_id(&name))
        }
    }

    /// A profile build's id: its data directory name without the
    /// `com.agentrelay.desktop.` prefix (`com.agentrelay.desktop.devaws` is
    /// `devaws`) when it has that prefix and the rest is lower-case
    /// letters, digits and `-`, at most 40 characters and not `dev`;
    /// otherwise `_` and the first 12 hex digits of the whole name's
    /// SHA-256. A name without the prefix is always hashed, even one the
    /// grammar would accept, so `foo` and `com.agentrelay.desktop.foo` are
    /// different builds. A written id never has `_`, so the two forms cannot
    /// name the same build.
    pub fn profile_id(name: &str) -> String {
        let rest = name
            .strip_prefix(crate::relay::app_store::APP_ID)
            .and_then(|rest| rest.strip_prefix('.'));
        if let Some(rest) = rest.filter(|rest| valid_profile_id(rest)) {
            return rest.to_string();
        }
        use sha2::{Digest, Sha256};
        let digest = format!("{:x}", Sha256::digest(name.as_bytes()));
        format!("_{}", &digest[..12])
    }

    /// The build a session command names: `--dev`, `--profile <id>` or
    /// neither. An id that no build could have is refused.
    pub fn named(development: bool, profile: Option<&str>) -> Result<Build, &'static str> {
        match (development, profile) {
            (true, Some(_)) => Err("Pass --dev or --profile, not both."),
            (true, None) => Ok(Build::Development),
            (false, None) => Ok(Build::Production),
            (false, Some(id)) if valid_profile_id(id) || hashed_profile_id(id) => {
                Ok(Build::Profile(id.to_string()))
            }
            (false, Some(_)) => Err(
                "--profile takes a profile build's id, the part of its bundle id after com.agentrelay.desktop.",
            ),
        }
    }

    pub fn is_development(&self) -> bool {
        matches!(self, Build::Development)
    }

    /// The pointer file's name: `relay-socket`, `relay-socket.dev` or
    /// `relay-socket.<profile id>`.
    pub fn pointer_name(&self) -> String {
        match self {
            Build::Production => "relay-socket".into(),
            Build::Development => "relay-socket.dev".into(),
            Build::Profile(id) => format!("relay-socket.{id}"),
        }
    }

    /// Who the build is, for messages: `Agent Relay`, `Agent Relay Dev` or
    /// `the <id> profile build`.
    pub fn describe(&self) -> String {
        match self {
            Build::Production => "Agent Relay".into(),
            Build::Development => "Agent Relay Dev".into(),
            Build::Profile(id) => format!("the {id} profile build of Agent Relay"),
        }
    }

    /// The flag that names this build to a session command.
    pub fn flag(&self) -> String {
        match self {
            Build::Production => "neither --dev nor --profile".into(),
            Build::Development => "--dev".into(),
            Build::Profile(id) => format!("--profile={id}"),
        }
    }

    /// The build whose pointer has `name`, if it is a pointer's name.
    pub fn of_pointer(name: &str) -> Option<Build> {
        match name.strip_prefix("relay-socket")? {
            "" => Some(Build::Production),
            ".dev" => Some(Build::Development),
            rest => rest
                .strip_prefix('.')
                .filter(|id| valid_profile_id(id) || hashed_profile_id(id))
                .map(|id| Build::Profile(id.to_string())),
        }
    }
}

fn valid_profile_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= PROFILE_ID_MAX
        && id != "dev"
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn hashed_profile_id(id: &str) -> bool {
    id.strip_prefix('_').is_some_and(|hex| {
        hex.len() == 12
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

/// `~/.agentworkforce/desktop/relay-socket`: the socket's path plus a
/// newline, for clients outside the core. Each build has its own
/// (`Build::pointer_name`): Agent Relay Dev writes `relay-socket.dev` and a
/// profile build `relay-socket.<profile id>`, never `relay-socket`, so no
/// build points another build's sessions at itself.
pub fn pointer_path(home: &Path, app_data_dir: &Path) -> PathBuf {
    pointer_directory(home).join(Build::of(app_data_dir).pointer_name())
}

/// `~/.agentworkforce/desktop`, where every build's pointer lives.
pub fn pointer_directory(home: &Path) -> PathBuf {
    home.join(".agentworkforce/desktop")
}

/// Agent Relay Dev: an app data directory ending `.dev`.
pub(crate) fn is_development(app_data_dir: &Path) -> bool {
    Build::of(app_data_dir).is_development()
}
