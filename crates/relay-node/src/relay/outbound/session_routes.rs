//! The routes the session socket serves, which the sandbox-rule tests
//! enumerate.

/// Every route the session socket serves ([`super::Outbound::handle`] and
/// `mobile_handoff_route`), by method. A test reads the router's source and
/// fails while this list and the router differ, so a new route is never left
/// out of the sandbox-rule enumeration (`session_cli::ALLOWED_SUBCOMMANDS`
/// and the probe's `codex_rules_reach_only_their_own_routes`).
pub const SESSION_ROUTES: &[(&str, &str)] = &[
    ("POST", "/connect/join"),
    ("POST", "/connect/send"),
    ("GET", "/connect/status"),
    ("POST", "/connect/leave"),
    ("GET", "/whoami"),
    ("GET", "/agents"),
    ("POST", "/attachments/fetch"),
    ("GET", "/messages"),
    ("POST", "/send"),
    ("POST", "/register"),
    ("POST", "/channels"),
    ("POST", "/channels/subscribe"),
    ("DELETE", "/channels/subscribe"),
    ("DELETE", "/register"),
    ("GET", "/settings"),
    ("PATCH", "/settings"),
    ("POST", "/codex/stop-hook"),
    ("POST", "/copilot/hook"),
    ("POST", "/copilot/mcp"),
    ("POST", "/claude/attestation"),
    ("GET", "/setup/status"),
    ("POST", "/setup/sign-in"),
    ("POST", "/setup/sharing"),
    ("POST", "/setup/auto-activate"),
    ("POST", "/setup/direct-delivery"),
    ("POST", "/webhooks"),
    ("DELETE", "/webhooks"),
    ("POST", "/integrations/subscribe"),
    ("DELETE", "/integrations/subscribe"),
    ("POST", "/claude/mobile-handoff/poll"),
    ("POST", "/claude/mobile-handoff/ack"),
    ("POST", "/claude/mobile-handoff/result"),
    ("POST", "/claude/mobile-handoff/permission"),
];
