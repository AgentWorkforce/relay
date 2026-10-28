//! Bounded, local-only execution metadata for the session table. Never returns
//! transcript text and never infers a reasoning setting from a model name.
use serde_json::Value;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const TAIL_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionMetadata {
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

pub fn read(source: &str, path: &Path) -> SessionMetadata {
    if !matches!(source, "codex" | "claude") {
        return SessionMetadata::default();
    }
    read_tail(source, path).unwrap_or_default()
}

fn read_tail(source: &str, path: &Path) -> std::io::Result<SessionMetadata> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok(SessionMetadata::default());
    }
    let start = metadata.len().saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes)?;
    // The first line may start mid-record. Never interpret that fragment.
    let bytes = if start > 0 {
        bytes
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| &bytes[i + 1..])
            .unwrap_or(&[])
    } else {
        &bytes
    };
    Ok(parse(source, bytes))
}

fn field(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 128 && !v.chars().any(char::is_control))
        .map(str::to_owned)
}

fn parse(source: &str, bytes: &[u8]) -> SessionMetadata {
    for line in bytes.rsplit(|b| *b == b'\n') {
        let Ok(record) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if source == "codex" && record["type"] == "turn_context" {
            let payload = &record["payload"];
            return SessionMetadata {
                model: field(&payload["model"]),
                reasoning_effort: field(&payload["effort"])
                    .or_else(|| field(&payload["reasoning_effort"])),
            };
        }
        if source == "claude" && record["type"] == "assistant" {
            if let Some(model) = field(&record["message"]["model"]).filter(|v| v != "<synthetic>") {
                return SessionMetadata {
                    model: Some(model),
                    reasoning_effort: None,
                };
            }
        }
    }
    SessionMetadata::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn latest_turn_context_wins_and_missing_effort_is_not_carried_forward() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            file,
            r#"{{"type":"turn_context","payload":{{"model":"gpt-5","effort":"high"}}}}"#
        )
        .unwrap();
        assert_eq!(
            read("codex", file.path()).reasoning_effort.as_deref(),
            Some("high")
        );
        writeln!(
            file,
            r#"{{"type":"turn_context","payload":{{"model":"gpt-6","effort":"low"}}}}"#
        )
        .unwrap();
        assert_eq!(
            read("codex", file.path()),
            SessionMetadata {
                model: Some("gpt-6".into()),
                reasoning_effort: Some("low".into())
            }
        );
        writeln!(
            file,
            r#"{{"type":"turn_context","payload":{{"model":"gpt-6"}}}}"#
        )
        .unwrap();
        assert_eq!(read("codex", file.path()).reasoning_effort, None);
        write!(file, "{{partial").unwrap();
        assert_eq!(read("codex", file.path()).model.as_deref(), Some("gpt-6"));
    }

    #[test]
    fn claude_reports_the_last_real_assistant_model_without_inventing_effort() {
        let metadata = parse(
            "claude",
            br#"{"type":"assistant","message":{"model":"claude-opus-4-6"}}
{"type":"assistant","message":{"model":"<synthetic>"}}
{"type":"user","message":{"model":"untrusted-prompt"}}"#,
        );
        assert_eq!(metadata.model.as_deref(), Some("claude-opus-4-6"));
        assert_eq!(metadata.reasoning_effort, None);
    }

    #[test]
    fn large_transcripts_are_bounded_and_unavailable_metadata_stays_unknown() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            file,
            r#"{{"type":"turn_context","payload":{{"model":"old","effort":"high"}}}}"#
        )
        .unwrap();
        file.write_all(&vec![b'x'; TAIL_BYTES as usize + 1])
            .unwrap();
        assert_eq!(read("codex", file.path()), SessionMetadata::default());
        writeln!(file, "\n{{\"type\":\"turn_context\",\"payload\":{{\"model\":\"current\",\"effort\":\"xhigh\"}}}}").unwrap();
        assert_eq!(
            read("codex", file.path()).reasoning_effort.as_deref(),
            Some("xhigh")
        );
        assert_eq!(read("grok", file.path()), SessionMetadata::default());
        assert_eq!(
            read("codex", Path::new("/missing/session.jsonl")),
            SessionMetadata::default()
        );
    }
}
