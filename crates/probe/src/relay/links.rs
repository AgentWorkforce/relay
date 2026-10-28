//! Message endpoints and the app's deep links.
//!
//! An endpoint is a legacy agent name (`alice`, `@alice`) or an exact
//! `agent@machine` address. Relaycast owns resolution, because agent and
//! machine identifiers may both contain `@`; the desktop only tells the two
//! forms apart, keeps an address byte for byte, and refuses strings no
//! reading can make an address of before anything is sent.
//!
//! Deep links carry destinations, never credentials or message bodies:
//!
//! ```text
//! agentrelay://connect?site=https%3A%2F%2Fagentrelay.com&account=<id>&workspace=<id>
//! agentrelay://message?to=reviewer%40sf-frame
//! ```
//!
//! A development build (`agentrelay-dev://`) accepts only its own local site.

use serde::{Deserialize, Serialize};
use url::Url;

/// The production Agent Relay site.
pub const DEFAULT_SITE_URL: &str = "https://agentrelay.com";

/// A direct-message target.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Endpoint {
    Name(String),
    Address(String),
}

impl Endpoint {
    /// Parses UI or caller input. Plain `alice` and the display form
    /// `@alice` are names; anything else holding an `@` with something on
    /// both sides of one is an exact address.
    pub fn parse(raw: &str) -> Result<Endpoint, EndpointError> {
        let value = raw.trim();
        if value.is_empty() {
            return Err(EndpointError::Empty);
        }
        if value.chars().any(char::is_whitespace) {
            return Err(EndpointError::Whitespace);
        }
        if let Some(name) = value.strip_prefix('@') {
            if name.is_empty() || name.contains('@') {
                return Err(EndpointError::MalformedAddress);
            }
            return Ok(Endpoint::Name(name.into()));
        }
        if !value.contains('@') {
            return Ok(Endpoint::Name(value.into()));
        }
        let last = value.len() - 1;
        if !value
            .char_indices()
            .any(|(index, c)| c == '@' && index > 0 && index < last)
        {
            return Err(EndpointError::MalformedAddress);
        }
        Ok(Endpoint::Address(value.into()))
    }

    pub fn value(&self) -> &str {
        match self {
            Endpoint::Name(value) | Endpoint::Address(value) => value,
        }
    }

    pub fn is_address(&self) -> bool {
        matches!(self, Endpoint::Address(_))
    }

    /// `name:<value>` or `address:<value>`, for caches.
    pub fn key(&self) -> String {
        match self {
            Endpoint::Name(value) => format!("name:{value}"),
            Endpoint::Address(value) => format!("address:{value}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndpointError {
    Empty,
    Whitespace,
    MalformedAddress,
}

impl std::fmt::Display for EndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            EndpointError::Empty => "Enter an agent name or an agent@machine address.",
            EndpointError::Whitespace => "Names and addresses cannot contain whitespace.",
            EndpointError::MalformedAddress => "An address must be of the form \"agent@machine\".",
        })
    }
}

impl std::error::Error for EndpointError {}

/// `value` as an Agent Relay site this app may hand a sign-in to: exactly
/// `https://agentrelay.com`, or a local development site on an unprivileged
/// port. Nothing else, and no user info, path, query or fragment.
pub fn site_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.path().is_empty() || url.path() == "/")
    {
        return None;
    }
    let host = url.host_str()?;
    if url.scheme() == "https" && host == "agentrelay.com" && url.port().is_none() {
        return Some(DEFAULT_SITE_URL.into());
    }
    let port = url.port()?;
    if url.scheme() == "http" && (host == "localhost" || host == "127.0.0.1") && port >= 1024 {
        return Some(format!("http://{host}:{port}"));
    }
    None
}

/// What a deep link asks for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, schemars::JsonSchema, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeepLink {
    /// Connect this computer to an Agent Relay account and workspace.
    Connect {
        site_url: String,
        account_id: String,
        workspace_id: String,
    },
    /// Open the composer to this endpoint.
    Message { endpoint: String, address: bool },
}

/// Parses a deep link for a build configured with `configured_site`: the
/// production site takes `agentrelay://`, any other `agentrelay-dev://`.
pub fn parse_link(raw: &str, configured_site: &str) -> Option<DeepLink> {
    let url = Url::parse(raw).ok()?;
    let expected = if configured_site == DEFAULT_SITE_URL {
        "agentrelay"
    } else {
        "agentrelay-dev"
    };
    if url.scheme() != expected
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || !url.path().is_empty()
    {
        return None;
    }
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    match url.host_str()? {
        "connect" => {
            let mut values: std::collections::HashMap<&str, &str> = Default::default();
            for (key, value) in &pairs {
                let key = key.as_str();
                if !["site", "account", "workspace"].contains(&key)
                    || values.insert(key, value.as_str()).is_some()
                {
                    return None;
                }
            }
            if site_url(values.get("site")?).as_deref() != Some(configured_site) {
                return None;
            }
            let account = values.get("account").filter(|v| valid_id(v))?;
            let workspace = values.get("workspace").filter(|v| valid_id(v))?;
            Some(DeepLink::Connect {
                site_url: configured_site.into(),
                account_id: account.to_string(),
                workspace_id: workspace.to_string(),
            })
        }
        "message" => {
            let [(key, value)] = pairs.as_slice() else {
                return None;
            };
            if key != "to" {
                return None;
            }
            let endpoint = Endpoint::parse(value).ok()?;
            Some(DeepLink::Message {
                address: endpoint.is_address(),
                endpoint: endpoint.value().into(),
            })
        }
        _ => None,
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Ported from AgentEndpointTests (macOS).
    #[test]
    fn legacy_names_and_canonical_addresses() {
        assert_eq!(Endpoint::parse("alice"), Ok(Endpoint::Name("alice".into())));
        assert_eq!(
            Endpoint::parse(" @alice "),
            Ok(Endpoint::Name("alice".into()))
        );
        assert_eq!(
            Endpoint::parse("alice@sf-frame"),
            Ok(Endpoint::Address("alice@sf-frame".into()))
        );
        assert_eq!(
            Endpoint::parse("x@ops@example.com"),
            Ok(Endpoint::Address("x@ops@example.com".into()))
        );
    }

    #[test]
    fn malformed_inputs_have_clear_errors() {
        for input in ["", " ", "alice@", "a b@machine", "@a@machine", "@"] {
            assert!(Endpoint::parse(input).is_err(), "{input}");
        }
        assert_eq!(Endpoint::parse(""), Err(EndpointError::Empty));
        assert_eq!(Endpoint::parse("a b"), Err(EndpointError::Whitespace));
    }

    // Ported from DesktopConnectionTests.
    #[test]
    fn pinned_browser_handoff() {
        let local = "http://localhost:3100";
        let link = "agentrelay-dev://connect?site=http%3A%2F%2Flocalhost%3A3100&account=user-1&workspace=ws_1";
        assert_eq!(
            parse_link(link, local),
            Some(DeepLink::Connect {
                site_url: local.into(),
                account_id: "user-1".into(),
                workspace_id: "ws_1".into()
            })
        );
        assert_eq!(parse_link(link, "http://localhost:3300"), None);
        assert_eq!(parse_link(link, DEFAULT_SITE_URL), None);
    }

    #[test]
    fn rejects_ambiguous_links_and_untrusted_origins() {
        let base =
            "agentrelay://connect?site=https%3A%2F%2Fagentrelay.com&account=user&workspace=ws";
        assert!(parse_link(base, DEFAULT_SITE_URL).is_some());
        for suffix in ["&account=other", "&secret=value", "#fragment"] {
            assert_eq!(
                parse_link(&format!("{base}{suffix}"), DEFAULT_SITE_URL),
                None
            );
        }
        for site in [
            "https://evil.example",
            "http://agentrelay.com",
            "http://localhost",
            "http://localhost:80",
            "http://user:pass@localhost:3100",
            "http://localhost:3100/path",
        ] {
            assert_eq!(site_url(site), None, "{site}");
        }
        assert_eq!(
            site_url("https://agentrelay.com/").as_deref(),
            Some(DEFAULT_SITE_URL)
        );
    }

    // DesktopConnectionTests.testEndpointDeepLinkCarriesOnlyOneValidatedTarget
    // and test_deep_link_carries_only_one_valid_target.
    #[test]
    fn endpoint_deep_link_carries_only_one_validated_target() {
        assert_eq!(
            parse_link(
                "agentrelay://message?to=reviewer%40sf-frame",
                DEFAULT_SITE_URL
            ),
            Some(DeepLink::Message {
                endpoint: "reviewer@sf-frame".into(),
                address: true
            })
        );
        assert_eq!(
            parse_link("agentrelay://message?to=%40reviewer", DEFAULT_SITE_URL),
            Some(DeepLink::Message {
                endpoint: "reviewer".into(),
                address: false
            })
        );
        for invalid in [
            "agentrelay://message?to=reviewer%40",
            "agentrelay://message?to=reviewer%40sf-frame&text=secret",
            "agentrelay://message?to=reviewer%40sf-frame#fragment",
            "agentrelay-dev://message?to=reviewer%40sf-frame",
            "agentrelay://message:bad?to=alice",
            "agentrelay://[message?to=alice",
            "agentrelay://message/path?to=alice",
        ] {
            assert_eq!(parse_link(invalid, DEFAULT_SITE_URL), None, "{invalid}");
        }
    }

    #[test]
    fn links_serialize_with_their_kind() {
        let link = parse_link("agentrelay://message?to=alice", DEFAULT_SITE_URL).unwrap();
        assert_eq!(
            serde_json::to_value(link).unwrap(),
            json!({"kind": "message", "endpoint": "alice", "address": false})
        );
    }
}
