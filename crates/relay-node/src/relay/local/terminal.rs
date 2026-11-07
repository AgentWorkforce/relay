//! Delivery into a terminal Codex or Claude Code session, which gets a
//! pointer (`message_pointer`) in place of a relayed message while relay
//! messages are hidden (`show_relay_messages` off, the default): a terminal
//! only accepts visible text, so the pointer is as hidden as it gets.

use super::LocalInjector;
use crate::relay::claude;
use crate::relay::claude_settings::{ClaudeSettings, DirectDeliveryError};
use crate::relay::codex::compact;
use crate::relay::inject::{InjectOutcome, Injector};
use crate::relay::message_pointer::{self, DeliveredTexts};
use crate::relay::setup::DirectDelivery;
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
        let pointer = || self.terminal_pointer(target, message_id, text, claude);
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
    /// The pointer a terminal session gets in place of `text`, once the
    /// text is kept (`message_pointer::prepare`). With `held`, Claude Code
    /// may hold the message for approval, and then it keeps its text so the
    /// person sees what they approve; a user turn is never held.
    pub(super) fn terminal_pointer(
        &self,
        target: &Target,
        message_id: &str,
        text: &str,
        held: bool,
    ) -> Option<String> {
        let enabled = compact::enabled()
            && (!held || ClaudeSettings::new(&self.config.claude).delivers_directly());
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
            reachable
                .then(message_pointer::configured_reader)
                .flatten()
                .as_deref(),
            crate::relay::state::now_ms(),
        )
    }

    /// `Injector::native_pointer`: a Claude Code user turn is never held.
    pub(super) fn claude_native_pointer(
        &self,
        target: &Target,
        message_id: &str,
        text: &str,
    ) -> Option<String> {
        (target.kind == SessionKind::ClaudeTerminal)
            .then(|| self.terminal_pointer(target, message_id, text, false))
            .flatten()
    }

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
    pub(super) fn claude_inbox_tail(
        &self,
        target: &Target,
        max: u64,
    ) -> Option<claude::inbox::Tail> {
        if target.kind != SessionKind::ClaudeTerminal {
            return None;
        }
        let (path, _) = claude::transcript::path(&self.config.claude, &*self.table, &target.id)?;
        claude::inbox::read_tail(&path, max).ok()
    }
}

impl DirectDelivery for ClaudeSettings {
    fn delivers_directly(&self) -> bool {
        ClaudeSettings::delivers_directly(self)
    }

    fn managed_value(&self) -> Option<String> {
        ClaudeSettings::managed_value(self)
    }

    fn user_choice(&self) -> Option<String> {
        ClaudeSettings::user_choice(self)
    }

    fn set_direct_delivery(&self, enabled: bool) -> Result<(), String> {
        ClaudeSettings::set_direct_delivery(self, enabled).map_err(|error| match error {
            DirectDeliveryError::ManagedPolicy => {
                "Managed Claude settings do not allow direct delivery.".to_string()
            }
            other => other.to_string(),
        })
    }
}
