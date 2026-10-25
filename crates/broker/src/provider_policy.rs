use anyhow::Result;

fn provider_basename(value: &str) -> String {
    let trimmed = value.trim();
    let executable = match trimmed.as_bytes().first().copied() {
        Some(quote @ (b'"' | b'\'')) => trimmed[1..]
            .find(char::from(quote))
            .map(|end| &trimmed[1..end + 1])
            .unwrap_or(&trimmed[1..]),
        _ => trimmed.split_whitespace().next().unwrap_or_default(),
    };
    let basename = executable
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(executable)
        .trim_matches(['"', '\'']);
    let basename = basename.to_ascii_lowercase();
    basename
        .strip_suffix(".cmd")
        .or_else(|| basename.strip_suffix(".exe"))
        .unwrap_or(&basename)
        .to_string()
}

/// Canonical provider name for a provider removed from all spawn surfaces.
pub(crate) fn removed_provider(value: &str) -> Option<&'static str> {
    match provider_basename(value).as_str() {
        "gemini" => Some("gemini"),
        "cursor" | "cursor-agent" => Some("cursor"),
        "aider" => Some("aider"),
        "goose" => Some("goose"),
        "droid" => Some("droid"),
        _ => None,
    }
}

/// Stable compatibility error used by HTTP, Fleet, and direct broker spawns.
pub(crate) fn provider_removed_message(value: &str) -> Option<String> {
    match removed_provider(value)? {
        "cursor" => Some(
            "provider_removed: local Cursor CLI spawning has been removed; use 'cursor-cloud' for Cursor Cloud agents."
                .to_string(),
        ),
        provider => Some(format!(
            "provider_removed: provider '{provider}' has been removed; switch to a supported native provider (claude, codex, or opencode)."
        )),
    }
}

pub(crate) fn ensure_provider_active(value: &str) -> Result<()> {
    if let Some(message) = provider_removed_message(value) {
        anyhow::bail!(message);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removed_provider_aliases_have_stable_guidance() {
        assert_eq!(removed_provider("/usr/local/bin/gemini"), Some("gemini"));
        assert_eq!(
            removed_provider(r"C:\\Tools\\cursor-agent.exe"),
            Some("cursor")
        );
        assert_eq!(
            removed_provider(r#""C:\Program Files\Cursor\cursor-agent.exe" --resume"#),
            Some("cursor")
        );
        assert!(provider_removed_message("cursor-agent")
            .unwrap()
            .contains("use 'cursor-cloud'"));
        assert!(provider_removed_message("goose")
            .unwrap()
            .starts_with("provider_removed:"));
        assert_eq!(removed_provider("codex"), None);
    }
}
