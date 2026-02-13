---
name: deploying-to-staging-environment
description: Use when deploying changes to staging across relay, relay-dashboard, and relay-cloud repos - coordinates multi-repo branch syncing using git worktrees, automatically triggers staging deployments via GitHub Actions
---

# Deploying to Staging Environment

## Overview

The staging environment deployment is a coordinated multi-repo process that synchronizes code across three repositories (relay, relay-dashboard, relay-cloud) and automatically triggers deployment via GitHub Actions. Staging deployments ensure feature verification before production while keeping main branch clean during development.

## When to Use

- **Integrating features across repos** - Multiple components depend on changes in different repos
- **Testing feature branches together** - Verify feature branch changes don't break integration
- **Promoting main to staging** - Standard sync to keep staging up-to-date with latest main
- **Verifying deployment readiness** - Test infrastructure changes or deployment workflows
- **Cross-team coordination** - Share feature branches for integration testing

**When NOT to use:**
- Emergency hotfixes (use production deployment instead)
- Single-repo changes only (push directly if not blocking other repos)
- Testing without intent to deploy (use local environment instead)

## Architecture

The staging deployment system consists of:

```
Three Repos (relay, relay-dashboard, relay-cloud)
    ↓
Staging Branches (synced via git push)
    ↓
relay-cloud staging push triggers GitHub Actions
    ↓
Deploy-Staging Workflow (deploy-staging.yml)
    ↓
Fly.io Staging Environment (agent-relay-staging)
    ↓
Automatic health check verification
```

**Key details:**
- Each repo has independent staging branch
- relay-cloud staging branch push triggers automatic deployment
- Workflow accepts optional relay/dashboard branch overrides
- Falls back to main if specified branch doesn't exist
- Workspace image builds in parallel with API deployment

## Quick Reference

### Standard Workflow (All Repos)

```bash
# 1. Create git worktree for staging work (BEST PRACTICE)
cd /data/repos/relay
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push

# 2. Push latest main to staging (fetch fresh)
git fetch origin main:main
git push origin main:staging

# 3. Or push current feature branch to staging (if desired)
git fetch origin feature/your-branch:feature/your-branch
git push origin feature/your-branch:staging

# 4. Clean up worktree
cd /data/repos/relay
git worktree remove .worktrees/staging-push
```

### Relay-Dashboard

```bash
cd /data/repos/relay-dashboard
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push
git fetch origin main:main
git push origin main:staging
cd /data/repos/relay-dashboard
git worktree remove .worktrees/staging-push
```

### Relay-Cloud (Triggers Deployment)

```bash
cd /data/repos/relay-cloud
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push
git fetch origin main:main
git push origin main:staging
# ⚠️ This push triggers deploy-staging.yml workflow
cd /data/repos/relay-cloud
git worktree remove .worktrees/staging-push
```

## Implementation

### Why Git Worktrees?

Git worktrees provide several benefits for staging workflows:

1. **Isolation** - Work on staging without changing main working directory state
2. **Safety** - Feature branch checked out in worktree won't affect your current work
3. **Cleanliness** - No lingering state changes after pushing
4. **Best practice** - Standard DevOps approach for multi-branch operations

### Step-by-Step Deployment Process

#### Prerequisites
- Access to all three repos with push permission
- Current working directory: one of the repos
- No uncommitted changes blocking worktree creation

#### Execute Staging Push Across All Repos

**Step 1: Relay**
```bash
cd /data/repos/relay
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push
git fetch origin main:main
git push origin main:staging
cd /data/repos/relay
git worktree remove .worktrees/staging-push
```

Expected output:
```
Updated 'main' to 'origin/main'
remote: Create pull request for staging...
To github.com:AgentWorkforce/relay.git
 [new branch]      main -> staging
or
 * [up-to-date]    main -> staging
```

**Step 2: Relay-Dashboard**
```bash
cd /data/repos/relay-dashboard
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push
git fetch origin main:main
git push origin main:staging
cd /data/repos/relay-dashboard
git worktree remove .worktrees/staging-push
```

**Step 3: Relay-Cloud (Triggers Deployment)**
```bash
cd /data/repos/relay-cloud
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push
git fetch origin main:main
git push origin main:staging
# Deployment starts automatically!
cd /data/repos/relay-cloud
git worktree remove .worktrees/staging-push
```

#### Verify Deployment

After pushing relay-cloud, GitHub Actions starts automatically:

1. **Watch workflow progress:**
   - Go to: https://github.com/AgentWorkforce/relay-cloud/actions
   - Find "Deploy (Staging)" workflow run
   - Check that both jobs pass:
     - "Deploy to Staging" (Fly.io deployment)
     - "Build Staging Workspace" (Docker image build)

2. **Verify health check:**
   - Workflow runs `curl https://agent-relay-staging.fly.dev/health`
   - Expected: 200 response within 150 seconds
   - Retries 30 times with 5-second intervals

3. **Check deployment summary:**
   - Click workflow run
   - View "Deployment Summary" in step summary
   - Confirms deployment to agent-relay-staging

### Pushing Feature Branches to Staging

Instead of main, push a specific feature branch:

```bash
cd /data/repos/relay
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push
git fetch origin feature/your-feature:feature/your-feature
git push origin feature/your-feature:staging
cd /data/repos/relay
git worktree remove .worktrees/staging-push
```

**For relay-cloud with custom relay/dashboard branches:**

The deploy-staging.yml workflow accepts optional inputs to specify exact branches:

```bash
# Push relay-cloud staging (will trigger GitHub Actions with inputs)
cd /data/repos/relay-cloud
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push
git fetch origin feature/custom-branch:feature/custom-branch
git push origin feature/custom-branch:staging
cd /data/repos/relay-cloud
git worktree remove .worktrees/staging-push
```

Then manually trigger with specific branches:
- Go to: https://github.com/AgentWorkforce/relay-cloud/actions/workflows/deploy-staging.yml
- Click "Run workflow"
- Enter: `relay_branch` and `dashboard_branch` (optional)
- Confirm run starts

## Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| Pushing from dirty working tree | Worktree creation fails with error | Commit or stash changes before creating worktree |
| Forgetting to remove worktree | Accumulates worktree directories | Always run `git worktree remove .worktrees/staging-push` after pushing |
| Pushing staging without relay/dashboard | Deployment uses outdated relay/dashboard | Coordinate all three repos or use GitHub Actions inputs to override |
| Not fetching fresh ref | Pushes stale local branch state | Always `git fetch origin branch:branch` before pushing |
| Confusing staging branch direction | Push main→staging, not staging→main | Remember: feature work → staging branch, for promotion/testing |
| Assuming all repos auto-sync | relay/dashboard changes don't auto-trigger | Only relay-cloud staging push triggers deployment |
| Not checking health status | Deployment may fail silently | Always verify workflow completes and health check passes |
| Creating worktrees in wrong directory | Path confusion for multiple repos | Each repo is separate; create worktrees within that repo's .worktrees/ |

## Workflow Details

### deploy-staging.yml Behavior

**Triggers:**
- Manual push to staging branch (automatic)
- GitHub Actions workflow_dispatch (manual with optional inputs)

**Optional Workflow Inputs:**
- `relay_branch` - Override which relay branch to deploy (defaults to current staging branch)
- `dashboard_branch` - Override which relay-dashboard branch to deploy (defaults to current staging branch)
- Falls back to main if specified branch doesn't exist in remote

**Deployment Steps:**
1. Checkout relay-cloud repository
2. Determine relay branch (input or current, fallback to main)
3. Determine dashboard branch (input or current, fallback to main)
4. Setup Fly CLI
5. Deploy to Fly.io with `flyctl deploy`
6. Verify health check endpoint
7. Create deployment summary

**Environment:** staging (requires GitHub Actions environment secrets)

### Deployment Success Criteria

✅ All checks passed:
- [ ] "Deploy to Staging" job completes
- [ ] "Build Staging Workspace" job completes
- [ ] Health check succeeds (HTTP 200 from /health endpoint)
- [ ] Deployment summary shows all expected values

❌ Deployment failed:
- Workflow run shows red X
- Check step that failed in workflow logs
- Common failures: auth (secrets), health check timeout, Docker build error

## Real-World Workflow

**Scenario:** Feature across all three repos ready for integration testing

```bash
# 1. Ensure local main branches are up-to-date
cd /data/repos/relay
git fetch origin main

cd /data/repos/relay-dashboard
git fetch origin main

cd /data/repos/relay-cloud
git fetch origin main

# 2. Push relay main to staging (using worktree)
cd /data/repos/relay
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push
git push origin main:staging
cd ..
git worktree remove .worktrees/staging-push

# 3. Push relay-dashboard main to staging
cd /data/repos/relay-dashboard
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push
git push origin main:staging
cd ..
git worktree remove .worktrees/staging-push

# 4. Push relay-cloud main to staging (triggers deployment)
cd /data/repos/relay-cloud
git worktree add .worktrees/staging-push main
cd .worktrees/staging-push
git push origin main:staging
cd ..
git worktree remove .worktrees/staging-push

# 5. Monitor deployment
echo "Check: https://github.com/AgentWorkforce/relay-cloud/actions"
# Wait for "Deploy (Staging)" workflow to complete
# Verify health check passes
# Access staging at: https://agent-relay-staging.fly.dev
```

## Troubleshooting

### Worktree Errors

**Error: "fatal: 'main' already exists"**
```
Solution: git worktree remove .worktrees/staging-push
         (if worktree from previous run still exists)
```

**Error: "fatal: cannot checkout branch into locked working tree"**
```
Solution: Ensure main branch isn't checked out in primary working tree
         git status (confirm different branch is checked out)
```

### Deployment Failures

**Health check timeout after 150s**
```
Problem: Staging environment took too long to become healthy
Solution: - Check Fly.io logs: flyctl logs --app agent-relay-staging
         - Restart app: flyctl restart --app agent-relay-staging
         - Check for build errors in workflow logs
         - Look for startup errors in deployment step
```

**Docker build fails**
```
Problem: "Build Staging Workspace" job failed
Solution: - Check docker-staging.yml workflow logs
         - Verify Dockerfile exists and is valid
         - Check for resource/dependency issues
         - Rebuild locally to verify docker configuration
```

**Branch not found fallback to main**
```
Problem: Workflow says "using main" for your custom branch
Reason: Specified branch doesn't exist in relay/relay-dashboard
Solution: - Verify branch name is exact (case-sensitive)
         - Ensure branch exists in remote (git ls-remote origin)
         - Use GitHub Actions workflow_dispatch with correct inputs
```

## Dependencies & Requirements

**Git:** Worktree feature (Git 2.5+, standard on all modern systems)

**Permissions:** Push access to all three repos:
- github.com:AgentWorkforce/relay
- github.com:AgentWorkforce/relay-dashboard
- github.com:AgentWorkforce/relay-cloud

**GitHub Secrets (relay-cloud):**
- `CROSS_REPO_TOKEN` - PAT with repo access across all three repos
- `FLY_API_TOKEN` or `FLY_API_TOKEN_STAGING` - Fly.io deployment token

**Environment:** staging (configured in relay-cloud)

---

**Key Principle:** Use git worktrees for clean, isolated branch operations. Push coordination across repos, with relay-cloud staging push triggering automatic deployment.
