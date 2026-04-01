# Trajectory: Fix Recurring GitHub Auth Issue

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** January 23, 2026
> **Completed:** January 23, 2026

---

## Summary

Fixed the recurring GitHub authentication issue by injecting GH_TOKEN at workspace startup rather than relying on on-demand cloud API fetches.

**Approach:** Pre-fetch and cache token at startup

---

## Root Cause Analysis

The issue was NOT missing fallback logic - git-credential-relay already had a fallback chain. The problem was that **GH_TOKEN was never SET** in the environment where git runs.

### Why This Kept Recurring

1. **Jan 6:** Added GH_TOKEN fallback to git-credential-relay
2. **Jan 11:** Per-user HOME scoping broke spawned agents (no GH_TOKEN migration)
3. **Jan 22:** Added more fallbacks (hosts.yml, gh CLI) - still didn't work
4. **Now:** Realized GH_TOKEN must be SET first, not just checked

The pattern: Each fix added MORE fallback options, but none addressed the root cause - the token was never populated in the environment.

---

## Key Decisions

### Pre-fetch GH_TOKEN at startup instead of on-demand

**Reasoning:**
- On-demand cloud API calls are unreliable when API is slow/down
- Pre-fetching once at startup ensures token is available for entire session
- Graceful fallback if fetch fails (logs warning, continues)
- Spawned agents inherit the token automatically

### Reorder fallback chain: env → hosts.yml → gh CLI → cloud API

**Reasoning:**
- Environment is fastest (no I/O)
- Entrypoint sets GH_TOKEN, so env check succeeds immediately
- Cloud API is last resort (may be slow or unreachable)
- Same order in both git-credential-relay and spawner.ts

---

## Changes

### 1. deploy/workspace/entrypoint.sh
- Added GH_TOKEN pre-fetch during workspace initialization
- Exports GH_TOKEN and GITHUB_TOKEN to environment
- 10-second timeout, graceful failure

### 2. deploy/workspace/git-credential-relay
- Improved fallback chain documentation
- Better error messages showing what was tried
- Added test suite (7 tests)

### 3. src/bridge/spawner.ts
- Reordered resolveGhToken: env → hosts.yml → gh CLI → cloud API
- Added 5-second timeout to cloud API calls
- Spawned agents inherit GH_TOKEN from daemon

---

## Verification

The fix ensures:
- [x] git push works without CLOUD_API_URL being reachable
- [x] gh CLI works (uses same GH_TOKEN from env)
- [x] Works for both main agent and spawned agents
- [x] Clear error messages when all sources fail
- [x] Test suite validates fallback chain

---

## Commits

```
d531137 fix: Inject GH_TOKEN at startup to prevent recurring auth failures
3c77748 fix: Comprehensive GitHub auth fallback chain in git-credential-relay
```

Branch: `fix/github-auth-fallback-chain`
