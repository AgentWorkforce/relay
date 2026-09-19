## Summary

Draft implementation of the attach and read-only-request portions of the workforce#338 upstream work. **This does not yet unblock workforce#338.** The reviewed plan's D4 decision is pending: `spawnFleetSandbox` must either orchestrate a running agent or expose a narrower ensure-only contract. No placeholder `spawnFleetSandbox` is exported.

- Move the attach adapter and workspace transport resolution into Cloud, retaining CLI re-exports and existing broker transport fields. Add Cloud and SDK `/attach` entries, nodeId/optional-agent discovery, a private single-client raw stdio socket, idempotent cleanup, and a completion promise.
- Expose existing provisioning primitives through Cloud and SDK `/fleet`; route the CLI's ensure import through the SDK entry. Preserve existing Cloud enrollment APIs. The running-agent spawn wrapper remains pending D4.
- Validate and forward `readonlyPaths` as explicit `/path/**` subtrees; expose `fleet spawn --sandbox-readonly-path` with mount guards.
- Add socket, request-validation, CLI, and built-entry regression coverage. Add an independent read-only-request RelayFlow proof; leave historical case 1630 unchanged.

The proxy retains broker transport fields alongside socketPath/finished/close, as the reviewed plan recommends: workforce duck-types the three consumer fields and ignores extras. Completion is an **inferred** status (0 for normal terminal closure/detach, 1 for transport failure), not a remote harness exit code. SDK re-exports add a dependency on Cloud and its transitive dependencies. No package versions changed.

## Remaining requirements

- Resolve reviewed-plan.md D4 and implement/test `spawnFleetSandbox` registration, placement confirmation, input mapping, and teardown.
- Cloud's server-side ensure handler/mount builder is absent from this repository. Forwarding does not enforce chmod-444; server implementation and a live Daytona write-denial proof are still required.
- Exports follow the reviewed plan's existing ESM conventions. No CommonJS build or `require` condition was added.
- No live CLI sandbox-spawn or node-attach parity run was performed.

## Validation

- `npm run typecheck`: passed.
- `npm run build`: passed (Rust build skipped automatically because Cargo is unavailable).
- SDK suite: 182 passed; fleet suite: 43 passed.
- Cloud suite: 450 passed, 4 skipped after removing inherited Cloud authentication variables.
- Existing and new attach tests: 42 passed, using actual local WebSocket and UNIX socket servers.
- CLI suite via `npx vitest run packages/cli/ --maxWorkers=2`: 1,652 passed, 29 skipped. `npm --prefix packages/cli test` is unavailable because that package has no test script. Tests ran without inherited Cloud/Relay credentials and with local Git file transport enabled for the temporary-repository fixture.
- Built Cloud/SDK entry-resolution regression: passed.
- New proof runner executed locally against base `c978302` and implementation `b6c3bb1`: base `absent`, head `fixed`. Both generated probes and compiled CLI-help checks passed. This was not a hosted Cloud or live Daytona run.

## RelayFlow Proof

- Change type: `feature` <!-- relay-pr-proof:type -->
- RelayFlow case: `sandbox-readonly-paths` <!-- relay-pr-proof:case -->

This generated base/head probe verifies exact request forwarding and compiled CLI help. It does not provision a sandbox or prove chmod enforcement.
