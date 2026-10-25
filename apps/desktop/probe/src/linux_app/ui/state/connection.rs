//! Relay connection wording for the sidebar and status bar.

use super::*;

impl State {
    /// What stops messages or uploads right now.
    pub fn relay_problem(&self) -> Option<String> {
        if let Some(error) = &self.core_error {
            return Some(error.clone());
        }
        if let Some(status) = self
            .status
            .as_ref()
            .filter(|status| status.stage == Stage::NeedsAttention)
        {
            return Some(
                status
                    .detail
                    .clone()
                    .unwrap_or_else(|| status.headline.clone()),
            );
        }
        let agents = self.snapshot.as_ref().map(|snapshot| &snapshot.agents);
        if let Some(error) = agents.and_then(|agents| {
            agents
                .store_error
                .clone()
                .or_else(|| agents.integration_error.clone())
        }) {
            return Some(error);
        }
        if let Some(error) = agents.and_then(|agents| agents.delivery_error.clone()) {
            if self
                .local_sessions
                .iter()
                .any(|session| session.registration.is_some())
            {
                return Some(format!("Can't reach the relay: {error}"));
            }
        }
        None
    }

    pub fn connection(&self) -> Connection {
        let connection = |label, color, help: &str, healthy| Connection {
            label,
            color,
            help: help.to_string(),
            healthy,
        };
        if !self.core_connected && self.launch_recorded && self.core_error.is_none() {
            return connection(
                "Reconnecting",
                Color::Orange,
                "Agent Relay is reconnecting to its background service.",
                false,
            );
        }
        if self.is_paused() {
            return connection(
                "Paused",
                Color::Orange,
                "Agents don't receive messages and nothing uploads.",
                false,
            );
        }
        if let Some(problem) = self.relay_problem() {
            return connection("Needs attention", Color::Orange, &problem, false);
        }
        if !self.has_workspace() {
            return connection(
                "No relay workspace",
                Color::Orange,
                "Connect a workspace in Settings › Messages.",
                false,
            );
        }
        if self.account().phase.as_deref() == Some("preparing_local_sessions") {
            return connection(
                "Preparing sessions",
                Color::Accent,
                "Reading your local history.",
                false,
            );
        }
        if !self.connected() {
            return connection(
                "Not connected",
                Color::Orange,
                "Agent Relay is not connected to its background service.",
                false,
            );
        }
        connection(
            "Connected",
            Color::Green,
            "Signed in and connected to your workspace.",
            true,
        )
    }
}
