# Super-Powered Ralph Loops

These workflows are the agent-relay take on the [Ralph Wiggum technique](https://github.com/mikeyobrien/ralph-orchestrator) — autonomous AI agents looping on a codebase until work is done. Where vanilla ralph runs one agent at a time, these workflows run **squads of specialists** with real quality gates, multi-model assignment, and observable coordination.

## What makes these different

| Vanilla Ralph                  | agent-relay Ralph                                                   |
| ------------------------------ | ------------------------------------------------------------------- |
| 1 agent per loop               | 2–10 agents per loop                                                |
| Single model                   | Multi-model (opus plans, sonnet leads, codex builds, gemini audits) |
| Agent checks its own work      | Independent reviewer with no confirmation bias                      |
| Polling for completion signals | DAG-based wave scheduling with verification gates                   |
| No parallelism                 | Workers implement features simultaneously                           |
| One retry strategy             | Per-step `maxIterations` + global `errorHandling`                   |
| No observability               | Trajectories, Relaycast channels, step output chaining              |

---

## `ralph-tdd.yaml` — Test-Driven Loop

**Best for:** Projects with an existing test framework where correctness is the priority.

```
architect writes failing tests
         ↓
builder implements to pass them (maxIterations: 3)
         ↓
npm test / pytest / go test  ←── deterministic gate
         ↓
arch-review ──┐
              ├── both must PASS (consensus: unanimous)
sec-review  ──┘
         ↓
address feedback (maxIterations: 2)
         ↓
commit + record learnings → next story
```

**Key agents:** 3 (architect/sonnet, builder/codex, reviewer/opus)
**Key feature:** Tests are written BEFORE implementation. Reviewer is separate from architect — no confirmation bias.

```bash
PRD_PATH=my-prd.json QUALITY_CMD="npm test" \
  node packages/sdk/dist/workflows/cli.js ralph-tdd.yaml
```

---

## `ralph-swarm.yaml` — Parallel Implementation Squad

**Best for:** Large backlogs where work can be decomposed into independent tasks.

```
tech-lead decomposes PRD into 5 atomic tasks
         ↓
worker-1 ──┐
worker-2   │
worker-3   ├── all 5 implement in parallel
worker-4   │
worker-5 ──┘
         ↓
npm test / tsc / lint  ←── gate
         ↓
fix-failures (if gate red)
         ↓
review-correctness ──┐
review-architecture  ├── all 3 must PASS
review-security    ──┘
         ↓
consensus → address rework → commit → loop
```

**Key agents:** 10 (opus tech-lead, 5 codex workers, 2 claude reviewers, gemini security auditor)
**Key feature:** 5x parallelism. Three independent reviewers. Gemini on security catches what Claude misses.

```bash
PRD_PATH=my-prd.json \
  node packages/sdk/dist/workflows/cli.js ralph-swarm.yaml
```

---

## `ralph-overnight.yaml` — 24-Hour Autonomous Session

**Best for:** Long sessions where you want to drop a repo before bed and wake up to PRs.

```
product-manager reads backlog, prioritizes, assigns to squads
         ↓
tech-lead plans architecture, creates feature branch
         ↓
squad-alpha (lead + 2 codex builders) ──┐
                                         ├── parallel on different files
squad-beta  (lead + 2 codex builders) ──┘
         ↓
full CI gate (lint + tsc + npm test)
         ↓
qa-engineer writes integration tests ──┐
                                        ├── parallel
security-auditor (gemini) audits     ──┘
         ↓
tech-lead reviews → fix if needed
         ↓
git push → gh pr create (draft)
         ↓
PM writes session-log.txt morning summary
→ mark stories complete → next batch
```

**Key agents:** 10 (PM/opus, tech-lead/sonnet, 2 squad leads/sonnet, 4 codex builders, QA/sonnet, security/gemini-pro)
**Key feature:** True hierarchical org. PM → Tech Lead → Squads. Morning report written to `session-log.txt`. Runs safely overnight with `errorHandling: continue` (one story failure doesn't kill the session).

```bash
BACKLOG_PATH=my-backlog.json SESSION_LOG=session-log.txt \
  node packages/sdk/dist/workflows/cli.js ralph-overnight.yaml
```

---

## Running any of these

```bash
# Preview the execution plan without spending tokens
DRY_RUN=1 node packages/sdk/dist/workflows/cli.js ralph-tdd.yaml

# Run for real
node packages/sdk/dist/workflows/cli.js ralph-tdd.yaml

# Watch Relaycast for live agent communication
# → open https://relaycast.dev and join the workflow's channel
```

## PRD / Backlog format

These workflows expect a JSON file with your stories:

```json
{
  "branchName": "feature/my-project",
  "userStories": [
    {
      "id": "US-001",
      "title": "User can log in with email",
      "description": "Implement email/password authentication",
      "acceptanceCriteria": [
        "POST /auth/login returns 200 with JWT on valid credentials",
        "Returns 401 on invalid credentials",
        "Passwords are bcrypt hashed"
      ],
      "passes": false
    }
  ]
}
```

For `ralph-overnight.yaml`, use `backlog.json` with `priority` and `effort` fields.
