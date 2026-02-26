# Workflow Run Log

## Goals

1. `relay.integration-tests.yaml` → runs to completion
2. `relay.workflow-hardening.yaml` → runs to completion

## Fixes Already Applied (pre-run)

- `requestTimeoutMs: 60_000` in runner for spawn operations
- Spawn stagger: 2s delay × step index when wave > 3 steps
- Broker name uniqueness: `<project>-<runId[0:8]>` per run
- Preflight: ignores `.trajectories/` and `relay.integration-tests.yaml`
- Channel posts: task content stripped, only assignment notification sent
- `waitForExitWithIdleNudging` bug: exit-wait window expiry was incorrectly returned as step timeout

---

## Run Attempt Log

### Run 1 — relay.integration-tests.yaml

**Result:** Failed at design step after ~3 minutes
**Error:** `Step "design" timed out after undefinedms`
**Root cause:** `waitForExitWithIdleNudging` bug — when the `nudgeAfterMs` window (3 min) expired without the agent exiting, `agent.waitForExit(nudgeAfterMs)` returned `'timeout'`, and the `result.source === 'exit'` branch immediately propagated that as a step timeout. The agent was still running; the runner abandoned it prematurely.
**Fix applied:** Check `result.result !== 'timeout'` before returning from the exit branch; loop when window expires.
**Secondary issue:** `nudgeAfterMs: 180000` (3 min) too short for agents reading 5 files. Increased to 600000 (10 min).

---

### Run 2 — relay.integration-tests.yaml (9-hour run)

**Result:** Still running after 9 hours, manually killed
**Duration log entries:** `[workflow 00:00]` → `[workflow 07:27]` (log stopped updating after wave 2 partial failure)

#### Issue 1: Design step took 6 hours

- Director (opus) was asked to read 5 files and produce a comprehensive spec
- Agent posted the spec to `#integration-tests` in **217 separate Relaycast messages**
- Each message round-trips to the Relaycast API (~2–3s each) = 7–10 minutes for channel publishing alone
- The 6-hour duration was the agent producing a very large spec, compacting context multiple times, and serializing output slowly over the channel
- **Root cause:** Task was too open-ended; agent produced far more output than needed
- **Fix needed:** Design step task must be scoped tightly; output written to a file, not 217 channel messages

#### Issue 2: Wave 2 — 7 of 10 agents failed to spawn (60s timeout)

- Stagger worked for first 3 agents (harness-lead, harness-util, harness-tests at 06:03–06:07)
- Agents 4–10 all hit `request timed out after 60000ms (type='spawn_agent')`
- **Root cause:** After 6 hours running the design step, broker had accumulated state (channel history, relay connections, open PTYs from the 3 already-spawned agents). Relaycast registration for subsequent agents timed out because the broker/API was saturated
- **Fix needed:** Don't spawn 10 agents in one wave when 3 are already running. Max concurrency of 5 is still too high when agents are long-running and holding resources

#### Issue 3: Codex agents in interactive PTY mode never exit

- `harness-util` (codex/gpt-5.3-codex) and `harness-tests` (codex/gpt-5.3-codex-spark) had been running for 9+ hours
- Neither produced `/exit` or any completion signal
- `harness-lead` (claude/sonnet) also stuck — waiting for workers that never completed
- **Root cause:** Codex in interactive PTY mode does not reliably output `/exit` on its own line when finished. The broker detects `/exit` at line 243 of `pty_worker.rs`:
  `clean_text.lines().any(|line| line.trim() == "/exit")`
  Codex may complete its task but output `/exit` embedded in other text, not on its own line, or not at all — depending on the model and prompt format
- **Fix needed:** Codex workers for implementation tasks should use `interactive: false` (one-shot subprocess mode). Only use interactive PTY for agents that need real-time relay messaging (claude leads that coordinate via channels)

#### Issue 4: Channel message flooding back to agents

- All 10 wave-2 agents join `#integration-tests`
- WorkflowRunner posts status updates to `#integration-tests` (preflight passed, step started, step assigned, etc.)
- The design step's 217 output messages also went to `#integration-tests`
- Every agent on the channel receives all of these as injected relay messages
- This creates noise in the agent's context, consuming tokens and potentially confusing the agent
- **Fix needed:** Agents should only join their team-specific track channel, not the main workflow channel. The workflow channel should be reserved for WorkflowRunner status and lead agents

---

## Root Cause Summary

The core design assumption — **interactive codex workers coordinating via relay channels** — does not work reliably because:

1. Codex does not reliably self-terminate with `/exit` on its own line in interactive PTY mode
2. Interactive codex agents accumulate in the broker indefinitely, exhausting spawn capacity
3. The team-of-teams pattern requires all team members to be running simultaneously, but long-running interactive agents prevent new agents from spawning

## Required Redesign

### Rule: Codex workers must be `interactive: false`

Non-interactive mode (`interactive: false`) runs codex as a one-shot subprocess:

- Gets task as CLI argument
- Runs, produces output, exits with code 0/1
- Output captured via stdout
- No PTY, no relay messaging, no `/exit` dependency
- No broker saturation from long-running processes

### Rule: Only claude leads use interactive PTY

Claude Code reliably outputs `/exit` when it completes a task. Use interactive claude for:

- Coordinating leads that need to review worker output
- Agents that need real-time relay messaging
- Any step that requires back-and-forth decision making

### Rule: Workers get their full spec in the task prompt

Non-interactive workers can't read from channels. Their task prompt must contain everything they need. This means the team-pattern changes:

- Lead (interactive claude): reads context, produces spec, passes it via step output chaining to workers
- Workers (non-interactive codex): receive full spec in task string via `{{steps.lead.output}}`
- Lead reviews worker output files directly (reads filesystem, no channel coordination needed)

### Rule: Reduce wave parallelism for long-running steps

When steps are expected to run for 30+ minutes, limit wave concurrency to 2–3 max. The broker holds PTY connections for the duration of each step; spawning 10 simultaneously is never safe.

---

## Next Steps

- [ ] Redesign `relay.integration-tests.yaml` using the above rules
- [ ] Test with a single simple pipeline first (director → 1 worker → compile → review)
- [ ] Only scale to multi-team once single pipeline proven stable
- [ ] Update `relay.workflow-hardening.yaml` with same constraints

---

## Codex Exit Experiments

Five targeted workflows to determine how to reliably get codex to exit
in interactive PTY mode. Run them in order; stop when one works reliably.

### Experiments

| File                                      | Strategy                  | Mechanism                                                             |
| ----------------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| `relay.codex-exit-v1-prompt.yaml`         | Explicit prompt           | Codex outputs `/exit` from task instructions alone                    |
| `relay.codex-exit-v2-lead-relay.yaml`     | Lead relay DM             | Claude lead DMs codex "output /exit now" after TASK_DONE signal       |
| `relay.codex-exit-v3-file-sentinel.yaml`  | File + /exit              | Codex writes `/tmp/codex-exit-test/sentinel.txt` then outputs `/exit` |
| `relay.codex-exit-v4-noninteractive.yaml` | Non-interactive (control) | `interactive: false` — `codex exec` one-shot, exits naturally         |
| `relay.codex-exit-v5-self-release.yaml`   | Self-release via relay    | Codex calls `relay_release()` on own agent name via MCP tool          |

### How to run

```bash
# Run one at a time, watch logs
node packages/sdk/dist/workflows/cli.js tests/workflows/codex-exit/relay.codex-exit-v1-prompt.yaml
node packages/sdk/dist/workflows/cli.js tests/workflows/codex-exit/relay.codex-exit-v2-lead-relay.yaml
node packages/sdk/dist/workflows/cli.js tests/workflows/codex-exit/relay.codex-exit-v3-file-sentinel.yaml
node packages/sdk/dist/workflows/cli.js tests/workflows/codex-exit/relay.codex-exit-v4-noninteractive.yaml
node packages/sdk/dist/workflows/cli.js tests/workflows/codex-exit/relay.codex-exit-v5-self-release.yaml
```

### What to observe

- Did the `do-task` / `codex-task` step complete without timeout?
- Did it complete via `/exit` detection, process exit, or force-release?
- How long did it take from task completion to step marked done?
- For V5: did `relay_release` appear in codex output? Did it work?

### Results Log

| Experiment           | Status     | Notes                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 - Explicit prompt | ✅ works   | Completed in 23s. Codex output `/exit` on its own line from prompt alone.                                                                                                                                                                                                                                                                            |
| V2 - Lead relay DM   | ✅ works   | codex-task done in 20s, lead-monitor done in 69s. Codex responded to relay DM and /exited. Note: broker logged "unknown worker" on release (codex already exited before runner cleanup).                                                                                                                                                             |
| V3 - File sentinel   | ⚠️ partial | Codex /exited correctly in 20s, but sentinel file was NOT written (VERIFY_FAILED). Codex skipped the file-write and went straight to /exit. Exit mechanism works; file delivery did not.                                                                                                                                                             |
| V4 - Non-interactive | ✅ works   | Fastest: 10s total. Clean output, process exited naturally. No /exit needed. Cleanest solution.                                                                                                                                                                                                                                                      |
| V5 - Self-release    | ✅ works   | 31s. Broker log: "released worker via relaycast". Required: (1) remove "no MCP tools" restriction from runner.ts injection, (2) add remove_agent hint to helpers.rs, (3) use plain `remove_agent` not `mcp__relaycast__remove_agent`, (4) read name from `$RELAY_AGENT_NAME`, (5) no /exit fallback (codex always prefers it when given the option). |
