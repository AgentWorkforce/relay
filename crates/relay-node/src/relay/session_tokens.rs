//! Per-session send tokens (`session_send_tokens`, off unless the person
//! turns it on).
//!
//! A tool running under a host process that holds several sessions (a Codex
//! app-server, an OpenCode, a Cursor window) names none of them on the
//! session socket: the kernel shows only the host, and the host's
//! environment tags can be set by any process under it. With the setting
//! on, the core gives each registered session a random token in the reply
//! commands it hands that session's own turns, and a request carrying it
//! names that session, but only when the session is one the caller's own
//! host process holds (`SessionDirectory::caller_among_held`).
//!
//! Tokens are 256 random bits, kept in memory only: they change when the
//! core restarts, and a session that registers again (a new agent id) gets a
//! new one. They are compared in constant time.

use crate::relay::store::Target;
use std::collections::HashMap;
use std::sync::Mutex;

/// The request header a token travels in; `session_token` in the query
/// serves the same.
pub const HEADER: &str = "x-relay-session-token";
/// The query field a token travels in.
pub const QUERY: &str = "session_token";

/// Whether `session_send_tokens` is on, as the agent store last loaded or
/// saved it: what decides, where no store is at hand, whether a session on a
/// host holding several sessions can answer on the socket (with its token).
static ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Records the store's `session_send_tokens` (load and every save).
pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

/// Whether `session_send_tokens` is on (`set_enabled`).
pub fn enabled() -> bool {
    ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// The tokens this core has handed out, by session.
#[derive(Default)]
pub struct SessionTokens {
    minted: Mutex<HashMap<Target, Minted>>,
}

struct Minted {
    /// The registration the token was minted for: a session registered
    /// again gets a new token.
    agent_id: String,
    token: String,
}

impl SessionTokens {
    /// The token for `target` registered as `agent_id`, minted now if it has
    /// none or its registration changed. `None` only when no randomness is
    /// available.
    pub fn token_for(&self, target: &Target, agent_id: &str) -> Option<String> {
        let mut minted = self.minted.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = minted.get(target).filter(|m| m.agent_id == agent_id) {
            return Some(existing.token.clone());
        }
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).ok()?;
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        minted.insert(
            target.clone(),
            Minted {
                agent_id: agent_id.to_string(),
                token: token.clone(),
            },
        );
        Some(token)
    }

    /// The session `token` was minted for, with the agent id it was minted
    /// under. Every stored token is compared in full, in constant time.
    pub fn target_of(&self, token: &str) -> Option<(Target, String)> {
        let minted = self.minted.lock().unwrap_or_else(|e| e.into_inner());
        let mut found = None;
        for (target, entry) in minted.iter() {
            if constant_time_eq(entry.token.as_bytes(), token.as_bytes()) {
                found = Some((target.clone(), entry.agent_id.clone()));
            }
        }
        found
    }
}

/// Whether `a` and `b` are equal, taking the same time for every pair of
/// one length.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// Whether `value` has a token's shape (64 lowercase hex characters), so a
/// malformed value is refused before any comparison.
pub fn well_formed(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::store::SessionKind;

    #[test]
    fn a_token_names_its_session_until_it_registers_again() {
        let tokens = SessionTokens::default();
        let a = Target::new(SessionKind::Codex, "a");
        let b = Target::new(SessionKind::Codex, "b");
        let first = tokens.token_for(&a, "agent-1").unwrap();
        assert!(well_formed(&first));
        assert_eq!(tokens.token_for(&a, "agent-1").unwrap(), first);
        let other = tokens.token_for(&b, "agent-2").unwrap();
        assert_ne!(first, other);
        assert_eq!(
            tokens.target_of(&first),
            Some((a.clone(), "agent-1".into()))
        );
        assert_eq!(tokens.target_of(&other), Some((b, "agent-2".into())));
        // Registered again: a new token, and the old one names no one.
        let again = tokens.token_for(&a, "agent-3").unwrap();
        assert_ne!(again, first);
        assert_eq!(tokens.target_of(&first), None);
        assert_eq!(tokens.target_of(&again), Some((a, "agent-3".into())));
        assert_eq!(tokens.target_of(""), None);
        assert_eq!(tokens.target_of(&"0".repeat(64)), None);
    }

    #[test]
    fn a_new_core_mints_new_tokens() {
        let a = Target::new(SessionKind::Codex, "a");
        let before = SessionTokens::default().token_for(&a, "agent-1").unwrap();
        let restarted = SessionTokens::default();
        assert_eq!(restarted.target_of(&before), None);
        assert_ne!(restarted.token_for(&a, "agent-1").unwrap(), before);
    }

    #[test]
    fn comparison_is_exact() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!well_formed("ABC"));
        assert!(!well_formed(&"g".repeat(64)));
    }
}
