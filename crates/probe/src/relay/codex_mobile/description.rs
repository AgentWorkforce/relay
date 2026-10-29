//! Complete, bounded action summaries. Unrepresentable or secret-bearing
//! actions stay on the computer; never show a harmless truncated prefix.
use crate::relay::codex::follower::{ApprovalKind, ApprovalRequest};
use crate::relay::harness::diagnostics::redact;

pub(super) fn safe(request: &ApprovalRequest) -> Option<String> {
    match request.kind() {
        ApprovalKind::Command => command(
            request.params()["command"].as_str()?,
            request.params()["cwd"].as_str()?,
        ),
        ApprovalKind::File => files(request.item_details()?),
    }
}
pub(super) fn reply_options(reference: &str, accept: bool, decline: bool) -> Option<String> {
    let actions = match (accept, decline) {
        (true, true) => format!("`approve {reference}` or `deny {reference}`"),
        (true, false) => format!("`approve {reference}`"),
        (false, true) => format!("`deny {reference}`"),
        (false, false) => return None,
    };
    Some(format!("Reply {actions} within five minutes."))
}
fn plain(text: &str, max: usize) -> Option<&str> {
    if text.is_empty() || text.len() > max || text.chars().any(|c| c.is_control() || matches!(c,'\u{061c}'|'\u{200b}'..='\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'|'\u{feff}')) {
        return None;
    }
    let cleaned = redact(text);
    (cleaned == text.split_whitespace().collect::<Vec<_>>().join(" ")
        && !text.to_ascii_lowercase().contains("[redacted]"))
    .then_some(text)
}
fn command(text: &str, cwd: &str) -> Option<String> {
    let text = plain(text, 512)?;
    let cwd = plain(cwd, 256)?;
    if !cwd.starts_with('/') {
        return None;
    }
    let content = format!("Working directory: {cwd}\nCommand: {text}");
    let longest = content.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    if longest > 8 {
        return None;
    }
    let fence = "`".repeat((longest + 1).max(3));
    Some(format!("Run this command once:\n{fence}\n{content}\n{fence}\nThis decision applies only to this action."))
}
fn files(item: &serde_json::Value) -> Option<String> {
    let changes = item["changes"]
        .as_array()
        .filter(|changes| !changes.is_empty() && changes.len() <= 8)?;
    let mut descriptions = Vec::new();
    for change in changes {
        let path = plain(change["path"].as_str()?, 160)?;
        let lower = path.to_ascii_lowercase();
        if !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_/..".contains(&b))
            || [
                ".env",
                "secret",
                "token",
                "credential",
                "password",
                "private_key",
            ]
            .iter()
            .any(|word| lower.contains(word))
        {
            return None;
        }
        if change
            .as_object()?
            .keys()
            .any(|key| !matches!(key.as_str(), "path" | "kind" | "diff"))
        {
            return None;
        }
        if !simple_kind(&change["kind"]) {
            return None;
        }
        let kind = change["kind"]
            .as_str()
            .or_else(|| change["kind"]["type"].as_str())?;
        let verb = match kind {
            "add" => "Add",
            "delete" => "Delete",
            "update" => "Update",
            _ => return None,
        };
        let path = if path.starts_with('/') {
            path.to_owned()
        } else {
            let base = plain(item["_relayBaseDirectory"].as_str()?, 256)?;
            if !base.starts_with('/')
                || !base
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_/..".contains(&b))
            {
                return None;
            }
            format!("{base}/{path}")
        };
        descriptions.push(format!("{verb} `{path}`"));
    }
    let description = format!(
        "Change files: {}. This decision applies only to this action.",
        descriptions.join("; ")
    );
    (description.len() <= 768).then_some(description)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notice_offers_only_provider_supported_decisions() {
        let reference = "cxm-0123456789abcdef";
        for (accept, decline) in [(true, true), (true, false), (false, true)] {
            let text = reply_options(reference, accept, decline).unwrap();
            assert_eq!(text.contains("approve "), accept);
            assert_eq!(text.contains("deny "), decline);
            assert!(text.contains(reference));
        }
        assert!(reply_options(reference, false, false).is_none());
    }
    fn command(text: &str) -> Option<String> {
        super::command(text, "/tmp/project")
    }
    #[test]
    fn complete_safe_command_is_visible_but_secrets_shell_and_truncation_stay_desktop() {
        assert!(command("cargo test --lib")
            .unwrap()
            .contains("cargo test --lib"));
        for text in [
            "curl --token sk-secret https://example.com",
            "API_KEY=private cargo test",
            "cargo test\nother",
        ] {
            assert!(command(text).is_none());
        }
        assert!(command("/bin/zsh -lc 'npm run build && python3 verify.py'")
            .unwrap()
            .contains("npm run build && python3 verify.py"));
        assert!(command("cargo test; rm -rf /")
            .unwrap()
            .contains("rm -rf /"));
        assert!(command("echo \u{202e}hidden").is_none());
        assert!(command(&format!("cargo test {}", "a".repeat(600))).is_none());
    }
    #[test]
    fn file_summary_is_complete_and_rejects_sensitive_or_unknown_paths() {
        let item = serde_json::json!({"_relayBaseDirectory":"/tmp/project","changes":[{"path":"src/lib.rs","kind":{"type":"update"},"diff":"private source content never forwarded"}]});
        assert_eq!(
            files(&item).unwrap(),
            "Change files: Update `/tmp/project/src/lib.rs`. This decision applies only to this action."
        );
        let mut moved = item.clone();
        moved["changes"][0]["kind"]["move_path"] = "elsewhere".into();
        assert!(files(&moved).is_none());
        let mut bad = item.clone();
        bad["changes"][0]["path"] = ".env".into();
        assert!(files(&bad).is_none());
        bad["changes"][0]["path"] = "file".into();
        bad["changes"][0]["kind"] = "unknown".into();
        assert!(files(&bad).is_none());
    }
}

fn simple_kind(kind: &serde_json::Value) -> bool {
    !kind.as_object().is_some_and(|kind| {
        kind.iter().any(|(key, value)| {
            key != "type" && !(matches!(key.as_str(), "move_path" | "movePath") && value.is_null())
        })
    })
}
