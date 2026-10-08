# Fix late fleet spawn confirmation and provide dispatch status reads

`fleet spawn` previously exhausted its two-minute confirmation budget while agents were still launching, then suggested redispatching without confirmation. Launches taking 1–5 minutes now have a six-minute default budget in the CLI and SDK. Explicit timeout overrides and the existing verified-spawn minimum remain supported.

Add `agent-relay fleet spawn-status <invocation-id>` to read the original spawn invocation without dispatching another worker. Timeout errors retain their structured invocation ID and direct callers to this command. It uses existing lifecycle receipts to report confirmed readiness, terminal failure, or an outcome still awaiting confirmation. A successful unverified launch retains `spawned: true, ready: false` with state `accepted`. Workspace-only callers mint and clean up a temporary reader using the established launcher pattern. Output excludes task payloads and raw handler errors.

Silence cannot establish that a process never started. A node that never returns a result remains explicitly unconfirmed; a terminal node failure is reported as failed. No roster-only inference of readiness is introduced. These tests use deterministic fixtures, not the affected physical fleet nodes.

Validation:

- `npx vitest run packages/cli/src/cli/lib/fleet-spawn-confirmation.test.ts packages/cli/src/cli/commands/fleet.test.ts packages/cli/src/cli/lib/spawn-lifecycle.test.ts` — 124 tests passed.
- `npm --prefix packages/sdk run check` — passed.
- `npx tsc -p packages/cli/tsconfig.json --noEmit` — passed.
- `npx eslint packages/cli/src/cli/commands/fleet.ts packages/cli/src/cli/commands/fleet.test.ts packages/cli/src/cli/lib/fleet-spawn-confirmation.test.ts` — no errors; four existing warnings in fleet.ts.
- `git diff --check` — passed.

Regression coverage includes a five-minute launch with exactly one dispatch, expiration of the extended budget with a pollable ID, pending/ready/failed/unverified status reads, safe receipt output, and temporary reader cleanup.

No workflow files changed. The existing unrelated active Trail trajectory prevented starting a new one; it was left intact.
