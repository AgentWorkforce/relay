//! Bounded, credential-redacted harness diagnostics. Never forward whole
//! logs, response bodies, headers or configuration as a spawn failure.

/// Diagnose a detached CLI without forwarding its task, environment or whole log.
/// Its supervisor records the actual exit status; absence is explicitly unknown.
pub(crate) fn launch_failure(
    reason: &str,
    executable: &std::path::Path,
    arguments: &[String],
    log: &std::path::Path,
) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let status = exit_status(&log.with_extension("exit"));
    let tail = (|| -> std::io::Result<String> {
        let mut file = std::fs::File::open(log)?;
        let size = file.metadata()?.len();
        file.seek(SeekFrom::Start(size.saturating_sub(4096)))?;
        let mut bytes = Vec::new();
        file.take(4096).read_to_end(&mut bytes)?;
        // Skip a cut first line rather than leak the suffix of a credential.
        let bytes = if size > 4096 {
            bytes.splitn(2, |byte| *byte == b'\n').nth(1).unwrap_or(&[])
        } else {
            &bytes
        };
        // Redact the whole window, then keep its end: the cap in `redact`
        // would keep the start and drop the final error.
        Ok(redact_uncapped(&String::from_utf8_lossy(bytes)))
    })()
    .unwrap_or_else(|_| "unavailable".into());
    let mut hide_value = false;
    let argv = std::iter::once(executable.to_string_lossy().into_owned())
        .chain(arguments.iter().cloned())
        .map(|argument| {
            let cleaned = if hide_value {
                "[redacted]".into()
            } else {
                redact(&argument)
            };
            hide_value = argument.starts_with('-')
                && !argument.contains('=')
                && sensitive(&argument.to_ascii_lowercase());
            cleaned
        })
        .collect::<Vec<_>>();
    // Each part has its own budget, so the whole stays under `redact`'s cap
    // and a second `redact` (receipts, hosted status) keeps every part.
    let tail = if tail.is_empty() {
        "empty".to_owned()
    } else {
        last_chars(&tail, TAIL_BUDGET)
    };
    let diagnostic = format!(
        "{}; argv={}; exit_status={}; stderr_tail={}",
        first_chars(&redact(reason), REASON_BUDGET),
        first_chars(
            &redact(&serde_json::to_string(&argv).unwrap_or_default()),
            ARGV_BUDGET
        ),
        status.trim(),
        tail
    );
    crate::relay::diagnostics::write(format_args!(
        "Agent Relay harness launch failed: {diagnostic}"
    ));
    diagnostic
}

const REASON_BUDGET: usize = 320;
const ARGV_BUDGET: usize = 280;
const TAIL_BUDGET: usize = 320;
/// How long a diagnosis waits for the detached supervisor to record the
/// exit status: callers see the child gone before the supervisor's `wait`
/// returns and writes the file.
const EXIT_WAIT: std::time::Duration = std::time::Duration::from_millis(500);

fn exit_status(path: &std::path::Path) -> String {
    let deadline = std::time::Instant::now() + EXIT_WAIT;
    loop {
        // A code, or `signal` for a child killed by one (Devin's host).
        let status = std::fs::read_to_string(path).ok().filter(|value| {
            let value = value.trim();
            value == "signal" || value.parse::<u32>().is_ok()
        });
        if let Some(status) = status {
            return status;
        }
        if std::time::Instant::now() >= deadline {
            return "not observed".into();
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

fn first_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn last_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(max)).collect()
}

pub(crate) fn redact(message: &str) -> String {
    redact_uncapped(message).chars().take(1024).collect()
}

fn redact_uncapped(message: &str) -> String {
    let secrets = std::env::vars().filter_map(|(key, value)| {
        let key = key.to_ascii_lowercase();
        (sensitive(&key) && value.len() >= 4).then_some(value)
    });
    redact_with(message, secrets)
}

fn sensitive(key: &str) -> bool {
    key.trim_matches(['"', '\'']).trim_start_matches('-') == "key"
        || [
            "token",
            "secret",
            "password",
            "api_key",
            "api-key",
            "credential",
            "cookie",
            "passwd",
            "apikey",
            "authorization",
        ]
        .iter()
        .any(|part| key.contains(part))
}

fn redact_with(message: &str, secrets: impl Iterator<Item = String>) -> String {
    let mut message = message.to_owned();
    for secret in secrets {
        message = message.replace(&secret, "[redacted]");
    }
    let mut hide_next = false;
    let mut quoted_secret = None;
    let mut words = Vec::new();
    let parts: Vec<_> = message.split_whitespace().collect();
    for (index, word) in parts.iter().copied().enumerate() {
        let lower = word.to_ascii_lowercase();
        let credential = ["rk_", "at_", "ar_", "sk_", "sk-", "xai-", "eyj"]
            .iter()
            .any(|prefix| lower.contains(prefix));
        let assignment = word.split_once('=').or_else(|| word.split_once(':'));
        let secret_field = assignment.is_some_and(|(key, _)| sensitive(&key.to_ascii_lowercase()));
        let hide = hide_next
            || quoted_secret.is_some()
            || credential
            || secret_field
            || lower.contains("://");
        if hide {
            let value = assignment
                .filter(|_| secret_field)
                .map_or(word, |(_, value)| value);
            quoted_secret = next_quote(value, quoted_secret);
        }
        words.push(if hide {
            "[redacted]".to_owned()
        } else {
            word.chars().filter(|c| !c.is_control()).collect()
        });
        let separator = matches!(word, "=" | ":");
        let separated_key = sensitive(lower.trim_matches(['"', '\'']))
            && parts
                .get(index + 1)
                .is_some_and(|next| matches!(*next, "=" | ":"));
        let scheme = lower.trim_matches(|c: char| !c.is_ascii_alphanumeric());
        hide_next = quoted_secret.is_some()
            || (hide_next && separator)
            || separated_key
            || scheme == "bearer"
            || scheme == "basic"
            || (word.starts_with("--") && sensitive(&lower))
            || (secret_field
                && assignment.is_some_and(|(_, value)| value.trim_matches(['"', '\'']).is_empty()));
    }
    words.join(" ")
}

fn next_quote(value: &str, current: Option<char>) -> Option<char> {
    if let Some(quote) = current {
        return (!closes_quote(value, quote)).then_some(quote);
    }
    let value = value.trim_start_matches('\\');
    let quote = value.chars().next()?;
    (matches!(quote, '"' | '\'') && !closes_quote(&value[1..], quote)).then_some(quote)
}

fn closes_quote(value: &str, quote: char) -> bool {
    let mut escaped = false;
    for c in value.chars() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == quote {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn armadillo_credentials_never_reach_a_diagnostic() {
        let message = redact_with(
            "spawn failed for ar_ws_secret and ar_ag_secret",
            [].into_iter(),
        );
        assert!(!message.contains("ar_ws_secret"), "{message}");
        assert!(!message.contains("ar_ag_secret"), "{message}");
    }

    #[test]
    fn a_long_diagnostic_keeps_every_part_through_a_second_redact() {
        let home = tempfile::tempdir().unwrap();
        let log = home.path().join("launch.log");
        std::fs::write(&log, format!("{}\nthe last line\n", "noise ".repeat(2000))).unwrap();
        std::fs::write(log.with_extension("exit"), "3\n").unwrap();
        let arguments: Vec<String> = (0..200).map(|n| format!("--flag-{n}")).collect();
        let diagnostic = launch_failure(
            &"reason ".repeat(300),
            std::path::Path::new("/bin/grok"),
            &arguments,
            &log,
        );
        // What receipts and hosted status keep.
        let kept = redact(&diagnostic);
        assert_eq!(kept, diagnostic);
        assert!(kept.contains("; argv=[\"/bin/grok\""));
        assert!(kept.contains("; exit_status=3;"));
        assert!(kept.contains("; stderr_tail="));
        assert!(kept.ends_with("the last line"));
    }

    #[test]
    fn the_tail_keeps_the_final_error_after_many_short_lines() {
        let home = tempfile::tempdir().unwrap();
        let log = home.path().join("launch.log");
        let noise: String = (0..400).map(|n| format!("line {n}\n")).collect();
        std::fs::write(&log, format!("{noise}fatal: credentials rejected\n")).unwrap();
        let diagnostic = launch_failure("failed", std::path::Path::new("grok"), &[], &log);
        assert!(
            diagnostic.ends_with("fatal: credentials rejected"),
            "{diagnostic}"
        );
    }

    #[test]
    fn a_recorded_signal_death_is_reported() {
        let home = tempfile::tempdir().unwrap();
        let log = home.path().join("launch.log");
        std::fs::write(&log, "").unwrap();
        std::fs::write(log.with_extension("exit"), "signal").unwrap();
        let started = std::time::Instant::now();
        let diagnostic = launch_failure("failed", std::path::Path::new("devin"), &[], &log);
        assert!(diagnostic.contains("exit_status=signal"), "{diagnostic}");
        assert!(
            started.elapsed() < EXIT_WAIT,
            "a recorded status is read at once"
        );
    }

    #[test]
    fn the_exit_status_written_just_after_the_child_ends_is_reported() {
        let home = tempfile::tempdir().unwrap();
        let log = home.path().join("launch.log");
        std::fs::write(&log, "exited\n").unwrap();
        let exit = log.with_extension("exit");
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            std::fs::write(exit, "7\n").unwrap();
        });
        let diagnostic = launch_failure("failed", std::path::Path::new("grok"), &[], &log);
        writer.join().unwrap();
        assert!(diagnostic.contains("exit_status=7"), "{diagnostic}");
    }

    #[test]
    fn launch_evidence_has_argv_exit_status_and_a_redacted_bounded_tail() {
        let home = tempfile::tempdir().unwrap();
        let log = home.path().join("launch.log");
        std::fs::write(&log, "credentials rejected api_key=private-value\n").unwrap();
        std::fs::write(log.with_extension("exit"), "42\n").unwrap();
        let diagnostic = launch_failure(
            "Grok failed",
            std::path::Path::new("/bin/grok"),
            &["agent".into(), "leader".into()],
            &log,
        );
        assert!(diagnostic.contains("argv=["));
        assert!(diagnostic.contains("exit_status=42"));
        assert!(diagnostic.contains("stderr_tail=credentials rejected [redacted]"));
        assert!(!diagnostic.contains("private-value"));
        let diagnostic = launch_failure(
            "failed",
            std::path::Path::new("grok"),
            &[
                "--password".into(),
                "opaque multi word credential".into(),
                "--key".into(),
                "unknown-value".into(),
            ],
            &log,
        );
        assert!(!diagnostic.contains("opaque"));
        assert!(!diagnostic.contains("multi word"));
        assert!(!diagnostic.contains("unknown-value"));
        std::fs::write(&log, format!("api_key={}\nuseful tail", "x".repeat(5000))).unwrap();
        let diagnostic = launch_failure("failed", std::path::Path::new("grok"), &[], &log);
        assert!(!diagnostic.contains("xxxxxxxx"));
        assert!(diagnostic.contains("useful tail"));
    }

    #[test]
    fn preserves_the_reason_and_redacts_credentials_before_bounding() {
        let text = "This API key has expired. Bearer opaque-value api_key=another-value \
                    https://host/?token=opaque sk-test-value xai-private eyJjwt custom-value api_key = separated-secret";
        let clean = redact_with(text, ["custom-value".to_owned()].into_iter());
        assert!(clean.starts_with("This API key has expired."));
        for secret in [
            "opaque",
            "another-value",
            "sk-test",
            "xai-private",
            "eyJjwt",
            "custom-value",
            "separated-secret",
        ] {
            assert!(!clean.contains(secret), "{clean}");
        }
        assert_eq!(redact(&"a".repeat(2048)).len(), 1024);
    }

    #[test]
    fn quoted_authorization_and_password_values_are_redacted_completely() {
        for message in [
            r#"Startup failed. Authorization: "Bearer opaque-credential" retry later"#,
            "Startup failed. Authorization: 'Basic opaque-credential' retry later",
            r#"Startup failed. "Authorization": "Bearer opaque-credential" retry later"#,
            "Startup failed. password = 'opaque-credential second-part' retry later",
            "Startup failed. api_key='opaque-credential second-part' retry later",
            r#"Startup failed. api_key="opaque-credential\" second-part" retry later"#,
        ] {
            let clean = redact_with(message, std::iter::empty());
            assert!(!clean.contains("opaque-credential"), "{clean}");
            assert!(!clean.contains("second-part"), "{clean}");
            assert!(clean.ends_with("retry later"), "{clean}");
            assert_eq!(redact_with(&clean, std::iter::empty()), clean);
        }
    }
}
