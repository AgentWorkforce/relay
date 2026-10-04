# PLAN — workflow hardening and diagnosis

## Goal
Create a workflow that identifies, reproduces, and helps iron out workflow execution problems discovered during real runs.

## Problems to target
1. Agent planning fragility
   - Claude plan steps can fail, idle, or return low-quality output.
   - Workflows should support deterministic plan docs or strict validation gates.

2. Active checkout vs hard-coded path issues
   - Agents/workflow steps must operate against the current checkout/worktree, not fixed absolute repo paths.

3. Missing workflow assets
   - Plan docs and helper files must be present and validated early.

4. Opaque validation/build phases
   - Large monolithic rebuild steps hide the real failing sub-step.
   - Steps should be split for observability.

5. Environment drift / local state problems
   - stale `.agent-relay/`
   - PATH shadowing
   - tracked `.trajectories` causing false dirty states
   - SSH/fetch issues that affect reruns

6. Build-tooling assumptions
   - package builds that rely on ambient tool resolution instead of deterministic invocation

## Desired outcome
A workflow that:
- uses Claude for plan/research
- uses Codex for implementation
- records environment diagnostics up front
- validates required workflow assets before agent work begins
- verifies the active checkout/worktree path before implementation
- splits build/validation into explicit steps
- produces review output with actionable distinctions:
  - workflow flaw
  - repo/tooling flaw
  - environment-specific issue

## Acceptance criteria
- Workflow file added to repo
- Supporting deterministic plan/research doc added
- New PR opened
