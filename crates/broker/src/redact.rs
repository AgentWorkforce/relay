use std::sync::LazyLock;

use regex::Regex;

static PATTERNS: LazyLock<[Regex; 4]> = LazyLock::new(|| {
    [
        // Bare Relaycast credentials, wherever they appear: workspace keys,
        // run tokens, agent tokens, and node tokens.
        Regex::new(r#"((?:rk|rt|at|nt)_(?:live|test)_)[A-Za-z0-9._-]+"#).expect("valid regex"),
        Regex::new(r#"(?i)(api[_-]?key\s*[:=]\s*)([^\s"']+)"#).expect("valid regex"),
        Regex::new(r#"(?i)(token\s*[:=]\s*)([^\s"']+)"#).expect("valid regex"),
        Regex::new(r#"(?i)(authorization:\s*bearer\s+)([^\s]+)"#).expect("valid regex"),
    ]
});

pub fn redact(input: &str) -> String {
    let mut output = input.to_string();
    for pattern in PATTERNS.iter() {
        output = pattern
            .replace_all(&output, |caps: &regex::Captures| {
                format!("{}[REDACTED]", &caps[1])
            })
            .into_owned();
    }
    output
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redacts_sensitive_fields() {
        let line = "api_key: secret token=abc authorization: bearer xyz";
        let redacted = redact(line);
        assert!(!redacted.contains("secret"));
        assert!(!redacted.contains("abc"));
        assert!(!redacted.contains("xyz"));
    }

    #[test]
    fn redacts_bare_relaycast_credentials_including_run_tokens() {
        let line = "using rt_live_abc123 and rk_live_def456 then at_live_x.y nt_live_z";
        let redacted = redact(line);
        for secret in ["abc123", "def456", "x.y", "nt_live_z"] {
            assert!(!redacted.contains(secret), "{redacted}");
        }
        assert!(redacted.contains("rt_live_[REDACTED]"), "{redacted}");
    }
}
