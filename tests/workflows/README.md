# Workflow Experiment Tests

Targeted single-concern workflow YAMLs that test specific agent behaviors.
Run individually to verify a mechanism works before using it in production workflows.

## Structure

```
tests/workflows/
├── codex-exit/       # How to get interactive codex to self-terminate
└── codex-lead/       # Codex as lead coordinating claude workers
```

## How to run

```bash
node packages/sdk/dist/workflows/cli.js tests/workflows/<dir>/<file>.yaml
```

> **Important:** Run from a regular terminal, not from inside a Claude Code session.
> Claude Code blocks nested `claude` processes — any workflow with a claude agent
> will hang indefinitely when launched from the Claude Code bash tool.

---

## codex-exit — Exit mechanism experiments

Tests which termination strategy reliably gets interactive codex to exit.

| File                                      | Strategy                           | Result                      | Time    |
| ----------------------------------------- | ---------------------------------- | --------------------------- | ------- |
| `relay.codex-exit-v1-prompt.yaml`         | Explicit prompt with example block | ✅ works                    | 23s     |
| `relay.codex-exit-v2-lead-relay.yaml`     | Claude lead DMs codex to /exit     | ✅ works                    | 20s/69s |
| `relay.codex-exit-v3-file-sentinel.yaml`  | File write + /exit                 | ⚠️ exit works, file skipped | 20s     |
| `relay.codex-exit-v4-noninteractive.yaml` | `interactive: false` (control)     | ✅ fastest                  | 10s     |
| `relay.codex-exit-v5-self-release.yaml`   | `remove_agent` MCP tool            | ✅ works                    | 31s     |

**Recommendation:** Use `interactive: false` for any codex worker that doesn't need real-time relay messaging. Use explicit prompt (V1 pattern) when interactive mode is required.

---

## codex-lead — Codex lead + claude worker experiments

Tests whether codex can reliably act as a lead agent coordinating claude workers.

| File                                              | Strategy                                          | Result     | Time |
| ------------------------------------------------- | ------------------------------------------------- | ---------- | ---- |
| `relay.codex-lead-v1-basic-coord.yaml`            | Channel-based assignment + completion signal      | ⬜ not run |      |
| `relay.codex-lead-v2-step-chaining.yaml`          | Codex reviews claude output via step chaining     | ⬜ not run |      |
| `relay.codex-lead-v3-multi-worker.yaml`           | Codex coordinates 2 parallel claude workers       | ⬜ not run |      |
| `relay.codex-lead-v4-noninteractive-workers.yaml` | Codex reviews 2 non-interactive claude workers    | ⬜ not run |      |
| `relay.codex-lead-v5-dm-worker.yaml`              | Codex DMs worker directly (not channel broadcast) | ⬜ not run |      |
