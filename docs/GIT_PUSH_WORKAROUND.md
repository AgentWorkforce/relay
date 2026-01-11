# Git Push Configuration for Agent Relay Workspace

## Problem (Now Fixed!)

When trying to push from the agent relay workspace, git was failing with:
```
fatal: could not read Username for 'https://github.com/AgentWorkforce/relay.git': terminal prompts disabled
```

**Root Cause:** The user's `~/.gitconfig` had conflicting credential helper settings:
```
credential.helper = /usr/local/bin/git-credential-relay          # Global
credential "https://github.com".helper = !/usr/bin/gh auth git-credential  # Overrides
```

The host-specific override forced git to use `gh auth git-credential`, which requires interactive terminal input.

## Solution (Permanent Fix)

Remove the conflicting `gh auth git-credential` overrides from your gitconfig:

```bash
git config --global --unset-all 'credential.https://github.com.helper'
git config --global --unset-all 'credential.https://gist.github.com.helper'
```

After this, plain `git push` just works:

```bash
git push origin feature/my-branch
```

### Full Example

```bash
# Push feature branch
GH_TOKEN=$(gh auth token) git push https://${GH_TOKEN}@github.com/AgentWorkforce/relay.git feature/my-feature:feature/my-feature

# Push to main (if allowed)
GH_TOKEN=$(gh auth token) git push https://${GH_TOKEN}@github.com/AgentWorkforce/relay.git main:main
```

## How It Works

1. `gh auth token` - Retrieves a fresh GitHub token from gh CLI's authenticated session
2. `https://${GH_TOKEN}@github.com/...` - Embeds token in URL (no credential prompt needed)
3. Git uses HTTPS with embedded credentials (no SSH, no terminal prompts)

**Benefits:**
- ✅ Works in non-interactive environments
- ✅ Token is fresh (gh CLI auto-refreshes via Nango)
- ✅ No credential helper configuration needed
- ✅ No SSH key setup required
- ✅ Works with existing `gh auth login` session

## Why Other Methods Don't Work

### SSH (git@github.com)
- ❌ Host key verification fails (no SSH key in sandbox)
- ❌ Can't configure without terminal interaction

### HTTPS with credential helper
- ❌ `git-credential-relay` requires WORKSPACE_ID, CLOUD_API_URL, WORKSPACE_TOKEN env vars
- ❌ Terminal prompts disabled prevents fallback auth
- ❌ Even though env vars exist, git still tries to prompt

### Interactive git credential
- ❌ Terminal prompts disabled prevents any user input

## Integration with .bashrc (Optional)

Add to your shell config for convenience:

```bash
# Git push helper for agent-relay workspace
git-push-relay() {
  local branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
  echo "Pushing $branch..."
  GH_TOKEN=$(gh auth token) git push https://${GH_TOKEN}@github.com/AgentWorkforce/relay.git "$branch:$branch"
}
```

Then use:
```bash
git-push-relay feature/my-feature
git-push-relay  # uses current branch
```

## Prerequisites

- `gh` CLI installed: `which gh`
- Authenticated with GitHub: `gh auth status` should show "✓ Logged in"
- Environment variable `WORKSPACE_ID`, `CLOUD_API_URL`, `WORKSPACE_TOKEN` set (auto-set by agent-relay)

## Verification

After pushing, verify with:
```bash
git log origin/<branch> --oneline -3
gh pr list --state open
```

## Related Issues

This workaround addresses the persistent git push authentication issue in agent-relay workspaces where:
- Terminal interaction is disabled
- SSH keys are not available
- Credential helper setup is problematic

See also:
- `git-credential-relay` - The workspace credential helper script
- `CONTRIBUTING.md` - Development workflow guidelines
