//! Grok writes startup failures to its unified log, even when the private
//! leader stdout/stderr file is empty. Attribute an error to this launch
//! by both pid and time; never return another session's log or a raw record.

use super::*;

pub(super) fn startup_error(home: &Path, pid: i32, since_ms: i64) -> Option<String> {
    let tail = read_tail(&home.join("logs/unified.jsonl"), EVENTS_TAIL)?;
    String::from_utf8_lossy(&tail)
        .lines()
        .rev()
        .find_map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).ok()?;
            if value["pid"].as_i64() != Some(i64::from(pid))
                || !matches!(value["lvl"].as_str(), Some("warn" | "error" | "fatal"))
            {
                return None;
            }
            let time = chrono::DateTime::parse_from_rfc3339(value["ts"].as_str()?).ok()?;
            (time.timestamp_millis() >= since_ms)
                .then(|| value["msg"].as_str().map(super::super::diagnostics::redact))?
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_launch_can_supply_a_reason() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("logs")).unwrap();
        let records = [
            serde_json::json!({"ts":"2026-10-18T05:27:53Z","pid":42,"lvl":"warn",
                "msg":"No credentials found: no login token and no model api_key/env_key"}),
            serde_json::json!({"ts":"2026-10-18T05:28:53Z","pid":99,"lvl":"error","msg":"other session"}),
        ];
        std::fs::write(
            dir.path().join("logs/unified.jsonl"),
            records
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let since = chrono::DateTime::parse_from_rfc3339("2026-10-18T05:27:52Z")
            .unwrap()
            .timestamp_millis();
        assert!(startup_error(dir.path(), 42, since)
            .unwrap()
            .starts_with("No credentials found"));
        assert!(startup_error(dir.path(), 42, since + 2000).is_none());
        assert!(startup_error(dir.path(), 41, since).is_none());
    }
}
