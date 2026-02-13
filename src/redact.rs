use std::sync::LazyLock;

use regex::Regex;

static PATTERNS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    [
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
}
