# Trajectory: Fix #1582: repoPaths never reaches native-broker node registration

> **Status:** ✅ Completed
> **Task:** 1582
> **Confidence:** 90%
> **Started:** August 19, 2026 at 03:51 PM
> **Completed:** August 19, 2026 at 04:16 PM

---

## Summary

Forwarded node definition repoPaths keys to the native broker via AGENT_RELAY_NODE_REPO_KEYS so nodes register repo_keys and repo:<owner/name> tags and repo-based placement can match. Validated placement-safe keys once at the env boundary so neither the repo_keys nor the repo: tag channel can carry a path-shaped value, and honored an explicitly empty operator preset so operators can clear stale advertisements.

**Approach:** Standard approach

---

## Key Decisions

### Carried repo keys to the native broker via AGENT_RELAY_NODE_REPO_KEYS env, not a new IPC or wire field
- **Chose:** Carried repo keys to the native broker via AGENT_RELAY_NODE_REPO_KEYS env, not a new IPC or wire field
- **Reasoning:** The broker builds its own registration manifest in Rust; the only existing CLI->broker channel into that manifest is env (AGENT_RELAY_NODE_HARNESSES, AGENT_RELAY_NODE_MAX_AGENTS). Reusing that seam keeps the change symmetric with existing capacity plumbing, works identically for the in-process and compiled-binary (--describe child) serving modes, and needs no @relaycast/sdk or protocol version bump.

### Broker emits BOTH repo_keys and repo:<owner/name> tags
- **Chose:** Broker emits BOTH repo_keys and repo:<owner/name> tags
- **Reasoning:** packages/sdk relaycast-translate readRepoKeys reads repoKeys/repo_keys first but falls back to repo: tags because the engine roster row has no dedicated repo field. Emitting only repo_keys would leave placement unable to match on rosters that drop the field.

### Presence of repoPaths is the signal; absent env leaves registration untouched
- **Chose:** Presence of repoPaths is the signal; absent env leaves registration untouched
- **Reasoning:** Mirrors nodeRegistrationTags' documented backward-compat contract. Set-but-empty maps to repo_keys: [] which build_node_register deliberately preserves so a node can clear stale advertisements.

---

## Chapters

### 1. Work
*Agent: default*

- Carried repo keys to the native broker via AGENT_RELAY_NODE_REPO_KEYS env, not a new IPC or wire field: Carried repo keys to the native broker via AGENT_RELAY_NODE_REPO_KEYS env, not a new IPC or wire field
- Broker emits BOTH repo_keys and repo:<owner/name> tags: Broker emits BOTH repo_keys and repo:<owner/name> tags
- Presence of repoPaths is the signal; absent env leaves registration untouched: Presence of repoPaths is the signal; absent env leaves registration untouched

---

## Artifacts

**Commits:** 11f97cbe4, 525560c8f
**Files changed:** 5
