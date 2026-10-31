//! Resolve the Relaycast destination before any credential can leave the broker.
//!
//! The TypeScript CLI records credential routes in
//! `$AGENT_RELAY_HOME/relaycast-origins.json`. The broker is a separate process,
//! so it must enforce the same fail-closed rule itself instead of relying on the
//! parent process to keep `RELAY_BASE_URL` set forever.

use std::{collections::HashMap, path::PathBuf};

use anyhow::{bail, Context, Result};
use pbkdf2::pbkdf2_hmac;
use serde::Deserialize;
use sha2::Sha256;
use url::Url;

const ORIGIN_BINDINGS_FILE: &str = "relaycast-origins.json";
const HOSTED_DOMAIN: &str = "agentrelay.com";
/// The one hosted gateway the CLI binds keys to: it creates new workspaces there.
const ARMADILLO_ORIGIN: &str = "https://armadillo.agentrelay.com";
const FINGERPRINT_SALT: &[u8] = b"agent-relay:relaycast-origin-binding";
const FINGERPRINT_ITERATIONS: u32 = 10_000;

#[derive(Debug, Deserialize)]
struct OriginBindings {
    version: u8,
    origins: HashMap<String, String>,
}

/// Resolve the one Relaycast base URL this broker may use.
///
/// An explicit non-blank `RELAYCAST_BASE_URL` wins over `RELAY_BASE_URL` and a
/// persisted binding. With neither set, every configured workspace credential
/// must either be unbound or resolve to the same saved server.
/// Mixed or conflicting routes fail rather than exposing one credential to a
/// server selected for another.
pub(crate) fn resolve_relaycast_base_url() -> Result<Option<String>> {
    let credentials = configured_credentials()?;
    resolve_relaycast_base_url_from(explicit_base_url(), &credentials, &origin_bindings_path())
}

fn resolve_relaycast_base_url_from(
    explicit: Option<(&str, String)>,
    credentials: &[String],
    bindings_path: &std::path::Path,
) -> Result<Option<String>> {
    if let Some((name, value)) = explicit {
        let base_url = normalize_base_url(&value, name)?;
        // Match the CLI's fail-closed contract: an explicit URL selects the
        // destination, but it does not make a corrupt security record safe to
        // ignore. Validate the file whenever a credential is about to be sent.
        if !credentials.is_empty() {
            read_bindings(bindings_path)?;
        }
        return Ok(Some(base_url));
    }

    if credentials.is_empty() {
        return Ok(None);
    }
    resolve_bound_base_url(credentials, bindings_path)
}

fn explicit_base_url() -> Option<(&'static str, String)> {
    ["RELAYCAST_BASE_URL", "RELAY_BASE_URL"]
        .into_iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| (name, value))
        })
}

fn configured_credentials() -> Result<Vec<String>> {
    if let Ok(raw) = std::env::var("RELAY_WORKSPACES_JSON") {
        if !raw.trim().is_empty() {
            return workspace_credentials_from_json(&raw);
        }
    }

    for name in [
        "AGENT_RELAY_WORKSPACE_KEY",
        "RELAY_WORKSPACE_KEY",
        "RELAY_API_KEY",
    ] {
        if let Ok(value) = std::env::var(name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(vec![trimmed.to_string()]);
            }
        }
    }
    Ok(Vec::new())
}

fn workspace_credentials_from_json(raw: &str) -> Result<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .context("RELAY_WORKSPACES_JSON must be valid JSON before resolving its server")?;
    let memberships: Vec<&serde_json::Value> = if let Some(values) = value.as_array() {
        values.iter().collect()
    } else if let Some(values) = value.get("memberships").and_then(|value| value.as_array()) {
        values.iter().collect()
    } else {
        vec![&value]
    };
    let mut credentials = Vec::with_capacity(memberships.len());
    for membership in memberships {
        let credential = membership
            .get("api_key")
            .or_else(|| membership.get("apiKey"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("RELAY_WORKSPACES_JSON contains a membership without an api_key")?;
        credentials.push(credential.to_string());
    }
    if credentials.is_empty() {
        bail!("RELAY_WORKSPACES_JSON must contain at least one membership");
    }
    Ok(credentials)
}

fn origin_bindings_path() -> PathBuf {
    std::env::var_os("AGENT_RELAY_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".agentworkforce/relay")))
        .unwrap_or_else(|| PathBuf::from(".agentworkforce/relay"))
        .join(ORIGIN_BINDINGS_FILE)
}

fn resolve_bound_base_url(
    credentials: &[String],
    path: &std::path::Path,
) -> Result<Option<String>> {
    let bindings = read_bindings(path)?;
    let mut resolved: Option<String> = None;
    let mut unbound = false;
    for credential in credentials {
        let saved = bindings
            .origins
            .get(&credential_fingerprint(credential))
            .map(String::as_str);
        match saved.or_else(|| armadillo_issued(credential).then_some(ARMADILLO_ORIGIN)) {
            Some(base_url) => match resolved.as_deref() {
                Some(previous) if previous != base_url => bail!(
                    "configured workspace credentials are bound to different Relaycast servers ({previous} and {base_url}); set RELAY_BASE_URL explicitly"
                ),
                None => resolved = Some(base_url.to_string()),
                _ => {}
            },
            None => unbound = true,
        }
    }
    if unbound && resolved.is_some() {
        bail!(
            "some configured workspace credentials have a saved self-hosted server and others do not; set RELAY_BASE_URL explicitly"
        );
    }
    Ok(resolved)
}

/// Armadillo's credentials name their server: `ar_ws_…` keys and `ar_ag_…`
/// agent tokens.
fn armadillo_issued(credential: &str) -> bool {
    let credential = credential.trim();
    credential.starts_with("ar_ws_") || credential.starts_with("ar_ag_")
}

fn read_bindings(path: &std::path::Path) -> Result<OriginBindings> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OriginBindings {
                version: 1,
                origins: HashMap::new(),
            });
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("could not read {}; fix or remove it", path.display()));
        }
    };
    let bindings: OriginBindings = serde_json::from_str(&raw).with_context(|| {
        format!(
            "{} is not a valid Relaycast origin file; fix or remove it",
            path.display()
        )
    })?;
    if bindings.version != 1 {
        bail!(
            "{} is not a valid Relaycast origin file (unknown version); fix or remove it",
            path.display()
        );
    }
    for (fingerprint, base_url) in &bindings.origins {
        if fingerprint.len() != 32
            || !fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            bail!(
                "{} is not a valid Relaycast origin file (bad fingerprint); fix or remove it",
                path.display()
            );
        }
        let normalized =
            normalize_base_url(base_url, "saved Relaycast server").with_context(|| {
                format!(
                    "{} is not a valid Relaycast origin file; fix or remove it",
                    path.display()
                )
            })?;
        if normalized != *base_url || !is_bindable_base_url(&normalized)? {
            bail!(
                "{} is not a valid Relaycast origin file (bad saved server); fix or remove it",
                path.display()
            );
        }
    }
    Ok(bindings)
}

fn credential_fingerprint(credential: &str) -> String {
    let mut derived = [0u8; 16];
    pbkdf2_hmac::<Sha256>(
        credential.trim().as_bytes(),
        FINGERPRINT_SALT,
        FINGERPRINT_ITERATIONS,
        &mut derived,
    );
    derived.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn normalize_base_url(value: &str, label: &str) -> Result<String> {
    let parsed = Url::parse(value.trim()).with_context(|| format!("{label} is not a valid URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("{label} must be an http(s) URL");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        bail!("{label} must not contain credentials");
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        bail!("{label} must not contain a query or fragment");
    }
    let host = parsed
        .host_str()
        .context(format!("{label} must contain a host"))?;
    let mut base = format!("{}://{}", parsed.scheme(), host_for_url(host));
    if let Some(port) = parsed.port() {
        base.push(':');
        base.push_str(&port.to_string());
    }
    let path = parsed.path().trim_end_matches('/');
    base.push_str(path);
    Ok(base)
}

fn host_for_url(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// Whether the CLI records this server against a credential: every hosted
/// gateway but the one new workspaces are created on stays unbound.
fn is_bindable_base_url(base_url: &str) -> Result<bool> {
    let parsed = Url::parse(base_url)?;
    let host = parsed.host_str().unwrap_or_default();
    let hosted = parsed.scheme() == "https"
        && (host == HOSTED_DOMAIN || host.ends_with(&format!(".{HOSTED_DOMAIN}")));
    Ok(!hosted || parsed.origin().ascii_serialization() == ARMADILLO_ORIGIN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::{
        fs,
        io::{Read, Write},
        net::TcpListener,
        time::{Duration, Instant},
    };

    #[derive(Deserialize)]
    struct SharedOriginVector {
        credential: String,
        fingerprint: String,
        base_url_input: String,
        normalized_base_url: String,
        binding_file: serde_json::Value,
    }

    fn shared_origin_vector() -> SharedOriginVector {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/fixtures/relaycast-origin-binding.json"
        ))
        .expect("shared Relaycast origin vector must be valid JSON")
    }

    #[test]
    fn fingerprint_and_binding_file_match_the_shared_typescript_contract() {
        let vector = shared_origin_vector();
        assert_eq!(
            credential_fingerprint(&vector.credential),
            vector.fingerprint
        );
        assert_eq!(
            normalize_base_url(&vector.base_url_input, "url").unwrap(),
            vector.normalized_base_url
        );

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ORIGIN_BINDINGS_FILE);
        fs::write(&path, serde_json::to_vec(&vector.binding_file).unwrap()).unwrap();
        assert_eq!(
            resolve_bound_base_url(&[vector.credential], &path).unwrap(),
            Some(vector.normalized_base_url)
        );
    }

    #[test]
    fn bound_credential_resolves_only_to_its_saved_server() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ORIGIN_BINDINGS_FILE);
        let credential = "rk_live_self_hosted";
        fs::write(
            &path,
            format!(
                "{{\"version\":1,\"origins\":{{\"{}\":\"https://relay.corp.test:8443\"}}}}",
                credential_fingerprint(credential)
            ),
        )
        .unwrap();

        assert_eq!(
            resolve_bound_base_url(&[credential.to_string()], &path).unwrap(),
            Some("https://relay.corp.test:8443".to_string())
        );
    }

    #[test]
    fn network_bound_credential_never_connects_to_the_hosted_gateway() {
        let self_hosted = TcpListener::bind("127.0.0.1:0").unwrap();
        self_hosted.set_nonblocking(true).unwrap();
        let self_hosted_address = self_hosted.local_addr().unwrap();
        let hosted_trap = TcpListener::bind("127.0.0.1:0").unwrap();
        hosted_trap.set_nonblocking(true).unwrap();
        let hosted_trap_address = hosted_trap.local_addr().unwrap();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ORIGIN_BINDINGS_FILE);
        let credential = "rk_live_never_hosted";
        fs::write(
            &path,
            format!(
                "{{\"version\":1,\"origins\":{{\"{}\":\"http://{}\"}}}}",
                credential_fingerprint(credential),
                self_hosted_address
            ),
        )
        .unwrap();
        let destination = resolve_bound_base_url(&[credential.to_string()], &path)
            .unwrap()
            .unwrap_or_else(|| "https://cast.agentrelay.com".to_string());

        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match self_hosted.accept() {
                    Ok((mut stream, _)) => {
                        // macOS hands back an accepted socket that inherits the
                        // listener's non-blocking mode; Linux does not.
                        stream.set_nonblocking(false).unwrap();
                        let mut request = [0u8; 1024];
                        let read = stream.read(&mut request).unwrap();
                        stream
                            .write_all(
                                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                            )
                            .unwrap();
                        return String::from_utf8_lossy(&request[..read]).to_string();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "self-hosted server was never contacted"
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("self-hosted accept failed: {error}"),
                }
            }
        });

        let response = reqwest::blocking::Client::builder()
            .no_proxy()
            .resolve("cast.agentrelay.com", hosted_trap_address)
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap()
            .get(format!("{destination}/v1/agents"))
            .bearer_auth(credential)
            .send()
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/agents "));
        assert!(matches!(
            hosted_trap.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
    }

    #[test]
    fn armadillo_keys_stay_bound_and_never_mix_with_keys_saved_before_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ORIGIN_BINDINGS_FILE);
        let bound = "rk_live_armadillo";
        fs::write(
            &path,
            format!(
                "{{\"version\":1,\"origins\":{{\"{}\":\"{ARMADILLO_ORIGIN}\"}}}}",
                credential_fingerprint(bound)
            ),
        )
        .unwrap();
        assert_eq!(
            resolve_bound_base_url(&[bound.to_string()], &path)
                .unwrap()
                .as_deref(),
            Some(ARMADILLO_ORIGIN)
        );
        assert_eq!(
            resolve_bound_base_url(&["ar_ws_never_seen".to_string()], &path)
                .unwrap()
                .as_deref(),
            Some(ARMADILLO_ORIGIN)
        );
        // No recorded server: the broker's cast default, never the binding above.
        assert_eq!(
            resolve_bound_base_url(&["rk_live_saved_before".to_string()], &path).unwrap(),
            None
        );
        assert!(resolve_bound_base_url(
            &[bound.to_string(), "rk_live_saved_before".to_string()],
            &path
        )
        .is_err());
    }

    #[test]
    fn malformed_or_unreadable_binding_file_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ORIGIN_BINDINGS_FILE);
        fs::write(&path, "not json").unwrap();
        assert!(resolve_bound_base_url(&["rk_live_test".to_string()], &path).is_err());

        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(resolve_bound_base_url(&["rk_live_test".to_string()], &path).is_err());
    }

    #[test]
    fn binding_file_rejects_unknown_versions_bad_fingerprints_and_hosted_servers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ORIGIN_BINDINGS_FILE);
        for invalid in [
            r#"{"version":2,"origins":{}}"#,
            r#"{"version":1,"origins":{"NOT-A-FINGERPRINT":"https://relay.corp.test"}}"#,
            r#"{"version":1,"origins":{"00000000000000000000000000000000":"https://cast.agentrelay.com"}}"#,
        ] {
            fs::write(&path, invalid).unwrap();
            assert!(
                read_bindings(&path).is_err(),
                "invalid binding file was accepted: {invalid}"
            );
        }
    }

    #[test]
    fn explicit_url_still_fails_on_a_broken_binding_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ORIGIN_BINDINGS_FILE);
        fs::write(&path, "not json").unwrap();
        let resolved = resolve_relaycast_base_url_from(
            Some(("RELAYCAST_BASE_URL", "https://explicit.test:8443/".into())),
            &["rk_live_test".into()],
            &path,
        );
        assert!(resolved.is_err());
    }

    #[test]
    fn malformed_explicit_url_never_falls_back_to_a_binding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ORIGIN_BINDINGS_FILE);
        let credential = "rk_live_test";
        fs::write(
            &path,
            format!(
                "{{\"version\":1,\"origins\":{{\"{}\":\"https://relay.corp.test\"}}}}",
                credential_fingerprint(credential)
            ),
        )
        .unwrap();
        let resolved = resolve_relaycast_base_url_from(
            Some(("RELAYCAST_BASE_URL", "not a url".into())),
            &[credential.into()],
            &path,
        );
        assert!(resolved.is_err());
    }

    #[test]
    fn normalizes_paths_ports_and_ipv6_without_queries_or_credentials() {
        assert_eq!(
            normalize_base_url("https://relay.test:8443/prefix///", "url").unwrap(),
            "https://relay.test:8443/prefix"
        );
        assert_eq!(
            normalize_base_url("http://[::1]:8787/", "url").unwrap(),
            "http://[::1]:8787"
        );
        assert!(normalize_base_url("https://u:p@relay.test", "url").is_err());
        assert!(normalize_base_url("https://relay.test/?q=1", "url").is_err());
    }
}
