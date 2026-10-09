# Fix late fleet spawn confirmation and provide dispatch status reads

`fleet spawn` previously exhausted its two-minute confirmation budget while agents were still launching, then suggested redispatching without confirmation. Launches taking 1–5 minutes now have a six-minute default budget in the CLI and SDK. Explicit timeout overrides and the existing verified-spawn minimum remain supported.

Add `agent-relay fleet spawn-status <invocation-id>` to read the original spawn invocation without dispatching another worker. Timeout errors retain their structured invocation ID and direct callers to this command. It uses existing lifecycle receipts to report confirmed readiness, terminal failure, or an outcome still awaiting confirmation. A successful unverified launch retains `spawned: true, ready: false` with state `accepted`. Workspace-only callers mint and clean up a temporary reader using the established launcher pattern. Output excludes task payloads and raw handler errors.

Silence cannot establish that a process never started. A node that never returns a result remains explicitly unconfirmed; a terminal node failure is reported as failed. No roster-only inference of readiness is introduced. These tests use deterministic fixtures, not the affected physical fleet nodes.

The new leaf is carried onto the surfaces that enumerate commands: the bootstrap leaf-command inventory, the trusted Fleet CLI inventory snapshot (`tests/relayflows/cleanroom/fleet-cli-inventory.json`) and its matrix pin, the `fleet` README, and the feature manifest. The Daytona board defers `fleet spawn-status` rather than mapping it to an operation: a read-only poll of a recorded invocation id proves nothing about placement that the spawn it reads has not already proven.

Validation:

- `sh .relayflow/check.sh` — all checks passed (npm ci, codegen check, build, typecheck, lint, format, PR-proof and subscription guards, `vitest run`: 200 test files, 3754 tests).
- Regression coverage: a five-minute launch confirmed with exactly one dispatch; expiration of the extended budget returning a pollable ID whose message names the poll command; pending/ready/failed/unverified status reads; launch evidence (`output.spawned`/`ready`, dispatch and handler node ids) surviving the sanitized read; safe receipt output; temporary reader cleanup; `fleet spawn-status` present as a public leaf in both command inventories.

Two check failures were environmental, not code: `node-claim.test.ts` needs `lsof`/`ps` and `broker-process-identity.test.ts` compiles a C fixture with `cc`. GitHub's ubuntu runners ship these (`node-compat.yml` installs `lsof procps`; `test-install.yml` installs `build-essential`), so the install step was added to the uncommitted `.relayflow/check.sh` rather than changing any test.

Pre-existing, left alone: the committed Fleet CLI inventory snapshot is stale for six `node` commands (`--state-dir`, `--broker-url`, `--api-key` were never snapshotted after `addBrokerOptions` was applied to them), so the qualification job's inventory comparison fails on main independently of this change. The snapshot regenerated here restores those six records verbatim to keep that drift out of this change.

No workflow files changed. The existing unrelated active Trail trajectory prevented starting a new one; it was left intact.
