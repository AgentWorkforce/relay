use super::*;

/// `agent-relay-broker reclaim-legacy-identity` — operator-invoked recovery
/// for a single named agent record created before 5c2ad8ee3 ("reclaim a
/// node's own registration across restart, hash the identity proof")
/// shipped. See `crate::relaycast::reclaim_legacy_identity` for the full
/// rationale and the safety checks it enforces; this is just the CLI
/// plumbing: resolve the workspace key, base URL, and the identity to stamp
/// (`RELAY_AGENT_IDENTITY_KEY`, else derived from the named broker's state
/// path under `--state-dir` the same way a live broker would), then call it
/// and report the outcome. The raw proof is never accepted on argv or printed.
///
/// Deliberately NOT part of the automatic startup/reconnect path — see the
/// doc comment on `reclaim_legacy_identity` for why an automatic grandfather
/// clause here would reopen the AR-448 hijack window it exists to close.
pub(crate) async fn run_reclaim_legacy_identity(cmd: ReclaimLegacyIdentityCommand) -> Result<()> {
    let workspace_key = cmd
        .workspace_key
        .clone()
        .or_else(|| std::env::var("RELAY_API_KEY").ok())
        .or_else(|| std::env::var("AGENT_RELAY_WORKSPACE_KEY").ok())
        .or_else(|| std::env::var("RELAY_WORKSPACE_KEY").ok())
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .context(
            "no workspace key supplied: pass --workspace-key or set RELAY_API_KEY / \
             AGENT_RELAY_WORKSPACE_KEY / RELAY_WORKSPACE_KEY",
        )?;

    let base_url = cmd
        .base_url
        .clone()
        .or_else(|| std::env::var("RELAYCAST_BASE_URL").ok())
        .or_else(|| std::env::var("RELAY_BASE_URL").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let our_identity_key = if let Some(env_key) = agent_identity_key() {
        env_key
    } else {
        let state_dir = cmd.state_dir.clone().context(
            "no identity to stamp: set RELAY_AGENT_IDENTITY_KEY or pass --state-dir pointing at \
             the node's own .agentworkforce/relay directory so the same derivation the broker \
             uses at startup can be reproduced here",
        )?;
        stable_node_identity_key(&persistent_broker_state_path(&state_dir, &cmd.name))
    };

    eprintln!("{}", reclaim_start_message(&cmd.name, &our_identity_key));

    let claim = reclaim_legacy_identity(
        base_url.as_deref(),
        &workspace_key,
        &cmd.name,
        &our_identity_key,
    )
    .await?;

    println!(
        "reclaimed: agent '{}' (id {}) now has an identity stamped; future restarts presenting \
         the same identity (RELAY_AGENT_IDENTITY_KEY or this node's own state directory) will \
         reclaim it via the normal startup path, and any OTHER identity will still be rejected.",
        claim.agent_name, claim.agent_id
    );

    Ok(())
}

fn reclaim_start_message(name: &str, identity_key: &str) -> String {
    format!(
        "reclaiming legacy identity for agent '{name}' (identity fingerprint: {})",
        identity_key_fingerprint(identity_key)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reclaim_diagnostic_uses_only_a_hash_fingerprint_for_short_proofs() {
        let secret = "short-proof";
        let message = reclaim_start_message("legacy-node", secret);

        assert!(message.contains(&identity_key_fingerprint(secret)));
        assert!(!message.contains(secret));
    }

    #[test]
    fn reclaim_diagnostic_does_not_slice_unicode_proofs() {
        let secret = "12345678901é-replayable";
        let message = reclaim_start_message("legacy-node", secret);

        assert!(message.contains(&identity_key_fingerprint(secret)));
        assert!(!message.contains(secret));
    }

    #[test]
    fn state_dir_identity_uses_the_named_persistent_broker_state_path() {
        let state_dir = Path::new("/srv/node/.agentworkforce/relay");
        let state_path = persistent_broker_state_path(state_dir, "node/a");

        assert_eq!(
            state_path,
            state_dir.join("state-node-a.json"),
            "recovery and normal startup must hash the same name-specific path"
        );
    }
}
