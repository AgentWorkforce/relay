use super::{LocalSessionRow, SpawnHandover};
use crate::linux_app::prefs::SessionOpenPreference;
use crate::relay::contract::agents::{LocalSession, SessionHolder};
use crate::relay::store::SessionKind;

#[derive(Debug, PartialEq)]
pub enum SessionOpenDestination {
    Desktop,
    Terminal,
    Unavailable,
}

/// Only local CLI identities are resumed. A session Agent Relay spawned is
/// never resumed beside the process that runs it: a spawned Codex thread
/// opens only in Codex, whose app server hosts it, a spawned Claude is taken
/// over instead (`SpawnHandover`) until it has been, and any other it runs
/// (Grok, OpenCode…) is not opened at all while it does.
#[derive(Debug, PartialEq)]
pub struct SessionOpening {
    pub deep_link: Option<String>,
    pub command: Option<String>,
    /// Opened only live in its app: never resumed in Terminal, whatever the
    /// preference.
    pub live_only: bool,
    /// What holds the session now, as the core reports it. Claude Code
    /// resumes a session in a process of its own, so it refuses to resume
    /// one a headless process holds; only the holder hands it over. The
    /// Claude Desktop handoff the Mac suppresses for a held session does
    /// not exist here (`--desktop` is macOS and x64 Windows only).
    pub holder: Option<SessionHolder>,
}

impl SessionOpening {
    pub fn destination(
        &self,
        preference: SessionOpenPreference,
        desktop_available: bool,
    ) -> SessionOpenDestination {
        if self.live_only {
            return match desktop_available {
                true => SessionOpenDestination::Desktop,
                false => SessionOpenDestination::Unavailable,
            };
        }
        if preference == SessionOpenPreference::Automatic
            && desktop_available
            && self.deep_link.is_some()
        {
            SessionOpenDestination::Desktop
        } else if self.command.is_some() {
            SessionOpenDestination::Terminal
        } else {
            SessionOpenDestination::Unavailable
        }
    }

    pub fn for_row(row: &LocalSessionRow) -> Option<Self> {
        Self::for_session(row, row.relay.as_ref(), row.relay.as_ref())
    }

    /// `for_row` with the row's session as last read (`relay`), and as the
    /// session list has it now (`listed`): `None` once the list no longer
    /// has it, which `relay` cannot say, since a row keeps the copy it was
    /// built with.
    pub fn for_session(
        row: &LocalSessionRow,
        relay: Option<&LocalSession>,
        listed: Option<&LocalSession>,
    ) -> Option<Self> {
        let handover = SpawnHandover::of(relay);
        if handover == Some(SpawnHandover::TakeOver) {
            return None;
        }
        if row
            .relay
            .as_ref()
            .is_some_and(|s| s.target.kind == SessionKind::ClaudeCloud)
        {
            return None;
        }
        let id = row
            .upload
            .as_ref()
            .map(|s| s.session_id.as_str())
            .or_else(|| row.relay.as_ref().map(|s| s.target.id.as_str()))?;
        let cwd = row
            .upload
            .as_ref()
            .and_then(|s| s.cwd.as_deref())
            .or_else(|| row.relay.as_ref().and_then(|s| s.directory.as_deref()))
            .unwrap_or_default();
        // What holds the session is read only from `listed`: a session the
        // list no longer has, or one that has ended, holds nothing.
        let holder = listed
            .filter(|session| session.running != Some(false))
            .and_then(|session| session.holder);
        let opening = Self::held(row.source(), id, cwd, holder)?;
        match handover {
            Some(SpawnHandover::OpenLive) => opening.live(),
            _ => Some(opening),
        }
    }

    /// Opened only live: its deep link, never a Terminal resume; without a
    /// deep link, not at all.
    fn live(self) -> Option<Self> {
        self.deep_link.is_some().then_some(Self {
            command: None,
            live_only: true,
            ..self
        })
    }

    pub fn new(source: &str, id: &str, cwd: &str) -> Option<Self> {
        if id.is_empty() || id.starts_with('-') || id.chars().any(char::is_control) {
            return None;
        }
        let cli = match source {
            "codex" => "codex resume",
            "claude" => "claude --resume",
            "grok" => "grok --resume",
            _ => return None,
        };
        let deep_link = (source == "codex").then(|| {
            let mut url = url::Url::parse("codex://threads/").unwrap();
            url.path_segments_mut().unwrap().push(id);
            url.to_string()
        });
        // An absolute folder: `/home/me/api` on every platform (the core
        // reports Unix sessions so), or `C:\api` on Windows.
        let absolute = cwd.starts_with('/') || std::path::Path::new(cwd).is_absolute();
        let command = (absolute && !cwd.contains('\0'))
            .then(|| format!("cd -- {} && {cli} {}", shell_quote(cwd), shell_quote(id)));
        (deep_link.is_some() || command.is_some()).then_some(Self {
            deep_link,
            command,
            live_only: false,
            holder: None,
        })
    }

    /// `new` for a session something may hold. A session a person is
    /// typing in resumes beside them; one a headless process holds is
    /// refused there too, so it is not offered at all.
    pub fn held(source: &str, id: &str, cwd: &str, holder: Option<SessionHolder>) -> Option<Self> {
        let opening = Self::new(source, id, cwd)?;
        let command = match holder {
            Some(SessionHolder::Background) => None,
            _ => opening.command,
        };
        (opening.deep_link.is_some() || command.is_some()).then_some(Self {
            deep_link: opening.deep_link,
            command,
            live_only: opening.live_only,
            holder,
        })
    }

    /// What to do instead, beside the open action of a held session. None
    /// for a session Agent Relay spawned, which is taken over instead, and
    /// none for a session a person is typing in: the Mac answers that one
    /// with Claude Code's `/desktop`, which is macOS and x64 Windows only.
    pub fn held_note(session: Option<&LocalSession>) -> Option<&'static str> {
        if SpawnHandover::of(session).is_some()
            || session.is_some_and(|session| session.running == Some(false))
        {
            return None;
        }
        match session.and_then(|session| session.holder) {
            Some(SessionHolder::Background) => Some(BACKGROUND_HOLDER_NOTE),
            _ => None,
        }
    }

    /// The button's title for `destination`.
    pub fn button_title(&self, destination: SessionOpenDestination) -> &'static str {
        match destination {
            _ if self.live_only => self.title(),
            SessionOpenDestination::Desktop => self.title(),
            SessionOpenDestination::Terminal => "Open in Terminal",
            SessionOpenDestination::Unavailable => "Set up session opening",
        }
    }

    pub fn title(&self) -> &'static str {
        if self.deep_link.is_some() {
            "Open in Codex"
        } else {
            "Open in Terminal"
        }
    }
}

/// Word for word the Mac's `SessionOpening.backgroundHolderNote`.
pub const BACKGROUND_HOLDER_NOTE: &str =
    "A headless Claude Code process is running this session. Run claude agents to find it, or stop it, to continue it here.";

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preference_and_missing_app_choose_terminal() {
        let action = SessionOpening::new("codex", "id", "/repo").unwrap();
        assert_eq!(
            action.destination(SessionOpenPreference::Automatic, true),
            SessionOpenDestination::Desktop
        );
        assert_eq!(
            action.destination(SessionOpenPreference::Automatic, false),
            SessionOpenDestination::Terminal
        );
        assert_eq!(
            action.destination(SessionOpenPreference::Terminal, true),
            SessionOpenDestination::Terminal
        );
        assert_eq!(
            SessionOpening::new("codex", "id", "")
                .unwrap()
                .destination(SessionOpenPreference::Automatic, false),
            SessionOpenDestination::Unavailable
        );
        // Claude's desktop handoff is unsupported on Linux even with an app installed.
        assert_eq!(
            SessionOpening::new("claude", "id", "/repo")
                .unwrap()
                .destination(SessionOpenPreference::Automatic, true),
            SessionOpenDestination::Terminal
        );
    }
    #[test]
    fn resumes_exact_session_in_its_directory() {
        for (source, cli) in [
            ("codex", "codex resume"),
            ("claude", "claude --resume"),
            ("grok", "grok --resume"),
        ] {
            let action = SessionOpening::new(source, "session-id", "/work/my repo").unwrap();
            assert_eq!(
                action.command.unwrap(),
                format!("cd -- '/work/my repo' && {cli} 'session-id'")
            );
        }
        assert_eq!(
            SessionOpening::new("codex", "thread/id", "")
                .unwrap()
                .deep_link
                .unwrap(),
            "codex://threads/thread%2Fid"
        );
    }
    // SessionOpeningTests.testHeldSessionIsNotOfferedTheDesktopHandoff:
    // Claude Code refuses to resume a session a headless process holds, so
    // it is not offered; one a person is typing in resumes beside them.
    #[test]
    fn a_session_a_headless_process_holds_is_not_offered() {
        let held = |holder| SessionOpening::held("claude", "session-id", "/repo", holder);
        assert!(held(Some(SessionHolder::Background)).is_none());
        for holder in [None, Some(SessionHolder::Interactive)] {
            assert_eq!(
                held(holder).unwrap().command.unwrap(),
                "cd -- '/repo' && claude --resume 'session-id'"
            );
        }
    }

    // The Mac answers an interactive holder with Claude Code's `/desktop`,
    // which does not exist here, so only the headless note is shown. A
    // session that has ended holds nothing, whatever it held before.
    #[test]
    fn only_a_headless_holder_has_a_note_here() {
        let session = |holder| LocalSession {
            target: crate::relay::store::Target::new(
                crate::relay::store::SessionKind::ClaudeTerminal,
                "session-id",
            ),
            title: "Session".into(),
            project: None,
            directory: Some("/repo".into()),
            live: true,
            running: Some(true),
            holder,
            updated_at_ms: None,
            host: None,
            registration: None,
            suggested_name: "repo".into(),
        };
        let background = session(Some(SessionHolder::Background));
        assert_eq!(
            SessionOpening::held_note(Some(&background)),
            Some(BACKGROUND_HOLDER_NOTE)
        );
        for quiet in [None, Some(SessionHolder::Interactive)] {
            assert_eq!(SessionOpening::held_note(Some(&session(quiet))), None);
        }
        let ended = LocalSession {
            running: Some(false),
            ..background.clone()
        };
        assert_eq!(SessionOpening::held_note(Some(&ended)), None);
        let row = LocalSessionRow {
            upload: None,
            relay: Some(ended.clone()),
        };
        // Nor is its Terminal resume withheld once it has ended.
        assert!(
            SessionOpening::for_session(&row, Some(&ended), Some(&ended))
                .is_some_and(|opening| opening.command.is_some())
        );
        // A session the list no longer has is not held either, however the
        // row's own copy of it still reads.
        assert!(SessionOpening::for_session(&row, Some(&background), None)
            .is_some_and(|opening| opening.command.is_some()));
    }

    #[test]
    fn missing_directory_unknown_source_and_option_ids_are_not_resumed() {
        assert!(SessionOpening::new("claude", "session", "").is_none());
        assert!(SessionOpening::new("grok", "session", "relative").is_none());
        assert!(SessionOpening::new("unknown", "session", "/repo").is_none());
        for id in ["", "--help", "id\ncommand", "id\0"] {
            assert!(SessionOpening::new("codex", id, "/repo").is_none());
        }
    }
    #[test]
    fn shell_metacharacters_stay_literal() {
        let action = SessionOpening::new("grok", "id'$(touch BAD)", "/repo's `name`").unwrap();
        assert_eq!(
            action.command.unwrap(),
            "cd -- '/repo'\"'\"'s `name`' && grok --resume 'id'\"'\"'$(touch BAD)'"
        );
    }

    // The quoting is POSIX shell syntax, which the Windows app hands to Git
    // Bash or Windows Terminal; only a Unix sh can check it here.
    #[cfg(unix)]
    #[test]
    fn shell_receives_unmodified_argument() {
        let value = "repo's $(printf EXPANDED) `printf EXPANDED`; echo unexpected";
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("printf %s {}", shell_quote(value))])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
    }
}
