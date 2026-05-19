use crate::util::ansi::strip_ansi;

#[derive(Debug, Clone)]
pub(crate) struct ActivityDetector {
    patterns: Vec<&'static str>,
}

impl ActivityDetector {
    pub(crate) fn for_cli(cli: &str) -> Self {
        let lower = cli.to_lowercase();
        let patterns = if lower.contains("claude") {
            vec!["⠋", "⠙", "⠹", "Tool:", "Read(", "Write(", "Edit("]
        } else if lower.contains("codex") {
            vec!["Thinking...", "Running:", "$ ", "function_call"]
        } else if lower.contains("gemini") {
            vec!["Generating", "Action:", "Executing"]
        } else {
            Vec::new()
        };

        Self { patterns }
    }

    pub(crate) fn detect_activity(&self, output: &str, expected_echo: &str) -> Option<String> {
        let clean_output = strip_ansi(output);
        let relevant_output = if expected_echo.is_empty() {
            clean_output
        } else {
            clean_output.replace(expected_echo, "")
        };

        if self.patterns.is_empty() {
            if relevant_output.trim().is_empty() {
                None
            } else {
                Some("any_output".to_string())
            }
        } else {
            self.patterns
                .iter()
                .find(|pattern| relevant_output.contains(**pattern))
                .map(|pattern| (*pattern).to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_activity_for_claude_patterns() {
        let detector = ActivityDetector::for_cli("claude");
        let output = "⠋ processing request\nRelay message from Alice [evt_1]: hello";
        assert_eq!(
            detector.detect_activity(output, "Relay message from Alice [evt_1]: hello"),
            Some("⠋".to_string())
        );
        assert_eq!(
            detector.detect_activity(
                "Tool: Write(file)",
                "Relay message from Alice [evt_1]: hello"
            ),
            Some("Tool:".to_string())
        );
    }

    #[test]
    fn detect_activity_removes_expected_echo_from_output() {
        let detector = ActivityDetector::for_cli("claude");
        let expected_echo = "Relay message from Alice [evt_1]: hello";
        let output = format!("{}\nTool: Write(file)", expected_echo);
        assert_eq!(
            detector.detect_activity(&output, expected_echo),
            Some("Tool:".to_string())
        );
    }

    #[test]
    fn detect_activity_for_codex_patterns() {
        let detector = ActivityDetector::for_cli("codex");
        assert_eq!(
            detector.detect_activity(
                "Thinking... running tool",
                "Relay message from Alice [evt_1]: hello"
            ),
            Some("Thinking...".to_string())
        );
    }

    #[test]
    fn detect_activity_for_gemini_patterns() {
        let detector = ActivityDetector::for_cli("gemini");
        assert_eq!(
            detector.detect_activity(
                "Action: execute task",
                "Relay message from Alice [evt_1]: hello"
            ),
            Some("Action:".to_string())
        );
    }

    #[test]
    fn detect_activity_uses_default_when_any_output_present_for_unknown_cli() {
        let detector = ActivityDetector::for_cli("mystery-cli");
        assert_eq!(
            detector.detect_activity(
                "Output after echo",
                "Relay message from Alice [evt_1]: hello"
            ),
            Some("any_output".to_string())
        );
    }

    #[test]
    fn detect_activity_defaults_to_any_output() {
        let detector = ActivityDetector::for_cli("mystery-cli");
        assert_eq!(
            detector.detect_activity(
                "Agent output line",
                "Relay message from Alice [evt_1]: hello"
            ),
            Some("any_output".to_string())
        );
        assert_eq!(
            detector.detect_activity(
                "Relay message from Alice [evt_1]: hello",
                "Relay message from Alice [evt_1]: hello"
            ),
            None
        );
    }

    #[test]
    fn detect_activity_strips_ansi_before_matching_patterns() {
        let detector = ActivityDetector::for_cli("claude");
        let expected_echo = "Relay message from Alice [evt_1]: hello";
        let output = format!("{}\n\x1b[32m⠙\x1b[0m writing output\n", expected_echo);
        assert_eq!(
            detector.detect_activity(&output, expected_echo),
            Some("⠙".to_string())
        );
    }

    #[test]
    fn detect_activity_does_not_match_pattern_in_echo() {
        let detector = ActivityDetector::for_cli("claude");
        let expected_echo = "Relay message from Alice [evt_1]: Tool: Write(file)";
        let output = expected_echo.to_string();
        assert_eq!(detector.detect_activity(&output, expected_echo), None);
    }

    #[test]
    fn detect_activity_removes_duplicate_echoes_before_matching_patterns() {
        let detector = ActivityDetector::for_cli("claude");
        let expected_echo = "Relay message from Alice [evt_1]: Tool: Write(file)";
        let output = format!("{expected_echo}\n{expected_echo}");
        assert_eq!(detector.detect_activity(&output, expected_echo), None);
    }
}
