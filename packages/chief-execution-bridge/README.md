# @agent-relay/chief-execution-bridge

The execution side of a [Relay Chief](https://github.com/AgentWorkforce/relay-chief)
assignment: it turns one authenticated assignment DM into one Relay-managed native
spawn, and reports `accepted`, `running`, `completed` or `failed` back to the chief.

Private and unpublished. Licence and distribution follow relay-chief's open decision.

**Not qualified for customers.** The bridge's behaviour has been verified against fakes
only; compatibility with relay-chief and the local core's API was checked separately. See
[What has been verified](#what-has-been-verified).

## How it works

The bridge runs as its own process, holding the worker's Relay identity, next to a
dedicated `agent-relay-node`. Each pass:

1. **Reads DMs** with the worker's token. Sender and recipient come from Relay, and the
   workspace from configuration once the token has matched it, never the body. Only a
   message with `chief_assignment` metadata that passes `readAssignment` can start work. A spawned agent's own messages are read only for its
   `CHIEF_RESULT` first line. Any other DM is ignored, and a refused assignment is quarantined
   as a hash, keeping the newest 10,000.
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
protocol changes. Its `extensions` reports are hand-written to the agreed contract until
relay-chief can generate them.

## Completion is a claim

Native spawn status only says the agent launched. The only end-of-work signal is the
agent's own final message, so the bridge asks for a first line of `CHIEF_RESULT: completed`
or `CHIEF_RESULT: failed`, and a message under 3,000 characters. It must be the first line
because the core cuts a final answer off at 4,000 characters.

That line is model-authored and untrusted. It selects the report state and nothing else;
identity comes from delivery metadata, and the chief's independent verification decides
whether work is done. A marker anywhere but the first non-empty line does not count.

The agent is told to send one message. The core carries a final answer and a message the
agent sends itself the same way, so the bridge cannot tell them apart: any message from the
bound agent without a marker fails the task at once (`result_marker_missing` in the ledger
and log), and the agent is stopped. No message at all by the deadline fails with
`runtime_exceeded`. The full reason always stays in the ledger and log.

## Report extensions

Reports are `relay-chief.report.v1`:
`{ protocol, taskId, assignmentDigest, sequence, state, artifactRefs }`. With
`"reportExtensions": true` in the configuration, two optional fields are added, still
under `relay-chief.report.v1`:

| Field      | On               | Value                                                                                                                                                                                                                                              |
| ---------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findings` | `completed` only | The agent's final message with its first `CHIEF_RESULT:` line removed, trimmed, and cut to at most 3,000 UTF-16 code units without splitting a surrogate pair. Omitted if empty.                                                                   |
| `reason`   | `failed` only    | The bridge's own recorded reason, never agent text: `runtime_exceeded`, `result_marker_missing`, `spawn_failed` (also for `spawn_refused`, `spawn_not_ready` and `repository_refresh_failed`), `stop_failed`, or `agent_failed` for anything else. |

`accepted` and `running` reports never carry either field. `findings` is untrusted agent
text: the bridge keeps it in the ledger only to build the report, never logs it and never
acts on it, and the chief must treat it as data.

**Deploy order.** `reportExtensions` defaults to `false`, and then every report is
byte-identical to the original v1 shape. Relay Chief's report schema is strict and refuses
unknown fields, so turn it on only after relay-chief and relaychief-control with the
matching change are deployed. A report is fixed when it is queued, so reports already in
the outbox keep the shape they were queued with, and findings are kept only for results
received while the flag is on.

## Repository refresh

Each configured folder in `repositories` is the spawned agent's working copy. Without help
it stays at whatever commit it was cloned at, so findings cite stale files and lines. With
`"refreshRepositories": true`, before every spawn the bridge brings that folder to the tip
of `origin`'s default branch and tells the agent the commit:

1. `git rev-parse --show-toplevel` must be the configured folder itself, because the next
   steps act on the whole repository.
2. `git fetch --prune origin`.
3. The default branch is `refs/remotes/origin/HEAD`; if that is unset,
   `git remote set-head origin --auto` sets it first.
4. `git reset --hard` to that branch, then `git clean -fdx`, which also removes ignored
   files such as `node_modules` and `.env`.
5. `git rev-parse HEAD` is recorded in the ledger with the invoke and named in the agent's
   task, so a repeated invoke carries the same task text.

git runs through `execFile` with no shell, a timeout per step, and an environment of only
`PATH`, `HOME`, `LANG` and `GIT_TERMINAL_PROMPT=0`, with the repository's own fsmonitor and
hooks overridden. A failure is logged as `repository_refresh_failed` with a short code
naming the step, never git's output or a remote URL. The task then fails without a spawn:
`repository_refresh_failed` in the ledger, `spawn_failed` as a report reason. A folder is
never refreshed while another task of this bridge that uses it is started or not yet
stopped.

**Deploy order.** `refreshRepositories` defaults to `false`, and then nothing changes.
Everything local in a configured folder is destroyed on every spawn, so before turning it
on:

- Give each configured folder to the bridge alone. Nothing else may keep work there, and
  no two bridges may share one.
- Check, as the service user, that `git fetch origin` in each folder works without a
  prompt. Only `HOME` reaches git, so the remote must authenticate through that user's
  git configuration or credential helper. An SSH remote that needs `SSH_AUTH_SOCK` will
  fail.
- Expect each spawn to start without installed dependencies, since `git clean -fdx`
  removes them.

A task already invoked before the flag was turned on keeps its original task text.

## Requirements

| Requirement                                        | Status                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sender and recipient from authenticated Relay data | Enforced. The recipient address is the configured one, checked against `/v1/agent` when Relay returns it                                                                                                                                                                                                                                                                      |
| Durable dedupe before native execution             | Enforced                                                                                                                                                                                                                                                                                                                                                                      |
| Generic DM never becomes native input              | Enforced                                                                                                                                                                                                                                                                                                                                                                      |
| Reports with increasing sequences; safe retry      | Enforced                                                                                                                                                                                                                                                                                                                                                                      |
| Failed or timed-out agent reports `failed`         | Enforced, including a report owed across a restart                                                                                                                                                                                                                                                                                                                            |
| Session binding                                    | Enforced as above. The agent ID is trust-on-first-use, since an agent token cannot read it from Relaycast                                                                                                                                                                                                                                                                     |
| Resource limits                                    | Enforced while the bridge runs: concurrency, one task per repository, wall-clock runtime, queue time, node capacity. A finished task holds its slot until its agent has stopped, so a stop the node refuses (such as a taken-over session) needs an operator. Nothing stops an agent while the bridge is down; a deadline passed during downtime is applied at the next start |
| Spending limits                                    | **Partly.** Per-task and lifetime _reservation_ caps only. **Real provider spend is not metered or enforced**: a spawn has no budget parameter                                                                                                                                                                                                                                |
| Allowlisted agent environment                      | **Unmet on any node not set up as below.** `spawn.invoke` has no environment parameter and spawned harnesses inherit the core's environment and the person's MCP servers                                                                                                                                                                                                      |
| Evidence is data, not instructions                 | Evidence is fenced and labelled in the prompt. This reduces injection risk and does not remove it                                                                                                                                                                                                                                                                             |
| No deployment, IAM or secret authority             | Stated in the prompt and never granted by the bridge; the actual boundary is what the node's account can reach                                                                                                                                                                                                                                                                |

## Node requirements

Run a dedicated node for this bridge, started with a scrubbed environment and a `HOME`
holding only the harness login: no person's credentials, no MCP servers. Turn full access
off for the harness.

`isolation` in the configuration must be `{ "dedicatedNode": true, "scrubbedEnvironment": true }`
or the bridge will not start. That is an operator attestation, which the bridge cannot
verify. It does check, at startup and before each spawn, that full access is off, spawns
are accepted, requester approvals are off, and the pinned node is live with capacity.
`node` must be this core's own node: preflight reads this core's settings, and the core
reports no identity to confirm that a named node is its own.
**Reply with final answer** must stay on for the agent; without it a task can only time out.

A per-spawn isolation profile in `relay-node` would replace the attestation.

## Security

- **The node and the bridge share a user, so a spawned agent can reach the worker token.**
  The core socket admits only the same user, so the bridge and the node run under one uid.
  A spawned agent with shell access as that user could read the worker token from the
  bridge process and impersonate the worker on Relay. Full access off narrows this but
  does not close it. A forged report is still only a claim, which the chief's independent
  verification must check.
- **A spawned agent can also reach a workspace-level key.** The dedicated node needs an
  `rk_` workspace key in a file under the service user (`workspaces.json`), and spawned
  agents run as that user. An agent with shell access could read that key, which reaches
  further than the worker token.
- **Keep the worker token out of the node service's environment.** Harnesses inherit that
  environment, so a token placed there reaches every spawned agent.
- **Block instance metadata for the service user.** A spawned agent runs as that user and
  must not be able to obtain the host's cloud credentials.

## Running

```sh
CHIEF_BRIDGE_RELAY_TOKEN=... chief-execution-bridge /etc/chief-bridge/config.json
```

See `configSchema` in `src/config.ts`. `workspaceId` is Control's workspace, the one
assignments carry. Set `relayWorkspaceId` when Relay's workspace differs; the token must
report that one, and it defaults to `workspaceId`. The token is read from the environment and is never
stored or logged. Logs carry event names, codes, task IDs, states, reasons and report
sequences; message text and tokens are not logged. There is one writer per ledger.
It does not use the Flows runtime, so Flows' missing linux-arm64 build does not apply.

## What has been verified

| Against                                        | What                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fakes (`npm test`, no network beyond loopback) | All bridge behaviour above, on a real on-disk SQLite ledger with restarts; the HTTP adapter over loopback; the core adapter against a fake client |
| relay-chief's real code                        | Digest, `readAssignment` and report shape, through a generated fixture                                                                            |
| A real local core (read-only, by hand)         | `settings.get` carries the keys preflight reads; `agents.end` and `spawn.targets` exist                                                           |
| **Not verified**                               | A real Relaycast, a real spawn, a real harness final answer, `agents.end` on a real agent, or a configured dedicated node                         |
