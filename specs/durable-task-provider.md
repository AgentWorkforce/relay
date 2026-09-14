# Durable broker task provider

This provider depends on the task invocation engine contract in
[Relaycast #436](https://github.com/AgentWorkforce/relaycast/pull/436).
Deploy that engine contract before enabling this broker feature. The existing
published Relaycast package alone does not enable the server contract.

## Enablement

Set `AGENT_RELAY_TASK_PROVIDER=1` in the environment of a persistent hosted
broker (for example, when starting `agent-relay node up`). The feature is off by
default and refuses ephemeral or `--local-only` mode. It advertises the global
`task.run` action with `execution_mode: "task"`. Enable only one provider for this
global action in each workspace; ordinary node capabilities remain unchanged.

## Invocation and completion

An authenticated agent uses the existing `POST /v1/actions/task.run/invoke`
endpoint and a stable `Idempotency-Key`. The invocation input contains:

```json
{
  "cli": "claude",
  "task": "Return the requested result using the injected result tool.",
  "task_context": {
    "run_id": "run-example",
    "step_id": "step-example",
    "dispatch_id": "dispatch-example",
    "timeout_ms": 300000
  }
}
```

Pass this object as the request's `input` field. Optional `model`, `channel`,
`result_schema`, and existing spawn harness options use the ordinary broker
spawn path. The provider chooses a stable worker name and UUID generation and
injects the generation's callback credential before process creation.

The engine dispatches `action.invoke` with `task_execution` correlation and a
persisted execution attempt. The provider records the invocation, then sends
`action.accept` with its worker generation. Only a matching durable acceptance
permits launch. Spawn registration, readiness, process exit, and interim output
never imply successful task completion. The invoking agent reads
`GET /v1/actions/task.run/invocations/:id` for the authoritative terminal output
or failure;
websocket events are notifications, not a substitute for that read.

The injected `/api/agent-result` callback keeps its existing request shape:
`data`, `final`, optional `name`, and optional `metadata.accounting` (finite,
nonnegative counters). For this provider, a final callback is recorded in the
local outbox before sending a fenced `action.result`. HTTP success follows only
a matching engine terminal receipt and its successful local durable write.
Interim callbacks forward an observation after engine acknowledgment and remain
nonterminal.

- HTTP 503 means the receipt is pending or durable storage is unavailable. Retry
  the identical final callback; the persisted outbox also reconciles it without
  relying on the worker's connection remaining open.
- HTTP 409 means the generation, terminal outcome, or replay payload conflicts.
  It is not a successful result acknowledgment.
- An identical final replay returns the same stored receipt. Changed final
  output or accounting cannot replace it. Callback tokens remain bound to their
  original generation.

## Restart, failure, and deadline behavior

A launch claim is persisted before attempting process creation. A restart can
resume a never-claimed launch after reconciling acceptance. If a launch was
claimed and that exact live generation cannot be proven, the provider reports
`worker_execution_lost`; it does not risk a duplicate launch. Automatic ordinary
worker restart is disabled for task generations. Spawn failures become explicit
failed task results. Old execution responses cannot advance a redispatched
invocation.

Lost result acknowledgments are reconciled through the existing `action.accept`
receipt. The provider resends its identical outbox result only while the engine
still reports the matching execution as running. Terminal engine failures,
including deadlines, are preserved. After receiving a failed terminal receipt,
the provider terminates only a locally tracked matching worker generation.
Disconnected providers cannot immediately observe an engine deadline; a failed
invocation is not proof that an unknown or disconnected process has stopped.

The task ledger sits alongside persistent broker state, under the same broker
ownership lock. Atomic replacement, file synchronization, and directory
synchronization precede acknowledgment; newly written files have mode 0600 on
Unix. A failed durable write disables further task writes and launches until the
storage problem is repaired and the broker restarted. A corrupt ledger refuses
startup. Keep the ledger with the broker's state: deleting it loses the evidence
needed to prevent duplicate launches. Terminal records are retained for replay;
this initial implementation does not prune them automatically.

## Compatibility and rollout

Existing short `spawn` actions keep their readiness receipts and existing wire
shape. Existing local result callbacks retain their behavior. No new public
HTTP endpoint or published dependency version is assumed by this provider.

The ordered rollout is Relaycast #436, this broker provider, then the Flows
adapter tracked in [Flows #397](https://github.com/AgentWorkforce/flows/issues/397)
and [Relay #1766](https://github.com/AgentWorkforce/relay/issues/1766). Preview
proof requires the engine contract to be deployed, a broker built with this
provider enabled, and the adapter using the task invocation lifecycle. Local
mocked tests and wire fixtures do not constitute deployed preview proof.
