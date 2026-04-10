# PLAN — relay local bootstrap and messaging fixes

## Goal
Fix the local agent-relay bootstrap/messaging issues this workflow targets, then validate from a clean local repo state.

## Root causes to address

### 1. Local bootstrap / installer issues
- `install.sh` can leave users in a confusing state on macOS when standalone binary verification fails.
- A stale shim / stale `.agent-relay/` state can confuse later spawned agents and local broker behavior.
- The local launcher path should be robust after install, with clearer fallback behavior and clearer verification messaging.

### 2. Local messaging/history issues
- Local broker mode should not fail awkwardly because of sender defaults.
- `agent-relay history` behavior in local mode should be clear and safe when `RELAY_API_KEY` is absent.
- Prefer code fixes over docs-only band-aids if behavior is actually wrong.

### 3. Clean-checkout workflow validation requirements
- Workflow validation must succeed from the active checkout/worktree, not a hard-coded repo path.
- `packages/config` and `packages/sdk` build steps must use deterministic TypeScript invocation that works in a clean workflow environment.
- Rebuild diagnostics should stay split into explicit steps so failures are attributable.

## Files allowed to change
Use judgment, but only touch files necessary for:
- installer/bootstrap behavior
- local CLI messaging/history behavior
- workflow validation/build sequencing

Do not edit unrelated packages or broad docs unless necessary to explain changed behavior.

## Validation requirements
After implementation, validate with:
1. clean local install/build path
2. local launcher smoke test
3. relay startup smoke test
4. local send/history path sanity check if possible

## Deliverable expectations
Implementation agents should:
- write code changes to disk
- keep edits narrow
- favor real fixes over commentary
- preserve working behavior outside the targeted local-mode fixes
