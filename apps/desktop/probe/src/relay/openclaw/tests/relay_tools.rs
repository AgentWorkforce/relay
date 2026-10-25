//! Agent Relay tools are offered only once the Gateway has said it can limit
//! relay sessions: a core that has not met it yet shakes hands first, and
//! fails closed when it cannot.
use super::*;
use crate::relay::contract::openclaw::OpenClawToolsState;
use crate::relay::openclaw::relay_tools::{self, RelayTools};

const SITE: &str = "https://agentrelay.com";

/// The tools with no CLI: whatever passes the Gateway check then stops at
/// "couldn't find OpenClaw's command-line tool".
fn tools(config: &OpenClawConfig) -> RelayTools {
    assert!(config.seen.get().is_none(), "nothing recorded yet");
    RelayTools::new(config, || None)
}

/// Status and Connect both stay closed with `reason`.
fn closed_with(config: &OpenClawConfig, reason: &str) {
    let tools = tools(config);
    let status = tools.status(SITE);
    assert_eq!(status.state, OpenClawToolsState::Unavailable);
    assert_eq!(status.detail.as_deref(), Some(reason));
    assert_eq!(tools.connect(SITE), Err(reason.to_string()));
}

#[test]
fn a_remote_gateway_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let config = configured(dir.path(), json!({ "mode": "remote" }));
    closed_with(&config, &Unavailable::RemoteGateway.reason());
}

#[test]
fn an_unreadable_config_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let config = configured(dir.path(), json!({}));
    std::fs::write(&config.config_path, "{ gateway: ").unwrap();
    closed_with(&config, &Unavailable::UnreadableConfig.reason());
}

#[test]
fn a_secret_reference_token_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let config = configured(
        dir.path(),
        json!({ "auth": { "mode": "token", "token": { "source": "env", "id": "T" } } }),
    );
    closed_with(&config, &Unavailable::UnsupportedSecret.reason());
}

#[test]
fn a_starting_gateway_says_so() {
    let fake = FakeGateway::start("secret-token", Behaviour::Starting, Value::Null);
    let dir = tempfile::tempdir().unwrap();
    closed_with(&against(&fake, dir.path()), relay_tools::STARTING);
}

#[test]
fn a_gateway_that_refuses_agent_relay_says_why() {
    let fake = FakeGateway::start("another-token", Behaviour::Answer, Value::Null);
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let tools = tools(&config);
    let status = tools.status(SITE);
    assert_eq!(status.state, OpenClawToolsState::Unavailable);
    let detail = status.detail.unwrap_or_default();
    assert!(
        detail.starts_with("OpenClaw's Gateway refused Agent Relay: "),
        "{detail}"
    );
    assert_eq!(tools.connect(SITE), Err(detail));
}

#[test]
fn an_old_gateway_met_only_now_refuses_the_tools() {
    let fake = FakeGateway::release(Release::new(2026, 7, 33));
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let tools = tools(&config);
    let withheld = relay_tools::unlimited("2026.7.33");
    let status = tools.status(SITE);
    assert_eq!(status.state, OpenClawToolsState::Unavailable);
    assert_eq!(status.detail.as_deref(), Some(withheld.as_str()));
    assert_eq!(tools.connect(SITE), Err(withheld));
}

#[test]
fn a_gateway_that_cannot_be_reached_fails_closed() {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let dir = tempfile::tempdir().unwrap();
    let config = configured(
        dir.path(),
        json!({ "port": port, "auth": { "mode": "token", "token": "secret-token" } }),
    );
    let tools = tools(&config);
    let status = tools.status(SITE);
    assert_eq!(status.state, OpenClawToolsState::Unavailable);
    assert_eq!(status.detail.as_deref(), Some(relay_tools::UNREACHABLE));
    assert_eq!(
        tools.connect(SITE),
        Err(relay_tools::UNREACHABLE.to_string())
    );
}

#[test]
fn a_current_gateway_met_only_now_lets_connect_go_on() {
    let fake = FakeGateway::release(CURRENT);
    let dir = tempfile::tempdir().unwrap();
    let config = against(&fake, dir.path());
    let tools = tools(&config);
    // Past the Gateway check: on to finding OpenClaw's CLI.
    let status = tools.status(SITE);
    assert_eq!(status.detail.as_deref(), Some(relay_tools::CLI_MISSING));
    assert_eq!(
        tools.connect(SITE),
        Err(relay_tools::CLI_MISSING.to_string())
    );
    assert!(config
        .seen
        .get()
        .is_some_and(|features| features.session_limits));
}
