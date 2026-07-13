# Agent messaging evals

Confirms that, after changes to the broker, MCP server, injected protocol skill,
or an agent CLI, agents can still talk to each other and follow the messaging
protocol — and measures **how often agents fail to use the MCP/CLI to send
messages** (a "phantom message": prose like _"I'll tell Lead the result"_ with no
actual send).

Scoring is **deterministic**, derived entirely from broker events:

- `relay_inbound` (from an agent) = ground truth that a messaging tool was
  actually invoked.
- `worker_stream` = the agent's raw output, where phantom intent is detected.

## Tiers

- **`realistic`** (default benchmark) — natural-language prompts where messaging
  is incidental to real work. Nothing names a tool; the protocol must come from
  the production onboarding (injected skill + broker hints). This is what
  measures whether agents actually remember to message under realistic
  conditions. Results are probabilistic — use `--repeat=N` to get a stable rate.
- **`smoke`** — leading prompts that name the exact tool ("…call
  `mcp__agent-relay__send_dm`"). A plumbing canary that proves the
  broker→MCP→agent→scoring path works; near-100% by construction, so it does not
  measure protocol retention.

Select with `--tier=realistic|smoke|all` (default `realistic`).

## Metrics

| Metric                         | Meaning                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `messageSentRate`              | actual sends ÷ expected sends                               |
| `phantomRate` / `phantomCount` | forward-looking intents with no backing send                |
| `protocolAdherence`            | ACK-before-DONE, correct-channel reply                      |
| `deliverySuccessRate`          | scenarios with no dropped / ACL-denied deliveries           |
| `wrongChannelReplies`          | replies sent to a DM/other channel instead of the shown one |

## Running

```bash
# Scorer unit tests — no CLIs, fast, runs in normal CI via vitest
npm run eval:unit

# Negative control — proves the eval goes RED on a broken/absent messaging path.
# Deterministic, no real LLM (uses the `cat` shim), costs no tokens.
npm run eval:selftest

# Wrong-tool-name trap — flags onboarding that tells agents to call tools the
# MCP server doesn't register. Deterministic, no broker, no tokens.
npm run eval:toolcheck

# Live evals (spawn real agent CLIs) — gated, needs the broker binary + CLIs
npm run eval                 # realistic tier, default harness matrix
npm run eval:claude          # claude only, realistic tier
npm run eval:matrix          # claude, codex, gemini, grok

# Direct runner flags (after `npm run eval:build`)
cd tests/integration/broker
RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js \
  --harness=claude,codex --tier=realistic --repeat=3 --baseline=path.json
# or pin specific scenarios:
RELAY_INTEGRATION_REAL_CLI=1 node dist/evals/runner.js --scenario=r02-forget-to-report
```

Live runs require `RELAY_INTEGRATION_REAL_CLI=1`, the `agent-relay-broker` binary
(`target/debug/`), and the named CLI on `PATH`; missing CLIs are skipped, not
failed. `--scenario` accepts a comma-separated list of scenario ids.

## Reports & HTML viewer

Each run writes to `tests/integration/broker/evals-reports/` (gitignored):

- `report-<iso>-<harness>.json` — full machine-readable result.
- `report-<iso>-<harness>.html` — **self-contained viewer; open in a browser.**
  Shows the metric overview, and per scenario the agents + their task prompts and
  the full message transcript (who sent what to whom, and whether the agent
  responded — agent sends are right-aligned, injected stimulus left-aligned).
  Phantom messages are called out in red.
- `matrix-<iso>.{json,html}` — roll-up across harnesses (when more than one).

Pass `--baseline=<prior-report.json>` to fail the run on regression (phantom rate
up, send rate down). Regenerate HTML from any saved JSON report with:

```bash
npm run eval:html -- evals-reports/report-<iso>-<harness>.json
```

## Layout

- `scenarios/` — coordination tasks. Smoke: `01`–`04` (leading). Realistic:
  `r01-incidental-report` (work + report back), `r02-forget-to-report` (real task
  with the coordination ask at the end — the phantom risk), `r03-proactive-handoff`
  (decide to message a peer), `r04-channel-vs-dm` (reply where the conversation is).
- `scoring/` — pure functions over `BrokerEvent[]`: `phantom.ts`, `protocol.ts`,
  `metrics.ts`, `stream-clean.ts`, `base.ts`, `toolcheck.ts`. Unit-tested via
  `*.unit.test.ts`.
- `runner.ts` — harness × scenario matrix, tier selection, report writing, baseline diff.
- `report/` — JSON + HTML writers and `compareReports`.
- `selftest.ts` — negative control. `toolcheck-cli.ts` — wrong-tool-name trap.

## Adding a scenario

Add `scenarios/<id>.ts` exporting an `EvalScenario` (set `tier`), register it in
`scenarios/index.ts`, and build its `ScenarioResult` with the `scoring/` helpers
(`baseScore` for sends/phantoms/delivery/transcript, plus the relevant
`protocol.ts` check). Realistic scenarios must not name a tool in the prompt.
