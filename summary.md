# Retire the removed workspace fleet rollout API

`fleet config`, `fleet enable`, `fleet disable`, and `fleet inherit` called an API removed by Relaycast, so every invocation failed. They now remain as hidden compatibility commands that exit 0, accept legacy SDK options, and print a deprecation notice without creating a client. `config` emits a JSON deprecation object; `disable` explicitly says nodes have not been disabled.

Removed `workspace.fleetNodes`, its messaging implementation, and `RelayWorkspaceFleetNodesConfig` from the SDK. SDK consumers must remove references to that API/type. Fleet nodes need no per-workspace enablement.

Updated help tests, current docs and skills, the feature manifest, verification procedures, and the Unreleased changelog. The cleanroom harness retains all 110 operations and verifies the four no-ops against an unreachable endpoint. Regenerated the CLI inventory and its digest; reconciled existing option drift by recording skipped coverage for three newer options and dropping coverage entries for nine removed options.

Validation:

- `npm run build` and `npm run typecheck` passed.
- `npm run lint` passed with 107 warnings and no errors.
- CLI fleet/bootstrap and cleanroom/guardian suites: 164 tests passed.
- SDK facade/messaging/observer suites, using the SDK's own Vitest config: 53 tests passed.
- All four built CLI commands exited 0 with an empty temporary HOME and no credentials.
- Generated inventory matches the built CLI and matrix digest; 110 operations retained.
- Acceptance searches found no `fleetNodes` references in SDK/CLI source, obsolete policy-restoration fields, or fleet-off-by-default guidance.

The live Daytona campaign was not run; validation covers local regression tests and the built CLI.
