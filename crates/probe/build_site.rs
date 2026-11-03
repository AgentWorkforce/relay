//! The site and link scheme a build is made for, checked by `build.rs` from
//! `AGENT_RELAY_SITE_URL` and `AGENT_RELAY_URL_SCHEME` so a wrong value fails
//! the build with its reason rather than every sign-in after it. Shared with
//! the crate's tests through `#[path]`, where this is a plain module.

/// `value` as the origin a build may talk to: `https://<host>` on its
/// default port, or `http://localhost:<port>` / `http://127.0.0.1:<port>` for
/// a site served on this computer; no user info, path, query or fragment. A
/// trailing slash is dropped and the scheme and host lowercased, so the
/// result compares byte for byte with what the core stores.
pub fn site_origin(value: &str) -> Result<String, String> {
    let value = value.trim();
    let (scheme, rest) = value
        .split_once("://")
        .ok_or_else(|| "it has no scheme".to_string())?;
    let scheme = scheme.to_ascii_lowercase();
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.contains(['/', '?', '#']) {
        return Err("it has a path, query or fragment".into());
    }
    if rest.contains('@') {
        return Err("it has user info".into());
    }
    let (host, port) = match rest.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    if host.is_empty()
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return Err("its host is not a host name".into());
    }
    let host = host.to_ascii_lowercase();
    let port = port
        .map(|port| {
            port.parse::<u16>()
                .ok()
                .filter(|port| *port != 0)
                .ok_or_else(|| format!("its port `{port}` is not a number from 1 to 65535"))
        })
        .transpose()?;
    match scheme.as_str() {
        "https" => {
            if port.is_some() {
                return Err("an https site is on its default port, so names none".into());
            }
            Ok(format!("https://{host}"))
        }
        "http" => {
            if host != "localhost" && host != "127.0.0.1" {
                return Err("http is for a site on localhost or 127.0.0.1 only".into());
            }
            let port = port.ok_or_else(|| "a local http site names its port".to_string())?;
            Ok(format!("http://{host}:{port}"))
        }
        _ => Err(format!("its scheme `{scheme}` is not https or http")),
    }
}

/// `value` as a URL scheme the app may register for its links (RFC 3986:
/// a letter, then letters, digits, `+`, `-` or `.`), lowercased.
pub fn url_scheme(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    let mut bytes = value.bytes();
    let well_formed = bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'));
    if !well_formed {
        return Err("a scheme is a letter followed by letters, digits, `+`, `-` or `.`".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_is_an_https_origin_or_a_local_http_one() {
        for (value, origin) in [
            ("https://agentrelay.com", "https://agentrelay.com"),
            (
                "https://Staging.AgentRelay.com/",
                "https://staging.agentrelay.com",
            ),
            (" HTTPS://relay.example.test ", "https://relay.example.test"),
            ("http://localhost:3100", "http://localhost:3100"),
            ("http://127.0.0.1:3100/", "http://127.0.0.1:3100"),
        ] {
            assert_eq!(site_origin(value).as_deref(), Ok(origin), "{value}");
        }
        for value in [
            "",
            "agentrelay.com",
            "ftp://agentrelay.com",
            "https://agentrelay.com/app",
            "https://agentrelay.com/?x=y",
            "https://agentrelay.com/#top",
            "https://user:secret@agentrelay.com",
            "https://agentrelay.com:8443",
            "https://agentrelay.com:443",
            "https://",
            "https://relay example",
            "http://agentrelay.com",
            "http://relay.example.test:3100",
            "http://localhost",
            "http://localhost:0",
            "http://localhost:70000",
            "http://localhost:web",
            "http://[::1]:3100",
        ] {
            assert!(site_origin(value).is_err(), "{value}");
        }
    }

    #[test]
    fn a_scheme_is_a_letter_then_letters_digits_plus_minus_or_dot() {
        assert_eq!(url_scheme("agentrelay").as_deref(), Ok("agentrelay"));
        assert_eq!(url_scheme(" AgentRelay-Dev "), Ok("agentrelay-dev".into()));
        assert_eq!(url_scheme("x1+.-").as_deref(), Ok("x1+.-"));
        for value in [
            "",
            "1relay",
            "agent relay",
            "agent_relay",
            "agentrelay://",
            "-dev",
        ] {
            assert!(url_scheme(value).is_err(), "{value}");
        }
    }
}
