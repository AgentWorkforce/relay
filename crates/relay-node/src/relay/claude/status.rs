//! Claude Code's registry `status`: `busy` during a turn, `idle` at the
//! prompt, and `shell` in place of `idle` while a background shell the
//! session started still runs.

use super::TerminalSession;

/// Whether `status` means the session waits at its prompt between turns.
pub fn is_idle_status(status: Option<&str>) -> bool {
    matches!(status, Some("idle" | "shell"))
}

impl TerminalSession {
    /// Whether the session waits at its prompt (`is_idle_status`).
    pub fn is_idle(&self) -> bool {
        is_idle_status(self.status.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::is_idle_status;

    // A session with a background shell running reports `shell` at its
    // prompt; it is as idle as one that reports `idle`.
    #[test]
    fn a_background_shell_leaves_the_session_idle() {
        assert!(is_idle_status(Some("idle")));
        assert!(is_idle_status(Some("shell")));
        assert!(!is_idle_status(Some("busy")));
        assert!(!is_idle_status(None));
    }
}
