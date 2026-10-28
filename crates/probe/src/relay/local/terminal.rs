//! Delivery into a terminal Codex or Claude Code session, which gets a
//! pointer (`message_pointer`) in place of a relayed message while relay
//! messages are hidden (`show_relay_messages` off, the default): a terminal
//! only accepts visible text, so the pointer is as hidden as it gets.

use super::LocalInjector;
use crate::relay::claude;
use crate::relay::claude_settings::ClaudeSettings;
use crate::relay::codex::compact;
use crate::relay::inject::{InjectOutcome, Injector};
use crate::relay::message_pointer::{self, DeliveredTexts};
use crate::relay::store::{SessionKind, Target};

impl LocalInjector {
    /// A terminal Codex is handed the pointer only if the message goes into
    /// its queue; the app-server and app windows get the whole message. A
    /// message Claude Code holds for approval keeps its text, so the person
    /// sees what they approve.
    pub(super) fn inject_terminal(
        &self,
        target: &Target,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        let claude = target.kind == SessionKind::ClaudeTerminal;
        let pointer = || {
            let enabled = compact::enabled()
                && (!claude || ClaudeSettings::new(&self.config.claude).delivers_directly());
            let reachable = enabled
                && message_pointer::reachable(target.kind, self.serving.get().is_some(), || {
                    self.relay_socket(target).is_some()
                });
            message_pointer::prepare(
                &DeliveredTexts::here()?,
                &target.key(),
                message_id,
                text,
                target.kind,
                reachable.then(message_pointer::configured_reader).flatten(),
                crate::relay::state::now_ms(),
            )
        };
        if !claude {
            return self
                .codex
                .inject_with(&target.id, message_id, text, &pointer);
        }
        let text = pointer().unwrap_or_else(|| text.to_string());
        claude::send_to_terminal(
            &self.config.claude,
            &*self.table,
            &target.id,
            message_id,
            &text,
        )
    }
}

impl LocalInjector {
    /// The note asking a Claude Code session Conductor hosts to quote the
    /// message it answers. Codex turns a relay starts are not shown by
    /// Conductor at all, so only Claude Code, whose reply is shown, is asked.
    pub(super) fn claude_host_note(&self, target: &Target) -> Option<String> {
        if target.kind != SessionKind::ClaudeTerminal {
            return None;
        }
        let session = claude::terminal_session(&self.config.claude, &*self.table, &target.id)?;
        crate::relay::conductor::host(session.cwd.as_deref())?;
        Some(crate::relay::conductor::QUOTE_NOTE.to_string())
    }

    /// Why Claude Code holds a message just written to a terminal session's
    /// inbox for the person's approval (`claude::predicted_hold`).
    pub(super) fn claude_held(&self, target: &Target) -> Option<String> {
        if target.kind != SessionKind::ClaudeTerminal {
            return None;
        }
        claude::predicted_hold(&self.config.claude, &*self.table, &target.id)
            .map(|hold| hold.detail().to_string())
    }

    /// The end of a terminal Claude Code session's transcript, for the inbox
    /// check (`claude::inbox`).
    pub(super) fn claude_inbox_tail(&self, target: &Target, max: u64) -> Option<(Vec<u8>, bool)> {
        if target.kind != SessionKind::ClaudeTerminal {
            return None;
        }
        let (path, _) = claude::transcript::path(&self.config.claude, &*self.table, &target.id)?;
        claude::inbox::read_tail(&path, max).ok()
    }
}
