/// Continuity actions that an agent can request via PTY output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ContinuityAction {
    Save,
    Load,
    Uncertain,
}

impl ContinuityAction {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            ContinuityAction::Save => "save",
            ContinuityAction::Load => "load",
            ContinuityAction::Uncertain => "uncertain",
        }
    }
}

/// Parse a `KIND: continuity` command block from accumulated PTY output.
///
/// The format is:
/// ```text
/// KIND: continuity
/// ACTION: save|load|uncertain
///
/// Optional body content here
/// ```
///
/// Returns `Some((action, content, bytes_consumed))` when a complete block is found,
/// where `bytes_consumed` is the number of bytes to trim from the start of `buf`.
///
/// The block must have:
/// - A line containing `KIND:` with value `continuity` (case-insensitive)
/// - A line containing `ACTION:` with a valid action (case-insensitive)
/// - Optionally followed by a blank line and body content
///
/// The function looks for the pattern anywhere in the buffer and returns the
/// offset past the detected block so the caller can advance their buffer.
pub(crate) fn parse_continuity_command(buf: &str) -> Option<(ContinuityAction, String, usize)> {
    let kind_prefix = "kind:";
    let action_prefix = "action:";

    let lines: Vec<&str> = buf.lines().collect();

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim().to_lowercase();
        if !trimmed.starts_with(kind_prefix) {
            continue;
        }
        let kind_value = trimmed[kind_prefix.len()..].trim();
        if kind_value != "continuity" {
            continue;
        }

        let mut action: Option<ContinuityAction> = None;
        let mut action_line: Option<usize> = None;
        let mut body_start_line: Option<usize> = None;

        for (j, line_at_j) in lines.iter().enumerate().skip(i + 1) {
            let next = line_at_j.trim();
            if next.is_empty() {
                if action.is_some() && body_start_line.is_none() {
                    body_start_line = Some(j + 1);
                }
                continue;
            }
            let lower = next.to_lowercase();
            if let Some(action_value) = lower.strip_prefix(action_prefix).map(str::trim) {
                action = match action_value {
                    "save" => Some(ContinuityAction::Save),
                    "load" => Some(ContinuityAction::Load),
                    "uncertain" => Some(ContinuityAction::Uncertain),
                    _ => None,
                };
                action_line = Some(j);
                continue;
            }
            if action.is_some() {
                if body_start_line.is_none() {
                    body_start_line = Some(j);
                }
                break;
            }
        }

        let action = action?;

        let content = if let Some(start) = body_start_line {
            lines[start..]
                .iter()
                .take_while(|l| !l.trim().to_lowercase().starts_with(kind_prefix))
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string()
        } else {
            String::new()
        };

        let end_line = body_start_line
            .map(|s| {
                s + lines[s..]
                    .iter()
                    .take_while(|l| !l.trim().to_lowercase().starts_with(kind_prefix))
                    .count()
            })
            .unwrap_or_else(|| action_line.map_or(i + 2, |line| line + 1));

        let bytes_consumed = lines[..end_line.min(lines.len())]
            .iter()
            .map(|l| l.len() + 1)
            .sum::<usize>()
            .min(buf.len());

        return Some((action, content, bytes_consumed));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_continuity_command_consumes_through_delayed_action_line() {
        let input = "noise\nKIND: continuity\n\nACTION: save\nKIND: other\n";
        let (action, content, consumed) = parse_continuity_command(input).unwrap();

        assert_eq!(action, ContinuityAction::Save);
        assert_eq!(content, "");
        assert_eq!(consumed, "noise\nKIND: continuity\n\nACTION: save\n".len());
    }
}
