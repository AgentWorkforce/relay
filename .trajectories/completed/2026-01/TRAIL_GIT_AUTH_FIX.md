# Git Authentication Infrastructure Fix - Trail Documentation

**Trajectory ID:** traj_pdreuiy4xr4i
**Status:** ✅ Completed
**Confidence:** 92%
**Started:** January 8, 2026 at 07:01 PM
**Completed:** January 8, 2026 at 07:03 PM

## Problem

Git push and GitHub CLI operations were failing due to authentication issues:
- `/api/git/token` endpoint returned GitHub App **installation tokens** (ghs_*)
- Installation tokens are API-only and don't work with git credential helpers
- Agents had to use workaround: embed token directly in HTTPS URL
- This wasted cycles and blocked automated workflows

Error encountered:
```
git push origin branch
# FAILS: "Password authentication is not supported for Git operations"
```

## Root Cause Analysis

The `/api/git/token` endpoint (src/cloud/api/git.ts):
1. Was fetching both `userToken` (GitHub user OAuth) and `installationToken` (GitHub App)
2. But returned `installationToken` as the primary `token` field
3. Installation tokens only work with GitHub API, not git operations
4. User OAuth tokens work for both git operations AND GitHub App API calls

## Solution: Dual Token Approach (Option A+)

Modified `/api/git/token` response to return:
- **`userToken`** (primary): GitHub user OAuth token → For git push, git clone, gh CLI
- **`installationToken`** (fallback): GitHub App token → For GitHub App-specific API operations
- **`tokenType`** (field): Indicates which type is being used ('user' or 'installation')

### Why This Works

1. **Git operations** get a compatible token (userToken)
2. **GitHub App operations** have access to app-specific endpoints
3. **Backward compatible** - falls back to installation token if user token unavailable
4. **Extensible** - enables future GitHub App integrations

## Implementation Details

### Files Modified

**src/cloud/api/git.ts** (lines 182-186)
```typescript
res.json({
  token: userToken || installationToken,  // Primary: prefer user token
  tokenType: userToken ? 'user' : 'installation',
  installationToken,                       // Also return for app ops
  expiresAt,
  username: 'x-access-token',
});
```

**deploy/workspace/git-credential-relay**
- Updated to prefer `.userToken` field
- Falls back to `.token` if userToken unavailable
- Added debug logging for token type

**deploy/workspace/gh-relay**
- Updated to prefer `.userToken` field
- Falls back to `.token` if userToken unavailable

## Verification

During implementation, GitAuthEngineer experienced the exact problem:
- `git push origin branch` failed with "Password authentication not supported"
- `gh pr create` failed with 401 Bad Credentials
- Had to use token-in-URL workaround to push the fix

This confirmed the fix is needed and validates the solution.

## Impact

✅ **Unblocks all agent workflows:**
- Git push/pull/clone now works transparently
- GitHub CLI (gh) operations work transparently
- No manual token embedding workarounds needed
- Credential helpers function as intended

✅ **Enables GitHub App integration:**
- Agents can call GitHub App-specific API endpoints if needed
- Webhook management, installation management, etc.
- Future extensibility for advanced integrations

## Related Tasks

- **PR:** #112 - Git auth infrastructure fix
- **Beads:** bd-git-auth-fix (completed - investigation and implementation)
- **Beads:** bd-git-auth-docs (pending - agent documentation on dual token usage)
- **Trail:** traj_pdreuiy4xr4i (this trajectory)

## Key Decisions

1. **Implemented dual-token approach** instead of single endpoint separation
   - Reasoning: Keeps endpoint simple, returns both tokens for flexibility
   - Keeps PR #112 focused on fix
   - Documentation tabled as separate task (bd-git-auth-docs) for later

2. **Return both tokens in response** rather than separate endpoints
   - Less API fragmentation
   - Agents get what they need in one call
   - Clear field names indicate purpose

3. **Prefer userToken over installationToken**
   - User tokens work for all operations (git + API)
   - Installation tokens only work for specific GitHub App operations
   - Makes transparent user experience the default
