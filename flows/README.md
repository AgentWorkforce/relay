# Relayflows (v2)

Journal-backed flows for the `flows` CLI (`@relayflows/sdk` 2.x). The older
`@relayflows/core` `WorkflowBuilder` flows still live in `workflows/` and are
being migrated here one at a time.

## Naming

Flow names are **dot-namespaced** and mirror their directory:

| File                        | Flow name           |
| --------------------------- | ------------------- |
| `flows/ci/pr-proof.flow.ts` | `relay.ci.pr-proof` |

`relay.<domain>.<name>`, where `<domain>` matches the directory under `flows/`.

Dots rather than slashes is a constraint, not a preference: `flows build` seals
a bundle as `<name>@sha256:<digest>` and validates the name against
`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, so a `relay/ci/pr-proof` name cannot be built
or deployed at all. Hyphens stay inside a single segment.

Deterministic steps cannot be named. `f.run(...)` has no id parameter, so the
journal labels them positionally (`run-1`, `run-2`, …) in source order. Only
`f.agent(name, …)` carries a name through to the journal, which is why the
agent steps here are `base-prover` and `head-verifier` — name those well, and
keep a comment above each `f.run` saying what it is.

## Planned names for the remaining v1 flows

| v1                                                      | v2 name                        |
| ------------------------------------------------------- | ------------------------------ |
| `workflows/verify-features.ts`                          | `relay.verify.features`        |
| `workflows/verify-cleanroom.ts`                         | `relay.verify.cleanroom`       |
| `workflows/verify-fleet-daytona.ts`                     | `relay.verify.fleet-daytona`   |
| `workflows/diagnose-relay-orchestration-reliability.ts` | `relay.diagnose.orchestration` |
| `workflows/audit-feature-manifest.ts`                   | `relay.audit.feature-manifest` |

`workflows/fleet-timeout-budget.ts` is a plain helper module with no builder
call; it does not migrate.

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

| v1 feature             | uses | v2 status                                             |
| ---------------------- | ---- | ----------------------------------------------------- |
| `retries`              | 58   | No equivalent. A failed step fails the run.           |
| `preset`               | 27   | No equivalent.                                        |
| `channel` (relaycast)  | 75   | No equivalent in the body.                            |
| `permissions`          | 8    | YAML/JSON steps only — not expressible in `.flow.ts`. |
| `onError('fail-fast')` | 7    | Default and only behaviour.                           |
| `maxConcurrency`       | 6    | An awaited body is sequential by construction.        |
| `repoReads`            | 5    | No equivalent.                                        |
| `.timeout(ms)`         | 5    | `{ budget: { wallclock: '<n>m' } }` header.           |

For `pr-proof` these were all either the v2 default already or expressible in
the header. The verification flows use `permissions` heavily, so those steps
need authoring in YAML and reaching from TypeScript with `f.dispatch`.
