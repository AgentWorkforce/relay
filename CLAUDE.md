# Agent Relay

Rust broker + TypeScript SDK for real-time agent-to-agent communication via Relaycast.

## Project Structure

```
relay/
  src/           # Rust broker binary (agent-relay)
  packages/sdk-ts/  # TypeScript SDK (@agent-relay/sdk)
  tests/         # Rust integration and stress tests
  docs/          # Mintlify documentation site
```

## Build

```bash
cargo build --release          # Rust broker
cd packages/sdk-ts && npm run build  # TypeScript SDK
```

## Test

```bash
cargo test                     # Rust tests
cargo clippy -- -D warnings    # Lint
cd packages/sdk-ts && npx tsc --noEmit  # SDK type check
```

# Git Workflow Rules

## NEVER Push Directly to Main

**CRITICAL: Agents must NEVER push directly to the main branch.**

- Always work on a feature branch
- Commit and push to the feature branch only
- Let the user decide when to merge to main
- Do not merge to main without explicit user approval

```bash
# CORRECT workflow
git checkout -b feature/my-feature
# ... do work ...
git add .
git commit -m "My changes"
git push origin feature/my-feature
# STOP HERE - let user merge

# WRONG - never do this
git checkout main
git merge feature/my-feature
git push origin main  # NO!
```

<!-- prpm:snippet:start @agent-workforce/trail-snippet@1.0.1 -->
# Trail

Record your work as a trajectory for future agents and humans to follow.

## Usage

If `trail` is installed globally, run commands directly:
```bash
trail start "Task description"
```

If not globally installed, use npx to run from local installation:
```bash
npx trail start "Task description"
```

## When Starting Work

Start a trajectory when beginning a task:

```bash
trail start "Implement user authentication"
```

With external task reference:
```bash
trail start "Fix login bug" --task "ENG-123"
```

## Recording Decisions

Record key decisions as you work:

```bash
trail decision "Chose JWT over sessions" \
  --reasoning "Stateless scaling requirements"
```

For minor decisions, reasoning is optional:
```bash
trail decision "Used existing auth middleware"
```

**Record decisions when you:**
- Choose between alternatives
- Make architectural trade-offs
- Decide on an approach after investigation

## Completing Work

When done, complete with a retrospective:

```bash
trail complete --summary "Added JWT auth with refresh tokens" --confidence 0.85
```

**Confidence levels:**
- 0.9+ : High confidence, well-tested
- 0.7-0.9 : Good confidence, standard implementation
- 0.5-0.7 : Some uncertainty, edge cases possible
- <0.5 : Significant uncertainty, needs review

## Abandoning Work

If you need to stop without completing:

```bash
trail abandon --reason "Blocked by missing API credentials"
```

## Checking Status

View current trajectory:
```bash
trail status
```

## Why Trail?

Your trajectory helps others understand:
- **What** you built (commits show this)
- **Why** you built it this way (trajectory shows this)
- **What alternatives** you considered
- **What challenges** you faced

Future agents can query past trajectories to learn from your decisions.
<!-- prpm:snippet:end @agent-workforce/trail-snippet@1.0.1 -->
