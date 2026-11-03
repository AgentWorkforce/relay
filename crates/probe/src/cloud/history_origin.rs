//! The one widening of the RelayHistory trust rule: the workspace's own
//! History origin, as Cloud names it, and the address check every
//! authenticated request to such a History passes first.

use super::{
    history_origin, history_url_origin, is_loopback_origin, normalized_stage,
    require_secure_transport, untrusted_cloud_base_url_allowed, PUSHED_HISTORY_HOSTS,
};
use anyhow::Result;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use url::Url;

/// [`history_origin`], widened by the one origin Cloud names for this
/// workspace. A workspace whose owner registered its own RelayHistory (a
/// customer-hosted data plane) gets that origin back in the authenticated,
/// redirect-free workspace-session answer from a trusted Cloud site; this is
/// the only place a non-default origin is accepted, and only an https origin
/// on a DNS name — never cleartext, loopback, an IP literal, a path or
/// credentials. Nothing local (environment, flag, file) can name one.
pub fn workspace_history_origin(raw: &str, site: &str) -> Result<String> {
    if let Ok(origin) = history_origin(raw, site) {
        return Ok(origin);
    }
    let url = Url::parse(raw.trim())?;
    let host = match url.host() {
        Some(url::Host::Domain(host)) => host.to_ascii_lowercase(),
        _ => anyhow::bail!("untrusted history origin"),
    };
    // A trailing dot (`localhost.`, `intranet.`) names the same host as an
    // absolute DNS name and would slip past the checks below; no public
    // History needs it, so it is refused rather than stripped, as Cloud does.
    anyhow::ensure!(
        !is_loopback_origin(&Url::parse(site.trim())?)
            && url.scheme() == "https"
            && !host.ends_with('.')
            && host.contains('.')
            && host != "localhost"
            && !INTERNAL_HOST_SUFFIXES
                .iter()
                .any(|suffix| host.ends_with(suffix)),
        "untrusted history origin"
    );
    history_url_origin(url)
}

/// Name suffixes that never belong to a public History. The same list Cloud
/// refuses when a workspace registers its own origin.
const INTERNAL_HOST_SUFFIXES: &[&str] =
    &[".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/// [`require_secure_transport`], and for a workspace's own History on a DNS
/// name, that the name resolves only to public addresses. Origin checks
/// refuse IP literals, but a custom name can still resolve to loopback, a
/// private network, link-local (cloud metadata) or a unique-local address;
/// the probe must not send a History session or Cloud's assertion there.
/// The compiled default stages and loopback development over http are not
/// resolved, nor is anything under the development flag. Every
/// authenticated History request calls this immediately before it is sent.
/// A workspace History's name did not resolve. Unlike a refused address
/// this can clear by itself, so delivery retries it instead of blocking.
#[derive(Debug)]
pub(crate) struct HistoryUnresolved;
impl std::fmt::Display for HistoryUnresolved {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("could not resolve the workspace RelayHistory")
    }
}
impl std::error::Error for HistoryUnresolved {}

pub(crate) fn require_history_destination(base_url: &str) -> Result<()> {
    require_secure_transport(base_url)?;
    if untrusted_cloud_base_url_allowed() {
        return Ok(());
    }
    let url = Url::parse(&normalized_stage(base_url)?)?;
    let Some(url::Host::Domain(host)) = url.host() else {
        return Ok(());
    };
    if url.scheme() != "https" || PUSHED_HISTORY_HOSTS.contains(&host) {
        return Ok(());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses: Vec<IpAddr> = ToSocketAddrs::to_socket_addrs(&(host, port))
        .map_err(|_| HistoryUnresolved)?
        .map(|address| address.ip())
        .collect();
    if addresses.is_empty() {
        return Err(HistoryUnresolved.into());
    }
    anyhow::ensure!(
        addresses.into_iter().all(is_public_address),
        "refusing to send a RelayHistory session to `{host}`: it resolves to a loopback, private or link-local address"
    );
    Ok(())
}

/// An agent for every request that carries a History session or Cloud's
/// assertion. Its resolver applies the address rule to the very addresses
/// the connection uses, so a name cannot answer [`require_history_destination`]
/// with a public address and the connection with a private one; TLS still
/// verifies the name itself.
pub fn history_agent() -> ureq::AgentBuilder {
    ureq::AgentBuilder::new().resolver(|netloc: &str| {
        let addresses = netloc.to_socket_addrs()?.collect();
        let host = netloc.rsplit_once(':').map_or(netloc, |(host, _)| host);
        connectable(host, addresses)
    })
}

/// `addresses` for `host`, unless `host` is a name the address rule covers
/// and any of them is not public. IP literals were checked as origins, and
/// `localhost`, the compiled default stages and the development flag are
/// exempt, as in [`require_history_destination`].
fn connectable(host: &str, addresses: Vec<SocketAddr>) -> std::io::Result<Vec<SocketAddr>> {
    let exempt = untrusted_cloud_base_url_allowed()
        || host.starts_with('[')
        || host.parse::<IpAddr>().is_ok()
        || host.eq_ignore_ascii_case("localhost")
        || PUSHED_HISTORY_HOSTS.contains(&host);
    if exempt
        || addresses
            .iter()
            .all(|address| is_public_address(address.ip()))
    {
        return Ok(addresses);
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "refusing a RelayHistory connection to a non-public address",
    ))
}

/// Is `address` reachable only across the public internet? Loopback,
/// private (RFC 1918), shared (CGNAT), link-local, unique-local, multicast,
/// unspecified, broadcast, documentation and reserved ranges are not, nor is
/// an IPv4-mapped IPv6 address of any of them.
fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    let special = ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation();
    // This network, shared CGNAT, IETF protocol assignments, benchmarking and
    // the reserved class E space.
    let reserved = a == 0
        || (a == 100 && (64..128).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (18..20).contains(&b))
        || a >= 240;
    !(special || reserved)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_v4(mapped);
    }
    let segments = ip.segments();
    let special = ip.is_unspecified() || ip.is_loopback() || ip.is_multicast();
    // Unique-local fc00::/7, link-local fe80::/10, site-local fec0::/10,
    // documentation 2001:db8::/32, IPv4-compatible ::/96 and NAT64 64:ff9b::/96.
    let reserved = (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || segments[..6] == [0, 0, 0, 0, 0, 0]
        || segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0];
    !(special || reserved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_addresses_may_receive_a_workspace_history_session() {
        let _guard = crate::cloud::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
        std::env::remove_var("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL");
        for private in [
            "127.0.0.1",
            "10.0.0.5",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "ff02::1",
            "::ffff:10.0.0.5",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !is_public_address(private.parse::<IpAddr>().unwrap()),
                "{private}"
            );
        }
        for public in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(
                is_public_address(public.parse::<IpAddr>().unwrap()),
                "{public}"
            );
        }
        // Every authenticated History request checks it: a name resolving to
        // loopback is refused, while the compiled default stage and loopback
        // development over http are not resolved at all.
        assert!(require_history_destination("https://localhost:8443").is_err());
        assert!(require_history_destination("https://history.agentrelay.com").is_ok());
        assert!(require_history_destination("http://127.0.0.1:8787").is_ok());
        // A refused address is not a lookup failure; a name that does not
        // resolve (`.invalid` never does) is, so delivery can retry it.
        assert!(!require_history_destination("https://localhost:8443")
            .unwrap_err()
            .is::<HistoryUnresolved>());
        assert!(
            require_history_destination("https://history.relayhistory.invalid")
                .unwrap_err()
                .is::<HistoryUnresolved>()
        );
        // The connection itself is held to the same rule, so a name that
        // answered the check with a public address cannot connect privately.
        let at = |ip: &str| vec![SocketAddr::new(ip.parse().unwrap(), 443)];
        assert!(connectable("history.hookdeck.example", at("10.0.0.5")).is_err());
        assert!(connectable("history.hookdeck.example", at("::1")).is_err());
        assert!(connectable("history.hookdeck.example", at("1.1.1.1")).is_ok());
        assert!(connectable("localhost", at("127.0.0.1")).is_ok());
        assert!(connectable("127.0.0.1", at("127.0.0.1")).is_ok());
        assert!(connectable("history.agentrelay.com", at("10.0.0.5")).is_ok());
        if let Some(value) = previous {
            std::env::set_var("RELAYHISTORY_ALLOW_UNTRUSTED_CLOUD_BASE_URL", value);
        }
    }
}
