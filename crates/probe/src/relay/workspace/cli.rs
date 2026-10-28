//! The workspace the `agent-relay` CLI selects, read and never written.
//!
//! This follows the CLI's precedence ladder
//! (`packages/cloud/src/project-workspace-key.ts` `resolveWorkspaceSelection`)
//! and its transport rule (`packages/cli/src/cli/lib/sdk-client.ts`
//! `resolveWorkspaceTransport`), minus the `--workspace-key` flag the daemon
//! has no equivalent of:
//!
//! 1. **env**: `RELAY_WORKSPACE_KEY` > `AGENT_RELAY_WORKSPACE_KEY` > `RELAY_API_KEY`;
//! 2. **project**: `<project>/.agentworkforce/relay/workspace-key.json`, where
//!    the project is `AGENT_RELAY_PROJECT` (the CLI's explicit project root;
//!    the daemon has no working directory of its own to search from). An
//!    absent or malformed pin falls through, as in the CLI;
//! 3. **store**: the active entry of `$AGENT_RELAY_HOME/workspaces.json`
//!    (`{ active, workspaces: { name: { key } } }`). A file that exists but
//!    cannot be read or parsed is an error, as in the CLI.
//!
//! The destination is then chosen the CLI's way:
//!
//! - a persisted project route (`relaycastRoute` + `relaycastBaseUrl`) must be
//!   one of Agent Relay's own gateways, and a credential bound to another
//!   server is refused rather than sent there;
//! - otherwise a non-blank `RELAY_BASE_URL` is used (a malformed one is an
//!   error, never a fallback);
//! - otherwise the credential's binding in `relaycast-origins.json`;
//! - otherwise the hosted default, `https://cast.agentrelay.com`.
//!
//! Whenever a credential is about to be used the bindings file must parse:
//! a malformed one fails closed.

use super::origin_binding::{self, OriginBindings};
use super::{is_workspace_key, Secret, Workspace, WorkspaceSource, DEFAULT_BASE_URL};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Workspace-key environment variables, highest precedence first.
pub const WORKSPACE_KEY_ENV_VARS: [&str; 3] = [
    "RELAY_WORKSPACE_KEY",
    "AGENT_RELAY_WORKSPACE_KEY",
    "RELAY_API_KEY",
];
/// The CLI's explicit project root.
pub const PROJECT_ENV: &str = "AGENT_RELAY_PROJECT";
/// The explicit Relaycast base URL the CLI honours.
pub const BASE_URL_ENV: &str = "RELAY_BASE_URL";
pub const WORKSPACE_STORE_FILE: &str = "workspaces.json";
pub const PROJECT_WORKSPACE_KEY_FILE: &str = "workspace-key.json";
pub const RELAYCAST_CREDENTIALS_FILE: &str = "relaycast-credentials.json";
const PROJECT_DATA_DIR: &str = ".agentworkforce/relay";

const CANONICAL_RELAYCAST_ORIGIN: &str = "https://cast.agentrelay.com";
const AGENT37_RELAYCAST_ORIGIN: &str = "https://agent37-cast.agentrelay.com";
const DEV_RELAYCAST_ORIGIN: &str = "https://dev-cast.agentrelay.com";
const DEV_CLOUD_API_URL: &str = "https://dev.agentrelay.com/cloud";

/// The project pin, as the CLI reads it (`readProjectWorkspaceSession`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ProjectSession {
    workspace_key: String,
    route: Option<Route>,
    relaycast_base_url: Option<String>,
    relaycast_cloud_api_url: Option<String>,
    /// The route credential: the one the pin's `relaycastApiKeyRef` names in
    /// `relaycast-credentials.json` when it matches the pin, else a legacy
    /// inline `relaycastApiKey`.
    relaycast_api_key: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Route {
    Canonical,
    Agent37Isolated,
}

impl Route {
    fn parse(value: &str) -> Option<Route> {
        match value {
            "canonical" => Some(Route::Canonical),
            "agent37-isolated" => Some(Route::Agent37Isolated),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Route::Canonical => "canonical",
            Route::Agent37Isolated => "agent37-isolated",
        }
    }
}

/// One selected key, where it came from, and the project route it carries.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Selection {
    key: String,
    source: WorkspaceSource,
    project: Option<ProjectSession>,
}

/// The CLI's workspace for this machine: `Ok(None)` when the CLI selects
/// none, `Err` with a printable reason (never key material) when its files
/// or settings forbid using the one it selects.
pub fn resolve(
    env: &dyn Fn(&str) -> Option<String>,
    relay_home: &Path,
) -> Result<Option<Workspace>, String> {
    let Some(selection) = select(env, relay_home)? else {
        return Ok(None);
    };
    transport(selection, env, relay_home).map(Some)
}

fn select(
    env: &dyn Fn(&str) -> Option<String>,
    relay_home: &Path,
) -> Result<Option<Selection>, String> {
    let data_dir = env(PROJECT_ENV)
        .and_then(trimmed)
        .map(|root| project_data_dir(Path::new(&root)));
    let project = data_dir
        .as_deref()
        .and_then(|dir| read_project_session(dir, relay_home));

    for name in WORKSPACE_KEY_ENV_VARS {
        if let Some(key) = env(name).and_then(trimmed) {
            // The pin's route rides along only for the same key, as in the CLI.
            let project = project.filter(|project| project.workspace_key == key);
            return Ok(Some(Selection {
                key,
                source: WorkspaceSource::CliEnv(name.to_string()),
                project,
            }));
        }
    }
    if let (Some(project), Some(dir)) = (project, data_dir) {
        return Ok(Some(Selection {
            key: project.workspace_key.clone(),
            source: WorkspaceSource::CliProject(dir.join(PROJECT_WORKSPACE_KEY_FILE)),
            project: Some(project),
        }));
    }
    let store = relay_home.join(WORKSPACE_STORE_FILE);
    Ok(read_active_store_key(&store)?.map(|(name, key)| Selection {
        key,
        source: WorkspaceSource::CliStore { file: store, name },
        project: None,
    }))
}

fn transport(
    selection: Selection,
    env: &dyn Fn(&str) -> Option<String>,
    relay_home: &Path,
) -> Result<Workspace, String> {
    let project = selection.project.as_ref();
    let credential = project
        .and_then(|project| project.relaycast_api_key.clone())
        .unwrap_or_else(|| selection.key.clone());
    if !is_workspace_key(&credential) {
        return Err(format!(
            "The workspace key from {} is not a Relaycast workspace key.",
            selection.source.describe()
        ));
    }
    let bindings = origin_binding::read_bindings(&origin_binding::bindings_path(relay_home))?;
    let base_url = match persisted_route_origin(project)? {
        Some(persisted) => {
            // A derived destination never moves a binding.
            accept_derived_destination(&bindings, &credential, &persisted)?;
            persisted
        }
        None => match env(BASE_URL_ENV) {
            Some(requested) => origin_binding::configured_base_url(&requested)
                .map_err(|reason| format!("{BASE_URL_ENV} {reason}."))?,
            None => None,
        }
        .or_else(|| bindings.bound(&credential).map(str::to_string))
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
    };
    Ok(Workspace {
        key: Secret::new(credential),
        base_url,
        // The pin's `workspaceId` is the Cloud's name for the workspace, not
        // necessarily Relaycast's; verification records Relaycast's own.
        workspace_id: None,
        source: selection.source,
    })
}

/// `validatePersistedRelaycastBaseUrl`: no route is `None`; a route must be
/// complete and name the gateway its kind belongs to, bare https.
fn persisted_route_origin(project: Option<&ProjectSession>) -> Result<Option<String>, String> {
    let Some(project) = project else {
        return Ok(None);
    };
    if project.relaycast_base_url.is_none()
        && project.route.is_none()
        && project.relaycast_api_key.is_none()
    {
        return Ok(None);
    }
    let (Some(base_url), Some(route)) = (&project.relaycast_base_url, project.route) else {
        return Err("The persisted Relaycast workspace route is incomplete.".into());
    };
    let expected = match route {
        Route::Canonical
            if project.relaycast_cloud_api_url.as_deref() == Some(DEV_CLOUD_API_URL) =>
        {
            DEV_RELAYCAST_ORIGIN
        }
        Route::Canonical => CANONICAL_RELAYCAST_ORIGIN,
        Route::Agent37Isolated => AGENT37_RELAYCAST_ORIGIN,
    };
    let untrusted = || "The persisted Relaycast workspace route is not trusted.".to_string();
    let parsed = url::Url::parse(base_url)
        .map_err(|_| "The persisted Relaycast workspace route is invalid.".to_string())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !(parsed.path().is_empty() || parsed.path() == "/")
        || parsed.origin().ascii_serialization() != expected
    {
        return Err(untrusted());
    }
    if route == Route::Agent37Isolated && project.relaycast_api_key.is_none() {
        return Err(
            "The persisted isolated Relaycast credential is unavailable or mismatched.".into(),
        );
    }
    Ok(Some(expected.to_string()))
}

/// `acceptDerivedDestination`, without the write: a bound credential may go
/// only to its own server.
fn accept_derived_destination(
    bindings: &OriginBindings,
    credential: &str,
    destination: &str,
) -> Result<(), String> {
    let Some(bound) = bindings.bound(credential) else {
        return Ok(());
    };
    let bound_origin = origin_binding::origin_of(bound).unwrap_or_else(|| bound.to_string());
    let destination = origin_binding::origin_of(destination).unwrap_or_default();
    if bound_origin == destination {
        return Ok(());
    }
    Err(format!(
        "This Relaycast credential belongs to {bound_origin}, so it will not be sent to {destination}."
    ))
}

/// `<root>/.agentworkforce/relay`, the root made absolute against the
/// daemon's working directory as the CLI's `path.resolve` would.
fn project_data_dir(root: &Path) -> PathBuf {
    let root = std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf());
    root.join(PROJECT_DATA_DIR)
}

/// The project pin, or `None` when absent or malformed (the CLI falls
/// through to the machine store then).
fn read_project_session(data_dir: &Path, relay_home: &Path) -> Option<ProjectSession> {
    let raw = std::fs::read_to_string(data_dir.join(PROJECT_WORKSPACE_KEY_FILE)).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let text = |field: &str| {
        parsed
            .get(field)
            .and_then(|v| v.as_str())
            .and_then(trimmed_str)
    };
    let workspace_key = text("workspaceKey")?;
    let workspace_id = text("workspaceId");
    let route = parsed
        .get("relaycastRoute")
        .and_then(|v| v.as_str())
        .and_then(Route::parse);
    let relaycast_base_url = text("relaycastBaseUrl");
    let api_key_ref = text("relaycastApiKeyRef");
    let relaycast_api_key = match api_key_ref {
        Some(reference) => {
            let expected = match (&workspace_id, route, &relaycast_base_url) {
                (Some(id), Some(route), Some(base_url)) => {
                    Some(credential_ref(data_dir, id, route.as_str(), base_url))
                }
                _ => None,
            };
            if expected.as_deref() == Some(reference.as_str()) {
                read_route_credential(
                    relay_home,
                    &reference,
                    workspace_id.as_deref()?,
                    route?,
                    relaycast_base_url.as_deref()?,
                )
            } else {
                None
            }
        }
        None => text("relaycastApiKey"),
    };
    Some(ProjectSession {
        workspace_key,
        route,
        relaycast_base_url,
        relaycast_cloud_api_url: text("relaycastCloudApiUrl"),
        relaycast_api_key,
    })
}

/// A route credential from `relaycast-credentials.json`, only when it
/// records the same workspace, route and server as the pin.
fn read_route_credential(
    relay_home: &Path,
    reference: &str,
    workspace_id: &str,
    route: Route,
    base_url: &str,
) -> Option<String> {
    let raw = std::fs::read_to_string(relay_home.join(RELAYCAST_CREDENTIALS_FILE)).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let entry = parsed.get("credentials")?.get(reference)?;
    let field = |name: &str| entry.get(name).and_then(|v| v.as_str());
    (field("workspaceId") == Some(workspace_id)
        && field("route") == Some(route.as_str())
        && field("baseUrl") == Some(base_url))
    .then(|| field("apiKey").map(str::to_string))
    .flatten()
}

/// `relaycastCredentialRef`: SHA-256 hex of the canonical project data
/// directory, the workspace id, the route and the server's origin, joined
/// by NULs.
fn credential_ref(data_dir: &Path, workspace_id: &str, route: &str, base_url: &str) -> String {
    let trimmed = base_url.trim();
    let endpoint = origin_binding::origin_of(trimmed).unwrap_or_else(|| trimmed.to_string());
    let mut hasher = Sha256::new();
    hasher.update(canonical_data_dir(data_dir).as_bytes());
    hasher.update([0]);
    hasher.update(workspace_id.as_bytes());
    hasher.update([0]);
    hasher.update(route.as_bytes());
    hasher.update([0]);
    hasher.update(endpoint.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The data directory resolved through symlinks (its missing tail kept),
/// case-folded on Windows, as the CLI's `canonicalProjectDataDir`.
fn canonical_data_dir(data_dir: &Path) -> String {
    let resolved = std::path::absolute(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
    let mut current = resolved.clone();
    let mut missing = Vec::new();
    let canonical = loop {
        match std::fs::canonicalize(&current) {
            Ok(real) => {
                break missing
                    .iter()
                    .rev()
                    .fold(real, |path, part| path.join(part))
            }
            Err(_) => match (current.parent(), current.file_name()) {
                (Some(parent), Some(name)) => {
                    missing.push(name.to_os_string());
                    current = parent.to_path_buf();
                }
                _ => break resolved,
            },
        }
    };
    let text = canonical.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// The active store entry's name and key. A missing file selects nothing;
/// one that cannot be read or parsed is an error, as in the CLI.
fn read_active_store_key(file: &Path) -> Result<Option<(String, String)>, String> {
    let raw = match std::fs::read_to_string(file) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(format!(
                "Could not read {}; fix or remove it.",
                file.display()
            ))
        }
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| format!("{} is not valid JSON; fix or remove it.", file.display()))?;
    let Some(active) = parsed
        .get("active")
        .and_then(|v| v.as_str())
        .and_then(trimmed_str)
    else {
        return Ok(None);
    };
    let key = parsed
        .get("workspaces")
        .and_then(|workspaces| workspaces.get(&active))
        .and_then(|entry| entry.get("key"))
        .and_then(|key| key.as_str())
        .and_then(trimmed_str);
    Ok(key.map(|key| (active, key)))
}

fn trimmed(value: String) -> Option<String> {
    trimmed_str(&value)
}

fn trimmed_str(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests;
