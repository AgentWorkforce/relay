//! Relay-owned credentials a spawned process must not inherit from the
//! spawning process's environment. Every agent worker and every spawn-time
//! helper (MCP registration, model probes, session pre-creation) strips this
//! list first; a worker then receives only what it is meant to hold through an
//! explicit `Command::env`, which still wins after the scrub.

use tokio::process::Command;

pub const INHERITED_RELAY_CREDENTIAL_ENV_KEYS: &[&str] = &[
    // The broker's local HTTP API key (set on the broker process at startup).
    "RELAY_BROKER_API_KEY",
    // The node's control-plane credential.
    "RELAY_NODE_TOKEN",
    // The broker's own registration identity proof.
    "RELAY_AGENT_IDENTITY_KEY",
    // Whoever launched the broker; each worker gets its own.
    "RELAY_AGENT_TOKEN",
    "AGENT_RELAY_RESULT_TOKEN",
    // Workspace credentials. Re-added from the broker's explicit worker
    // environment when the broker delegates them; never taken from ambient
    // environment.
    "RELAY_API_KEY",
    "RELAY_WORKSPACE_KEY",
    "AGENT_RELAY_WORKSPACE_KEY",
    "RELAY_WORKSPACES_JSON",
];

/// Remove [`INHERITED_RELAY_CREDENTIAL_ENV_KEYS`] from a command's inherited
/// environment. Call before applying the command's own environment: a later
/// `Command::env` for the same key still wins.
pub fn remove_inherited_relay_credentials(command: &mut Command) {
    for key in INHERITED_RELAY_CREDENTIAL_ENV_KEYS {
        command.env_remove(key);
    }
}

/// A `Command` for `program` that does not inherit relay credentials. Use it for
/// every process the broker starts on an agent's behalf, including spawn-time
/// helpers that never become the agent (MCP registration, model probes).
pub fn scrubbed_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    remove_inherited_relay_credentials(&mut command);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubbed_command_removes_every_relay_credential() {
        let mut command = scrubbed_command("true");
        command.env("RELAY_AGENT_TOKEN", "own-token");
        let envs: std::collections::HashMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_owned()),
                )
            })
            .collect();
        for key in INHERITED_RELAY_CREDENTIAL_ENV_KEYS {
            if *key == "RELAY_AGENT_TOKEN" {
                continue;
            }
            assert_eq!(envs.get(*key), Some(&None), "{key} must be removed");
        }
        // An explicit value set after construction still wins.
        assert_eq!(
            envs.get("RELAY_AGENT_TOKEN"),
            Some(&Some("own-token".into()))
        );
        // Everything else is left to normal inheritance.
        assert!(!envs.contains_key("PATH"));
    }
}
