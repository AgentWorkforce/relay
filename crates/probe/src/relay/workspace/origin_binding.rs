//! The `agent-relay` CLI's Relaycast origin bindings
//! (`$AGENT_RELAY_HOME/relaycast-origins.json`), read and never written.
//!
//! The CLI records which self-hosted server each credential belongs to, keyed
//! by a one-way fingerprint of the credential, so that a self-hosted key is
//! never sent to the hosted gateway. Hosted servers (`*.agentrelay.com`) are
//! the default and are never bound. A file that cannot be read or parsed fails
//! closed: ignoring it would unbind every credential and send it to the
//! hosted default. This mirrors `packages/cli/src/cli/lib/relaycast-origin-binding.ts`
//! and the broker's `crates/broker/src/transport.rs`; all three are checked
//! against `packages/contracts/fixtures/relaycast-origin-binding.json`.

use std::collections::HashMap;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

/// The bindings file, next to the CLI's `workspaces.json`.
pub const ORIGIN_BINDINGS_FILE: &str = "relaycast-origins.json";

const FINGERPRINT_SALT: &[u8] = b"agent-relay:relaycast-origin-binding";
const FINGERPRINT_ITERATIONS: NonZeroU32 = match NonZeroU32::new(10_000) {
    Some(iterations) => iterations,
    None => panic!("PBKDF2 needs at least one iteration"),
};
const HOSTED_DOMAIN: &str = "agentrelay.com";

/// The validated bindings: credential fingerprint → self-hosted base URL.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OriginBindings {
    origins: HashMap<String, String>,
}

impl OriginBindings {
    /// The self-hosted server `credential` is bound to, if any.
    pub fn bound(&self, credential: &str) -> Option<&str> {
        self.origins
            .get(&credential_fingerprint(credential))
            .map(String::as_str)
    }
}

/// `<relay_home>/relaycast-origins.json`.
pub fn bindings_path(relay_home: &Path) -> PathBuf {
    relay_home.join(ORIGIN_BINDINGS_FILE)
}

/// Reads the bindings file. Missing means no bindings; anything unreadable,
/// unparsable, of an unknown version, or holding a bad fingerprint or server
/// is an error naming the file (never a credential).
pub fn read_bindings(path: &Path) -> Result<OriginBindings, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OriginBindings::default());
        }
        Err(_) => {
            return Err(format!(
                "Could not read {}; fix or remove it.",
                path.display()
            ))
        }
    };
    let invalid = |detail: &str| {
        format!(
            "{} is not a valid Relaycast origin file ({detail}); fix or remove it.",
            path.display()
        )
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|_| invalid("not JSON"))?;
    let object = parsed.as_object().ok_or_else(|| invalid("not an object"))?;
    if object.get("version").and_then(serde_json::Value::as_f64) != Some(1.0) {
        return Err(invalid("unknown version"));
    }
    let origins = object
        .get("origins")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| invalid("\"origins\" is not an object"))?;
    let mut validated = HashMap::with_capacity(origins.len());
    for (fingerprint, value) in origins {
        if !is_fingerprint(fingerprint) {
            return Err(invalid(&format!("bad fingerprint \"{fingerprint}\"")));
        }
        let base_url = value
            .as_str()
            .and_then(|value| configured_base_url(value).ok().flatten())
            .filter(|base_url| !is_hosted(base_url))
            .ok_or_else(|| invalid(&format!("bad server for \"{fingerprint}\"")))?;
        validated.insert(fingerprint.clone(), base_url);
    }
    Ok(OriginBindings { origins: validated })
}

/// The CLI's one-way credential fingerprint: PBKDF2-HMAC-SHA256 of the
/// trimmed credential, 10,000 iterations, 16 bytes, lowercase hex.
pub fn credential_fingerprint(credential: &str) -> String {
    let mut derived = [0u8; 16];
    ring::pbkdf2::derive(
        ring::pbkdf2::PBKDF2_HMAC_SHA256,
        FINGERPRINT_ITERATIONS,
        FINGERPRINT_SALT,
        credential.trim().as_bytes(),
        &mut derived,
    );
    derived.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_fingerprint(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The CLI's `configuredBaseUrl`: blank is unset (`Ok(None)`); otherwise an
/// http(s) URL without credentials, query or fragment, reduced to its origin
/// plus any path prefix without trailing slashes. Anything else is an error,
/// because falling back to the hosted default would send the credential
/// somewhere nobody chose.
pub fn configured_base_url(value: &str) -> Result<Option<String>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "is not a valid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("must be an http(s) URL".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("must not contain credentials".into());
    }
    if parsed.query().is_some_and(|query| !query.is_empty())
        || parsed
            .fragment()
            .is_some_and(|fragment| !fragment.is_empty())
    {
        return Err("must not contain a query or fragment".into());
    }
    let origin = parsed.origin();
    if !origin.is_tuple() {
        return Err("is not a valid URL".into());
    }
    Ok(Some(format!(
        "{}{}",
        origin.ascii_serialization(),
        parsed.path().trim_end_matches('/')
    )))
}

/// `base_url`'s origin (`scheme://host[:port]`), if it parses.
pub fn origin_of(base_url: &str) -> Option<String> {
    let origin = url::Url::parse(base_url).ok()?.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

/// Agent Relay's own gateways (`https://*.agentrelay.com`): the default,
/// never bound.
pub fn is_hosted(base_url: &str) -> bool {
    url::Url::parse(base_url).is_ok_and(|url| {
        let host = url.host_str().unwrap_or_default();
        url.scheme() == "https"
            && (host == HOSTED_DOMAIN || host.ends_with(&format!(".{HOSTED_DOMAIN}")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct SharedVector {
        credential: String,
        fingerprint: String,
        base_url_input: String,
        normalized_base_url: String,
        binding_file: serde_json::Value,
    }

    /// The vector the CLI's TypeScript tests and the broker's Rust tests read.
    fn shared_vector() -> SharedVector {
        serde_json::from_str(include_str!(
            "../../../../../packages/contracts/fixtures/relaycast-origin-binding.json"
        ))
        .expect("the shared Relaycast origin vector is valid JSON")
    }

    fn write(dir: &Path, contents: &str) -> PathBuf {
        let path = bindings_path(dir);
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn fingerprint_and_binding_file_match_the_shared_cli_and_broker_contract() {
        let vector = shared_vector();
        assert_eq!(
            credential_fingerprint(&vector.credential),
            vector.fingerprint
        );
        assert_eq!(
            configured_base_url(&vector.base_url_input)
                .unwrap()
                .as_deref(),
            Some(vector.normalized_base_url.as_str())
        );
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), &vector.binding_file.to_string());
        let bindings = read_bindings(&path).unwrap();
        // The fingerprint trims, as the CLI's does.
        assert_eq!(
            bindings.bound(vector.credential.trim()),
            Some(vector.normalized_base_url.as_str())
        );
        assert_eq!(
            bindings.bound(&vector.credential),
            Some(vector.normalized_base_url.as_str())
        );
        assert_eq!(bindings.bound("rk_live_some_other_key"), None);
    }

    #[test]
    fn a_missing_file_binds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let bindings = read_bindings(&bindings_path(dir.path())).unwrap();
        assert_eq!(bindings.bound("rk_live_anything"), None);
    }

    #[test]
    fn malformed_files_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        for bad in [
            "not json",
            "[]",
            "null",
            r#"{"version":2,"origins":{}}"#,
            r#"{"origins":{}}"#,
            r#"{"version":1}"#,
            r#"{"version":1,"origins":[]}"#,
            r#"{"version":1,"origins":{"NOT-A-FINGERPRINT":"https://relay.corp.test"}}"#,
            r#"{"version":1,"origins":{"0dcecdc46ef84167c45e73cf1e859dd4":"https://cast.agentrelay.com"}}"#,
            r#"{"version":1,"origins":{"0dcecdc46ef84167c45e73cf1e859dd4":"ftp://relay.corp.test"}}"#,
            r#"{"version":1,"origins":{"0dcecdc46ef84167c45e73cf1e859dd4":42}}"#,
            r#"{"version":1,"origins":{"0dcecdc46ef84167c45e73cf1e859dd4":"https://u:p@relay.corp.test"}}"#,
        ] {
            let path = write(dir.path(), bad);
            let error = read_bindings(&path).expect_err(bad);
            assert!(error.contains("relaycast-origins.json"), "{error}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be cannot be read as one.
        std::fs::create_dir(bindings_path(dir.path())).unwrap();
        assert!(read_bindings(&bindings_path(dir.path())).is_err());
    }

    #[test]
    fn base_urls_normalize_like_the_cli() {
        for (input, expected) in [
            ("http://127.0.0.1:8787", "http://127.0.0.1:8787"),
            ("http://127.0.0.1:8787/", "http://127.0.0.1:8787"),
            ("http://LOCALHOST:8787", "http://localhost:8787"),
            ("https://relay.corp.test:443/", "https://relay.corp.test"),
            (
                "https://relay.corp.test/relaycast/",
                "https://relay.corp.test/relaycast",
            ),
            ("http://[::1]:8787", "http://[::1]:8787"),
            (
                "  https://cast.agentrelay.com  ",
                "https://cast.agentrelay.com",
            ),
        ] {
            assert_eq!(
                configured_base_url(input).unwrap().as_deref(),
                Some(expected),
                "{input}"
            );
        }
        assert_eq!(configured_base_url("   ").unwrap(), None);
        for bad in [
            "relay.corp.test",
            "ftp://relay.corp.test",
            "https://u:p@relay.corp.test",
            "https://relay.corp.test/?q=1",
            "https://relay.corp.test/#f",
        ] {
            assert!(configured_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_https_agentrelay_hosts_are_hosted() {
        assert!(is_hosted("https://cast.agentrelay.com"));
        assert!(is_hosted("https://agent37-cast.agentrelay.com"));
        assert!(is_hosted("https://agentrelay.com"));
        assert!(!is_hosted("http://cast.agentrelay.com"));
        assert!(!is_hosted("https://evilagentrelay.com"));
        assert!(!is_hosted("http://127.0.0.1:8787"));
    }
}
