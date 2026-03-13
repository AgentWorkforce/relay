---
name: using-beads-bv
description: Use when coordinating dependency-aware task planning with beads (bd) CLI and bv graph sidecar - covers ready work selection, priority management, and robot flags for deterministic outputs
---

# Using Beads and bv

## Overview

Beads provides a lightweight, dependency-aware issue database. The `bd` CLI manages tasks, while `bv` provides graph metrics and execution planning.

**Project:** [steveyegge/beads](https://github.com/steveyegge/beads)

## When to Use

- Coordinating multi-agent work with dependencies
- Finding ready work (no blockers)
- Priority management and task sequencing
- Understanding project graph metrics

**Don't use:** Simple single-session tasks (use TodoWrite instead).

## Quick Reference

| Command | Description |
|---------|-------------|
| `bd ready` | Show issues ready to work (no blockers) |
| `bd list --status=open` | All open issues |
| `bd list --status=in_progress` | Active work |
| `bd show <id>` | Issue details with dependencies |
| `bd create --title="..." --type=task` | Create new issue |
| `bd update <id> --status=in_progress` | Claim work |
| `bd close <id>` | Mark complete |

## bv Robot Flags (AI Sidecar)

**CRITICAL:** Always use `--robot-*` flags. The interactive TUI will block your session!

```bash
bv --robot-help          # All AI-facing commands
bv --robot-insights      # JSON graph metrics (PageRank, critical path, cycles)
bv --robot-plan          # JSON execution plan with parallel tracks
bv --robot-priority      # Priority recommendations with reasoning
bv --robot-recipes       # List available recipes
bv --robot-diff --diff-since <commit>  # Changes since commit/date
```

### Example: Get Execution Plan

```bash
bv --robot-plan
```

Returns JSON with:
- Parallel tracks (what can run concurrently)
- Items per track
- Unblocks lists (what each completion frees up)

## Common Workflows

### Starting Work

```bash
bd ready                                  # Find available work
bd show <id>                              # Review issue details
bd update <id> --status=in_progress       # Claim it
```

### Completing Work

```bash
bd close <id1> <id2> ...                  # Close completed issues
bd sync                                   # Push to remote
```

### Creating Dependent Work

```bash
bd create --title="Implement feature X" --type=feature --priority=P2
bd create --title="Write tests for X" --type=task --priority=P2
bd dep add <tests-id> <feature-id>        # Tests depend on feature
```

## Priority Levels

Use numeric priorities (NOT "high"/"medium"/"low"):

| Priority | Use Case |
|----------|----------|
| P0 | Critical - blocking everything |
| P1 | High - needs immediate attention |
| P2 | Medium - standard work |
| P3 | Low - nice to have |
| P4 | Backlog - future consideration |

## Conventions

- **Single source of truth:** Use Beads for task status/priority/dependencies
- **Shared identifiers:** Use beads issue ID (e.g., `agent-relay-123`) in commit messages
- **Message subjects:** Prefix with `[agent-relay-123]` for traceability

## Session Close Protocol

Before ending any session:

```bash
bd sync                 # Commit beads changes
git add <files>         # Stage code changes
git commit -m "..."     # Include bd-### in message
bd sync                 # Commit any new beads changes
git push                # Push to remote
```

## Anti-Patterns

| Mistake | Fix |
|---------|-----|
| Using `bv` without robot flags | Always use `--robot-*` flags |
| Managing tasks in markdown | Use `bd` as single task queue |
| Missing issue IDs in commits | Always include `bd-###` |
| Using high/medium/low priority | Use P0-P4 numeric format |
