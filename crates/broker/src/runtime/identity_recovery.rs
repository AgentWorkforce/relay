use super::*;

/// `agent-relay-broker reclaim-legacy-identity` — operator-invoked recovery
/// for a single named agent record created before 5c2ad8ee3 ("reclaim a
/// node's own registration across restart, hash the identity proof")
/// shipped. See `crate::relaycast::reclaim_legacy_identity` for the full
/// rationale and the safety checks it enforces; this is just the CLI
/// plumbing: resolve the workspace key, base URL, and the identity to stamp
/// (explicit flag, else `RELAY_AGENT_IDENTITY_KEY`, else derived from
/// `--state-dir`'s `state.json` the same way a live broker would), then call
/// it and report the outcome.
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

    let our_identity_key = if let Some(explicit) = cmd
        .identity_key
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        explicit
    } else if let Some(env_key) = agent_identity_key() {
        env_key
    } else {
        let state_dir = cmd.state_dir.clone().context(
            "no identity to stamp: pass --identity-key, set RELAY_AGENT_IDENTITY_KEY, or pass \
             --state-dir pointing at the node's own .agentworkforce/relay directory so the \
             same derivation the broker uses at startup can be reproduced here",
        )?;
        stable_node_identity_key(&state_dir.join("state.json"))
    };

    eprintln!(
        "reclaiming legacy identity for agent '{}' (derived identity: {}...)",
        cmd.name,
        &our_identity_key[..our_identity_key.len().min(12)]
    );

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
