//! Presentation only: acquisition and image copying into history belong to ai-hist.
use anyhow::Result;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::path::Path;

pub(super) fn user_text(value: &str) -> String {
    let mut text = value.trim();
    // App context is not a human message. Only strip complete leading
    // wrappers; an XML example inside prose or a code fence is still prose.
    while let Some(after) = text.strip_prefix("<external_") {
        let Some(end) = after.find('>') else {
            return String::new();
        };
        let name = &after[..end];
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            break;
        }
        let close = format!("</external_{name}>");
        let Some((_, rest)) = text.split_once(&close) else {
            return String::new();
        };
        text = rest.trim();
    }
    if text.starts_with("# Files mentioned by the user:") {
        for marker in ["\n## My request:\n", "\n## My request for Codex:\n"] {
            if let Some((_, request)) = text.split_once(marker) {
                text = request.trim();
                break;
            }
        }
    }
    let mut out = text.to_string();
    // The actual image is a separate captured block; do not display path XML.
    while let Some(start) = out.find("<image name=[Image #") {
        let Some(end) = out[start..].find("</image>") else {
            break;
        };
        out.replace_range(start..start + end + "</image>".len(), "");
    }
    out.trim().to_string()
}

pub(super) fn cache_image(text: &str, directory: &Path) -> Result<Option<String>> {
    let Some(url) = text
        .strip_prefix("![Attached image](data:image/")
        .and_then(|s| s.strip_suffix(')'))
    else {
        return Ok(None);
    };
    let Some((kind, data)) = url.split_once(";base64,") else {
        return Ok(None);
    };
    if !matches!(kind, "png" | "jpeg" | "gif" | "webp") || data.len() > 1_398_104 {
        return Ok(None);
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
        return Ok(None);
    };
    if bytes.len() > 1_048_576 {
        return Ok(None);
    }
    let directory = directory.join("images");
    super::private_directory(&directory)?;
    let path = directory.join(format!("{:x}.{kind}", Sha256::digest(&bytes)));
    if !path.exists() {
        std::fs::write(&path, bytes)?;
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hides_app_context_but_preserves_requests_and_xml_examples() {
        let xml =
            "<external_codex_apps_open_page>{\"page_id\":null}</external_codex_apps_open_page>";
        assert_eq!(user_text(xml), "");
        assert_eq!(user_text(&format!("{xml}\nFix tests")), "Fix tests");
        assert_eq!(
            user_text("Explain <external_foo> tags"),
            "Explain <external_foo> tags"
        );
        assert_eq!(
            user_text("```xml\n<external_foo>x</external_foo>\n```"),
            "```xml\n<external_foo>x</external_foo>\n```"
        );
        assert_eq!(user_text("# Files mentioned by the user:\n## shot.png: /tmp/shot.png\n\n## My request:\nMatch this\n<image name=[Image #1] path=\"/tmp/shot.png\"></image>"), "Match this");
    }
}
