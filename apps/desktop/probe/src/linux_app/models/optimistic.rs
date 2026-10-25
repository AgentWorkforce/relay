//! What a Settings list shows the moment a change is asked for, before the
//! core answers: the incoming (Codex) threads and held messages, and Claude
//! Code delivery consent. Pure: the Mac's `OptimisticStatus` in
//! `RelayDesktopCore` matches these.

use crate::relay::contract::claude_delivery::{ClaudeDeliveryStatus, ClaudeSender};
use crate::relay::contract::incoming::IncomingStatus;
use crate::relay::outbox::Mode;

impl IncomingStatus {
    /// The thread shared as asked (`mode` `None` stops sharing).
    pub fn sharing(
        mut self,
        thread_id: &str,
        mode: Option<Mode>,
        allows_unrestricted: bool,
    ) -> Self {
        for thread in &mut self.threads {
            if thread.id == thread_id {
                thread.mode = mode;
                thread.shared = mode.is_some();
                thread.allows_unrestricted = mode.is_some() && allows_unrestricted;
            }
        }
        self
    }

    /// Without the held message decided on.
    pub fn without_held(mut self, id: &str) -> Self {
        self.held.retain(|message| message.id != id);
        self
    }
}

impl ClaudeDeliveryStatus {
    pub fn restricting(mut self, restricted: bool) -> Self {
        self.restricted = restricted;
        self
    }

    pub fn with_session(mut self, id: &str, direct: bool) -> Self {
        for session in &mut self.sessions {
            if session.id == id {
                session.direct = direct;
            }
        }
        self
    }

    pub fn without_sender(mut self, address: &str) -> Self {
        self.allowed_senders
            .retain(|sender| sender.address != address);
        self
    }

    /// With `sender` allowed, once.
    pub fn allowing(mut self, sender: ClaudeSender) -> Self {
        if !self
            .allowed_senders
            .iter()
            .any(|allowed| allowed.address == sender.address)
        {
            self.allowed_senders.push(sender);
        }
        self
    }

    pub fn without_held(mut self, id: &str) -> Self {
        self.held.retain(|message| message.id != id);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::contract::claude_delivery::{ClaudeDeliverySession, ClaudeHeldDelivery};
    use crate::relay::contract::incoming::{HeldMessage, IncomingThread};
    use crate::relay::incoming::IncomingState;

    fn incoming() -> IncomingStatus {
        IncomingStatus {
            state: IncomingState::Connected,
            error: None,
            threads: vec![IncomingThread {
                id: "t1".into(),
                project: "api".into(),
                title: "Fix login".into(),
                open: true,
                shared: false,
                mode: None,
                allows_unrestricted: false,
            }],
            held: vec![HeldMessage {
                id: "m1".into(),
                thread_id: "t1".into(),
                text: "hi".into(),
                sender_name: None,
                enqueued_at_ms: 1,
                expires_at_ms: 2,
            }],
            can_approve: true,
        }
    }

    #[test]
    fn a_thread_shows_its_new_sharing_at_once() {
        let shared = incoming().sharing("t1", Some(Mode::Auto), true);
        assert_eq!(shared.threads[0].mode, Some(Mode::Auto));
        assert!(shared.threads[0].shared);
        assert!(shared.threads[0].allows_unrestricted);
        let off = shared.sharing("t1", None, true);
        assert_eq!(off.threads[0].mode, None);
        assert!(!off.threads[0].shared);
        assert!(!off.threads[0].allows_unrestricted);
        assert!(incoming().without_held("m1").held.is_empty());
        assert_eq!(incoming().without_held("other").held.len(), 1);
    }

    #[test]
    fn claude_delivery_lists_change_at_once() {
        let status = ClaudeDeliveryStatus {
            restricted: false,
            sessions: vec![ClaudeDeliverySession {
                id: "s1".into(),
                agent: "ada".into(),
                title: "".into(),
                direct: false,
            }],
            allowed_senders: vec![],
            held: vec![ClaudeHeldDelivery {
                id: "h1".into(),
                agent: "ada".into(),
                session_id: "s1".into(),
                sender: "bob@m-1".into(),
                sender_name: "Bob".into(),
                text: "hi".into(),
                held_at_ms: 1,
            }],
        };
        let changed = status
            .clone()
            .restricting(true)
            .with_session("s1", true)
            .allowing(ClaudeSender {
                address: "bob@m-1".into(),
                name: "Bob".into(),
            })
            .allowing(ClaudeSender {
                address: "bob@m-1".into(),
                name: "Bob".into(),
            })
            .without_held("h1");
        assert!(changed.restricted);
        assert!(changed.sessions[0].direct);
        assert_eq!(changed.allowed_senders.len(), 1);
        assert!(changed.held.is_empty());
        assert!(changed.without_sender("bob@m-1").allowed_senders.is_empty());
        assert_eq!(status.held.len(), 1);
    }
}
