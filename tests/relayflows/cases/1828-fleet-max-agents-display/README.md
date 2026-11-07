# PR proof for #1828

An enrolled node serving `defineNode({ name: "sf-frame", maxAgents: 15, ... })`
showed up in `fleet nodes list` as `1/unlimited` with JSON `maxAgents: 0`,
even though spawning worked. `node up` computed `AGENT_RELAY_NODE_HARNESSES`
from the node-definition plan but never forwarded its `maxAgents`, so the
broker registered and heartbeated `max_agents: 0` (unlimited) while the
sidecar/child provider registered the configured 15 — and the fleet roster
reports the broker's value.

This case proves the operator-facing half of the fix: `node up` forwards a
discovered definition's `maxAgents` into `AGENT_RELAY_NODE_MAX_AGENTS` before
the broker starts.

## How

The probe calls the real `runUpCommand` with a discovered `agent-relay.mjs`
declaring `maxAgents: 15` and everything broker-shaped mocked out (mock relay,
mock `startServeNode`, scratch home), then reads `AGENT_RELAY_NODE_MAX_AGENTS`
off `deps.env`:

- on base the variable stays unset — the bug (broker reports 0/unlimited);
- on head it reads `'15'`.

Only seams present on both arms are used (`runUpCommand`, the env var, and the
marker-object config shape `loadNodeDefinition` accepts); the new
`resolveNodeMaxAgents` helper exists only on head, so the probe observes its
effect, never the helper itself.

The shared `u32` range (`MAX_FLEET_NODE_AGENTS`, enforced by `defineNode` and
descriptor parsing) and the preset-wins/unset semantics are covered by the
branch's unit suites (`fleet-sidecar.test.ts`, `node-provider-child.test.ts`,
`broker-lifecycle.test.ts`, `index.test.ts`), not by this probe.

Run from the checkout containing this case, with an absolute target checkout:

```sh
RELAY_PR_PROOF_ARM=base \
RELAY_PR_PROOF_TARGET_DIR=/absolute/path/to/pre-1828-checkout \
RELAY_PR_PROOF_RESULT_PATH=/tmp/1828-base.json \
node tests/relayflows/cases/1828-fleet-max-agents-display/run.mjs

RELAY_PR_PROOF_ARM=head \
RELAY_PR_PROOF_TARGET_DIR=/absolute/path/to/current-checkout \
RELAY_PR_PROOF_RESULT_PATH=/tmp/1828-head.json \
node tests/relayflows/cases/1828-fleet-max-agents-display/run.mjs
```

Both correct arms exit 0 and write their observation; swapping the arms fails
the probe and produces no observation.
