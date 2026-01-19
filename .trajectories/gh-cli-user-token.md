# Trajectory: Investigate gh CLI auth solution for agents

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 6, 2026 at 12:44 PM
> **Completed:** January 6, 2026 at 01:10 PM

---

## Summary

Created PR #79 to fix gh CLI auth. Updates git.ts to use user login connection (GITHUB_USER) for userToken. Also created ~/.local/bin/gh-relay wrapper that uses userToken with GH_TOKEN env var.

**Approach:** Standard approach

---

## Chapters

### 1. Initial work
*Agent: Fullstack*

- API currently returns same token for both 'token' and 'userToken' - both are GitHub App installation tokens (ghs_*): API currently returns same token for both 'token' and 'userToken' - both are GitHub App installation tokens (ghs_*)
- Issue identified: getGithubUserOAuthToken returns installation token (ghs_*) instead of user OAuth token (gho_*). gh CLI needs user OAuth token for full API access.: Issue identified: getGithubUserOAuthToken returns installation token (ghs_*) instead of user OAuth token (gho_*). gh CLI needs user OAuth token for full API access.
- API still returns same token - code change not deployed yet. Need to verify user has login connection (users.nangoConnectionId) and that GITHUB_USER integration returns gho_* OAuth token: API still returns same token - code change not deployed yet. Need to verify user has login connection (users.nangoConnectionId) and that GITHUB_USER integration returns gho_* OAuth token

### 2. 2026-01-19 Follow-up: Spawned agent GH_TOKEN regression
*Agent: EnvAugmentor*

- **Original working state (Jan 6, commit 5ee01d4):** Workspace containers install `/usr/local/bin/gh` wrapper and entrypoint config relies on gh-relay to fetch fresh user tokens for gh CLI. GH_TOKEN is provided for legacy mode via `GITHUB_TOKEN`.
- **Regression point (Jan 11, commit 5dc8373):** Per-user HOME scoping was added in `src/bridge/spawner.ts` (via `getUserEnvironment`). Spawned agents started using isolated HOME without any GH_TOKEN injection or gh config migration. This broke gh auth for spawned agents that do not run through workspace entrypoint (local bridge spawns) and no longer inherit any existing gh auth from the parent HOME.
- **Not caused by relay-pty migration (Jan 17, commit 7f414c6):** Env merge behavior remained `{ ...process.env, ...config.env }` in both node-pty and relay-pty wrappers; no GH_TOKEN handling was removed there.
- **Why gh-relay wrapper did not fix it:** gh-relay exists only in workspace containers; bridge-spawned agents on host machines do not have that wrapper or workspace env vars. Without GH_TOKEN, gh CLI returns 401.
- **Fix rationale:** Inject GH_TOKEN into spawned agent env by calling the cloud git token endpoint (`/api/git/token`), falling back to parent `process.env.GH_TOKEN` when available, so gh works in spawned agents regardless of entrypoint wrapper presence.
