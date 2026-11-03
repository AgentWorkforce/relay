//! Claude Code on the web (claude.ai/code) sessions as agents.
//!
//! A web session runs in Anthropic's cloud container, so nothing on this
//! computer holds it and the Claude desktop app's `remote-session-spaces.json`
//! lists only the sessions it has against local folders. A build's remote
//! session source (`session_sources::RemoteSessions`) lists them as
//! `ClaudeCloud` rows. Delivery is the Claude app route:
//! `claude --print --cloud <id>` under the person's own Claude sign-in,
//! which wakes the session with a new turn.
//!
//! The session answers through Agent Relay Cloud's hosted
//! `agent-relay-sessions` MCP (see `integrations/claude-code-web`), linked
//! to this identity with `join_relay desktop_address`, or by Cloud on its
//! own: identity sync sends each web identity's [`web_session_id`], and the
//! plugin sends the container's `CLAUDE_CODE_REMOTE_SESSION_ID` with every
//! hosted MCP request.

use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{is_claude_session_id, SessionKind, Target};

/// The `host` a web session's row carries: the session runs on claude.ai,
/// not on this computer or in the Claude desktop app.
pub const HOST: &str = "claude-web";

/// The id a claude.ai/code container knows itself by
/// (`CLAUDE_CODE_REMOTE_SESSION_ID`), for a Claude cloud `target`: always
/// the `cse_` form, though the catalog and the Claude app may name the same
/// session `session_…`. None for any other session.
pub fn web_session_id(target: &Target) -> Option<String> {
    if target.kind != SessionKind::ClaudeCloud || !is_claude_session_id(&target.id) {
        return None;
    }
    let body = target
        .id
        .strip_prefix("session_")
        .or_else(|| target.id.strip_prefix("cse_"))?;
    Some(format!("cse_{body}"))
}

/// One claude.ai session whatever it is named by: Claude calls the same
/// session `session_<body>` and `cse_<body>`, so rows compare by the body.
pub fn same_session(id: &str) -> &str {
    id.strip_prefix("session_")
        .or_else(|| id.strip_prefix("cse_"))
        .unwrap_or(id)
}

/// Appends to `found` the web sessions the build's remote session sources
/// list. A session the Claude desktop app also has open, under either form
/// of its id, keeps that row but is marked as web-backed so clients can join
/// it to the history catalog.
pub fn extend(config: &crate::relay::local::LocalConfig, found: &mut Vec<DiscoveredSession>) {
    extend_discovered(
        found,
        config
            .sources
            .remote
            .sessions(config, SessionKind::ClaudeCloud),
    );
}

fn extend_discovered(found: &mut Vec<DiscoveredSession>, web: Vec<DiscoveredSession>) {
    for session in web {
        if let Some(existing) = found.iter_mut().find(|existing| {
            existing.target.kind == SessionKind::ClaudeCloud
                && same_session(&existing.target.id) == same_session(&session.target.id)
        }) {
            existing.host = Some(HOST.to_string());
        } else {
            found.push(session);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_forms_of_one_session_id_are_one_session() {
        assert_eq!(
            same_session("session_01AbCdEfGh"),
            same_session("cse_01AbCdEfGh")
        );
        assert_eq!(same_session("0b6f2d0e"), "0b6f2d0e");
    }

    #[test]
    fn a_matching_claude_app_row_is_marked_as_web_backed() {
        let app_id = "session_01AbCdEfGhIjKlMn";
        let web_id = "cse_01AbCdEfGhIjKlMn";
        let app = DiscoveredSession {
            target: Target::new(SessionKind::ClaudeCloud, app_id),
            title: "Claude app title".into(),
            directory: Some("/work/app".into()),
            updated_at_ms: None,
            host: None,
            live: true,
            holder: None,
        };
        let web = DiscoveredSession {
            target: Target::new(SessionKind::ClaudeCloud, web_id),
            title: "Web title".into(),
            directory: Some("/work/web".into()),
            updated_at_ms: Some(10),
            host: Some(HOST.into()),
            live: true,
            holder: None,
        };
        let other = DiscoveredSession {
            target: Target::new(SessionKind::ClaudeCloud, "cse_01OtherWebSession"),
            title: "Other web title".into(),
            ..web.clone()
        };
        let mut found = vec![app];
        extend_discovered(&mut found, vec![web, other.clone()]);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].title, "Claude app title");
        assert_eq!(found[0].host.as_deref(), Some(HOST));
        assert_eq!(web_session_id(&found[0].target).as_deref(), Some(web_id));
        assert_eq!(found[1], other);
    }

    #[test]
    fn a_web_session_id_is_the_containers_cse_form() {
        let id = |kind, id: &str| web_session_id(&Target::new(kind, id.to_string()));
        assert_eq!(
            id(SessionKind::ClaudeCloud, "cse_01AbCdEfGhIjKlMn").as_deref(),
            Some("cse_01AbCdEfGhIjKlMn")
        );
        assert_eq!(
            id(SessionKind::ClaudeCloud, "session_01AbCdEfGhIjKlMn").as_deref(),
            Some("cse_01AbCdEfGhIjKlMn")
        );
        assert_eq!(id(SessionKind::ClaudeCloud, "session_short"), None);
        assert_eq!(id(SessionKind::Codex, "cse_01AbCdEfGhIjKlMn"), None);
    }
}
