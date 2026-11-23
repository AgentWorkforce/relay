//! The Relaycast workspace this computer's agents live in. Two sources can
//! name it, and the daemon uses exactly one at a time:
//!
//! 1. **The `agent-relay` CLI** (`cli`): the workspace the CLI itself would
//!    use on this machine, by its own precedence (environment key, the
//!    `AGENT_RELAY_PROJECT` project pin, then the active entry of
//!    `$AGENT_RELAY_HOME/workspaces.json`) and its own origin rule
//!    (`relaycast-origins.json` bindings, `RELAY_BASE_URL`, else the hosted
//!    default). This is how `relay init`'s local and self-hosted servers work
//!    with no Cloud sign-in, and it keeps the probe in the same workspace as
//!    the CLI's MCP tools in every session.
//! 2. **The Cloud sign-in** (`cloud` in the agent store, written by the
//!    desktop sign-in), used only when the CLI selects nothing — a desktop
//!    user who never ran the CLI. `RELAYCAST_URL` overrides its origin, but
//!    only a bare https origin (http only for localhost) is accepted;
//!    anything else leaves the account's.
//!
//! Each source's key goes only to that source's origin: `RELAYCAST_URL`
//! never re-origins a CLI key, and a CLI binding never re-origins the
//! account's. When the CLI's files forbid using the key it selects (a
//! malformed `relaycast-origins.json`, a bad `RELAY_BASE_URL`, an unreadable
//! `workspaces.json`), resolution fails closed with that reason instead of
//! falling back to the account's workspace.
//!
//! A build made for its own site (`AGENT_RELAY_SITE_URL`,
//! [`links::is_site_build`]) uses only that site's values and never falls
//! back to Agent Relay's public gateways: the account's workspace must carry
//! the Relaycast origin the site's workspace resolve answered
//! (`RELAYCAST_URL` is ignored), a CLI key needs a recorded server or
//! `RELAY_BASE_URL`, and a persisted CLI route must name the site's own
//! Relaycast origin. Each is otherwise an error naming the site.
//!
//! The first source exists only with the `relay-cli` feature: a build without
//! it reads the Cloud sign-in alone, whatever the CLI's files or environment say.

#[cfg(feature = "relay-cli")]
pub mod cli;
#[cfg(feature = "relay-cli")]
pub mod origin_binding;

use crate::relay::app_store::CloudWorkspace;
use crate::relay::links;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Path, PathBuf};

/// Where a key with no recorded server goes, and the Cloud sign-in's fallback,
/// in the default build only (a site build has neither fallback).
/// New hosted workspaces live on armadillo, but their keys are bound to it: an
/// unbound key predates that default, so this must not move with it.
pub const DEFAULT_BASE_URL: &str = "https://cast.agentrelay.com";
/// The hosted gateway `relay init --hosted` creates workspaces on.
#[cfg(feature = "relay-cli")]
pub const ARMADILLO_ORIGIN: &str = "https://armadillo.agentrelay.com";

/// A credential that never prints: `Debug` shows only a prefix. It
/// serializes as the bare value, which only the 0600 agent store writes.
#[derive(Clone, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Secret {
        Secret(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let prefix: String = self.0.chars().take(3).collect();
        write!(f, "Secret({prefix}…)")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workspace {
    pub key: Secret,
    pub base_url: String,
    /// The Relaycast workspace id (`rw_…`), when sign-in recorded it.
    pub workspace_id: Option<String>,
    /// Which source named this workspace. Only a `Cloud` key is ever
    /// recovered through the Cloud account.
    pub source: WorkspaceSource,
    /// The Control origin brokering a node-scoped key's workspace calls
    /// ([`KeyKind::NodeScoped`]); `None` for a workspace key.
    pub control_url: Option<String>,
    /// The relaygate origin of a gate-only install (validated, a bare
    /// origin like `base_url`, which is the same origin then). Agents enrol
    /// there with the desktop's device token and use the `rg_` token it
    /// returns; `key` is empty. `None` for every other workspace.
    pub gate_url: Option<String>,
}

impl Workspace {
    /// What kind of credential `key` is. A key that is neither kind never
    /// reaches a `Workspace` (every source refuses it), so it counts as a
    /// workspace key here.
    pub fn kind(&self) -> KeyKind {
        key_kind(self.key.expose()).unwrap_or(KeyKind::Workspace)
    }

    /// Whether this workspace is reached through a node-scoped credential,
    /// so only the brokered calls are available.
    pub fn node_scoped(&self) -> bool {
        self.kind() == KeyKind::NodeScoped
    }

    /// Whether this is a gate-only workspace: agents enrol through relaygate
    /// ([`Workspace::gate_url`]) and there is no workspace key.
    pub fn is_gate_only(&self) -> bool {
        self.gate_url.is_some()
    }

    /// Where this workspace's workspace-key calls go, and with what.
    pub fn route(&self) -> WorkspaceRoute {
        workspace_route(&self.base_url, &self.key, self.control_url.as_deref())
    }
}

/// What a workspace credential is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    /// A Relaycast workspace key (`rk_…`, `ar_ws_…`), sent to Relaycast.
    Workspace,
    /// A node-scoped workspace credential (`sh_wk_…`) Control minted for one
    /// node. It never goes to Relaycast: Control brokers the few
    /// workspace-key calls a node needs at `<control_url>/relay-node/v1/…`,
    /// and every other workspace-key call is unavailable.
    NodeScoped,
}

/// The prefix of a node-scoped workspace credential.
pub const NODE_KEY_PREFIX: &str = "sh_wk_";
/// The path Control brokers node-scoped workspace calls under.
pub const NODE_BROKER_PREFIX: &str = "/relay-node";

/// What `value` is as a workspace credential, or `None` when it is neither
/// kind. Both need at least 12 characters and no whitespace.
pub fn key_kind(value: &str) -> Option<KeyKind> {
    if value.len() < 12 || value.chars().any(char::is_whitespace) {
        return None;
    }
    if value.starts_with("rk_") || value.starts_with("ar_ws_") {
        Some(KeyKind::Workspace)
    } else if value.starts_with(NODE_KEY_PREFIX) {
        Some(KeyKind::NodeScoped)
    } else {
        None
    }
}

/// Whether `value` is a node-scoped credential (`sh_wk_…`).
pub fn is_node_key(value: &str) -> bool {
    key_kind(value) == Some(KeyKind::NodeScoped)
}

/// The environment variables a workspace credential is read from, highest
/// precedence first. None of them reaches a child process the core starts:
/// an agent never inherits the node's workspace credential.
pub const WORKSPACE_KEY_ENV: [&str; 3] = [
    "RELAY_WORKSPACE_KEY",
    "AGENT_RELAY_WORKSPACE_KEY",
    "RELAY_API_KEY",
];

/// Whether `name` is one of [`WORKSPACE_KEY_ENV`], in any ASCII case:
/// Windows reads environment names case-insensitively, so `Relay_Api_Key`
/// is `RELAY_API_KEY` there. Matched the same everywhere, so a child never
/// gets a credential under another spelling on any platform.
pub fn is_workspace_key_env(name: &str) -> bool {
    WORKSPACE_KEY_ENV
        .iter()
        .any(|key| key.eq_ignore_ascii_case(name))
}

/// The variable an earlier design handed a spawned agent its one-time
/// launch credential (`sh_lt_…`) in. Never set now: the node redeems the
/// credential at relaygate itself. Still stripped from every child's
/// environment ([`AGENT_SECRET_ENV`]), so a stale one is never inherited.
pub const LAUNCH_CREDENTIAL_ENV: &str = "RELAY_LAUNCH_CREDENTIAL";

/// Other credential variables no child process the core starts inherits,
/// in production builds too: the Cloud access and refresh tokens the core
/// may run with (the refresh token alone gets a new access token), and a
/// launch credential left in the node's environment.
pub const AGENT_SECRET_ENV: [&str; 3] = [
    "CLOUD_API_ACCESS_TOKEN",
    "CLOUD_API_REFRESH_TOKEN",
    LAUNCH_CREDENTIAL_ENV,
];

/// Removes [`AGENT_SECRET_ENV`] from a child `command` that inherits the
/// core's environment, in every spelling `inherited` (the core's variable
/// names) has: names are case-sensitive outside Windows.
pub fn remove_agent_secret_env(
    command: &mut std::process::Command,
    inherited: impl Iterator<Item = std::ffi::OsString>,
) {
    for name in AGENT_SECRET_ENV {
        command.env_remove(name);
    }
    for name in inherited {
        if name.to_str().is_some_and(|name| {
            AGENT_SECRET_ENV
                .iter()
                .any(|secret| secret.eq_ignore_ascii_case(name))
        }) {
            command.env_remove(name);
        }
    }
}

/// Whether `name` is a variable no child process inherits: one of
/// [`WORKSPACE_KEY_ENV`] or [`AGENT_SECRET_ENV`], in any ASCII case
/// ([`is_workspace_key_env`]).
pub fn is_child_secret_env(name: &str) -> bool {
    is_workspace_key_env(name)
        || AGENT_SECRET_ENV
            .iter()
            .any(|secret| secret.eq_ignore_ascii_case(name))
}

/// `environment` for a child process: without [`WORKSPACE_KEY_ENV`] and
/// [`AGENT_SECRET_ENV`].
pub fn without_workspace_key_env(
    mut environment: std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    environment.retain(|name, _| !is_child_secret_env(name));
    environment
}

/// Removes [`WORKSPACE_KEY_ENV`] and [`AGENT_SECRET_ENV`] from a child
/// `command`'s environment, for a command that inherits the core's own.
/// Every spelling of them the core's environment has is removed
/// ([`is_child_secret_env`]).
pub fn remove_workspace_key_env(command: &mut std::process::Command) {
    for name in WORKSPACE_KEY_ENV.iter().chain(AGENT_SECRET_ENV.iter()) {
        command.env_remove(name);
    }
    for (name, _) in std::env::vars_os() {
        if name.to_str().is_some_and(is_child_secret_env) {
            command.env_remove(name);
        }
    }
}

/// Where a workspace credential's workspace-key calls go: `origin` plus
/// `prefix` plus the Relaycast `/v1/…` path, with `credential` as the bearer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceRoute {
    pub origin: String,
    pub prefix: &'static str,
    pub credential: Secret,
}

impl WorkspaceRoute {
    /// The base URL an SDK client for this route is built with.
    pub fn base(&self) -> String {
        format!("{}{}", self.origin.trim_end_matches('/'), self.prefix)
    }
}

/// The route for `key` at Relaycast origin `base_url`: a workspace key goes
/// to `base_url` itself; a node-scoped key to `control_url` under
/// [`NODE_BROKER_PREFIX`]. A node-scoped key with no Control origin keeps
/// `base_url` with no prefix, which the SDK transport refuses to send it to
/// ([`crate::relay::sdk_http::client`]), so it fails closed.
pub fn workspace_route(base_url: &str, key: &Secret, control_url: Option<&str>) -> WorkspaceRoute {
    match (is_node_key(key.expose()), control_url) {
        (true, Some(control_url)) => WorkspaceRoute {
            origin: control_url.trim_end_matches('/').to_string(),
            prefix: NODE_BROKER_PREFIX,
            credential: key.clone(),
        },
        _ => WorkspaceRoute {
            origin: base_url.trim_end_matches('/').to_string(),
            prefix: "",
            credential: key.clone(),
        },
    }
}

/// Where the daemon's workspace key came from. Printable: it names a
/// variable or a file, never key material.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum WorkspaceSource {
    /// The desktop's Cloud sign-in (`cloud` in the agent store).
    #[default]
    Cloud,
    /// A CLI workspace-key environment variable (its name).
    CliEnv(String),
    /// The CLI project pin `<project>/.agentworkforce/relay/workspace-key.json`.
    CliProject(PathBuf),
    /// The active entry of the CLI's `workspaces.json`.
    CliStore { file: PathBuf, name: String },
}

impl WorkspaceSource {
    pub fn is_cloud(&self) -> bool {
        matches!(self, WorkspaceSource::Cloud)
    }

    /// Where the key came from, for activity and errors.
    pub fn describe(&self) -> String {
        match self {
            WorkspaceSource::Cloud => "your Agent Relay account".to_string(),
            WorkspaceSource::CliEnv(name) => format!("${name}"),
            WorkspaceSource::CliProject(file) => file.display().to_string(),
            WorkspaceSource::CliStore { file, name } => {
                format!("{} (active: \"{name}\")", file.display())
            }
        }
    }
}

/// Why a source's workspace may not be used: printable, never key material.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The `agent-relay` CLI's selection.
    Cli(String),
    /// The Cloud sign-in's workspace (only a site build refuses it).
    Cloud(String),
}

impl Refusal {
    pub fn reason(&self) -> &str {
        match self {
            Refusal::Cli(reason) | Refusal::Cloud(reason) => reason,
        }
    }

    pub fn into_reason(self) -> String {
        match self {
            Refusal::Cli(reason) | Refusal::Cloud(reason) => reason,
        }
    }

    /// The activity line that reports it.
    pub fn activity(&self) -> String {
        match self {
            Refusal::Cli(reason) => format!("Not using the agent-relay CLI's workspace: {reason}"),
            Refusal::Cloud(reason) => {
                format!("Not using your Agent Relay account's workspace: {reason}")
            }
        }
    }
}

/// The daemon's workspace: the CLI's when the CLI selects one, else the
/// Cloud sign-in's (see the module docs). `Ok(None)` when neither names one;
/// `Err` with a printable reason when the selected one may not be used.
/// Without `relay-cli` only the Cloud sign-in counts.
pub fn resolve(
    cloud: Option<&CloudWorkspace>,
    env: &dyn Fn(&str) -> Option<String>,
    home: &Path,
) -> Result<Option<Workspace>, String> {
    resolve_for_site(cloud, env, home, links::built_in_site_url()).map_err(Refusal::into_reason)
}

/// [`resolve`] for a build whose built-in site is `site`
/// ([`links::built_in_site_url`]), saying which source was refused.
#[cfg(not(feature = "relay-cli"))]
pub fn resolve_for_site(
    cloud: Option<&CloudWorkspace>,
    env: &dyn Fn(&str) -> Option<String>,
    _home: &Path,
    site: &str,
) -> Result<Option<Workspace>, Refusal> {
    resolve_cloud_for_site(cloud, env, site).map_err(Refusal::Cloud)
}

/// [`resolve`] for a build whose built-in site is `site`
/// ([`links::built_in_site_url`]), saying which source was refused.
#[cfg(feature = "relay-cli")]
pub fn resolve_for_site(
    cloud: Option<&CloudWorkspace>,
    env: &dyn Fn(&str) -> Option<String>,
    home: &Path,
    site: &str,
) -> Result<Option<Workspace>, Refusal> {
    // In a site build the site's own Relaycast origin is the one its
    // sign-in recorded (what its workspace resolve answered).
    let site_relaycast = cloud.and_then(|cloud| validated_base_url(&cloud.base_url));
    match cli::resolve_for_site(env, &relay_home(env, home), site, site_relaycast.as_deref())
        .map_err(Refusal::Cli)?
    {
        Some(workspace) => Ok(Some(workspace)),
        None => resolve_cloud_for_site(cloud, env, site).map_err(Refusal::Cloud),
    }
}

/// The account's workspace, at its own origin; `Ok(None)` when signed out
/// or its key is not a workspace key. A node-scoped key (`sh_wk_…`) never
/// comes from the sign-in: it counts as no key here. A stored relaygate URL
/// makes it a gate-only workspace whatever the key ([`resolve_gate`]); an
/// invalid one is an `Err`.
///
/// In the default build `RELAYCAST_URL` overrides that origin when it is a
/// bare https origin, and a missing or invalid one falls back to
/// [`DEFAULT_BASE_URL`] ([`cloud_origin`]: a release build refuses a
/// loopback origin for this key, and an origin that is not Agent Relay's is
/// logged). A site build ([`links::is_site_build`]) uses only
/// what its site's workspace resolve recorded: `RELAYCAST_URL` is ignored,
/// and a missing or invalid origin is an `Err` naming the site, never the
/// public gateway.
pub fn resolve_cloud(
    cloud: Option<&CloudWorkspace>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<Workspace>, String> {
    resolve_cloud_for_site(cloud, env, links::built_in_site_url())
}

/// [`resolve_cloud`] for a build whose built-in site is `site`.
pub fn resolve_cloud_for_site(
    cloud: Option<&CloudWorkspace>,
    env: &dyn Fn(&str) -> Option<String>,
    site: &str,
) -> Result<Option<Workspace>, String> {
    if let Some(cloud) = cloud.filter(|cloud| cloud.gate_url.is_some()) {
        return resolve_gate(cloud, site).map(Some);
    }
    let Some(cloud) = cloud.filter(|cloud| is_workspace_key(cloud.key.expose())) else {
        return Ok(None);
    };
    let base_url = if links::is_site_build_for(site) {
        let origin = validated_base_url(&cloud.base_url).ok_or_else(|| {
            let what = if cloud.base_url.trim().is_empty() {
                "no relaycastUrl"
            } else {
                "no valid relaycastUrl (it must be a bare https origin)"
            };
            format!(
                "This build is for {site}, and {site}'s workspace resolve named {what}. \
                 It will not fall back to Agent Relay's public gateway, and RELAYCAST_URL \
                 is ignored in this build; sign in again once {site} answers with its own \
                 Relaycast URL."
            )
        })?;
        if !LOOPBACK_ALLOWED && is_loopback_origin(&origin) {
            return Err(loopback_refusal(&origin));
        }
        origin
    } else {
        cloud_origin(
            env("RELAYCAST_URL").as_deref(),
            &cloud.base_url,
            LOOPBACK_ALLOWED,
        )?
    };
    Ok(Some(Workspace {
        key: cloud.key.clone(),
        base_url,
        workspace_id: cloud.workspace_id.clone(),
        source: WorkspaceSource::Cloud,
        control_url: None,
        gate_url: None,
    }))
}

/// Whether a Cloud sign-in's key may go to a loopback origin: only in debug
/// and test builds. A release build's account key belongs to a hosted
/// Relaycast, and a loopback listener is any local process of this user's.
const LOOPBACK_ALLOWED: bool = cfg!(any(debug_assertions, test));

/// Why the account's key is not used at `origin`, a loopback one.
fn loopback_refusal(origin: &str) -> String {
    let message = format!(
        "The account's Relaycast URL is the loopback origin {origin}. This build sends the \
         account's workspace key only to a hosted Relaycast, and never to a different origin \
         than the one it was issued for; sign in again against a hosted Relaycast."
    );
    warn_once(&format!("relay: {message}"));
    message
}

/// The origin the account's key goes to in the default build: `RELAYCAST_URL`
/// when it is a valid origin, else the one the sign-in recorded, else
/// [`DEFAULT_BASE_URL`] when the sign-in recorded none. Unless
/// `loopback_allowed`, a loopback `RELAYCAST_URL` is ignored (and logged),
/// and a loopback recorded origin is an `Err`: the key is bound to that
/// origin, so it is never sent to another one instead. An origin other than
/// Agent Relay's own is logged once, so a key going elsewhere is never
/// silent.
fn cloud_origin(
    relaycast_url: Option<&str>,
    recorded: &str,
    loopback_allowed: bool,
) -> Result<String, String> {
    // The key is bound to its recorded origin: a loopback one is refused
    // before any override is looked at, so the key never goes elsewhere.
    if let Some(origin) = validated_base_url(recorded)
        .filter(|origin| !loopback_allowed && is_loopback_origin(origin))
    {
        return Err(loopback_refusal(&origin));
    }
    let overridden = relaycast_url.and_then(validated_base_url).filter(|origin| {
        let refused = !loopback_allowed && is_loopback_origin(origin);
        if refused {
            warn_once(&format!(
                "relay: RELAYCAST_URL names the loopback origin {origin}; this build sends \
                     the account's workspace key only to a hosted Relaycast, so it is ignored"
            ));
        }
        !refused
    });
    let origin = match overridden.clone() {
        Some(origin) => origin,
        None => match validated_base_url(recorded) {
            Some(origin) if !loopback_allowed && is_loopback_origin(&origin) => {
                return Err(loopback_refusal(&origin));
            }
            Some(origin) => origin,
            None => DEFAULT_BASE_URL.to_string(),
        },
    };
    if !is_agent_relay_origin(&origin) {
        warn_once(&format!(
            "relay: the account's workspace key goes to {origin}, which is not Agent Relay's \
             own Relaycast ({DEFAULT_BASE_URL}); set by {}",
            if overridden.as_deref() == Some(origin.as_str()) {
                "RELAYCAST_URL"
            } else {
                "the account's sign-in"
            }
        ));
    }
    Ok(origin)
}

/// Whether `origin` is one of Agent Relay's hosted Relaycast origins, or the
/// site this build is for.
fn is_agent_relay_origin(origin: &str) -> bool {
    const HOSTED: [&str; 2] = [DEFAULT_BASE_URL, "https://armadillo.agentrelay.com"];
    HOSTED.contains(&origin)
        || validated_base_url(links::built_in_site_url()).as_deref() == Some(origin)
}

/// Whether a validated origin's host reaches this computer: `localhost`
/// (with or without a trailing dot, in any case) or a name under
/// `.localhost`, any address in `127.0.0.0/8`, `::1`, an IPv4-mapped or
/// IPv4-compatible form of a loopback address, or an unspecified address
/// (`0.0.0.0`, `::`), which connects to this computer too.
fn is_loopback_origin(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    match url.host() {
        Some(url::Host::Domain(domain)) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            domain == "localhost" || domain.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(address)) => address.is_loopback() || address.is_unspecified(),
        Some(url::Host::Ipv6(address)) => {
            address.is_loopback()
                || address.is_unspecified()
                || address
                    .to_ipv4_mapped()
                    .or_else(|| address.to_ipv4())
                    .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
        None => false,
    }
}

/// `base_url` as the origin requests for a registration may go to: a valid
/// bare origin (`validated_base_url`) that is exactly what was recorded, and,
/// in a release build, not a loopback one. `None` otherwise.
pub(crate) fn pinned_origin(base_url: &str) -> Option<String> {
    let origin = validated_base_url(base_url)?;
    let recorded = base_url.trim().trim_end_matches('/');
    (origin == recorded && (LOOPBACK_ALLOWED || !is_loopback_origin(&origin))).then_some(origin)
}

/// Logs `message` once per process (resolution runs on every refresh).
fn warn_once(message: &str) {
    static SEEN: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let mut seen = SEEN
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !seen.iter().any(|line| line == message) {
        seen.push(message.to_string());
        crate::relay::diagnostics::write(format_args!("{message}"));
    }
}

/// The account's workspace in gate-only mode: agent traffic goes to the gate
/// (which serves the Relaycast paths), so the gate is the base URL too, and
/// there is no workspace key. A gate URL means gate-only, as agreed with
/// relaygate: a workspace key stored beside it is ignored and never sent
/// anywhere. `RELAYCAST_URL` does not re-origin a gate. A gate URL that is
/// not a valid origin fails closed instead of falling back to the key.
fn resolve_gate(cloud: &CloudWorkspace, site: &str) -> Result<Workspace, String> {
    let stored = cloud.gate_url.as_deref().unwrap_or_default();
    let gate = validated_base_url(stored).ok_or_else(|| {
        let whose = if links::is_site_build_for(site) {
            format!("This build is for {site}, and {site}'s workspace resolve")
        } else {
            "The account's workspace resolve".to_string()
        };
        format!(
            "{whose} named no valid relaygateUrl (it must be a bare https origin), so this \
             computer's agents cannot enrol through the gate. It will not fall back to a \
             workspace key; sign in again once it names a valid one."
        )
    })?;
    Ok(Workspace {
        key: Secret::default(),
        base_url: gate.clone(),
        workspace_id: cloud.workspace_id.clone(),
        source: WorkspaceSource::Cloud,
        control_url: None,
        gate_url: Some(gate),
    })
}

/// `$AGENT_RELAY_HOME`, else `~/.agentworkforce/relay`: the `agent-relay`
/// CLI's own state, read and never written here.
pub fn relay_home(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    match env("AGENT_RELAY_HOME").and_then(trimmed) {
        Some(value) if value == "~" => home.to_path_buf(),
        Some(value) => match value.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None => PathBuf::from(value),
        },
        None => home.join(".agentworkforce/relay"),
    }
}

/// Workspace keys are `rk_live_…` (or `rk_test_…`), or armadillo's
/// `ar_ws_…`, which a self-hosted Relaycast on durable actors issues and
/// which Cloud's workspace resolve hands every client, the Desktop core
/// included; so every build accepts both. A node-scoped `sh_wk_…` key is
/// not one ([`key_kind`]).
pub fn is_workspace_key(value: &str) -> bool {
    key_kind(value) == Some(KeyKind::Workspace)
}

/// `value` as a bare origin credentials may be sent to, or `None`: https
/// (http only for a loopback host), a host, and nothing else — no user info, path,
/// query or fragment that could redirect where requests resolve, and no port
/// except on a loopback host. An IPv6 host keeps its brackets.
pub fn validated_base_url(value: &str) -> Option<String> {
    let url = url::Url::parse(value.trim()).ok()?;
    let scheme = url.scheme().to_ascii_lowercase();
    let host = url.host_str()?.to_ascii_lowercase();
    if host.is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.path().is_empty() || url.path() == "/")
    {
        return None;
    }
    let local = match url.host()? {
        url::Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(address) => address.is_loopback(),
        url::Host::Ipv6(address) => address.is_loopback(),
    };
    if !(scheme == "https" || (scheme == "http" && local)) {
        return None;
    }
    // `Url` drops a port equal to the scheme's default, so `https://x:443`
    // is the same origin as `https://x`; any other port is local-only.
    let port = url.port();
    if port.is_some() && !local {
        return None;
    }
    let port = port.map(|port| format!(":{port}")).unwrap_or_default();
    Some(format!("{scheme}://{host}{port}"))
}

fn trimmed(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use crate::relay::links::DEFAULT_SITE_URL;

    /// A build made for its own site.
    const SITE: &str = "https://relay.corp.test";

    /// The default build's Cloud source, which never refuses.
    fn resolve_with(env: &[(&str, &str)], cloud: Option<CloudWorkspace>) -> Option<Workspace> {
        resolve_cloud_at(DEFAULT_SITE_URL, env, cloud).expect("the default build never refuses")
    }

    fn resolve_cloud_at(
        site: &str,
        env: &[(&str, &str)],
        cloud: Option<CloudWorkspace>,
    ) -> Result<Option<Workspace>, String> {
        let env: HashMap<String, String> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        resolve_cloud_for_site(
            cloud.as_ref(),
            &move |key: &str| env.get(key).cloned(),
            site,
        )
    }

    fn account(key: &str, base_url: &str) -> CloudWorkspace {
        CloudWorkspace {
            key: Secret::new(key),
            base_url: base_url.into(),
            workspace_id: Some("rw_acct".into()),
            name: Some("Acme".into()),
            gate_url: None,
        }
    }

    #[test]
    fn the_cloud_source_is_the_account_workspace() {
        assert!(resolve_with(&[], None).is_none());
        // Environment keys are the CLI source's, never the account's.
        assert!(resolve_with(&[("RELAY_WORKSPACE_KEY", "rk_live_env00000")], None).is_none());
        let found = resolve_with(
            &[],
            Some(account("rk_live_account00", "http://localhost:9999")),
        )
        .unwrap();
        assert_eq!(found.key.expose(), "rk_live_account00");
        assert_eq!(found.base_url, "http://localhost:9999");
        assert_eq!(found.workspace_id.as_deref(), Some("rw_acct"));
        // An agent token is not a workspace key.
        assert!(resolve_with(&[], Some(account("at_live_agenttoken", DEFAULT_BASE_URL))).is_none());
    }

    fn gate(key: &str, gate_url: &str) -> CloudWorkspace {
        CloudWorkspace {
            gate_url: Some(gate_url.into()),
            ..account(key, "https://cast.corp.test")
        }
    }

    #[test]
    fn a_key_only_account_is_not_gate_only() {
        let found =
            resolve_with(&[], Some(account("rk_live_account00", DEFAULT_BASE_URL))).unwrap();
        assert_eq!(found.gate_url, None);
        assert!(!found.is_gate_only());
    }

    #[test]
    fn a_gate_record_resolves_to_a_keyless_gate_workspace() {
        for site in [DEFAULT_SITE_URL, SITE] {
            for key in ["", "at_live_agenttoken"] {
                let found = resolve_cloud_at(site, &[], Some(gate(key, "https://gate.corp.test/")))
                    .unwrap()
                    .unwrap();
                assert!(found.is_gate_only());
                assert_eq!(found.gate_url.as_deref(), Some("https://gate.corp.test"));
                // The gate serves the Relaycast paths, so agent traffic goes there.
                assert_eq!(found.base_url, "https://gate.corp.test");
                assert_eq!(found.key.expose(), "");
                assert_eq!(found.workspace_id.as_deref(), Some("rw_acct"));
                assert!(found.source.is_cloud());
                assert_eq!(found.control_url, None);
            }
        }
    }

    #[test]
    fn a_release_build_never_sends_the_account_key_to_loopback() {
        let local = "http://127.0.0.1:8787";
        // Debug and test builds keep a local Relaycast for development.
        assert_eq!(
            cloud_origin(Some(local), DEFAULT_BASE_URL, true).unwrap(),
            local
        );
        assert_eq!(cloud_origin(None, local, true).unwrap(), local);
        // A release build ignores a loopback override: the key goes to the
        // origin it was issued for.
        assert_eq!(
            cloud_origin(Some(local), DEFAULT_BASE_URL, false).unwrap(),
            DEFAULT_BASE_URL
        );
        assert_eq!(
            cloud_origin(
                Some("http://localhost:9000"),
                "https://relay.corp.test",
                false
            )
            .unwrap(),
            "https://relay.corp.test"
        );
        // A key issued for a loopback origin is refused, never sent to the
        // public Relaycast instead.
        for recorded in [
            local,
            "http://[::1]:8787",
            "https://[::ffff:127.0.0.1]",
            "http://127.9.9.9:1",
            "https://localhost.",
            "https://api.localhost",
        ] {
            let refused = cloud_origin(None, recorded, false).unwrap_err();
            assert!(refused.contains("loopback"), "{recorded}: {refused}");
            assert!(
                cloud_origin(Some("https://[::ffff:7f00:1]"), recorded, false).is_err(),
                "{recorded}"
            );
            // Nor does a hosted override lend it another origin.
            assert!(
                cloud_origin(Some("https://override.corp.test"), recorded, false).is_err(),
                "{recorded}"
            );
        }
        // A hosted override is still honoured (and logged).
        assert_eq!(
            cloud_origin(Some("https://override.corp.test"), DEFAULT_BASE_URL, false).unwrap(),
            "https://override.corp.test"
        );
        for loopback in [
            local,
            "http://localhost:1",
            "https://LOCALHOST.",
            "https://a.localhost",
            "http://127.0.0.2:1",
            "http://[::1]:1",
            "https://[::ffff:127.0.0.1]",
            "https://[::ffff:7f00:2]",
            "https://0.0.0.0",
            "https://[::]",
        ] {
            assert!(is_loopback_origin(loopback), "{loopback}");
        }
        for remote in [
            "https://cast.agentrelay.com",
            "https://localhost.example.com",
            "https://128.0.0.1",
            "https://[::ffff:8.8.8.8]",
            "https://[2001:db8::1]",
        ] {
            assert!(!is_loopback_origin(remote), "{remote}");
        }
        assert!(is_agent_relay_origin(DEFAULT_BASE_URL));
        assert!(!is_agent_relay_origin("https://override.corp.test"));
    }

    #[test]
    fn a_site_build_refuses_a_loopback_account_origin_in_release() {
        // `LOOPBACK_ALLOWED` is on in tests; the release rule is the same
        // check, refused with the message below.
        let refused = loopback_refusal("http://127.0.0.1:8787");
        assert!(refused.contains("never to a different origin"), "{refused}");
    }

    #[test]
    fn a_gate_wins_over_a_workspace_key_and_relaycast_url() {
        let found = resolve_with(
            &[("RELAYCAST_URL", "https://override.corp.test")],
            Some(gate("rk_live_account00", "https://gate.corp.test")),
        )
        .unwrap();
        assert!(found.is_gate_only());
        assert_eq!(found.base_url, "https://gate.corp.test");
        assert_eq!(found.key.expose(), "", "the workspace key is never used");
    }

    #[test]
    fn an_invalid_gate_url_is_an_error_not_a_fallback_to_the_key() {
        for bad in [
            "",
            "  ",
            "ftp://gate.corp.test",
            "http://gate.corp.test",
            "https://gate.corp.test/v1",
            "https://user@gate.corp.test",
            "not a url",
        ] {
            for site in [DEFAULT_SITE_URL, SITE] {
                let error = resolve_cloud_at(site, &[], Some(gate("rk_live_account00", bad)))
                    .expect_err(bad);
                assert!(error.contains("relaygateUrl"), "{error}");
                if site == SITE {
                    assert!(error.contains(SITE), "{error}");
                }
            }
        }
        // http stays allowed for a loopback gate, as for any base URL.
        let local = resolve_with(&[], Some(gate("", "http://127.0.0.1:8790"))).unwrap();
        assert_eq!(local.gate_url.as_deref(), Some("http://127.0.0.1:8790"));
    }

    /// `resolve` in the default build over a fresh home whose CLI state
    /// `setup` writes.
    fn combined(
        env: &[(&str, &str)],
        cloud: Option<CloudWorkspace>,
        setup: impl FnOnce(&Path),
    ) -> Result<Option<Workspace>, String> {
        combined_at(DEFAULT_SITE_URL, env, cloud, setup).map_err(Refusal::into_reason)
    }

    /// `resolve_for_site` for a build whose site is `site`.
    fn combined_at(
        site: &str,
        env: &[(&str, &str)],
        cloud: Option<CloudWorkspace>,
        setup: impl FnOnce(&Path),
    ) -> Result<Option<Workspace>, Refusal> {
        let home = tempfile::tempdir().unwrap();
        let relay = home.path().join(".agentworkforce/relay");
        std::fs::create_dir_all(&relay).unwrap();
        setup(&relay);
        let env: HashMap<String, String> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        resolve_for_site(
            cloud.as_ref(),
            &move |key: &str| env.get(key).cloned(),
            home.path(),
            site,
        )
    }

    fn store(relay: &Path, key: &str) {
        std::fs::write(
            relay.join("workspaces.json"),
            format!(r#"{{"active":"local","workspaces":{{"local":{{"key":"{key}"}}}}}}"#),
        )
        .unwrap();
    }

    #[cfg(feature = "relay-cli")]
    fn bind(relay: &Path, key: &str, base_url: &str) {
        std::fs::write(
            relay.join("relaycast-origins.json"),
            format!(
                r#"{{"version":1,"origins":{{"{}":"{base_url}"}}}}"#,
                origin_binding::credential_fingerprint(key)
            ),
        )
        .unwrap();
    }

    #[cfg(feature = "relay-cli")]
    #[test]
    fn the_cli_workspace_wins_over_the_cloud_sign_in() {
        let found = combined(
            &[],
            Some(account("rk_live_account00", DEFAULT_BASE_URL)),
            |relay| {
                store(relay, "rk_live_cli_local0");
                bind(relay, "rk_live_cli_local0", "http://127.0.0.1:8787");
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.key.expose(), "rk_live_cli_local0");
        assert_eq!(found.base_url, "http://127.0.0.1:8787");
        assert!(!found.source.is_cloud());
        // The account's recorded id is the account's; the CLI's is verified.
        assert_eq!(found.workspace_id, None);
    }

    #[cfg(feature = "relay-cli")]
    #[test]
    fn the_cloud_sign_in_is_used_only_when_the_cli_selects_nothing() {
        let found = combined(
            &[],
            Some(account("rk_live_account00", "http://localhost:9999")),
            |_| {},
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.key.expose(), "rk_live_account00");
        assert_eq!(found.base_url, "http://localhost:9999");
        assert_eq!(found.source, WorkspaceSource::Cloud);
        // An active name with no saved entry selects nothing either.
        let found = combined(
            &[],
            Some(account("rk_live_account00", DEFAULT_BASE_URL)),
            |relay| {
                std::fs::write(
                    relay.join("workspaces.json"),
                    r#"{"active":"gone","workspaces":{}}"#,
                )
                .unwrap()
            },
        )
        .unwrap()
        .unwrap();
        assert!(found.source.is_cloud());
        assert!(combined(&[], None, |_| {}).unwrap().is_none());
    }

    #[cfg(feature = "relay-cli")]
    #[test]
    fn neither_source_lends_its_origin_to_the_other() {
        // RELAYCAST_URL re-origins only the account's key.
        let found = combined(
            &[("RELAYCAST_URL", "https://relay.example.com")],
            Some(account("rk_live_account00", DEFAULT_BASE_URL)),
            |relay| store(relay, "rk_live_cli_hosted"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.key.expose(), "rk_live_cli_hosted");
        assert_eq!(found.base_url, DEFAULT_BASE_URL);
        // A binding of the account's key never re-origins it either: the
        // account's key keeps the account's origin.
        let found = combined(
            &[],
            Some(account("rk_live_account00", DEFAULT_BASE_URL)),
            |relay| bind(relay, "rk_live_account00", "https://relay.corp.test"),
        )
        .unwrap()
        .unwrap();
        assert!(found.source.is_cloud());
        assert_eq!(found.base_url, DEFAULT_BASE_URL);
    }

    #[cfg(feature = "relay-cli")]
    #[test]
    fn a_broken_cli_selection_fails_closed_instead_of_falling_back_to_the_account() {
        let error = combined(
            &[],
            Some(account("rk_live_account00", DEFAULT_BASE_URL)),
            |relay| {
                store(relay, "rk_live_cli_local0");
                std::fs::write(relay.join("relaycast-origins.json"), "{").unwrap();
            },
        )
        .unwrap_err();
        assert!(error.contains("relaycast-origins.json"), "{error}");
        assert!(!error.contains("rk_live"), "{error}");
        let error = combined(
            &[],
            Some(account("rk_live_account00", DEFAULT_BASE_URL)),
            |relay| std::fs::write(relay.join("workspaces.json"), "not json").unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("workspaces.json"), "{error}");
        // A store the CLI throws on is not "nothing selected" either.
        let error = combined(
            &[],
            Some(account("rk_live_account00", DEFAULT_BASE_URL)),
            |relay| std::fs::write(relay.join("workspaces.json"), "null").unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("workspaces.json"), "{error}");
    }

    #[cfg(feature = "relay-cli")]
    #[test]
    fn agent_relay_home_locates_the_cli_state() {
        let elsewhere = tempfile::tempdir().unwrap();
        store(elsewhere.path(), "rk_live_isolated0");
        let relay_home = elsewhere.path().to_string_lossy().into_owned();
        let found = combined(&[("AGENT_RELAY_HOME", &relay_home)], None, |relay| {
            store(relay, "rk_live_default00")
        })
        .unwrap()
        .unwrap();
        assert_eq!(found.key.expose(), "rk_live_isolated0");
    }

    #[test]
    fn relaycast_url_overrides_the_origin_only_when_valid() {
        let cloud = || Some(account("rk_live_account00", "https://cast.agentrelay.com"));
        assert_eq!(
            resolve_with(&[("RELAYCAST_URL", "https://relay.example.com")], cloud())
                .unwrap()
                .base_url,
            "https://relay.example.com"
        );
        assert_eq!(
            resolve_with(&[("RELAYCAST_URL", "http://cast.agentrelay.com")], cloud())
                .unwrap()
                .base_url,
            DEFAULT_BASE_URL
        );
        assert_eq!(
            resolve_with(&[], Some(account("rk_live_account00", "ftp://x.com")))
                .unwrap()
                .base_url,
            DEFAULT_BASE_URL
        );
    }

    #[test]
    fn a_site_build_uses_only_the_origin_its_site_resolved() {
        // The site's own origin is used as is.
        let found = resolve_cloud_at(
            SITE,
            &[],
            Some(account("rk_live_account00", "https://cast.relay.corp.test")),
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.base_url, "https://cast.relay.corp.test");
        assert!(found.source.is_cloud());
        // Signed out, or holding no workspace key, is still no workspace.
        assert_eq!(resolve_cloud_at(SITE, &[], None), Ok(None));
        assert_eq!(
            resolve_cloud_at(SITE, &[], Some(account("at_live_agenttoken", ""))),
            Ok(None)
        );
    }

    #[test]
    fn a_site_build_refuses_a_missing_or_invalid_origin_instead_of_the_public_gateway() {
        for (base_url, what) in [
            ("", "named no relaycastUrl"),
            ("   ", "named no relaycastUrl"),
            ("ftp://x.com", "no valid relaycastUrl"),
            ("http://cast.relay.corp.test", "no valid relaycastUrl"),
            (
                "https://u:secret@cast.relay.corp.test",
                "no valid relaycastUrl",
            ),
        ] {
            // The default build falls back exactly as before.
            assert_eq!(
                resolve_with(&[], Some(account("rk_live_account00", base_url)))
                    .unwrap()
                    .base_url,
                DEFAULT_BASE_URL,
                "{base_url:?}"
            );
            let error = resolve_cloud_at(SITE, &[], Some(account("rk_live_account00", base_url)))
                .unwrap_err();
            assert!(error.contains(SITE), "{error}");
            assert!(error.contains(what), "{base_url:?}: {error}");
            assert!(error.contains("RELAYCAST_URL is ignored"), "{error}");
            assert!(!error.contains(DEFAULT_BASE_URL), "{error}");
            assert!(!error.contains("secret"), "{error}");
            assert!(!error.contains("rk_live"), "{error}");
        }
    }

    #[test]
    fn a_site_build_ignores_relaycast_url() {
        let env = [("RELAYCAST_URL", "https://relay.example.com")];
        let cloud = || Some(account("rk_live_account00", "https://cast.relay.corp.test"));
        // The default build honours it.
        assert_eq!(
            resolve_with(&env, cloud()).unwrap().base_url,
            "https://relay.example.com"
        );
        // A site build keeps its site's origin, and RELAYCAST_URL cannot
        // stand in for a missing one either.
        assert_eq!(
            resolve_cloud_at(SITE, &env, cloud())
                .unwrap()
                .unwrap()
                .base_url,
            "https://cast.relay.corp.test"
        );
        let error =
            resolve_cloud_at(SITE, &env, Some(account("rk_live_account00", ""))).unwrap_err();
        assert!(error.contains("RELAYCAST_URL is ignored"), "{error}");
    }

    #[test]
    fn a_refused_account_workspace_is_reported_as_the_account_s() {
        let refusal =
            combined_at(SITE, &[], Some(account("rk_live_account00", "")), |_| {}).unwrap_err();
        assert!(matches!(refusal, Refusal::Cloud(_)), "{refusal:?}");
        assert!(refusal.reason().contains(SITE), "{refusal:?}");
        assert!(
            refusal
                .activity()
                .starts_with("Not using your Agent Relay account's workspace: "),
            "{refusal:?}"
        );
        // The default build's resolve keeps its old shape.
        assert_eq!(
            combined(&[], Some(account("rk_live_account00", "")), |_| {})
                .unwrap()
                .unwrap()
                .base_url,
            DEFAULT_BASE_URL
        );
    }

    #[cfg(feature = "relay-cli")]
    #[test]
    fn a_site_build_refuses_an_unbound_cli_key_before_the_account() {
        let refusal = combined_at(
            SITE,
            &[],
            Some(account("rk_live_account00", "https://cast.relay.corp.test")),
            |relay| store(relay, "rk_live_cli_hosted"),
        )
        .unwrap_err();
        assert!(matches!(refusal, Refusal::Cli(_)), "{refusal:?}");
        assert!(
            refusal.reason().contains("relaycast-origins.json"),
            "{refusal:?}"
        );
        assert!(refusal.reason().contains(SITE), "{refusal:?}");
        assert!(
            refusal
                .activity()
                .starts_with("Not using the agent-relay CLI's workspace: "),
            "{refusal:?}"
        );
        // A bound CLI key is used as before.
        let found = combined_at(SITE, &[], None, |relay| {
            store(relay, "rk_live_cli_local0");
            bind(relay, "rk_live_cli_local0", "http://127.0.0.1:8787");
        })
        .unwrap()
        .unwrap();
        assert_eq!(found.base_url, "http://127.0.0.1:8787");
    }

    // Ported from test_only_bare_https_origins_carry_credentials (Linux) and
    // InjectableAgentsTests.validatedBaseURL (macOS).
    #[test]
    fn only_bare_https_origins_carry_credentials() {
        assert_eq!(
            validated_base_url("https://cast.agentrelay.com/").as_deref(),
            Some("https://cast.agentrelay.com")
        );
        assert_eq!(
            validated_base_url("HTTPS://Cast.AgentRelay.com").as_deref(),
            Some("https://cast.agentrelay.com")
        );
        assert_eq!(
            validated_base_url("http://localhost:8787").as_deref(),
            Some("http://localhost:8787")
        );
        assert_eq!(
            validated_base_url("https://cast.agentrelay.com:443").as_deref(),
            Some("https://cast.agentrelay.com")
        );
        assert_eq!(
            validated_base_url("https://[2001:DB8::1]").as_deref(),
            Some("https://[2001:db8::1]")
        );
        assert_eq!(
            validated_base_url("http://[::1]:8787").as_deref(),
            Some("http://[::1]:8787")
        );
        assert_eq!(
            validated_base_url("http://127.0.0.1:8787").as_deref(),
            Some("http://127.0.0.1:8787")
        );
        for bad in [
            "http://[2001:db8::1]",
            "https://[2001:db8::1]:8443",
            "http://cast.agentrelay.com",
            "https://u@x.com",
            "https://x.com/path",
            "https://x.com?q=1",
            "https://x.com#f",
            "https://x.com:8443",
            "ftp://x.com",
            "",
        ] {
            assert_eq!(validated_base_url(bad), None, "{bad}");
        }
    }

    #[cfg(not(feature = "relay-cli"))]
    #[test]
    fn without_relay_cli_only_the_cloud_sign_in_counts() {
        let cli_key = "rk_live_cli0000000";
        let store_only = |relay: &Path| store(relay, cli_key);
        // Nothing selected but the CLI's environment key and store: no workspace.
        assert_eq!(
            combined(&[("RELAY_WORKSPACE_KEY", cli_key)], None, store_only),
            Ok(None)
        );
        // The account keeps its own key and origin beside them.
        let found = combined(
            &[("RELAY_WORKSPACE_KEY", cli_key)],
            Some(account("rk_live_account00", "https://origin.example")),
            store_only,
        )
        .unwrap()
        .unwrap();
        assert_eq!(found.key.expose(), "rk_live_account00");
        assert_eq!(found.base_url, "https://origin.example");
        assert!(found.source.is_cloud());
        // A broken CLI file is not read, so it cannot fail anything.
        assert_eq!(
            combined(&[], None, |relay| {
                std::fs::write(relay.join("workspaces.json"), "not json").unwrap()
            }),
            Ok(None)
        );
    }

    #[test]
    fn an_armadillo_key_is_a_workspace_key_in_every_build() {
        let key = "ar_ws_0123456789abcdef";
        assert!(is_workspace_key(key));
        assert!(resolve_with(&[], Some(account(key, "https://origin.example"))).is_some());
        assert!(!is_workspace_key("ar_ws_short"));
    }

    #[test]
    fn workspace_keys_are_rk_prefixed_and_unspaced() {
        assert!(is_workspace_key("rk_live_abcdef"));
        assert!(!is_workspace_key("rk_live"));
        assert!(!is_workspace_key("at_live_abcdefgh"));
        assert!(!is_workspace_key("rk_live_abc def"));
    }

    #[test]
    fn keys_are_classified_by_kind() {
        assert_eq!(key_kind("rk_live_abcdef"), Some(KeyKind::Workspace));
        assert_eq!(key_kind("ar_ws_0123456789abcdef"), Some(KeyKind::Workspace));
        assert_eq!(key_kind("sh_wk_abcdef"), Some(KeyKind::NodeScoped));
        // Surrounding whitespace is trimmed by every source before this.
        assert_eq!(key_kind(" sh_wk_abcdef "), None);
        // Twelve characters at least, and no whitespace.
        assert_eq!(key_kind("sh_wk_abcde"), None);
        assert_eq!(key_kind("sh_wk_abc def"), None);
        assert_eq!(key_kind("at_live_abcdefgh"), None);
        assert!(is_node_key("sh_wk_abcdef"));
        // A node credential is neither a workspace key nor armadillo's.
        assert!(!is_workspace_key("sh_wk_abcdef"));
    }

    #[test]
    fn a_node_credential_is_refused_from_the_cloud_sign_in() {
        assert!(resolve_with(&[], Some(account("sh_wk_fixture0123", DEFAULT_BASE_URL))).is_none());
    }

    #[test]
    fn a_route_goes_to_the_broker_only_for_a_node_credential() {
        let workspace_key = Secret::new("rk_live_abcdef");
        let node_key = Secret::new("sh_wk_abcdef");
        let route = workspace_route(
            "https://cast.example",
            &workspace_key,
            Some("https://control.example"),
        );
        assert_eq!(route.base(), "https://cast.example");
        let route = workspace_route(
            "https://cast.example",
            &node_key,
            Some("https://control.example/"),
        );
        assert_eq!(route.base(), "https://control.example/relay-node");
        assert_eq!(route.credential, node_key);
        // Without a Control origin a node credential has no broker: its
        // route is Relaycast's, which the transport refuses for it.
        let route = workspace_route("https://cast.example", &node_key, None);
        assert_eq!(route.base(), "https://cast.example");
        let options = relaycast::ClientOptions::new(node_key.expose()).with_base_url(route.base());
        assert!(crate::relay::node_credential::check_destination(&options).is_err());
    }

    #[test]
    fn a_child_environment_loses_every_workspace_credential_variable() {
        let environment: std::collections::BTreeMap<String, String> = [
            ("RELAY_WORKSPACE_KEY", "sh_wk_fixture0123"),
            ("AGENT_RELAY_WORKSPACE_KEY", "rk_live_fixture"),
            ("RELAY_API_KEY", "ar_ws_fixture"),
            ("RELAY_BASE_URL", "https://cast.example"),
            ("CLOUD_API_ACCESS_TOKEN", "fixture-cloud-access"),
            ("Cloud_Api_Access_Token", "fixture-cloud-access"),
            ("CLOUD_API_REFRESH_TOKEN", "fixture-cloud-refresh"),
            (
                "RELAY_LAUNCH_CREDENTIAL",
                "sh_lt_fixture_from_an_earlier_spawn",
            ),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
        let stripped = without_workspace_key_env(environment);
        assert_eq!(
            stripped.keys().map(String::as_str).collect::<Vec<_>>(),
            ["RELAY_BASE_URL"]
        );
    }

    /// A command that inherits the core's environment loses every spelling
    /// of the Cloud tokens and a launch credential, and keeps the rest.
    #[test]
    fn an_inheriting_command_loses_the_agent_secrets_in_any_case() {
        let mut command = std::process::Command::new("true");
        let inherited = [
            "Cloud_Api_Access_Token",
            "cloud_api_refresh_token",
            "Relay_Launch_Credential",
            "KEPT",
        ]
        .map(std::ffi::OsString::from);
        remove_agent_secret_env(&mut command, inherited.into_iter());
        let removed: Vec<String> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        // Windows keeps one entry per name whatever its case.
        let same = |a: &str, b: &str| {
            if cfg!(windows) {
                a.eq_ignore_ascii_case(b)
            } else {
                a == b
            }
        };
        for name in [
            "CLOUD_API_ACCESS_TOKEN",
            "CLOUD_API_REFRESH_TOKEN",
            "RELAY_LAUNCH_CREDENTIAL",
            "Cloud_Api_Access_Token",
            "cloud_api_refresh_token",
            "Relay_Launch_Credential",
        ] {
            assert!(removed.iter().any(|r| same(r, name)), "{name}: {removed:?}");
        }
        assert!(!removed.iter().any(|r| same(r, "KEPT")));
    }

    /// Windows reads environment names in any case, so every spelling of a
    /// credential variable is one, and none reaches a child.
    #[test]
    fn a_credential_variable_in_any_case_is_one() {
        for name in [
            "Relay_Api_Key",
            "relay_workspace_key",
            "Agent_Relay_Workspace_Key",
        ] {
            assert!(is_workspace_key_env(name), "{name}");
        }
        assert!(!is_workspace_key_env("RELAY_API_KEYS"));
        assert!(!is_workspace_key_env("RELAY_BASE_URL"));
        let environment: std::collections::BTreeMap<String, String> = [
            ("Relay_Api_Key", "fixture"),
            ("relay_workspace_key", "fixture"),
            ("KEPT", "kept"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect();
        assert_eq!(
            without_workspace_key_env(environment)
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["KEPT"]
        );
    }

    #[test]
    fn secrets_never_print() {
        let secret = Secret::new("rk_live_supersecret");
        assert_eq!(format!("{secret:?}"), "Secret(rk_…)");
    }
}
