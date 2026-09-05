# Relay Fleet / Daytona manual baseline — 2026-09-04

This is the immutable operator summary for the first clean-board run. It is not
a claim that Fleet is green. It records what was actually proven, what failed,
and what was cleaned before the repeatable 95-operation Relayflow was added.

## Topology and cleanup

Two independent no-mount Daytona sandboxes registered as live Fleet nodes and
launched real Codex workers:

| Role               | Exact sandbox ID                       | Fleet node                     | image Relay version                       |
| ------------------ | -------------------------------------- | ------------------------------ | ----------------------------------------- |
| A                  | `11c75e08-13c2-4870-9cb3-5e27265e0120` | `relay-fleetboard-a-0904`      | 11.8.2                                    |
| B                  | `aed4f60a-ef49-4e98-8e96-423bdc050aeb` | `relay-fleetboard-b-0904`      | 11.8.2, then manually upgraded to 11.10.2 |
| root mount probe   | `a0af4d71-0f83-4299-b5ae-2360c0b4af9e` | never registered               | 11.8.2 snapshot                           |
| scoped mount probe | `2d8f3332-d261-4057-9d07-b2b838838a3a` | `relay-fleetboard-scoped-0904` | 11.8.2                                    |

All four exact sandboxes were deleted. Daytona returned to the pre-run count of
100 with zero names matching `relay-fleetboard-*`. All exact workspace agent
identities were eventually removed. Three offline Fleet history rows remain by
design; there is no public history-delete command and each reports zero active
agents.

## Proven end to end

- Fresh Daytona provisioning, Fleet node enrollment/heartbeat, exact targeted
  placement, real Codex `gpt-5.6-luna` startup, initial task injection, MCP
  configuration, and outbound MCP replies worked on both A and B. The exact
  sentinels were `RELAY_FLEETBOARD_A_READY` and
  `RELAY_FLEETBOARD_B_READY`.
- `fleet nodes` default/name/capability/all and `fleet agent list`
  JSON/pretty/node/all returned live board state.
- Direct `node agent spawn codex` worked with auto-to-PTY and explicit PTY;
  `node agent new --mode view` consumed its task; same-name reuse worked after
  release. OpenCode targeted placement also produced its exact MCP sentinel.
- `node status`, readiness wait, metrics/filter, deadletters/JSON, empty
  `redeliver --all`, and the invalid-redeliver argument contract were exercised.
- On the manually upgraded 11.10.2 node, `node workflow run`, logs, follow,
  sync dry-run, and sync all completed in roughly 1.1–1.3 seconds.
- Scoped Relayfile mount (`/tests/relayflows/cleanroom/**`) materialized only the
  requested subtree at `/home/daytona/workspace`: two files, 14 directories,
  1,022 bytes. The root `package.json` was absent and the worker cwd was the
  mount root. Its exact MCP sentinel was `RELAY_FLEETBOARD_SCOPED_READY`.
- The hidden `fleet serve` stub exited nonzero with `node up` migration
  guidance. Exact forced node shutdown worked after graceful timeout.

## Relay-owned failures

1. **Post-ready injection is unread.** On both 11.8.2 and upgraded 11.10.2,
   steer DMs were accepted but no worker reply arrived after about 95 seconds.
   On 11.10.2 the message reported zero readers and remained queued/unread even
   while the broker advertised automatic injection and zero pending messages.
2. **Remote terminal/control routing is inconsistent.** 11.8.2 attach returned
   snapshot HTTP 503 / WebSocket 1011. Matching 11.10.2 returned terminal API
   404 `agent_not_found` while Fleet heartbeat listed the agent. Remote
   hold/flush/auto followed the same broken path.
3. **Fleet policy commands are unwired.** `fleet config`, `enable`, `disable`,
   and `inherit` fail because installed `@relaycast/sdk` 8.0.7 has no
   `workspace.fleetNodes` API.
4. **Fresh node workspace selection is split.** A node enrolled through Cloud
   still reports `Workspace source: created`. After upgrading B, its project pin
   and enrollment disagreed; moving the stale pin let startup continue, but it
   silently created another workspace and the next `node up` failed on the new
   mismatch.
5. **Release is an acknowledgement, not proven cleanup.** Normal and direct
   release results varied between success, retry warnings, and exit 1. Successful
   sandbox workers remained billable; `--delete-agent` did not reliably remove
   identities. Cleanup needed explicit absence polling and `agent remove`.
6. **Spawn confirmation can be false.** Native Codex printed success on 11.10.2
   then immediately died because the image lacks `pnpm`. Claude `--no-confirm`
   reported dispatch while blocked on a first-run permissions screen. An invalid
   session reference was accepted/dispatched but no sustained worker existed.
7. **Placement and metadata are not isolated.** Automatic placement selected an
   unrelated workspace node. Requested custom channels were ignored on the
   sandbox path. `--persona` is ignored for targeted/sandbox spawns.
8. **Lifecycle counters and streams disagree.** Metrics showed one active agent
   but `total_agents_spawned: 0`; `node tail --agent` emitted nothing around a
   best-effort model change; local `attach --json` produced ANSI/TUI bytes in the
   tested path rather than normalized NDJSON.
9. **Concurrent identity cleanup overloads the service.** Four-way deletion
   produced temporary database-overloaded errors and timeouts. Serial deletion
   with 2.5 second spacing converged; individual calls took 2.6–28.7 seconds.

## Cross-repository / deployment blockers

- **Cloud image train:** the production Daytona snapshot pinned Relay 11.8.2
  while the checkout and published current release were 11.10.2. Daytona CLI
  0.205.1 also warned that the service API was 0.210.0.
- **Cloud + Relayfile root mount:** mounting the representative 258 MB root
  failed with a bare HTTP 500, left its sandbox running, and registered no Fleet
  node. Exact compensation deletion was required. The successful scoped mount is
  the control proving that Daytona and Relayfile are not universally broken.
- **Image provider readiness:** Gemini, Aider, and Goose were missing; Grok was
  installed but not advertised and was blocked by first-run telemetry/quota;
  Claude was not past first-run confirmation; native Codex expected unavailable
  `pnpm`. Capability advertisement and actual readiness were therefore not the
  same contract.

These dependencies block a green whole-product result, but they do not explain
the Relay-owned injection, terminal proxy, SDK wiring, workspace selection,
release, or confirmation failures above.

## Repeated comprehensive board

Three additional hand-driven boards ran later on 2026-09-04. The first was used
to repair verifier-caused cascading blocks. The next two attempts were each
bound by an evidence seal and were combined in the exploratory aggregate
`relayfull-campaign-0904`:

- attempt `r2-relayfull-0904-1925`: 48 pass, 41 fail, 1 blocked, 3
  safety-skipped;
- attempt `r3-relayfull-0904-2036`: 45 pass, 41 fail, 4 blocked, 3
  safety-skipped;
- aggregate: 37 stable passes, 33 stable failures, 20 flaky operations, and 3
  incomplete workspace-policy probes. Verdict: RED.

A subsequent independent verifier audit invalidated that aggregate as a
controlled reliability campaign. The two attempts used different runner hashes,
both had dirty source trees, their shared Relay workspace already contained
roughly four thousand identities, and both used the Relay 11.8.2 snapshot while
the then-current matrix required 11.10.2; the current matrix requires 11.10.3.
In addition, `node-tail-agent` was a false pass in
both attempts: the command timed out with empty broker stdout and only Daytona's
CLI/API version warning on stderr. The counts above remain the literal contents
of the historical artifact; they must not be quoted as a current stable/flaky
classification or final signoff. The hardened aggregator now rejects dirty,
unsealed, or provenance-mismatched attempts.

The root Relayfile mount failed three independent times at 265.3s, 264.1s, and
273.2s with HTTP 503 initial-sync readiness pauses. A scoped mount passed in the
third board at 102.9s, and an independent no-mount sandbox passed at 82.6s,
which isolates the root-workspace size/readiness path. Every owned Daytona
sandbox was deleted. Relay agent reconciliation failed in both hardened
attempts; three attempt-2 identities eventually disappeared after exact delayed
recovery, while one attempt-3 Droid identity survived the board's 120-second
window and required a final exact release. A subsequent 3,995-record roster
census found none of those identities.

The stable pass/fail/flaky operation lists and per-attempt min/p50/p95/max
timings are in
`.workflow-artifacts/verify-fleet-daytona/relayfull-campaign-0904/campaign.json`.

## Repeatable follow-up

Run `workflows/verify-fleet-daytona.ts`. Its matrix records every operation,
monotonic duration, redacted bounded output, exact resource ownership, provider
and snapshot provenance, cleanup retries, and final absence. It then requires a
cheap supervisory audit, an analysis-repair disposition, and fresh independent
Claude and Codex signoff before enforcing the product verdict.
