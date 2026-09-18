# Relayflows (v2)

Journal-backed flows for the `flows` CLI (`@relayflows/sdk` 2.x).

## Layout

Every v1 `@relayflows/core` flow has been migrated; `workflows/` is gone.

| v2                                     | Flow name                      | Entry point                      |
| -------------------------------------- | ------------------------------ | -------------------------------- |
| `flows/ci/pr-proof.flow.ts`            | `relay.ci.pr-proof`            | `flows deploy` (hosted listener) |
| `flows/verify/fleet-daytona.spec.ts`   | `relay.verify.fleet-daytona`   | `npm run verify:fleet-daytona`   |
| `flows/verify/cleanroom.spec.ts`       | `relay.verify.cleanroom`       | `npm run verify:cleanroom`       |
| `flows/verify/features.spec.ts`        | `relay.verify.features`        | `npm run verify:features`        |
| `flows/diagnose/orchestration.spec.ts` | `relay.diagnose.orchestration` | `npm run diagnose:orchestration` |
| `flows/audit/feature-manifest.spec.ts` | `relay.audit.feature-manifest` | `npm run audit:feature-manifest` |

Each has a matching `:check` script that generates the spec and runs
`flows check` on it — the v2 replacement for v1's `DRY_RUN=1`, which validated
the graph without executing it.

## Why most of these are generated specs, not `.flow.ts`

Only `pr-proof` is authored directly against `@relayflows/surface`. The others
emit a v2 `FlowSpec` as JSON, because three things they depend on are reachable
only from the data dialect:

1. **Steps longer than 15 minutes.** `f.run`'s `timeout` is capped at 15
   minutes (`compile.ts`, `lease_exceeded`), and the cap is enforced at run —
   `flows check` does not catch it. A spec's `timeoutMs` is uncapped.
2. **Agent `permissions`.** `AgentOptions` has no permissions field;
   `AgentStepSpec` does.
3. **Named deterministic steps.** `f.run` takes no id, so a TypeScript body
   labels every step `run-7`. The v1 names are the vocabulary the runners,
   their evidence, and the tests already use.

The hybrid that would have avoided this — `use:` plus `f.dispatch` — is
accepted by `flows check` and then refused at run (`unsupported_header: use`).

`flows/spec-builder.ts` holds the v1-to-v2 translation, so the four flows that
were mostly large shell bodies keep their authoring calls byte-identical and
only what they build changed.

## Naming

## Checking and deploying

```sh
flows check flows/ci/pr-proof.flow.ts

flows deploy flows/ci/pr-proof.flow.ts \
  --repo AgentWorkforce/relay \
  --on github:events=pull_request \
  --approver <github-handle> \
  --agents claude

flows deployments          # list hosted listeners
flows undeploy <id>        # remove one
```

`flows deploy` needs `@relayflows/sdk` **2.0.19 or newer** — the hosted-listener
form of `deploy` does not exist in the 2.0.11 currently pinned in the
repository's `node_modules`. There is no webhook to register: the GitHub App
installation is the ingress, and each matching pull request launches a run with
`{ approver, issue, event }` as input, in a fresh branch of the repository.

## What v1 features do not survive the port

Migrating the rest means deciding what to do with builder features v2's
TypeScript surface has no equivalent for. Counted across the v1 flows:

| v1 feature             | uses | v2 status                                                       |
| ---------------------- | ---- | --------------------------------------------------------------- |
| `retries`              | 58   | `maxIterations: retries + 1` on a spec step; no TS knob.        |
| `preset`               | 27   | No equivalent.                                                  |
| `channel` (relaycast)  | 75   | No equivalent in the body.                                      |
| `permissions`          | 8    | Spec steps only, and coarser: no read/write split or deny list. |
| `onError('fail-fast')` | 7    | Default and only behaviour.                                     |
| `maxConcurrency`       | 6    | An awaited body is sequential by construction.                  |
| `repoReads`            | 5    | No equivalent.                                                  |
| `.timeout(ms)`         | 5    | `{ budget: { wallclock: '<n>m' } }` header.                     |

For `pr-proof` these were all either the v2 default already or expressible in
the header. The verification flows use `permissions` heavily, so those steps
need authoring in YAML and reaching from TypeScript with `f.dispatch`.
