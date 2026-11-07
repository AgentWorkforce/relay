# `@agent-relay/evals` — Package Extraction Scope

## Why extract

The relay eval harness is currently embedded in `tests/integration/broker/evals/`. Three other repos need the same infrastructure:

| Repo            | Current situation                                              | What they need                                                    |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| relay           | source of truth                                                | owns the harness, keeps relay-specific scenarios                  |
| pear            | no eval infra                                                  | i01/i02 .integrations scenarios (live agent + filesystem scoring) |
| agent-assistant | separate telemetry eval system (fixture-based, no live agents) | protocol compliance evals for assistant agents                    |
| relayfile       | VFS contract unit tests (no live agents)                       | not relevant — different eval type                                |

The relayfile and agent-assistant eval systems are different in kind (no live broker, no agent spawn) and don't need this package. The extraction is primarily relay → pear path, with agent-assistant as a later consumer.

---

## What moves into the package

### Core (must move)

```
packages/evals/src/
  types.ts          # EvalScenario, ScenarioResult, ScenarioContext, MetricSet, EvalReport
  runner.ts         # parseHarnessSpec, runScenario, repeat/majority-vote logic
  harness.ts        # BrokerHarness (currently tests/integration/broker/utils/broker-harness.ts)
  scoring/
    base.ts         # baseScore(), phantom detection
    lifecycle.ts    # scoreSpawn(), scoreRelease()
  scenarios/
    helpers.ts      # STARTUP_MS, RESPONSE_MS, waitForSends()
    onboarding.ts   # OnboardingVariant, onboardingText()
    s01-spawn-worker.ts
    s02-release-worker.ts
    s03-spawn-release-lifecycle.ts
    s04-no-native-subagents.ts
  report/
    html.ts         # HTML report generator
    json.ts         # JSON report serialisation
```

`s01–s04` are the shared protocol compliance baseline — any relay-connected agent should pass these. They ship with the package.

### Stays in relay (repo-specific)

```
tests/integration/broker/evals/scenarios/
  s05-phrasing-variants.ts   # relay-specific vocabulary testing
  s06-auto-routing.ts        # --auto Director testing
  run-opencode-models.sh     # batch eval driver
```

### Moves into pear (new, not yet built)

```
tests/evals/scenarios/
  i01-integrations-discovery.ts   # Linear .integrations read + writeback
  i02-integrations-event-reaction.ts  # Slack integration event handling
```

---

## Package structure

```
packages/evals/
  package.json        # name: "@agent-relay/evals"
  tsconfig.json
  src/
    index.ts          # re-exports all public types + utilities
    ...               # (as above)
```

`package.json` dependencies:

```json
{
  "name": "@agent-relay/evals",
  "dependencies": {
    "@agent-relay/harness-driver": "workspace:*"
  },
  "peerDependencies": {
    "typescript": ">=5.0"
  },
  "exports": {
    "./types": "./src/types.ts",
    "./runner": "./src/runner.ts",
    "./harness": "./src/harness.ts",
    "./scoring/base": "./src/scoring/base.ts",
    "./scoring/lifecycle": "./src/scoring/lifecycle.ts",
    "./scenarios/helpers": "./src/scenarios/helpers.ts",
    "./scenarios/onboarding": "./src/scenarios/onboarding.ts",
    "./scenarios/core": "./src/scenarios/index.ts"
  }
}
```

---

## Consumer pattern

Each product repo has a thin `tests/evals/runner.ts` that imports core and adds its own scenarios:

```typescript
// pear/tests/evals/runner.ts
import { runScenarios } from '@agent-relay/evals/runner';
import { LIFECYCLE_EVAL_SCENARIOS } from '@agent-relay/evals/scenarios/core';
import { scenario as integrationsDiscovery } from './scenarios/i01-integrations-discovery.js';
import { scenario as integrationEventReaction } from './scenarios/i02-integrations-event-reaction.js';

await runScenarios(
  [
    ...LIFECYCLE_EVAL_SCENARIOS, // shared protocol baseline
    integrationsDiscovery,
    integrationEventReaction,
  ],
  { harness: process.env.EVAL_HARNESS ?? 'claude', repeat: 3 }
);
```

---

## Migration steps

1. **Create `packages/evals/`** in the relay monorepo with the files above.
2. **Update imports in relay** — `tests/integration/broker/evals/` switches from local `../utils/broker-harness` to `@agent-relay/evals/harness`.
3. **Publish** — add to relay's workspace packages and bump the version in `packages/evals/package.json`.
4. **Add dependency in pear** — `"@agent-relay/evals": "^8.x"` in pear's `package.json`.
5. **Wire pear scenarios** — implement `tests/evals/runner.ts` using the consumer pattern above.
6. **Add to CI** — pear's CI runs `npm run evals` after broker smoke tests pass.

---

## Blockers / pre-conditions

- **Stabilise the runner first.** `parseHarnessSpec`, the opencode batch infrastructure, and the scoring model are still actively changing (Phase 2 evals not yet run). Extract after Phase 2 is complete and the runner API has settled.
- **`BrokerHarness` has relay-specific assumptions** — it talks to a local broker binary path. The harness constructor needs a configurable broker path before pear can use it without forking.
- **i01/i02 scenarios need filesystem scoring** beyond what `baseScore()` provides. The `ScenarioResult` type already supports this (via `protocolAdherence` and `notes`), but the pear runner needs the extra `scoreWriteback()` helper (already written in the scenario files).

---

## What this does NOT solve

- relayfile evals (VFS contract tests) — different architecture, no broker, stays in relayfile.
- agent-assistant telemetry evals — fixture-based output quality tests, not protocol compliance; stays in `@agent-assistant/telemetry`.
- The eval HTML reports are relay-specific and stay in relay. Pear would get JSON output only until someone wires up an HTML reporter there.

---

## Recommended timing

Start the extraction after:

1. Phase 2 opencode evals are complete (runner API stable)
2. PR #1100-series lands (lifecycle test infrastructure confirmed)

Estimated effort: **~1 day** for the package creation + relay migration, **~half day** for pear wiring.
