# @agent-relay/chief-execution-bridge

The execution side of a [Relay Chief](https://github.com/AgentWorkforce/relay-chief)
assignment: it turns one authenticated assignment DM into one Relay-managed native
spawn, and reports `accepted`, `running`, `completed` or `failed` back to the chief.

Private and unpublished. Licence and distribution follow relay-chief's open decision.

**Not qualified for customers.** Everything here has been verified against fakes only.
See [What has been verified](#what-has-been-verified).

## How it works

The bridge runs as its own process, holding the worker's Relay identity, next to a
dedicated `agent-relay-node`. Each pass:

1. **Reads DMs** with the worker's token. Sender, workspace and recipient come from
   Relay, never the body. Only a message with `chief_assignment` metadata that passes
   `readAssignment` goes further. Any other DM is ignored, and a refused assignment is
   quarantined as a hash.
2. **Claims the task.** The task ID, digest and `accepted` report are written in one
   transaction before any native call. A replay is a no-op; the same task with a
   different digest is refused.
3. **Spawns** through `POST /v1/actions/spawn/invoke`, the route the core itself uses,
   with a stable idempotency key persisted first.
4. **Binds the session** by invocation ID, node ID and a unique per-task agent name,
   then pins the immutable agent ID of the first sender of that name.
5. **Reports** from a durable outbox, in order per task, with a stable idempotency key,
   retrying with backoff until delivered.
6. **Ends the agent** through the core's `agents.end` when the task is over.

`src/protocol.ts` is vendored from relay-chief, which is unpublished. A fixture written by
relay-chief's own code guards digest and report compatibility. Regenerate it when the
protocol changes.

## Completion is a claim

Native spawn status only says the agent launched. The only end-of-work signal is the
agent's own final message, so the bridge asks for a last line of `CHIEF_RESULT: completed`
or `CHIEF_RESULT: failed`.

That line is model-authored and untrusted. It selects the report state and nothing else;
identity comes from delivery metadata, and the chief's independent verification decides
whether work is done. No result line by the deadline is reported as `failed`, and a message
without one is otherwise ignored.

## Requirements

| Requirement                                        | Status                                                                                                                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sender and recipient from authenticated Relay data | Enforced. The recipient address is the configured one, checked against `/v1/agent` when Relay returns it                                                                                                                               |
| Durable dedupe before native execution             | Enforced                                                                                                                                                                                                                               |
| Generic DM never becomes native input              | Enforced                                                                                                                                                                                                                               |
| Reports with increasing sequences; safe retry      | Enforced                                                                                                                                                                                                                               |
| Failed or timed-out agent reports `failed`         | Enforced, including a report owed across a restart                                                                                                                                                                                     |
| Session binding                                    | Enforced as above. The agent ID is trust-on-first-use, since an agent token cannot read it from Relaycast                                                                                                                              |
| Resource limits                                    | Enforced: concurrency, one task per repository, wall-clock runtime, queue time, node capacity. A finished task holds its slot until its agent has stopped, so a stop the node refuses (such as a taken-over session) needs an operator |
| Spending limits                                    | **Partly.** Per-task and lifetime _reservation_ caps only. **Real provider spend is not metered or enforced**: a spawn has no budget parameter                                                                                         |
| Allowlisted agent environment                      | **Unmet on any node not set up as below.** `spawn.invoke` has no environment parameter and spawned harnesses inherit the core's environment and the person's MCP servers                                                               |
| Evidence is data, not instructions                 | Evidence is fenced and labelled in the prompt. This reduces injection risk and does not remove it                                                                                                                                      |
| No deployment, IAM or secret authority             | Stated in the prompt and never granted by the bridge; the actual boundary is what the node's account can reach                                                                                                                         |

## Node requirements

Run a dedicated node for this bridge, started with a scrubbed environment and a `HOME`
holding only the harness login: no person's credentials, no MCP servers. Turn full access
off for the harness.

`isolation` in the configuration must be `{ "dedicatedNode": true, "scrubbedEnvironment": true }`
or the bridge will not start. That is an operator attestation, which the bridge cannot
verify. It does check, at startup and before each spawn, that full access is off, spawns
are accepted, requester approvals are off, and the pinned node is live with capacity.
**Reply with final answer** must stay on for the agent; without it a task can only time out.

A per-spawn isolation profile in `relay-node` would replace the attestation.

## Running

```sh
CHIEF_BRIDGE_RELAY_TOKEN=... chief-execution-bridge /etc/chief-bridge/config.json
```

See `configSchema` in `src/config.ts`. The token is read from the environment and is never
stored or logged. Logs carry event names and codes only. There is one writer per ledger.
It does not use the Flows runtime, so Flows' missing linux-arm64 build does not apply.

## What has been verified

| Against                                        | What                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fakes (`npm test`, no network beyond loopback) | All bridge behaviour above, on a real on-disk SQLite ledger with restarts; the HTTP adapter over loopback; the core adapter against a fake client |
| relay-chief's real code                        | Digest, `readAssignment` and report shape, through a generated fixture                                                                            |
| A real local core (read-only, by hand)         | `settings.get` carries the keys preflight reads; `agents.end` and `spawn.targets` exist                                                           |
| **Not verified**                               | A real Relaycast, a real spawn, a real harness final answer, `agents.end` on a real agent, or a configured dedicated node                         |
