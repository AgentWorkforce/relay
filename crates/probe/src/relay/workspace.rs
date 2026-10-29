//! The Relaycast workspace this computer's agents live in: the signed-in
//! account's workspace (`cloud` in the agent store), the same one uploads go
//! to. Sign-in writes it; nothing else names a workspace key.
//!
//! `RELAYCAST_URL` overrides the origin, but only a bare https origin (http
//! only for localhost) is accepted; anything else leaves the account's.

use crate::relay::app_store::CloudWorkspace;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Path, PathBuf};

/// Relaycast's canonical origin.
pub const DEFAULT_BASE_URL: &str = "https://cast.agentrelay.com";

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
}

/// The account's workspace, at its own origin unless `RELAYCAST_URL`
/// overrides it; `None` when signed out or its key is not a workspace key.
pub fn resolve(
    cloud: Option<&CloudWorkspace>,
    env: &dyn Fn(&str) -> Option<String>,
) -> Option<Workspace> {
    let cloud = cloud.filter(|cloud| is_workspace_key(cloud.key.expose()))?;
    let base_url = env("RELAYCAST_URL")
        .and_then(|value| validated_base_url(&value))
        .or_else(|| validated_base_url(&cloud.base_url))
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    Some(Workspace {
        key: cloud.key.clone(),
        base_url,
        workspace_id: cloud.workspace_id.clone(),
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

/// Workspace keys are `rk_live_…` (or `rk_test_…`).
pub fn is_workspace_key(value: &str) -> bool {
    value.starts_with("rk_") && value.len() >= 12 && !value.chars().any(char::is_whitespace)
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

    fn resolve_with(env: &[(&str, &str)], cloud: Option<CloudWorkspace>) -> Option<Workspace> {
        let env: HashMap<String, String> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        resolve(cloud.as_ref(), &move |key: &str| env.get(key).cloned())
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
    fn the_account_workspace_is_the_only_workspace() {
        assert!(resolve_with(&[], None).is_none());
        // Environment keys name no workspace.
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
