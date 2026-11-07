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
/// or its key is not a workspace key.
///
/// In the default build `RELAYCAST_URL` overrides that origin when it is a
/// bare https origin, and a missing or invalid one falls back to
/// [`DEFAULT_BASE_URL`]. A site build ([`links::is_site_build`]) uses only
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
    let Some(cloud) = cloud.filter(|cloud| is_workspace_key(cloud.key.expose())) else {
        return Ok(None);
    };
    let base_url = if links::is_site_build_for(site) {
        validated_base_url(&cloud.base_url).ok_or_else(|| {
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
        })?
    } else {
        env("RELAYCAST_URL")
            .and_then(|value| validated_base_url(&value))
            .or_else(|| validated_base_url(&cloud.base_url))
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
    };
    Ok(Some(Workspace {
        key: cloud.key.clone(),
        base_url,
        workspace_id: cloud.workspace_id.clone(),
        source: WorkspaceSource::Cloud,
    }))
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
/// included; so every build accepts both.
pub fn is_workspace_key(value: &str) -> bool {
    (value.starts_with("rk_") || value.starts_with("ar_ws_"))
        && value.len() >= 12
        && !value.chars().any(char::is_whitespace)
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
    fn secrets_never_print() {
        let secret = Secret::new("rk_live_supersecret");
        assert_eq!(format!("{secret:?}"), "Secret(rk_…)");
    }
}
