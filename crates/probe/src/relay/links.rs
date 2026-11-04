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
//! agentrelay://message?to=reviewer%40sf-frame&site=https%3A%2F%2Fagentrelay.com
//! ```
//!
//! A build opens links of its own scheme only ([`built_in_url_scheme`]), and
//! a link that names a site only for the site it was built for
//! ([`built_in_site_url`]): a connect link always names one, a message link
//! may.

use serde::{Deserialize, Serialize};
use url::Url;

/// The production Agent Relay site: what a build talks to unless
/// `AGENT_RELAY_SITE_URL` named another when it was made.
pub const DEFAULT_SITE_URL: &str = "https://agentrelay.com";

/// The scheme of the app's links unless `AGENT_RELAY_URL_SCHEME` named
/// another when the build was made.
pub const DEFAULT_URL_SCHEME: &str = "agentrelay";

/// The Agent Relay site this build talks to: `AGENT_RELAY_SITE_URL` when it
/// was built, checked and normalized by `build.rs` (an https origin, or http
/// on localhost or 127.0.0.1), else [`DEFAULT_SITE_URL`]. Fixed when the
/// build is made; nothing at run time changes it, in any build.
pub fn built_in_site_url() -> &'static str {
    match option_env!("AGENT_RELAY_SITE_URL") {
        Some(site) if !site.trim().is_empty() => site,
        _ => DEFAULT_SITE_URL,
    }
}

/// The scheme of the links this build opens (`agentrelay://…`):
/// `AGENT_RELAY_URL_SCHEME` when it was built (checked by `build.rs`: never
/// one of the web's), else [`DEFAULT_URL_SCHEME`]. One scheme per build, so
/// a build for another site can register its own.
pub fn built_in_url_scheme() -> &'static str {
    match option_env!("AGENT_RELAY_URL_SCHEME") {
        Some(scheme) if !scheme.trim().is_empty() => scheme,
        _ => DEFAULT_URL_SCHEME,
    }
}

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
/// the site this build is made for ([`built_in_site_url`]), written as an
/// origin, and no user info, path, query or fragment. Nothing else.
pub fn site_url(value: &str) -> Option<String> {
    site_url_for(built_in_site_url(), value)
}

/// [`site_url`] for a build made for `built_in`.
pub fn site_url_for(built_in: &str, value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.path().is_empty() || url.path() == "/")
    {
        return None;
    }
    // Origins compare host and scheme case-insensitively and fill in a
    // default port, so `https://AgentRelay.com:443/` is the production site.
    let origin = url.origin();
    (origin.is_tuple() && origin == Url::parse(built_in).ok()?.origin())
        .then(|| built_in.to_string())
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

/// Why a link is not opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkError {
    /// Not a link this app opens: another scheme, an action it does not
    /// know, or a malformed or ambiguous link.
    NotALink,
    /// A connect link for another Agent Relay site than this build's.
    OtherSite { site: String, built_in: String },
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkError::NotALink => f.write_str("That is not an Agent Relay link this app opens."),
            LinkError::OtherSite { site, built_in } => write!(
                f,
                "That link connects to {site}, but this app is built for {built_in}."
            ),
        }
    }
}

impl std::error::Error for LinkError {}

/// Parses a deep link of this build: its scheme is [`built_in_url_scheme`],
/// and a connect link names [`built_in_site_url`]; a connect link for
/// another site is refused with the reason.
pub fn parse_link(raw: &str) -> Result<DeepLink, LinkError> {
    parse_link_for(raw, built_in_url_scheme(), built_in_site_url())
}

/// [`parse_link`] for a build made with `scheme` for `site`.
pub fn parse_link_for(raw: &str, scheme: &str, site: &str) -> Result<DeepLink, LinkError> {
    let url = Url::parse(raw).map_err(|_| LinkError::NotALink)?;
    if url.scheme() != scheme
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || !url.path().is_empty()
    {
        return Err(LinkError::NotALink);
    }
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    match url.host_str().ok_or(LinkError::NotALink)? {
        "connect" => {
            let mut values: std::collections::HashMap<&str, &str> = Default::default();
            for (key, value) in &pairs {
                let key = key.as_str();
                if !["site", "account", "workspace"].contains(&key)
                    || values.insert(key, value.as_str()).is_some()
                {
                    return Err(LinkError::NotALink);
                }
            }
            let linked = values.get("site").ok_or(LinkError::NotALink)?;
            this_site(site, linked)?;
            let account = values
                .get("account")
                .filter(|v| valid_id(v))
                .ok_or(LinkError::NotALink)?;
            let workspace = values
                .get("workspace")
                .filter(|v| valid_id(v))
                .ok_or(LinkError::NotALink)?;
            Ok(DeepLink::Connect {
                site_url: site.into(),
                account_id: account.to_string(),
                workspace_id: workspace.to_string(),
            })
        }
        "message" => {
            let mut to = None;
            let mut linked = None;
            for (key, value) in &pairs {
                let slot = match key.as_str() {
                    "to" => &mut to,
                    // A dashboard's message link names its site as its
                    // connect link does, so a build for another site says
                    // so instead of messaging the wrong one.
                    "site" => &mut linked,
                    _ => return Err(LinkError::NotALink),
                };
                if slot.replace(value.as_str()).is_some() {
                    return Err(LinkError::NotALink);
                }
            }
            if let Some(linked) = linked {
                this_site(site, linked)?;
            }
            let to = to.ok_or(LinkError::NotALink)?;
            let endpoint = Endpoint::parse(to).map_err(|_| LinkError::NotALink)?;
            Ok(DeepLink::Message {
                address: endpoint.is_address(),
                endpoint: endpoint.value().into(),
            })
        }
        _ => Err(LinkError::NotALink),
    }
}

/// The site a link names must be this build's: another site is named by
/// its origin only (the rest of the value is whatever the link carried),
/// and a value that is no site at all is no link.
fn this_site(site: &str, linked: &str) -> Result<(), LinkError> {
    let origin = Url::parse(linked)
        .ok()
        .map(|url| url.origin())
        .filter(url::Origin::is_tuple)
        .ok_or(LinkError::NotALink)?;
    if Url::parse(site).map_or(true, |built_in| built_in.origin() != origin) {
        return Err(LinkError::OtherSite {
            site: origin.ascii_serialization(),
            built_in: site.to_string(),
        });
    }
    if site_url_for(site, linked).is_none() {
        return Err(LinkError::NotALink);
    }
    Ok(())
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

    /// Every site and scheme `build.rs` lets into a build is one the core
    /// then trusts and parses: the build-time check and the run-time rules
    /// move together.
    #[test]
    fn a_site_and_scheme_the_build_accepts_work_at_run_time() {
        for value in [
            "https://agentrelay.com",
            "https://Staging.AgentRelay.com:443/",
            "http://localhost:3100",
            "http://localhost:80",
            "http://127.0.0.1",
        ] {
            let site = crate::build_site::site_origin(value).unwrap();
            assert_eq!(
                crate::cloud::site_origin_with(&site, &site).unwrap(),
                site,
                "{value}"
            );
            assert_eq!(site_url_for(&site, &site).as_deref(), Some(site.as_str()));
            let link = format!(
                "agentrelay://connect?site={}&account=user&workspace=ws",
                url::form_urlencoded::byte_serialize(site.as_bytes()).collect::<String>()
            );
            assert!(
                parse_link_for(&link, "agentrelay", &site).is_ok(),
                "{value}"
            );
        }
        for value in ["agentrelay", "agentrelay-dev", "x1+.-"] {
            let scheme = crate::build_site::url_scheme(value).unwrap();
            assert!(
                parse_link_for(
                    &format!("{scheme}://message?to=alice"),
                    &scheme,
                    DEFAULT_SITE_URL
                )
                .is_ok(),
                "{value}"
            );
        }
        // A web scheme would parse with a `/` path, never as an app link,
        // and the build refuses it (as an app link of it would be refused).
        assert!(crate::build_site::url_scheme("https").is_err());
        assert_eq!(
            parse_link_for("https://message?to=alice", "https", DEFAULT_SITE_URL),
            Err(LinkError::NotALink)
        );
    }

    #[test]
    fn the_built_in_site_and_scheme_default_to_production() {
        // Set at build time, `AGENT_RELAY_SITE_URL` has been checked by
        // build.rs; unset, the build is for production.
        match option_env!("AGENT_RELAY_SITE_URL").filter(|site| !site.trim().is_empty()) {
            Some(site) => assert_eq!(built_in_site_url(), site),
            None => assert_eq!(built_in_site_url(), DEFAULT_SITE_URL),
        }
        match option_env!("AGENT_RELAY_URL_SCHEME").filter(|scheme| !scheme.trim().is_empty()) {
            Some(scheme) => assert_eq!(built_in_url_scheme(), scheme),
            None => assert_eq!(built_in_url_scheme(), DEFAULT_URL_SCHEME),
        }
        // Whatever the build is for, its own site is the one it hands a
        // sign-in to and the one its connect links name.
        assert_eq!(
            site_url(built_in_site_url()).as_deref(),
            Some(built_in_site_url())
        );
        let link = format!(
            "{}://connect?site={}&account=user&workspace=ws",
            built_in_url_scheme(),
            url::form_urlencoded::byte_serialize(built_in_site_url().as_bytes())
                .collect::<String>()
        );
        assert_eq!(
            parse_link(&link),
            Ok(DeepLink::Connect {
                site_url: built_in_site_url().into(),
                account_id: "user".into(),
                workspace_id: "ws".into()
            })
        );
    }

    // Ported from DesktopConnectionTests.
    #[test]
    fn pinned_browser_handoff() {
        let local = "http://localhost:3100";
        let link = "agentrelay-dev://connect?site=http%3A%2F%2Flocalhost%3A3100&account=user-1&workspace=ws_1";
        assert_eq!(
            parse_link_for(link, "agentrelay-dev", local),
            Ok(DeepLink::Connect {
                site_url: local.into(),
                account_id: "user-1".into(),
                workspace_id: "ws_1".into()
            })
        );
        // A build with its own scheme opens only links of that scheme.
        assert_eq!(
            parse_link_for(link, "agentrelay", local),
            Err(LinkError::NotALink)
        );
        // A connect link for another site is refused, and says which.
        assert_eq!(
            parse_link_for(link, "agentrelay-dev", "http://localhost:3300"),
            Err(LinkError::OtherSite {
                site: "http://localhost:3100".into(),
                built_in: "http://localhost:3300".into()
            })
        );
        let production = "agentrelay-dev://connect?site=https%3A%2F%2Fagentrelay.com%2F&account=user-1&workspace=ws_1";
        let error = parse_link_for(production, "agentrelay-dev", local).unwrap_err();
        assert_eq!(
            error.to_string(),
            "That link connects to https://agentrelay.com, but this app is built for http://localhost:3100."
        );
        // A site that is no origin at all, or this build's site with user
        // info or a path, is just not a link.
        let connect = |site: &str| {
            format!(
                "agentrelay-dev://connect?site={}&account=user-1&workspace=ws_1",
                url::form_urlencoded::byte_serialize(site.as_bytes()).collect::<String>()
            )
        };
        for site in [
            "",
            "localhost:3100",
            "mailto:x@y",
            "http://user:pw@localhost:3100",
            "http://localhost:3100/path",
        ] {
            assert_eq!(
                parse_link_for(&connect(site), "agentrelay-dev", local),
                Err(LinkError::NotALink),
                "{site}"
            );
        }
    }

    #[test]
    fn rejects_ambiguous_links_and_untrusted_origins() {
        let base =
            "agentrelay://connect?site=https%3A%2F%2Fagentrelay.com&account=user&workspace=ws";
        assert!(parse_link_for(base, "agentrelay", DEFAULT_SITE_URL).is_ok());
        for suffix in ["&account=other", "&secret=value", "#fragment"] {
            assert_eq!(
                parse_link_for(&format!("{base}{suffix}"), "agentrelay", DEFAULT_SITE_URL),
                Err(LinkError::NotALink)
            );
        }
        for site in [
            "https://evil.example",
            "http://agentrelay.com",
            "https://agentrelay.com:8443",
            "https://user:pass@agentrelay.com",
            "https://agentrelay.com/path",
            "https://agentrelay.com/?x=y",
            "http://localhost:3100",
        ] {
            assert_eq!(site_url_for(DEFAULT_SITE_URL, site), None, "{site}");
        }
        for site in [
            "https://agentrelay.com/",
            "https://AgentRelay.com",
            "https://agentrelay.com:443",
        ] {
            assert_eq!(
                site_url_for(DEFAULT_SITE_URL, site).as_deref(),
                Some(DEFAULT_SITE_URL),
                "{site}"
            );
        }
        // A build for a local site accepts exactly that site.
        let local = "http://localhost:3100";
        assert_eq!(
            site_url_for(local, "http://localhost:3100/").as_deref(),
            Some(local)
        );
        for site in [
            "http://localhost:3300",
            "http://127.0.0.1:3100",
            "https://localhost:3100",
            "http://user:pass@localhost:3100",
            "http://localhost:3100/path",
            DEFAULT_SITE_URL,
        ] {
            assert_eq!(site_url_for(local, site), None, "{site}");
        }
    }

    // DesktopConnectionTests.testEndpointDeepLinkCarriesOnlyOneValidatedTarget
    // and test_deep_link_carries_only_one_valid_target.
    #[test]
    fn endpoint_deep_link_carries_only_one_validated_target() {
        let parse = |raw: &str| parse_link_for(raw, "agentrelay", DEFAULT_SITE_URL);
        assert_eq!(
            parse("agentrelay://message?to=reviewer%40sf-frame"),
            Ok(DeepLink::Message {
                endpoint: "reviewer@sf-frame".into(),
                address: true
            })
        );
        assert_eq!(
            parse("agentrelay://message?to=%40reviewer"),
            Ok(DeepLink::Message {
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
            "agentrelay://open?to=alice",
            "not a link",
        ] {
            assert_eq!(parse(invalid), Err(LinkError::NotALink), "{invalid}");
        }
        // A build with its own scheme opens its message links, not production's.
        assert!(parse_link_for(
            "agentrelay-dev://message?to=alice",
            "agentrelay-dev",
            "http://localhost:3100"
        )
        .is_ok());
    }

    // A dashboard's message link names its site (relay-dashboard #88).
    #[test]
    fn message_deep_link_may_name_this_builds_site_only() {
        let message = Ok(DeepLink::Message {
            endpoint: "reviewer@sf-frame".into(),
            address: true,
        });
        let parse = |raw: &str| parse_link_for(raw, "agentrelay", DEFAULT_SITE_URL);
        assert_eq!(
            parse("agentrelay://message?to=reviewer%40sf-frame&site=https%3A%2F%2Fagentrelay.com"),
            message
        );
        assert_eq!(
            parse(
                "agentrelay://message?site=https%3A%2F%2Fagentrelay.com%2F&to=reviewer%40sf-frame"
            ),
            message
        );
        assert_eq!(
            parse("agentrelay://message?to=reviewer%40sf-frame&site=https%3A%2F%2Fgcp-proof.agentrelay.com"),
            Err(LinkError::OtherSite {
                site: "https://gcp-proof.agentrelay.com".into(),
                built_in: DEFAULT_SITE_URL.into(),
            })
        );
        assert_eq!(
            parse_link_for(
                "agentrelay-gcpproof://message?to=reviewer%40sf-frame&site=https%3A%2F%2Fgcp-proof.agentrelay.com",
                "agentrelay-gcpproof",
                "https://gcp-proof.agentrelay.com",
            ),
            message
        );
        for invalid in [
            "agentrelay://message?to=reviewer%40sf-frame&site=not%20a%20site",
            "agentrelay://message?to=reviewer%40sf-frame&site=https%3A%2F%2Fagentrelay.com&site=https%3A%2F%2Fagentrelay.com",
            "agentrelay://message?to=reviewer%40sf-frame&to=reviewer%40sf-frame",
            "agentrelay://message?site=https%3A%2F%2Fagentrelay.com",
        ] {
            assert_eq!(parse(invalid), Err(LinkError::NotALink), "{invalid}");
        }
    }

    #[test]
    fn links_serialize_with_their_kind() {
        let link = parse_link_for(
            "agentrelay://message?to=alice",
            "agentrelay",
            DEFAULT_SITE_URL,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(link).unwrap(),
            json!({"kind": "message", "endpoint": "alice", "address": false})
        );
    }
}
