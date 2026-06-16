# Factory P12 Node Placement Self-Reflection

## Changed files

- `packages/sdk/src/messaging/types.ts`
  - Added node `live` and `repoKeys` fields.
  - Added placement spawn input/ack/reconcile types and node dispatch fields on action invocation acks.
- `packages/sdk/src/messaging/relaycast.ts`
  - Normalizes node liveness and repo mapping keys from `repoKeys`, `repo_keys`, `repoPaths`, or `repo_paths`.
  - Adds `RelaycastMessagingClient.placement.spawn(...)` for named, `self`, and untargeted placement.
  - Adds bounded queueing with TTL, queue depth cap, reconcile hooks, and placement log lines.
  - Sends selected placement metadata as `node` and `target_node`, plus `capability`, `repo`, `ttl_override_ms`, and inferred `cli` for `spawn:<cli>` capabilities.
  - Preserves `handlerNodeId` and `dispatchedNodeId` from Relaycast invocation acks.
- `packages/sdk/src/messaging/index.ts`
  - Exports `RelayPlacementError`.
- `packages/sdk/src/messaging/placement.test.mts`
  - Focused proof for targeted placement, `self`, capability mismatch, unmapped repo reconcile, live-node drain, and TTL failure.
- `packages/sdk/src/messaging/vitest.placement.config.mts`
  - Placement-only Vitest config kept as `.mts` so SDK build globs do not compile it.

## Spec coverage

- Named placement lands on the named live eligible node and invokes the spawn action with explicit target metadata.
- `node: "self"` resolves through `selfNodeName`.
- Targeted capability mismatch hard-fails before invocation with `RelayPlacementError.code === "capability_mismatch"`.
- Repo-targeted placement requires the node to advertise the repo key; unmapped repos log and reconcile through queued/failure events instead of being silently dropped.
- Untargeted placement picks a live eligible node without cross-node bleed by filtering on capability, liveness, and repo key before invoking.
- No eligible node enters a bounded in-process queue, drains when a node becomes eligible, and fails after TTL with a reconcile event and log line.

## Tests/proofs run

- `npm run --workspace @agent-relay/sdk check`
- `npx vitest run --config packages/sdk/src/messaging/vitest.placement.config.mts`
- `npm run --workspace @agent-relay/sdk test`
- `npm run --workspace @agent-relay/sdk build`

All listed commands passed.

## Repo-rule alignment

- Stayed on feature branch `ricky/factory-p12-node-placement`; no main push or merge.
- Kept implementation and focused proof under declared target `packages/sdk/src/messaging`, plus this required artifact.
- Did not add `.agentworkforce/trajectories/` to `.gitignore`.
- Used the active trajectory for decision/reflection records.
- Left unrelated untracked runtime directories untouched.

## Remaining risks

- Queueing is SDK in-process, not a persistent Relaycast durable mailbox. It mirrors bounded TTL semantics at this client layer, but process restart loses queued placement attempts.
- Slack surfacing is represented by the `onReconcile` hook; Slack-specific delivery remains a caller responsibility.
- Node registration changes that actually push `NodeConfig.repoPaths` are outside the declared target for this issue slice.
