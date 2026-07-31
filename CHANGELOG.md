# Changelog

All notable changes to Agent Relay will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `@agent-relay/policy` exports `ConfinedRoot`: filesystem confinement that binds a write to a directory it cannot escape. Refuses path traversal, symlinked components, hardlinks to files outside the root, non-regular targets, and components swapped mid-operation; writes atomically so an interrupted write never leaves a partial or empty file. A security refusal makes no observable filesystem change. Nothing consumes it yet — it is available for callers that execute agent-directed writes.

## [11.3.1] - 2026-07-31

### Fixed

- A CLI command that fails with a non-`Error` value now reports it. A protocol-shaped rejection such as `{ status: 401 }` from a broker client printed `[object Object]`, and an `Error` with an empty message printed nothing at all; both now surface the message, status, and code, with credentials redacted. Applies to the top-level failure handler, `node agent attach`, and broker request failures.
- `agent-relay integration webhook create` now works. It took a `<url>` argument and sent `{ url, event }`, but `POST /v1/webhooks` accepts `{ channel, name? }` and returns the URL — so every invocation failed with `channel is required`. It now takes `<channel>` with an optional `--name`, matching `create-inbound`, which posts to the same endpoint.
- `@agent-relay/sdk` `RelayCreateWebhookInput` declared a required `url` and an `event`, neither of which the endpoint accepts. It is now `{ channel, name? }`. Code passing `url`/`event` was already failing at runtime.

## [11.3.0] - 2026-07-30

### Changed

- `@agent-relay/config`, `@agent-relay/cli`, `@agent-relay/fleet`, and `@agent-relay/harness-driver` now build on Zod 4, matching `@agent-relay/sdk`; Relay no longer ships a split Zod 3/Zod 4 install.
- `@agent-relay/config` builds `jsonSchemas` with Zod's built-in `z.toJSONSchema` and drops the `zod-to-json-schema` dependency. Output stays draft-7 and still describes config files as authored, but some keywords differ (records gain `propertyNames`, integers gain explicit bounds, and `RegExp` fields render as unconstrained).
- `@agent-relay/harness-driver` now exports `SpawnAgentResultSchema` as a Zod 4 schema, and `@agent-relay/fleet` `action()` validates its `input` with Zod 4. Code that pairs either with its own Zod 3 instance — `z.infer`, `.extend()` — needs `zod@^4`.
- `node agent attach --mode drive` keeps the agent in `auto_inject`, so a driven agent goes on receiving relay messages while you watch it instead of having them parked for the whole session. `Ctrl+]` now holds delivery when you want the screen still while typing; a second press drains the queue and returns to live delivery.

### Added

- `relay node agent list --pretty` shows a `PENDING` column with the messages still waiting to reach each agent (queued inbound plus in-flight deliveries awaiting confirmation); the broker reports it as `pending_messages` on `GET /api/spawned` and `GET /api/status`.
- `agent-relay cloud login` now records your user, email, and organization to `~/.agentworkforce/relay/cloud-identity.json`, and the CLI, broker, and Relaycast traffic all report usage under that user and org instead of an anonymous machine id. `agent-relay cloud whoami` refreshes the record; `agent-relay cloud logout` clears it.
- `agent-relay telemetry status` reports which user and organization usage is attributed to, or says so explicitly when it is anonymous.
- Every event now carries a `machine_id` alongside the person key, signed in or not, so machine-level questions survive login: how many machines an account runs on, how many accounts share a machine, and (via Relaycast's `actor_machine_id`) how many machines share a workspace.
- `@agent-relay/cloud/identity` exposes the identity store (`readStoredIdentity`, `resolveCloudIdentity`, `cloudIdentityEnv`), and child processes inherit identity via `AGENT_RELAY_USER_ID` / `AGENT_RELAY_ORG_ID` / `AGENT_RELAY_ORG_SLUG` / `AGENT_RELAY_USER_EMAIL`.

### Fixed

- An agent released and respawned under the same name receives relay messages again. Release drops the agent's delivery cursor and the engine reuses the agent record, so every message after the respawn arrived past the start of the sequence, was classified as a gap, and was acknowledged without being delivered — discarding it and stopping the engine from retrying.
- A PTY agent whose inbound delivery is held when it becomes ready now runs the initial task from its spawn, instead of leaving it parked in the worker's injection queue until the hold lifts.
- The published CLI now actually reports telemetry. The npm package is plain `tsc` output with no key injection step, and the bun standalone's `--define` targeted a literal `process.env.AGENT_RELAY_POSTHOG_KEY` that the code never read (it used a computed `process.env[name]` lookup), so **both** installable artifacts shipped with telemetry silently disabled — every `cli_command_run`, `workflow_run`, `cloud_auth`, `agent_relay_tool_call`, `setup_init`, `swarm_run`, and `bridge_spawn` event was dropped. Only the Rust broker was reporting.
- Opting out of telemetry (`AGENT_RELAY_TELEMETRY_DISABLED` or `DO_NOT_TRACK`) now keeps your cloud identity out of child process environments, including identity an ancestor process or your shell had already exported. The identity env vars — one of which carries your email — previously reached every spawned process, including third-party harness CLIs, even when opted out.
- Identity forwarding to the Relaycast gateway is no longer gated on the local process carrying a PostHog key. An npm-installed CLI bakes no key, so it previously forwarded no identity at all and every hosted event fell back to being keyed on the workspace. Forwarding now follows the telemetry preference alone.
- `node agent list` no longer reports an exited agent as `working` indefinitely; the broker now reaps a worker whose harness has gone away or never started.
- `node agent attach --mode drive|passthrough` truncates its status line to the terminal width, so a narrow pane no longer stacks status lines over the agent's output.
- PTY `node agent attach --mode drive|passthrough` sessions now reserve and safely clip their status row, preventing full-screen agent CLIs from tearing, scrolling, or duplicating Relay's controls.
- Detaching from `node agent attach --mode drive|passthrough` restores the row and column the status line reserved, so a later `--mode view` session no longer inherits a PTY one row and column short. `POST /api/resize/{name}` applies dimensions sent alongside `release: true`.
- Agent Relay MCP instructions now route work with existing named participants through Relay instead of provider-native subagents.
- The `drive` status line counts only messages actually parked by the inbound hold. It previously also counted every delivery a harness queued for injection, so `pending` climbed on ordinary traffic and never came back down.
- `node agent attach --mode view` now exits on the first Ctrl-C instead of waiting for a WebSocket close handshake.
- `agent-relay up` keeps Reflex history-sync diagnostics out of normal startup output, writes them to `--log-file` when configured, and shows them with `--verbose`.
- The broker now sends its anonymous telemetry id (`X-Agent-Relay-Distinct-Id`) and origin actor with its Relaycast requests, so hosted usage can be attributed to an install instead of only to a workspace. The id header is omitted when telemetry is opted out; requests and origin actor are unaffected.
- The broker now reads its telemetry preference and machine-id files from `AGENT_RELAY_DATA_DIR` when set, matching the CLI. It previously only read `~/.agentworkforce/relay/telemetry.json`, so an opt-out written by `agent-relay telemetry disable` under a configured data directory was ignored.
- `WhoAmIResponse.currentOrganization` and `currentWorkspace` are typed as nullable, matching what Cloud returns for a user with no active workspace; `agent-relay cloud whoami` no longer crashes for those users.

### Security

- CLI output masks credentials: `node up` / `node status` print the workspace key as `rk_live_…xxxx`, `cloud session --json` masks the access token unless `--reveal-token` is passed, and `workspace active --json` / `workspace create` mask workspace keys unless `--reveal-secrets` is passed. The new `workspace key [name]` command reads a stored key back from the local store (masked unless `--reveal-secrets`).
- The workspace key no longer appears on any child argv: the broker child and the `--background` daemon both receive it via the environment only, so `ps` output and startup error messages never carry it. Verbose startup steps mask the key in the handshake line.
- Error output redacts embedded credentials: cloud endpoint errors (which carry key-bearing URLs) and Commander unknown-option errors (which echo mistyped flags like `--workspce-key=rk_live_…` verbatim) mask any live credential in the text.
- Upgraded `axios`, `concurrently`, `fast-uri`, `form-data`, `hono`, `js-yaml`, `postcss`, `shell-quote`, and `tar` past their high- and critical-severity advisories.

## [11.2.0] - 2026-07-25

### Added

- `agent-relay cloud room` can invite trusted full room participants through explicit secret sinks, manage members, and establish revocable per-device Relaycast sessions without sharing the workspace key.
- `agent-relay cloud integration` exposes the existing Cloud integration catalog, connection, and disconnection lifecycle from the CLI; connected providers remain available through Relayfile's normal setup, mount, and writeback flow.
- `agent-relay agent me|presence` use scoped agent credentials for room-safe identity and presence checks.

### Fixed

- Codex PTY workers now receive initial Relay tasks in one bulk write, preventing full-screen input redraws from delaying task submission for minutes.
- `agent-relay node up` now binds an OS-assigned API port atomically by default, preventing concurrent Fleet nodes from racing over a probed port; `AGENT_RELAY_BROKER_PORT` remains an explicit stable-port override.
- Newly connected Fleet brokers now advertise their spawn/release handlers immediately, so the first remote spawn is dispatched instead of remaining queued until load changes.
- `agent-relay fleet spawn --session-ref` now passes the requested session to Claude and Codex as a real resume operation, and a released agent name can be reused immediately instead of being suppressed as a duplicate spawn.

## [11.1.1] - 2026-07-23

### Added

- `relay node agent list --pretty` now provides a compact agent view with each agent's name, CLI/model, state, and relative last activity time.
- `agent-relay fleet spawn|release` can create, target, and release agents across live Fleet nodes directly from the terminal.
- `agent-relay fleet nodes --all` includes offline and direct fleet-history records when they are needed for diagnostics.
- `agent-relay message dm send --mode steer` can wake an idle remote agent immediately from the terminal.

### Changed

- `agent-relay fleet nodes` now shows only live fleet providers by default instead of mixing unavailable nodes with direct-delivery history.
- CLI and MCP workspace selection is now pinned to the current project, so later agents and processes resume one collaboration session until a new workspace is explicitly created or selected.
- Enrolled Fleet nodes now retain their node identity when a pinned project session is restarted.

### Fixed

- MCP workspace creation and selection now preserve completed remote or in-memory changes with a warning when local persistence fails, preventing duplicate workspaces and false failed switches.
- Workspace creation now rejects invalid names before provisioning a remote workspace.
- Fleet node restarts now reject stored enrollment fallbacks that do not match the project-pinned node identity.

## [11.0.2] - 2026-07-22

### Fixed

- `agent-relay agent attach --mode drive|passthrough` now takes raw input before replaying terminal state and preserves inherited raw mode on detach, preventing mouse-report escape characters and parent-TUI input regressions.

## [11.0.1] - 2026-07-22

### Fixed

- `agent-relay agent attach --mode view` now consumes local input while viewing, preventing mouse-wheel reports from appearing as scroll-up and scroll-down escape characters.

## [11.0.0] - 2026-07-21

### Added

- Relay harnesses and `agent-relay node agent spawn|new --runtime native` can run Claude Code, Codex, OpenCode, Pi, and experimental Deep Agents through official AI SDK harness adapters, while `--runtime pty` remains available for terminal sessions and unsupported harnesses.
- Relaycast exposes canonical agent activity and agent events with capability, source, and fidelity metadata across native and PTY runtimes.

### Changed

- Feature verification catalog now records the exact CLI and MCP surfaces, adds previously unlisted SDK and plugin integrations, and maps every category to an end-to-end procedure with prerequisites, assertions, cleanup, and automation limits.

### Fixed

- Native Codex sessions now use an AI SDK adapter that avoids the macOS XProtect false positive affecting its previous bundled Codex executable and defaults to a model accepted by ChatGPT-account authentication.
- Native `node agent attach --mode drive` now disconnects idle event streams before cleanup, so `/detach` and Ctrl-C return immediately.
- Native harness sidecars now start with authenticated Relay messaging and discovery tools plus collaboration instructions, so agents can coordinate without user setup or global MCP configuration.
- Native harnesses now preserve sender and routing context on inbound Relay messages, so Claude and Codex reply through Relay instead of only printing responses in attached terminals.
- `agent-relay-broker` now orders fleet `agent.deregister` before acknowledging a local worker release, so a restarted node can immediately recover the same agent name without an active-location collision, and fails fast instead of stalling the runtime API when fleet-control delivery is backpressured.
- Native AI SDK harnesses now permit official adapter bootstrap files under their fixed cache root and invoke pnpm independently of Relay's npm workspace, preventing successful-looking spawns from immediately disappearing.
- Native `node agent attach --mode drive` sessions now show an interactive prompt, preserve structured adapter error messages, and close their broker connection when detached.

### Breaking Changes

- Agent Relay now requires Node.js 22 or newer.

### Migration Guidance

- Upgrade Node.js to version 22 or newer before installing this Agent Relay release.

## [10.6.7] - 2026-07-21

### Fixed

- `@agent-relay/cloud` now exposes project-aware workspace resolution, and SDK-backed CLI consumers prefer the workspace recorded by the broker in the current checkout over an unrelated machine-global active workspace.

## [10.6.6] - 2026-07-19

### Fixed

- `agent-relay cloud enroll --workspace` now validates and resolves Cloud UUIDs and unified `rw_` IDs before minting, and reports unresolvable identifiers instead of mislabeling them as permission failures.

## [10.6.5] - 2026-07-19

### Added

- `agent-relay cloud enroll --workspace <id>` now mints and redeems a fleet-node enrollment token from the stored Cloud login, so admins can enroll machines without copying tokens from the dashboard.
- `agent-relay-broker` `/health` now reports `deadLetterCount`, making terminal delivery loss visible alongside the pending queue.

### Fixed

- `agent-relay-broker` now keeps wait-mode PTY deliveries pending through busy turns and enrolls spawned workers in their declared Relaycast channels, preventing premature dead-lettering and missing channel mentions.

## [10.6.4] - 2026-07-18

### Fixed

- `agent-relay integration` now discovers relayfile control-plane capabilities before sending API v3 headers, fails fast with upgrade and restart guidance for incompatible daemons, and safely replaces stale daemons when a compatible binary is installed.
- `AgentRelaySDK` now maps Relaycast lifecycle states onto its existing Swift presence states, so root-package consumers compile with Relaycast 6.1 and later while package-local builds remain compatible with 6.0.5.
- `agent-relay-broker` and `@agent-relay/utils` now preserve mise/asdf/rtx-style CLI shims when spawning provider workers, so Codex, Claude, Gemini, and other agent CLIs installed via a version manager receive their own permission flags (e.g. `--dangerously-bypass-approvals-and-sandbox`) instead of the manager binary rejecting them.

## [10.6.3] - 2026-07-17

### Fixed

- `agent-relay-broker` no longer mistakes `/exit` text echoed during a paced message injection for an agent-issued exit command, preventing freshly spawned PTY agents from terminating before their initial task is delivered.

## [10.6.2] - 2026-07-16

### Added

- `workflows/verify-features.ts` — scheduled relayflow that verifies every user-facing CLI feature tier by tier (CLI health, broker lifecycle, channel messaging, cross-agent DMs, critical paths) and posts structured PASS/FAIL reports to `#relay-health`. The reporter agent analyzes logs for drift and waits for human approval before opening a PR with fixes.
- `.agentworkforce/features/manifest.yaml` — exhaustive catalog of 124 features across 20+ categories, each tagged with verify tier, criticality, and source location.
- `.agentworkforce/features/critical-paths.md` — documents the 4 product-critical sequences that must work end-to-end (broker+registration, channel messaging, local agent lifecycle, MCP server).
- `@agent-relay/sdk` `./workflows` subpath export, enabling local workflow files to import the workflow builder without a build step.

### Fixed

- `agent-relay node up --background` now preserves persisted Cloud enrollment credentials and node identity through detached startup, and fails instead of reporting healthy when the enrolled node cannot connect.

## [10.6.1] - 2026-07-16

### Fixed

- `agent-relay node up --config` now loads JavaScript and TypeScript node definitions with package imports from standalone binaries, while npm-installed Bun runs keep their existing in-process behavior.
- `agent-relay node up` now serves persisted Cloud-enrolled nodes with the enrolled `nodeId`, so the broker and local providers authenticate with the node token's bound identity instead of a fresh local node id.

## [10.6.0] - 2026-07-16

### Added

- `agent-relay-broker` reports a PII-safe `broker_panic` telemetry event from a process-wide panic hook, capturing only the compile-time `panic_location` (`file:line`) — never the panic message — so broker crashes are visible alongside the existing agent-crash signal.

### Fixed

- `@agent-relay/sdk` repo-filtered message placement now matches nodes: `toRelayNode` derives a node's `repoKeys` from its `repo:<key>` registration tags when no dedicated repo field is present, so a placement repo filter is no longer a no-op that never matches. Explicit `repoKeys`/`repo_keys`/`repoPaths` fields still take precedence.
- `agent-relay-broker`'s `/api/observer-token` recovers from an `observer_token_name_conflict` (409) by rotating the existing same-named token to return fresh, usable material instead of failing the mint, so repeat mints of the fixed-name dashboard observer token succeed. It rotates only a token whose scopes exactly match the endpoint's read-only set and that carries no filters; any other conflict still propagates unchanged.

## [10.5.0] - 2026-07-16

### Added

- `agent-relay drive` (and `agent new`, which attaches in drive mode) gains an in-band `Ctrl+]` toggle that flips the driven agent between held (`manual_flush`) and live (`auto_inject`) inbound delivery, draining the parked queue into the PTY; the status line shows the current mode, the pending count, and the toggle hint.
- `@agent-relay/sdk` observer mode: `new AgentRelay({ observerToken })` streams `relay.addListener(...)` read-only from the workspace observer plane — the durable event log is REST-backfilled and merged with the live stream, deduped and ordered by `seq`, with `sinceSeq`/`onCursor` options to persist and resume the cursor across restarts. Degrades to live-only against engines without the backfill endpoint; `workspace.register()`/`reconnect()` throw in observer mode (observer tokens are read-only).

### Changed

- `@agent-relay/sdk` messaging and delivery types now derive from the canonical `@relaycast/types` schemas: `Relay*` types index into the wire contract, `normalize.ts` validates payloads with canonical-derived zod schemas at the boundary instead of probing snake/camel field variants, and `InboxItemState` builds on canonical `DeliveryStatus`, while `InjectionResult.status` derives from the adapter receipt lifecycle (`MessageReceipt`) — wire-contract changes now surface as compile errors instead of silent drift.

### Fixed

- `agent-relay node agent message flush` now actually injects the queued messages while a drive session is attached: the broker sends a one-shot `flush_injections` frame that exempts the flushed backlog from the drive-mode interactive hold, instead of parking it in a second frozen queue until detach. Without this (and the `Ctrl+]` toggle above), an agent being driven could never receive a relay message — replies to anything it sent sat invisible until the human detached.
- `agent-relay drive` no longer zeroes its pending counter on a partial flush; the undrained remainder stays counted in the status line.
- `@agent-relay/sdk` `relay.addListener(...)` on a workspace-key client now receives channel messages, DMs, and thread replies by streaming through registered agent clients (`workspace.register`/`reconnect`) over the node transport, deduplicating events delivered to multiple locally-registered agents; previously listeners silently received nothing. Listener connect failures now surface through `onError` instead of being swallowed, and a listener with no registered agent warns after 10s.
- `agent-relay-broker` now mutes the default/extra channels it joins for its own broker-self agent, so channel messages stop writing delivery rows to that identity's permanently-offline implicit node (they previously queued until TTL expiry on every message). Muting is best-effort and never fails startup.
- `@agent-relay/sdk` messaging events map the canonical `message.reacted` WebSocket event onto `reactionAdded`/`reactionRemoved`; previously only the non-canonical `reaction.added`/`reaction.removed` names were handled, so reaction listeners never fired against current Relaycast engines.

## [10.4.0] - 2026-07-15

### Added

- `--wk <key>` is a shorthand for `--workspace-key` on every SDK-backed `agent-relay` command (`fleet nodes`, `workspace`, `integration`, `webhook`, …) and on `up`/`node up`; an explicit `--workspace-key` still wins when both are passed.
- `agent-relay up` records the workspace it joins (passed via `--workspace-key`/`--wk` or auto-minted) in the project data dir, and SDK-backed commands run in that directory now resolve that workspace key ahead of the machine-global active workspace, so `fleet nodes`/`node …` in a project reflect the broker's actual workspace. An explicit `--workspace-key`/`--wk` or `RELAY_WORKSPACE_KEY`/`RELAY_API_KEY` still overrides it. `fleet nodes` prints a stderr note when the key was inferred from that project record, so a stale broker workspace is visible rather than silent.

### Changed

- `agent-relay-broker` injects messages into a CLI with escape-aware paced writes — one VT control sequence (CSI/SS3/OSC), UTF-8 codepoint, or byte at a time with a small gap between them — instead of one bulk write, reducing dropped or batched leading characters during injection. Tunable via `RELAY_INJECT_RATE_MS` (default `5`; `0` restores the single bulk write).

## [10.3.0] - 2026-07-15

### Added

- `AgentRelayBrokerSDK` (Swift) reaches broker-control/observability parity with the TypeScript harness driver: `listAgents`, `sendInput`, `resizePty`, `flushPending`, `snapshot`, full-payload `sendMessage` (with `mode`), `setModel`, `subscribeChannels`/`unsubscribeChannels`, `getStatus`, `getMetrics`, `getCrashInsights`, `preflight`, and `renewLease` on `AgentRelayBrokerClient`, plus the `Codable` response types (`ListAgent`, `BrokerStatus`, `PtySnapshot`, `MetricsResponse`, `CrashInsightsResponse`, and related).

### Fixed

- `agent-relay agent attach --mode view` strips mouse-tracking, focus-reporting, alternate-scroll, and bracketed-paste enables from the viewed agent's output, so watching an agent whose TUI uses the mouse no longer sprays `^[[<35;22;25M`-style escape sequences over the read-only viewer.
- `AgentRelaySDK` and `AgentRelayBrokerSDK` (Swift) release cancelled async-stream consumers, bound event buffering, and avoid creating channel event queues for join-only subscriptions, preventing reconnect-driven memory growth.
- `agent-relay-broker` retries the Codex model-detection spawn (`codex debug models`) on `ExecutableFileBusy` (`ETXTBSY`), so a concurrent `fork`/`exec` race under load no longer aborts detection and spuriously falls back away from the requested model.
- `agent-relay-broker` bounds each initial Relaycast startup handshake attempt and retries on timeout with backoff (per-attempt deadline scaled by the configured workspace count), so a stalled backend connection no longer hangs `agent-relay node up`/`init` until an external supervisor kills the broker (which surfaced as an opaque "broker exited with code null during initial handshake"). Returned errors are surfaced immediately rather than replayed. Tunable via `AGENT_RELAY_HANDSHAKE_TIMEOUT_MS` and `AGENT_RELAY_HANDSHAKE_ATTEMPTS`.

## [10.2.0] - 2026-07-14

### Added

- `AgentRelaySDK` (Swift) gains rich relay facades over the relaycast engine SDK, mirroring the TypeScript `@agent-relay/sdk`: `AgentClient.threads` (get/reply), `inbox` and `deliveries` (list/ack/fail/defer), `channels` (list/get/create/update/archive/join/leave/invite/members/mute/unmute), `agents` (list/get/me/update/delete/presence), `nodes`, `triggers`, `integrations` (webhooks + subscriptions), `files` (upload), and `workspace` admin. `post`/`dm` accept `attachments`, and a typed listener hub adds `addListener`/`once`/`onError` alongside the existing event streams. `AgentRelay.createWorkspace(name:)` and `AgentRelay.workspace` consolidate workspace bootstrap and participant registration. Depends on relaycast `6.0.5+`.
- `agent-relay-broker` retains terminally-failed deliveries (retry cap exhausted or recipient gone) in a persisted, capped dead-letter queue instead of discarding them, emitting `dead_letter_added`/`dead_letter_redelivered` broker events and exposing `GET /api/dead-letters` and `POST /api/dead-letters/redeliver`.
- `agent-relay node deadletters` lists dead-letter deliveries and `agent-relay node redeliver <id|--all>` requeues them through the normal delivery path with a reset retry count; `@agent-relay/harness-driver` adds matching `getDeadLetters()`/`redeliverDeadLetters()` client methods.
- `agent-relay-broker` persists its inbound dedup cache (relaycast spawn control events and delivery read-acks) alongside pending deliveries and reloads it on startup, dropping expired entries, so a crash + restart no longer re-processes those already-seen control events and read-acks.

### Changed

- `agent-relay-broker` upgrades the bundled `relaycast` engine crate to 6.0 and parses inbound Relaycast WebSocket events against the published typed contract first, logging a structured warning when an event only parses via the tolerant fallback — so engine contract drift is observable without dropping traffic.

### Fixed

- `AgentRelaySDK` (Swift): realtime channel/DM/thread events now resolve the sender correctly instead of falling back to `"unknown"`, reading it from relaycast's message-level `agent_id`/`agent_name` fields.
- `AgentRelaySDK` (Swift): a bare HTTP 409 from relaycast is no longer blanket-mapped to `agent_already_exists`; only agent registration (`register`/`registerOrRotate`) gets that remapping, while every other endpoint (channels, triggers, nodes, webhooks, ...) surfaces its original error code.
- `@agent-relay/harness-driver` ignores callbacks from superseded event WebSockets, decodes fragmented and binary frames correctly, and reconnects with exponential backoff, preventing duplicate or dropped events during reconnect races.
- `HarnessDriverClient.subscribeWorkerStream()` bounds each subscription buffer (default 10,000 chunks, configurable with `maxQueueSize`) and drops the oldest chunk with a one-time warning when a consumer falls behind.
- `relay node tail --agent <headless-agent>` preserves stdout and stderr bytes, including CRLF and unterminated final chunks, instead of joining or altering output lines.
- `agent-relay-broker` prunes stale PTY input serializers when workers exit or are released and reconciles them after broadcast lag instead of retaining entries indefinitely.
- `agent-relay drive` and `passthrough` restore inbound delivery mode safely when setup is interrupted or detach races another session, preserving explicit holds and concurrent mode changes.
- `agent-relay drive`, `view`, and `passthrough` preserve split UTF-8 input, stop terminal writes after detach begins, avoid status-line repaints inside partial ANSI sequences, skip status output for non-TTY streams, and bound buffered output under backpressure.
- PTY input acks (`POST /api/input/{name}`, the input WebSocket, and the harness-driver `PtyInputStream.send()`) now resolve only after the worker confirms the keystrokes reached the child process. Failed PTY writes surface as a rejected `send()` (via a `write_pty`→`write_pty_response` round-trip with a 5s dead-worker timeout) so `agent-relay drive` predictive echo rolls back glyphs for input that never landed, instead of acking prematurely on enqueue. The `POST /api/input/{name}` response includes the worker `name` alongside `bytes_written`, matching the `HarnessDriverClient.sendInput` contract.
- `agent-relay drive` no longer races worker automation against the human. Switching a worker to `manual_flush` sends an interactive hold that pauses pending relay-message injection (queued deliveries are parked, not dropped), freezes any in-flight injection, and suppresses the stuck-agent auto-enter and prompt auto-responders; switching back to `auto_inject` releases the hold and resumes. The hold is replayed to a worker that restarts while still in `manual_flush`.
- PTY workers no longer deadlock or stall when a wrapped CLI floods output without reading its input. PTY writes (drive keystrokes, relay-message injection, auto-responses) now submit to the write drainer non-blockingly instead of parking the worker's async select loop, so the loop keeps forwarding output and handling input even when the child's stdin buffer is full. Injection pacing delays are now deadline-driven rather than inline sleeps, removing the per-delivery drive/watch latency jank. Relay-message injection now advances only after the drainer confirms each paced write reached the child, so a wedged drainer no longer produces a false `delivery_injected` or a bogus echo baseline — the delivery is requeued and retried instead. Human keystrokes that hit a momentarily full write queue are buffered in FIFO order and retried rather than dropped, preserving typing under back-pressure.
- `agent-relay-broker` raises the timeout for detecting local Codex CLI model support from 5s to 15s, avoiding a spurious fallback away from the requested model when the CLI is slow to spawn under load.
- `agent-relay drive`/`passthrough`: concurrent attach clients no longer fight over the shared PTY size. The broker now enforces a single-resizer policy — `POST /api/resize/{name}` accepts an optional `session_id` (sent by the attach clients) and applies resizes only from the current owner, releasing on detach so the next client can take over. An idle-but-live session keeps ownership by periodically re-asserting its current size (a no-op refresh that emits no SIGWINCH), so it can't be superseded mid-session; ownership is also cleared when a worker exits, restarts, or is released. Resize calls without a `session_id` are unchanged.
- PTY readiness/echo detection and `agent-relay wrap` auto-suggestion guarding now scan a stateful, stitched output stream, so an ANSI escape sequence split across two PTY reads (e.g. a cursor-position sequence or a `\x1b[7m` ghost-text marker) is no longer corrupted or missed.
- PTY workers with no discoverable child PID (macOS quirk) are no longer declared dead after ~30s of silence — a silently "thinking" agent could be killed mid-task. The no-PID watchdog now tolerates several minutes of silence, resets on real child-side activity (PTY output or a write the drainer confirms reached the PTY — not a mere enqueue, so a wedged drainer can't defer the fallback forever), and still detects genuine exits promptly via the PTY reader.

## [10.1.0] - 2026-07-13

### Added

- `agent-relay node up` gains `--log-file <path>`, `--log-level <debug|info|warn|error>`, and `--log-json`: a served node logs each capability it registers (`debug`) and every action that hits it (`info`, with a duration and `node`/`kind`/`invocationId` fields; failures at `warn`). Without a flag the node stays quiet apart from warnings; `--verbose` raises the level to `debug`. An invalid `--log-level` is rejected instead of silently disabling logs. Serving programmatically, inject any sink via `serveNode({ logger })`.
- `@agent-relay/sdk` adds thin Relaycast client factories — `createWorkspaceClient`, `createAgentClient`, `createRealtimeClient`, and `createWorkspace` — typed raw pass-throughs for workspace-key and agent-token operations that keep upstream payloads and errors untouched.

### Changed

- `@relaycast/sdk` is no longer a runtime dependency of the `agent-relay` CLI package.

### Changed

- `agent-relay-broker` links the `relaycast` engine crate at 6.0.0 (multi-provider fleet-wire registration); WebSocket event schemas are unchanged.
- `agent-relay-broker` now parses inbound Relaycast WebSocket events (channel messages, DMs, group DMs, thread replies, reactions, presence, `action.invoked`) against the typed wire contract first; events that do not match the published schema still route through the previous tolerant field probing, with a structured warning so contract drift is observable in broker logs.

### Fixed

- `agent-relay-broker` resumes Relaycast mailbox delivery at the server's authoritative per-agent ACK cursor after a broker restart, preserving strict gap detection and legacy node compatibility.

## [10.0.0] - 2026-07-13

### Added

- **Node providers** — a node's actions are hosted by providers that connect directly to the engine and are invoked node-addressed (`POST /v1/nodes/:node/actions/:name/invoke`). The broker attaches to its node as the `broker` provider over `/v1/node/ws` — PTY runtime, agent delivery, `spawn:<harness>`/`release` capacity, real-load heartbeats — as one provider among several, self-advertising its capacity (default harness set plus `AGENT_RELAY_NODE_HARNESSES`) and exposing its resolved `node_id`/`node_name` on `/api/session`. Author TypeScript actions with `@agent-relay/fleet` (`defineNode`/`serveNode`); an action named `spawn:<harness>` wraps the broker's spawn so any language can adjust the command, env, or cwd before it runs.
- Python `agent_relay.node.NodeProvider.from_enrollment()` serves node actions from Python, reading the node credentials from the enrollment. Install with the `node` extra.

### Changed

- Relaycast SDKs upgraded to the node-provider release: `@relaycast/sdk` 6.0.0 (adds the node-provider client) and `relaycast-sdk` (Python) 1.0.0 (adds `relay_sdk.node.NodeProvider`).
- `agent-relay fleet status` reads this node's provider attachment and per-provider liveness from the engine nodes API instead of a local status file.

### Removed

- `agent-relay fleet serve` is removed. Run `agent-relay node up` (optionally `--config <file>`); for a Cloud-managed node run `agent-relay cloud enroll --token <token>` first.

### Fixed

- `agent-relay node up` reports `Broker started.` as soon as the workspace handshake completes: the broker no longer blocks its `/api/session` readiness on minting the node token (a Relaycast `create_node` round-trip). The node-control client mints the token in the background and publishes it to the session, so a slow node-token mint on a slow network no longer delays or fails startup. Serving a capability definition without an explicit `RELAY_NODE_TOKEN` waits briefly for the background-minted token instead of skipping the provider.

### Breaking Changes

- The broker's local `/api/fleet/ws` sidecar protocol — and its `@agent-relay/harness-driver` TS mirror (`SdkToBroker`/`BrokerToSdk`/`NodeSupervision`) — is removed. Capability handlers connect to the engine directly as node providers instead of tunnelling through the broker, which keeps only its PTY runtime, agent delivery, and `spawn:<harness>`/`release` capacity. Node-scoped action rows replace workspace-global ones, and existing action-invoke URLs change to `POST /v1/nodes/:node/actions/:name/invoke`.

## [9.2.4] - 2026-07-11

### Fixed

- `agent-relay integration subscribe|unsubscribe` now safely persists and retires each relayfile-cloud inbound webhook subscription during replacement, rollback, and normal removal. The `@relayfile/client@0.10.21` pin enables full recovery of interrupted cloud creates.
- Inbound webhook cleanup is crash-safe and retryable: subscription retirement is journaled under a kernel advisory lock with framed commits and bounded owner leases, so an interrupted or crashed cleanup recovers on restart (with periodic lease renewal and post-rename-safe temp cleanup) instead of leaking webhooks. Journal directories open with `FILE_FLAG_BACKUP_SEMANTICS` on Windows.
- Activate relayfile v3 crash recovery.

## [9.2.3] - 2026-07-08

### Added

- `agent-relay integration subscribe` now wires a server-side inbound bridge: it provisions a relaycast inbound-target and a relayfile-cloud webhook subscription so real provider messages (Slack/GitHub/Linear) are injected into the target relay channel — and delivered to on-node agents — with no local watcher or client process running.

## [9.2.2] - 2026-07-08

### Added

- `agent-relay cloud enroll --token <ocl_node_enr_…>` redeems a one-time Cloud enrollment token and persists node credentials to `~/.agentworkforce/relay/fleet-enrollments.json` (0600); a later plain `agent-relay node up` then runs as the Cloud-managed node. The token is never printed.
- `agent-relay node up|down|status|metrics|tail`, `node agent …`, and `node workflow run|logs|sync` unify `local up` and `fleet serve` under one command group. `node up [--config <file>]` brings the current context's node online: the broker runs agents, and a project `agent-relay.{ts,…}` or `agent-relay.py` is served as a capability provider. A plain agent host needs no definition file.
- Reflex history sync runs in-process via the ai-hist SDK, syncing to relayhistory-cloud.
- Swift SDK (`AgentRelaySDK`, `packages/sdk-swift`): `AgentClient` gains `invokeAction(_:input:timeout:pollInterval:)` — invoke a relay action and await its output — plus `channelHistory(_:limit:before:)` and `dmHistory(with:limit:before:)` for reading channel and 1:1 DM message history as oldest-first `RelayChannelEvent`s.

### Changed

- `local` is now a hidden deprecated alias of `node` (the full old surface, including `local run|logs|sync`, still works) and prints a one-time deprecation warning; it is slated for removal in a future major.
- The harness-agnostic PTY kernel is extracted into a `relay-pty` crate: injection, queue, supervision, and crash-insight primitives moved there, `relay-pty` runs in default cargo commands, and broker dependencies are trimmed.

### Removed

- Removed the orphaned `@agent-relay/utils` `relay-pty-path` resolver, its `./relay-pty-path` subpath export, and other stale references to the pre-broker `relay-pty` standalone binary (rules docs, `.gitignore`, an unrunnable benchmark script).

### Fixed

- `agent-relay-broker` resumes Relaycast mailbox delivery at the server's authoritative per-agent ACK cursor after a broker restart, preserving strict gap detection and legacy node compatibility.
- `agent-relay-broker` no longer acknowledges Relaycast `manual_flush` deliveries while they exist only in volatile memory; flushes ACK only an injected FIFO prefix, and full queues reject new deliveries without evicting held messages.
- PTY snapshots (`view`/`drive`/`passthrough` attach, `GET /api/spawned/{name}/snapshot` ansi format) now capture and replay terminal modes — alt-screen, cursor visibility, application cursor keys, bracketed paste, mouse reporting, autowrap, and keypad — so attaching to a TUI no longer leaves the client terminal mis-configured (stray cursor, misbehaving arrows, broken paste). Each mode is re-emitted in both directions so an attach after a crashed session heals a terminal left in the wrong state.
- `agent-relay view`/`drive`/`passthrough`: detaching now emits a conservative terminal reset (leave alt-screen, show cursor, disable mouse reporting + bracketed paste + application cursor keys, reset scroll region) on TTY stdout, so a driven session's replayed snapshot and live stream can't leave your shell in a broken terminal state.
- `agent-relay drive`/`passthrough`: a `Ctrl+C` during attach setup no longer strands the worker's inbound delivery mode — an interrupt in that window can't leave the worker stuck in `manual_flush` (drive) or cancel an explicit `agent message hold` (passthrough).
- `agent-relay drive`/`passthrough`: multi-byte UTF-8 input split across stdin reads (large pastes, IME) is now forwarded intact instead of being mangled into U+FFFD.
- `agent-relay drive`/`passthrough`/`view`: output no longer sprays to the terminal after detach begins.
- `agent-relay drive`/`passthrough`: the status line no longer corrupts the agent's output by splicing reverse-video controls into a half-sent escape sequence, and is skipped entirely when stdout is not a TTY (e.g. piped to `tee`).
- `agent-relay drive`/`passthrough`: on detach the worker's delivery mode is restored without clobbering a concurrent change from another session (broker compare-and-set), and a session that never learned the pre-attach mode leaves it unchanged with a warning instead of force-resetting to `auto_inject` and silently cancelling a hold.
- `agent-relay drive`/`passthrough`/`view`: stdout backpressure is respected — output is buffered (bounded, in order) and flushed on drain instead of growing Node's stdout buffer without limit under a fast agent and slow terminal.
- PTY input acks (`POST /api/input/{name}`, the input WebSocket, and the harness-driver `PtyInputStream.send()`) now resolve only after the worker confirms the keystrokes reached the child process. Failed PTY writes surface as a rejected `send()` (via a `write_pty`→`write_pty_response` round-trip with a 5s dead-worker timeout) so `agent-relay drive` predictive echo rolls back glyphs for input that never landed, instead of acking prematurely on enqueue. The `POST /api/input/{name}` response includes the worker `name` alongside `bytes_written`, matching the `HarnessDriverClient.sendInput` contract.
- `agent-relay drive` no longer races worker automation against the human. Switching a worker to `manual_flush` sends an interactive hold that pauses pending relay-message injection (queued deliveries are parked, not dropped), freezes any in-flight injection, and suppresses the stuck-agent auto-enter and prompt auto-responders; switching back to `auto_inject` releases the hold and resumes. The hold is replayed to a worker that restarts while still in `manual_flush`.
- PTY workers no longer deadlock or stall when a wrapped CLI floods output without reading its input. PTY writes (drive keystrokes, relay-message injection, auto-responses) now submit to the write drainer non-blockingly instead of parking the worker's async select loop, so the loop keeps forwarding output and handling input even when the child's stdin buffer is full. Injection pacing delays are now deadline-driven rather than inline sleeps, removing the per-delivery drive/watch latency jank. Relay-message injection now advances only after the drainer confirms each paced write reached the child, so a wedged drainer no longer produces a false `delivery_injected` or a bogus echo baseline — the delivery is requeued and retried instead. Human keystrokes that hit a momentarily full write queue are buffered in FIFO order and retried rather than dropped, preserving typing under back-pressure.
- `agent-relay drive|view|passthrough` no longer lose or duplicate agent output around attach.
- `agent-relay drive` no longer strands the user on a stale, wrong-geometry screen after attach.
- `agent-relay drive` pending counter is no longer inflated or under-counted by events around attach.
- Swift SDK: depending on this repository by git URL no longer fails with `no such module 'Relaycast'` — the root `Package.swift` now declares the `relaycast` dependency `AgentRelaySDK` imports.

## [9.2.1] - 2026-07-02

### Fixed

- Surface agent-originated fleet deliveries to the dashboard live.

## [9.2.0] - 2026-07-01

### Added

- `POST /api/observer-token` mints scoped read-only tokens.

### Fixed

- Harden dashboard replay against silent live-channel drops.

## [9.1.10] - 2026-07-01

### Changed

- All message delivery is routed through Relaycast with no local bypass.

### Fixed

- `HarnessDriverClient.spawn()` now polls the broker's startup handshake for the full `startupTimeoutMs` budget (default 45s) instead of a fixed ~10s, so a slow-but-healthy Relaycast handshake that keeps answering `503` while warming up is no longer misreported as a spawn failure.

## [9.1.9] - 2026-06-30

### Added

- `agent-relay up --verbose` now prints step-by-step startup progress (port resolution, broker process spawn, handshake retries, capability providers, node-delivery wait, agent spawns) and streams the broker's own startup-phase logs and stderr live, instead of only surfacing a terse error if startup fails.

## [9.1.8] - 2026-06-30

### Added

- `agent-relay integration` commands now talk to relayfile over its local **control-plane unix socket** (`relayfile control-plane serve`) via the published **`@relayfile/client`** package — a typed, version-negotiated client (`/v1/hello` handshake) — instead of shelling out to the `relayfile` CLI and parsing stdout. The daemon is auto-started on first use (or required already-running via `RELAYFILE_REQUIRE_DAEMON=1`); request/response types are generated from relayfile's OpenAPI so contract drift is a build error rather than a runtime surprise. Requires relayfile ≥ 0.10.17.

### Changed

- `agent-relay integration subscribe` now resolves provider-native `--resource` values through relayfile before binding, so Slack channel names, GitHub repos, Linear team keys, and Telegram chats bind to matching relayfile VFS globs while explicit `/`-prefixed globs still work.

### Fixed

- `agent-relay-broker` node id, when the broker auto-mints its node, is derived from the machine-id seed plus a hash of the working directory **and the workspace id**, so the same project directory re-pointed at a different workspace (e.g. `agent-relay up` minting a fresh workspace) mints a distinct node instead of reusing a node id already owned by the old workspace. Previously that reuse made `create_node` fail the mint and silently disabled all realtime injection. When an explicit `RELAY_NODE_TOKEN` is supplied (operator-enrolled / fleet nodes), the pinned node id is used verbatim so `node.register` matches the token's node.

## [9.1.7] - 2026-06-29

### Fixed

- `agent-relay integration subscribe` is now idempotent and supports multiple resources/channels per provider. Each inbound webhook is scoped to its `(provider, resource)` binding (not one-per-provider), so subscribing a second Slack channel — or two sources into the same relay channel — no longer collides on the unique `(workspace, webhook name)` index or clobbers the other binding's webhook. Re-subscribing creates the replacement webhook/subscription before retiring the old one, so a transient failure can't leave you with no working binding; a failed cleanup now warns instead of being silently swallowed. The relay channel id is normalized (`#general` → `general`) consistently across the webhook, subscription filter, relayfile bind, and writeback-secret lookup.

## [9.1.6] - 2026-06-28

### Changed

- `agent-relay integration subscribe` now points the writeback subscription at the relayfile-cloud ingress and signs it with a per-channel secret fetched from relayfile (`relayfile integration writeback-secret`), instead of a relay-server path that returned 404. The secret is derived server-side and tied to the logged-in account, so there's nothing to provision; `--bridge-url`/`--bridge-secret` still override.

## [9.1.5] - 2026-06-27

### Added

- `agent-relay skills add` installs the `/orchestrate` skill (from `agentrelay.com/skill.md`) into your coding harnesses. An interactive TUI asks whether to install for the current project or globally and which harnesses to target (Claude Code, Codex, Cursor, Gemini, OpenCode); `--global`/`--local`, `--harness <ids>`, and `--all` flags drive it non-interactively.
- `agent-relay reflex on|off|status` manages Reflex history sync with a consent prompt and persisted `~/.agentworkforce/reflex.json` state.
- `agent-relay integration subscribe|unsubscribe` binds any relayfile provider to a relay channel or agent in one command, with an inline connect flow when the provider isn't linked yet.
- `agent-relay integration subscription create` now accepts `--filter`, `--url`, and `--secret` to scope delivery and secure the writeback endpoint.

## [9.1.4] - 2026-06-27

### Changed

- Relaycast SDKs upgraded to v5: `@relaycast/sdk` `^5.0.5` (v4→v5 major), the `relaycast` broker crate `5.0.2`, `relaycast-sdk` (Python) `0.3.0`, and Swift Relaycast `5.0.5`. The v5 `agents.release` returns an action invocation (like `agents.spawn`); the `remove_agent` MCP tool surfaces that invocation.

## [9.1.3] - 2026-06-26

### Added

- Node-only delivery for relaycast v5.0.1: agents spawned by the broker are bound to its node so the engine delivers realtime injection to them.
- `sdk-swift` splits broker orchestration into `AgentRelayBrokerSDK` and adds hosted participant `AgentRelaySDK` APIs for workspace registration, channel/DM messaging, inbound events, and relay-routed `AgentClient.registerAction(...)` handlers.

### Changed

- The relaycast engine and `relaycast-sdk` are wrapped in a hosted communicate transport.

### Fixed

- `agent-relay-broker` bootstrap `node.register` no longer advertises a generic `"spawn"` capability. Because the engine does not treat bare `"spawn"` as a placement capability (only `spawn:*`), it had materialized a `spawn` action pinned to whichever node bootstrapped first, which then hijacked capability-based spawn placement for the whole workspace — every `spawn` invoke was dispatched to that node, ignoring `cli`/`target_node`/least-loaded routing.
- Node tokens are now cached per `node_id` (`node-tokens/{node_id}.json`) and scoped to the workspace (and engine base URL) they were minted for, so two brokers in different directories on one host no longer overwrite each other's token, and a token cached for one workspace/engine is no longer reused against another and rejected with HTTP 401. A node-control `/v1/node/ws` 401 discards the stale token and re-mints a fresh one under a bounded give-up cap with reconnect backoff instead of looping forever.
- `agent.register` now forwards the invocation id and harness session ref, so the invocation is correlated to the spawned agent and a `spawn:<harness>` with `harnessConfig.session_id` resumes the session instead of starting fresh. A fleet `spawn:<harness>` runs the sidecar's declared harness rather than the literal `cli` from the action input; the broker-direct raw-`cli` spawn is reserved for the no-sidecar path.
- `seq:0` fan-out frames (action results, reactions, read receipts) are no longer dropped — action results are injected into the calling agent's PTY; inbound `deliver`/`action.invoke` frames tolerate unknown future engine fields instead of being dropped without an ack (which caused infinite redelivery), and the per-agent delivery-dedup memory is bounded.
- `create_node` mint failures now log the real HTTP status and response body instead of collapsing to `Max retries exceeded`, and non-retryable `4xx` responses are no longer retried.
- `agent-relay up` refuses to auto-spawn agents when broker node delivery (`/v1/node/ws`) is not connected, exiting non-zero with guidance instead of spawning agents that can never receive realtime injection; `agent-relay status`, `agent-relay doctor`, `/health`, and `/api/status` now report node-delivery health (`nodeConnected`/`nodeDelivery`).
- The `release` action reports a faithful result — a genuinely unknown worker returns an error while an already-exited worker still reports success — and node-control no longer logs a spurious `agent.register reply did not match a pending registration` warning.

## [9.1.2] - 2026-06-24

### Changed

- The hosted engine base URL default is owned solely by the relaycast SDK. `agent-relay`, `agent-relay-broker`, and the bundled SDKs no longer hardcode a base URL — they pass `RELAYCAST_BASE_URL`/`RELAY_BASE_URL` through for self-hosting and otherwise inherit the SDK default (`cast.agentrelay.com`). The broker reaches the fleet node-control endpoint via the SDK's `node_control_ws_url` helper and only injects `RELAY_BASE_URL` into spawned agents when an override is set.

### Fixed

- `@agent-relay/cloud` refresh now fails with typed, timeout-bounded errors and migrates legacy `~/.agent-relay/cloud-auth.json` credentials into the canonical `~/.agentworkforce/relay/cloud-auth.json` store without dual-writing.

### Breaking Changes

- relay's Swift `AgentRelay` client and Python `communicate` client no longer default the base URL — callers must pass `baseURL`/`base_url` or set `RELAY_BASE_URL`.

## [9.1.1] - 2026-06-24

### Fixed

- `agent-relay integration webhook|subscription` commands work reliably in local broker workflows even when shell auth is stale or missing.
- Escape glob in `@agent-relay/*` to satisfy prettier.

## [9.1.0] - 2026-06-24

### Added

- `agent-relay integration webhook create-inbound <channel> [--name]` mints an inbound channel webhook (returns a scoped URL + one-time token) so external services can push messages into an agent's channel without the SDK; `list-inbound` and `delete-inbound` manage them. Closes the CLI gap where inbound webhooks were reachable only via the SDK/MCP.

### Changed

- Default Agent Relay clients to `cast.agentrelay.com`, and drop the redundant `gateway.relaycast.dev` default in the MCP server.
- Decompose the three largest TypeScript god files into single-responsibility modules.

### Removed

- Removed all `gateway.relaycast.dev` / `api.relaycast.dev` references; clients target `cast.agentrelay.com` only.
- Remove the web app (moved to AgentWorkforce/agentrelay.com).

### Fixed

- The Bun-compiled `agent-relay` standalone binary now bundles workspace packages from their compiled JS instead of their `.d.ts`, so `node up` starts the implicit Fleet local node instead of failing with `Fleet local node skipped: … is not a function`. The redundant `tsconfig` `paths` that mapped `@agent-relay/*` to declaration files have been removed.
- Record workspace_id from the agent registration response.
- Use `@relaycast/sdk` instead of the dead bespoke RPC API.
- Pin verify-standalone-macos to macos-15 and add a smoke wait timeout.

## [9.0.1] - 2026-06-21

### Changed

- `agent-relay-broker` upgrades the bundled `relaycast` crate to 4.1 (broker crate 4.1.1 + CLI SDK 4.1.6), changing the relaycast-backed local delivery store schema.

### Removed

- The local web dashboard is removed. `agent-relay up` no longer starts a dashboard, the installer no longer fetches the `relay-dashboard-server` binary / UI or installs `@agent-relay/dashboard-server`, and `up` drops the `--no-dashboard`, `--port`, and `--foreground` flags.
- Telemetry drops the `human_dashboard` `ActionSource` (CLI and `agent-relay-broker`); broker HTTP-API spawns now report `human_cli`.
- Dropped the legacy `~/.agent-relay` auth fallback and the removed/placeholder `@agent-relay/telemetry` package.

### Fixed

- Fix verifiable gaps between docs and code.

### Breaking Changes

- `agent-relay up` is broker-only and runs attached by default. The previous `--no-dashboard` (which detached) is gone — use `--background` to run detached. The `--no-dashboard`, `--port`, and `--foreground` flags now error as unknown options.
- The `AGENT_RELAY_DASHBOARD_PORT` environment variable is replaced by `AGENT_RELAY_BROKER_PORT`, which sets the broker base port (the HTTP API binds the next free port above it).

### Migration Guidance

- Replace `agent-relay up --no-dashboard` with `agent-relay up --background`; remove `--port`/`--foreground` from `up` invocations; set `AGENT_RELAY_BROKER_PORT` in place of `AGENT_RELAY_DASHBOARD_PORT` to pin the broker port.
- Dashboard assets are no longer managed by `agent-relay uninstall`; delete any leftover `~/.agentworkforce/relay/dashboard` directory manually.

## [8.9.2] - 2026-06-19

### Changed

- `add_agent` MCP tool descriptions map natural-language spawn requests to exact parameters ("spawn a codex agent" → `cli:"codex"`; "spawn an opus claude agent" → `cli:"claude", model:"claude-opus-4-8"`), so relay orchestrators route cross-CLI and model-tier requests correctly.

### Fixed

- Accept grok and opencode in the spawn tool cli enum.

## [8.9.1] - 2026-06-19

### Changed

- Update Relaycast SDK to 4.1.2.
- Align `web/content/docs` with the actual SDK/CLI implementation.
- Decompose the two largest CLI god files into cohesive modules.
- Add design engineering skills and improve button interaction polish.

### Fixed

- `agent-relay node up --config <node-def>` loads plain JavaScript node definitions without `jiti`, so the published Bun-compiled CLI can serve compiled JS node files.

## [8.9.0] - 2026-06-18

### Added

- `agent-relay fleet config|enable|disable|inherit` and `@agent-relay/sdk` `workspace.fleetNodes` expose the per-workspace fleet node rollout flag.

## [8.8.5] - 2026-06-18

### Fixed

- Spawned opencode worker agents no longer pause for interactive tool-approval prompts; the broker injects a wildcard allow-all permission block into every generated `opencode.json`, augmenting existing partial permission objects rather than replacing them.

## [8.8.4] - 2026-06-17

### Added

- `@agent-relay/integration-prompts` provides shared Relayfile integration descriptor discovery and prompt builders for prescriptive, full-inject, and slim writeback instructions.

### Fixed

- `@agent-relay/cloud` preserves operator refresh-token expiry metadata and refreshes canonical cloud sessions before access or refresh tokens reach their renewal windows.

## [8.8.3] - 2026-06-17

### Added

- `agent-relay local agent spawn` and `agent-relay new` accept `--cwd` so agents spawn into a specific working directory.

### Fixed

- `agent-relay-broker` keeps an explicitly requested Codex model when the model catalog cannot be queried, falling back to the default only when the catalog explicitly rejects the model.

## [8.8.2] - 2026-06-17

### Added

- `@agent-relay/sdk` adds `placement.spawn({ capability, node?, repo? })` — node-targeted / `self` / least-eligible placement that gates on advertised capability and repo-key map, queues with a bounded TTL until an eligible live node appears, and surfaces queue/fail visibility through `onReconcile` events. A `spawn:<cli>` capability pins the broker harness — a mismatched `input.cli` is rejected — and the exported `RelayPlacementError` reports `capability_mismatch` / `placement_queue_full` / `placement_ttl_expired` / `unmapped_repo`.
- `agent-relay-broker` keeps fleet node rosters and load counts accurate across reconnects, restarts, and worker lifecycle changes; the broker heartbeat carries a node roster snapshot for liveness.
- Support fleet-node enrollment in `fleet serve`.
- Add mount scoring and onboarding variants to `@agent-relay/evals`.

## [8.8.1] - 2026-06-16

### Added

- `agent-relay` spawn APIs add an optional task-exit mode so spawned CLI agents run the injected task and then cleanly self-terminate with `/exit`.

### Changed

- `agent-relay-broker` improves relay-worker spawning guidance for small models and Gemini, and removes Droid broker injection (it suppressed relay tool use).

### Fixed

- Apply eval-derived relay worker guidance.

## [8.8.0] - 2026-06-16

### Added

- `@agent-relay/fleet` ships the fleet node SDK — `defineNode`/`action`/`spawn`/`onMessage` declare a node's typed capabilities and channel-message triggers. Trigger `match` regexes must be flag-free: a flagged regex (e.g. `/ship/i`) is rejected at `defineNode` rather than silently matched case-sensitively — use character classes like `[Ss]hip`.
- `agent-relay-broker` adds a fleet node control plane: a `node_control` client drives the harness-driver sidecar over the local protocol, registers nodes and handlers, dispatches broker handler invocations, and attributes handler spawns, with hardened node/handler registration timing.
- `@agent-relay/harness-driver` adds the local fleet sidecar protocol frames for node and handler registration, clean node deregistration, broker handler invocation, handler results, handler-attributed spawns, and sidecar supervision metadata.
- `agent-relay fleet nodes|status` inspect registered fleet nodes, and the broker MCP surface adds `query_nodes` and `spawn` tools.
- Two-node fleet E2E (`tests/e2e/fleet`, `Fleet E2E` CI workflow) boots a real relaycast engine plus two nodes (real Rust broker + sidecar each) and asserts the live control wire — boot/register, capability-filtered roster, cross-node action dispatch + ack, declarative trigger fire-once, end-to-end spawn completion, capability-routed / least-loaded / resume placement, in-flight reschedule on node death, and bounded-mailbox TTL dead-letter.
- `agent-relay cloud connect daytona` (local capture).

### Changed

- `@agent-relay/sdk` and `@agent-relay/cli` now depend on `@relaycast/sdk` 4.0 (durable-delivery status model `queued|delivered|acked|failed|dead_lettered`).
- Publish `@agent-relay/fleet` in the release pipeline.

### Fixed

- `@agent-relay/cloud` writes cloud auth atomically and serializes file-backed token refreshes across processes, preventing concurrent refreshes from clobbering rotated credentials.

## [8.7.2] - 2026-06-13

### Added

- Add worker CLI client

## [8.7.1] - 2026-06-13

### Fixed

- Refresh lockfile for cloud workspace version

## [8.7.0] - 2026-06-13

### Added

- `@agent-relay/cloud` adds a canonical cloud session and active-workspace contract — `ensureCloudSession`, `resolveActiveWorkspace`, promoted workspace-store APIs, `agent-relay cloud session --json`, and `agent-relay workspace active --json` — unifying the auth session for cross-language consumers.

### Changed

- Include cloud session commands in bootstrap manifest
- Add infrastructure-failure delivery coverage

## [8.6.0] - 2026-06-11

### Added

- `@agent-relay/config` `CLI_AUTH_CONFIG` adds an `xai` provider (Grok CLI): `grok login --device-auth` device-code connect, `~/.grok/auth.json` credential capture, and the official x.ai installer as the sandbox fallback — so cloud sandboxes can authenticate the `grok` harness from a connected account instead of an API key.

### Changed

- `agent-relay local agent message hold|flush|auto <name>` now owns local broker delivery controls; the old top-level `agent-relay agent message …` path was removed.

## [8.5.0] - 2026-06-11

### Added

- `@agent-relay/sdk` wires the durable delivery surface to the Relaycast backend: `inbox.list`, `inbox.subscribe`, `inbox.ack/fail/defer`, and `deliveries.ack/fail/defer` now use the hosted delivery ledger, agent-scoped capabilities report `serverDeliveryState: true`, and `DeliveryRunner` works against Relaycast-backed inbox items.

### Fixed

- `agent-relay-broker` persists pending deliveries on shutdown and on every queue change, redelivers them on restart, reports timeout-fallback verification explicitly, and emits `delivery_dropped` when the per-worker queue cap evicts a message.
- Default plugin base URLs to `gateway.relaycast.dev`.

## [8.4.0] - 2026-06-11

### Added

- `@agent-relay/sdk` re-exports `RelayError` and `RelayErrorCode`, adds `relay.once(selector, handler)`, and exposes an `onError` hook for listener and action-handler failures.
- `@agent-relay/sdk` typed action handles now provide `completed()`, `failed()`, `invoked()`, and `denied()` listener predicates, and spawn result schemas accept JSON Schema or Zod-compatible validators.

### Changed

- `@agent-relay/sdk` `relay.workspace.register(...)` is idempotent by default: re-registering an existing agent adopts the identity and rotates its token; pass `{ strict: true }` to keep conflict failures.
- `@agent-relay/sdk` `relay.addListener(...)` and `relay.once(...)` narrow handler event types for exact dotted selectors such as `message.created`.
- `agent-relay` and cloud clients stop sending `origin_surface`; spawned-agent Relaycast attribution includes the selected model in `origin_actor`.

### Fixed

- `@agent-relay/sdk` listener and action-handler errors are no longer silently swallowed; without an `onError` hook they log a warning naming the failing selector or action.

## [8.3.7] - 2026-06-11

### Added

- Spawned agents emit `origin_actor` metadata from the JavaScript SDK and per-worker broker path.

### Changed

- PTY message injection re-sends the full MCP reply-instructions `<system-reminder>` block only after roughly 64KB of agent output since the last reminder, in addition to the five-minute cooldown; `agent-relay wrap` uses the same throttle and otherwise sends the short reminder hint.
- LLM markdown mirrors and raw Agent Relay skill markdown are discoverable from the docs surface.

### Fixed

- `packages/sdk/README.md` now documents the v8 API surface instead of removed pre-v8 calls such as `relay.as(...)`, `agent.events.on(...)`, and `relay.actions.register(...)`.

## [8.3.6] - 2026-06-10

### Added

- `agent-relay-broker` emits Relaycast `origin_actor` metadata with the launched CLI path.
- Spawn `model` values flow through MCP, the TypeScript SDK, and the broker to the launched CLI.

### Changed

- Relaycast dependencies were bumped to the published model-aware versions.
- Agent Relay skill handoff docs were refreshed for the current MCP and spawn flows.

## [8.3.5] - 2026-06-10

### Fixed

- `agent-relay cloud connect <provider>` forwards the OAuth callback to the sandbox's `127.0.0.1` endpoint instead of `localhost`, avoiding failed `::1` dials in Daytona sandboxes.

## [8.3.4] - 2026-06-10

### Added

- `agent-relay-broker` bridges delivery read acknowledgements to the Relaycast backend.

### Fixed

- `agent-relay-broker` suppresses the intentional `too_many_arguments` lint on the read-ack timeout helper.

## [8.3.3] - 2026-06-09

### Fixed

- `agent-relay cloud connect codex` binds the OAuth callback tunnel on both `127.0.0.1` and `::1` and pins the sandbox Codex CLI to `@openai/codex@0.138.0`.

## [8.3.2] - 2026-06-09

### Fixed

- `agent-relay-broker` forwards harness metadata to the Relaycast backend while consuming `@relaycast/sdk` 2.3.0.

## [8.3.1] - 2026-06-09

### Added

- `agent-relay-broker` and `@agent-relay/harness-driver` accept explicit workspace keys and broker instance names, so local and cloud brokers can join the same Relay workspace with stable, addressable names.

### Fixed

- `agent-relay` defaults hosted traffic to `https://gateway.relaycast.dev`.

## [8.3.0] - 2026-06-05

### Added

- `@agent-relay/harnesses` adds a `grok` PTY harness for the Grok CLI, including Relaycast MCP support for spawned agents.
- `agent-relay local run|logs|sync` starts executable workflow files on the local machine, stores run metadata and logs under `.agentworkforce/relay/local-runs`, and mirrors the cloud run/logs/sync command shape.
- `agent-relay local run` supports Relayflows YAML workflows through the same background logs and sync wrapper used for local script workflows.

### Changed

- `agent-relay local run` delegates YAML, TypeScript, and Python workflow execution to `@relayflows/cli` instead of bundling TypeScript workflow execution inside the Relay CLI.

## [8.2.0] - 2026-06-04

### Added

- `@agent-relay/harness-driver` adds lifecycle-aware `SpawnedAgentHandle` state for managed agent sessions.
- `@agent-relay/harnesses` is now published to npm, so SDK consumers can install the prebuilt PTY harnesses and harness-authoring helpers.

## [8.1.2] - 2026-06-04

### Fixed

- `@agent-relay/harness-driver` exports the `./predictive-echo` subpath.

## [8.1.1] - 2026-06-04

### Added

- `agent-relay drive` and `agent-relay passthrough` add adaptive predictive echo so typing stays responsive when driving high-latency or remote agents, and stays invisible on fast local links.
- `@agent-relay/harness-driver` exports a reusable `PredictiveEchoEngine` for other attach UIs.

### Changed

- `agent-relay-broker` streams interactive PTY output more smoothly, and `@agent-relay/harness-driver` reduces PTY input latency when driving remote agents.

## [8.1.0] - 2026-06-03

### Added

- `agent-relay agent message hold|flush|auto <name>` controls local broker message delivery without relying on interactive attach key chords.

### Changed

- `agent-relay drive` and `agent-relay passthrough` now forward `Ctrl+B` and `Ctrl+G` to the agent; use `agent message hold`, `agent message flush`, and `agent message auto` for delivery control.

### Fixed

- `agent-relay` attach sessions no longer write successful `view`, `drive`, or `passthrough` banners into the interactive terminal buffer.

## [8.0.5] - 2026-06-03

### Fixed

- Legacy Codex MCP opt-out behavior is preserved after the v8 MCP rename.

## [8.0.4] - 2026-06-03

### Added

- `agent-relay` forwards Relaycast attribution and Agent Relay MCP tool events to hosted Relaycast.

### Fixed

- `agent-relay local agent list` and `agent-relay local metrics` connect only to an existing broker, so read-only commands no longer start an empty broker and hang after printing results.
- OpenClaw skill markdown imports build correctly.

## [8.0.3] - 2026-06-03

### Fixed

- SDK package export validation passes after publish.

## [8.0.2] - 2026-06-03

### Fixed

- Publish checks resolve the `@agent-relay/harness-driver` broker path correctly.

## [8.0.0] - 2026-06-03

### Added

- `@agent-relay/sdk` adds the v8 messaging, delivery, and action surface: live workspace/agent clients, channels, DMs, threads, reactions, inbox, events, `DeliveryRunner`, `ActionRegistry`, `relay.addListener(...)`, fire-and-forget actions, and webhooks.
- `@agent-relay/sdk` adds the public session/harness contract, `AgentRelay.spawnAgent({ runtime, cli, ... })`, and agent-client send/reply/react helpers that expose stable `messageId` values.
- `@agent-relay/harness-driver` adds the optional managed harness boundary for broker startup, PTY/headless spawn, release/status, logs/readiness plumbing, and runtime-provided actions such as `agent.create`, `agent.release`, `agent.status`, and `agent.attach`.
- `@agent-relay/harnesses` PTY harnesses accept `create({ relay })` to spawn live sessions into a relay workspace, and add `createHuman({ relay, name })`, `defineHarness`, and the harness contract types.
- `agent-relay` adds SDK-backed workspace, agent, channel, message, integration, and capabilities command groups, restores the cloud command group, and keeps `view`, `drive`, and `passthrough` as top-level attach commands.
- `agent-relay mcp` ships the Agent Relay MCP stdio server with underscore tool names, can expose registered SDK actions as MCP tools, and recovers stale agent tokens mid-session with re-registration guidance.

### Changed

- Relay stores per-project runtime state in `.agentworkforce/relay/` instead of `.agent-relay/`, and global data/log homes move from `~/.agent-relay`, `$XDG_DATA_HOME/agent-relay`, and platform equivalents to `agentworkforce/relay`.
- `agent-relay` installs dashboard UI assets under `~/.agentworkforce/relay/dashboard` instead of `~/.relay/dashboard`.
- `agent-relay` and `@agent-relay/sdk` upgrade to Relaycast 2.x/2.5.x: spawn/release run as Relaycast actions, action events replace the old command protocol, and the workspace-scoped realtime stream backs listener APIs.
- `@agent-relay/sdk` is scoped to communication primitives; managed broker startup, PTY/headless spawning, workflow supervision, and harness lifecycle helpers move to `@agent-relay/harness-driver`.
- `@agent-relay/sdk` actions accept Zod-compatible `safeParse` schemas alongside JSON-schema-lite, and `DeliveryRunner` can deliver inbox items to session targets through `receiveMessage(...)`.
- `@agent-relay/sdk` no longer emits client-side analytics or depends on `@agent-relay/telemetry`; SDK/API attribution uses Relaycast origin metadata and CLI telemetry posts through `https://i.agentrelay.com` by default.
- `@agent-relay/openclaw` consumes Relaycast's unified `message.reacted` event and remains available as an optional adapter with managed spawn internals moved to `@agent-relay/harness-driver`.

### Deprecated

- `@agent-relay/telemetry` is deprecated as a public npm package; telemetry implementation is now internal to the `agent-relay` CLI.
- External MCP setup through `agent-relay up` is deprecated: spawned agents receive the bundled Agent Relay MCP server through launch-time configuration.
- Workspace setup now leads with creating an Agent Relay workspace through the SDK, MCP, or OpenClaw setup; existing workspace keys are treated as join secrets.

### Breaking Changes

- `@agent-relay/sdk` `relay.workspace.register(...)` returns a live agent client instead of a `{ token }` registration record, and rejects duplicate agent names.
- `@agent-relay/sdk` removes `AgentRelay.as()` / `asAgent()`; act as a registered agent through the client returned by `workspace.register(...)` / `workspace.reconnect({ apiToken })`.
- `@agent-relay/sdk` removes the top-level `relay.sendMessage(...)`; send from a registered agent or human client.
- `@agent-relay/sdk` removes `relay.on(...)`, `relay.notify(...)`, and the public `relay.actions` register/invoke namespace; use `relay.addListener(...)` and `relay.registerAction(...)`.
- `@agent-relay/sdk` removes root and subpath exports for broker clients, spawn facades, PTY/headless helpers, workflow/consensus/shadow helpers, communicate adapters, browser/worker entry points, GitHub/Slack primitive adapters, and persona support.
- `agent-relay` removes spawn-first, workflow/swarm, DLQ, activity, log, and `on` command trees from the default CLI package.
- `@agent-relay/sdk` swaps `@agentworkforce/harness-kit` and `@agentworkforce/workload-router` for `@agentworkforce/persona-kit@^3`, removes the persona tier system, and makes `loadPersona` return the canonical `PersonaSpec`.
- `@agent-relay/sdk` renames the raw client spawn surface from provider terminology to CLI terminology: `HarnessDriverClient.spawnProvider()` is now `spawnCli()`, `SpawnProviderInput` is now `SpawnCliInput`, and `SpawnHeadlessInput.provider` is now `SpawnHeadlessInput.cli`.
- `@agent-relay/sdk` removes high-level `spawnPty`, `spawnHeadless`, positional `spawn`, `spawnAndWait`, and shorthand CLI spawners such as `relay.claude.spawn()`; use `AgentRelay.spawnAgent({ cli, ... })`.
- `agent-relay-broker` public Rust protocol types now require typed ID newtypes such as `WorkerName`, `DeliveryId`, `EventId`, `WorkspaceId`, `ChannelName`, and `MessageTarget`; JSON wire format is unchanged because wrappers are `#[serde(transparent)]`.
- `agent-relay spawn` and SDK spawn calls now return harness `sessionId` metadata for resumable Claude and Codex PTY sessions.
- `sdk-swift` renames `RelayCast` to `AgentRelayClient`.
- `@agent-relay/harness-driver` renames the managed broker client and companion exports from `AgentRelayClient` names to `HarnessDriverClient` names.

### Migration Guidance

- Bind to the live client `register(...)` returns instead of a token, persist `client.token`, and reconnect later with `relay.workspace.reconnect({ apiToken })`.
- Replace `relay.sendMessage(...)` with a send from a registered participant such as `alice.sendMessage(...)` or a `createHuman(...)` client.
- Replace `relay.on(predicate, handler)` with `relay.addListener(predicate, handler)`, prefer dotted event names, and replace `relay.notify(...)` with an inline handler that sends from a participant.
- Replace `relay.actions.register(...)` / `relay.actions.invoke(...)` with `relay.registerAction(...)`; read outcomes from `action.completed` events.
- Read message IDs as `message.messageId`, reply with `reply({ messageId })`, and react with `react({ messageId, emoji })`.
- Stop running brokers before upgrading, remove stale `.agent-relay/` and `~/.agent-relay` state if present, and restart with `agent-relay local up`; new runtime state is created under `.agentworkforce/relay/`.
- Use `agent-relay local up/status/down` for local broker lifecycle commands.
- Install `@agent-relay/harness-driver` for code that starts brokers, spawns PTY/headless agents, waits for managed harness state, or runs supervised workflows; keep `@agent-relay/sdk` for identities, messages, delivery/read state, presence, and commands.
- Replace SDK spawn calls with driver actions such as `agent.create`, `agent.release`, and `agent.status` when agents need to request managed harness work through MCP.
- Flatten personas that relied on `tiers.*` to a single top-level `harness`, `model`, and `systemPrompt`, then launch them through the owning CLI/package and pass the resulting command to `relay.spawnAgent({ cli, ... })`.
- Replace `client.spawnProvider({ provider, ... })` with `client.spawnCli({ cli, ... })`; replace `client.spawnHeadless({ provider, ... })` with `client.spawnHeadless({ cli, ... })`.
- Downstream Rust callers must construct identifiers via `relay_broker::ids::{WorkerName, DeliveryId, EventId, MessageTarget, ...}` instead of raw `String` values.
- `sdk-swift`: replace `RelayCast(apiKey:baseURL:)` with `AgentRelayClient(apiKey:baseURL:)`.
- Import `HarnessDriverClient` from `@agent-relay/harness-driver` and update companion type names such as `HarnessDriverClientOptions`, `RuntimeSpawnOptions`, `BrokerInitArgs`, `HarnessDriverEvents`, and `HarnessDriverProtocolError`.

### Removed

- `@agent-relay/config` removes unused legacy global-storage helpers, the `.agent-relay.json` project-root config fallback, and the legacy `/tmp/relay-outbox` symlink support.
- `agent-relay` drops the legacy `~/.agent-relay/dashboard` static-asset fallback from broker startup; uninstall still purges legacy install directories.

### Fixed

- `@agent-relay/sdk`, `agent-relay mcp`, and `agent-relay-broker` share the same invalid-agent-token recovery signal for stale Relaycast agent tokens.
- `@agent-relay/cloud` ignores stray localhost callbacks with invalid OAuth state parameters.
- `agent-relay-broker` harness configs report harness PIDs, validate app-server protocol/auth/host settings at spawn, and give app-server release requests time to finish.
- `@agent-relay/sdk` normalizes broker `pid: null` spawn responses to `undefined` while PTY harness PIDs are reported asynchronously.
- `agent-relay workspace` stores workspace keys with owner-only permissions and rejects reserved object-property names.
- `sdk-swift` connects to the v7 broker `/ws` event stream and routes spawn, release, channel post, and direct message calls through the broker HTTP API.

### Security

- `agent-relay` upgrades Vitest to 4.x to resolve the critical npm audit advisory.
- `agent-relay-sdk` refreshes `packages/sdk-py/uv.lock` to clear transitive CVEs across urllib3, gitpython, pillow, python-multipart, cryptography, authlib, idna, python-dotenv, pytest, and uv.
- `gemini-relay-extension` refreshes its lockfile to clear fast-uri, path-to-regexp, hono, qs, ip-address, express-rate-limit, and `@hono/node-server` advisories.

## [7.1.1] - 2026-05-25

### Changed

- Cache nested workspace node_modules
- Update README to reflect new features and remove old content
- Prune unused root dependencies
- Add three-way demo and update README

### Fixed

- Bump relayfile-mount binary v0.1.6 -> v0.7.39
- Externalize @slack/web-api in build:cjs + declare as root dep
- Bump quinn-proto to 0.11.14 to address Dependabot alert
- Drop swarms extra to clear litellm Dependabot alerts
- Run package validation smoke before tarball cleanup

### Security

- Bump protobufjs and fast-xml-builder to clear high-severity alerts
- Bump fast-uri to 3.1.2 to clear path-traversal & host-confusion
- Bump ws to 8.21.0 to clear uninitialized memory disclosure
- Bump @slack/web-api to ^7.16.0 to clear axios prototype pollution

## [7.1.0] - 2026-05-22

### Changed

- Drop user-directory validation references
- Remove unused user-directory package
- Avoid persisting result callback tokens
- Add structured agent result callbacks

### Fixed

- Normalize changelog release notes
- Resolve clippy regressions for structured result callbacks

## [7.0.1] - 2026-05-22

### Added

- `agent-relay log {path,list,view,rotate,clear}` inspects and prunes broker diagnostic logs, with rotated platform-standard log files.
- `AgentRelayClient.onBrokerExit()` notifies SDK consumers when a spawned broker exits, including code, signal, PID, and recent stderr.
- `AgentRelay.addListener()` accepts `BeforeAgentSpawnHandler` directly.

### Changed

- Relay self-termination guidance now points agents at direct process exit instead of broker shutdown paths.

## [7.0.0] - 2026-05-21

### Breaking Changes

- `@agent-relay/sdk`: `AgentRelay` event callbacks moved from `relay.on* = handler` fields to `relay.addListener(type, handler)` / `removeListener`; the old callback fields are removed.
- `@agent-relay/sdk`: channel subscribe and unsubscribe listeners now receive `{ agent, channels }` instead of positional arguments.
- `@agent-relay/sdk`: spawn and release lifecycle hooks can observe call sites, and `beforeAgentSpawn` listeners can return shallow spawn-input patches.
- Broker/SDK wire protocol moved to v2 for terminal delivery events and lifecycle event shape changes.

### Migration Guidance

- Use `relay.addListener(...)` and retain the returned unsubscribe function instead of assigning `relay.onAgentSpawned = ...`.
- Update channel subscribe and unsubscribe handlers to destructure `({ agent, channels })`.

## [6.3.5] - 2026-05-21

### Added

- `agent-relay up --broker-name` overrides the local broker identity instead of deriving it from the project directory.

## [6.3.4] - 2026-05-21

### Added

- `agent-relay cloud`: workflow code uploads through the cloud storage API.
- Scheduled workflows can receive environment variables.

## [6.3.3] - 2026-05-21

### Fixed

- `agent-relay config`: OpenCode API-key completion is detected correctly.

## [6.3.2] - 2026-05-20

### Fixed

- Broker worker stderr no longer renders inside the agent xterm.

## [6.3.1] - 2026-05-20

### Fixed

- Claude PTY workers pre-register so `agent-relay mcp` boots faster.

## [6.3.0] - 2026-05-20

### Added

- `agent-relay activity` tails broker-wide message, delivery, lifecycle, and worker-output events with filters and JSON Lines output.
- Broker `/api/input/{name}/stream` and SDK `openInputStream()` provide ordered websocket PTY input without one HTTP request per keystroke.

### Changed

- CLI attach modes use the SDK PTY input stream for interactive input.

## [6.2.8] - 2026-05-20

### Fixed

- Workflow runtime PTY chrome scrubbing is stricter, stale-state warnings are quieter, and idle override behavior is documented.

## [6.2.7] - 2026-05-20

### Fixed

- `agent-relay up --no-dashboard` and `agent-relay down --force` recover half-started brokers that stayed alive without readable connection metadata.
- `agent-relay who` and `agent-relay agents` fail clearly when broker queries fail instead of printing empty agent lists.
- `agent-relay doctor` reports half-started, stale-connection, unresolved-template, and stuck outbound-delivery states directly.

## [6.2.6] - 2026-05-20

### Fixed

- PTY `worker_stream` events preserve multi-byte UTF-8 characters split across read chunks.
- The broker flushes UTF-8 decoder state on the normal `pty_closed` path.

## [6.2.5] - 2026-05-19

### Changed

- Deprecated `uuid` usage was removed from install-time dependencies.

### Fixed

- PTY workers handle `write_pty` frames.

## [6.2.4] - 2026-05-19

### Changed

- Broker Relaycast integration uses the Relaycast SDK 1.1 helper APIs.

## [6.2.3] - 2026-05-19

### Added

- Broker status reports the product release line instead of an internal crate version.

### Changed

- Broker runtime code was split into focused modules and the public Rust crate API was narrowed.
- `agent-relay agents:logs` returns readable, line-oriented output by default.

### Fixed

- Spawned workers receive idle thresholds consistently.
- Broker runtime review issues in request handling and stale-state reporting were addressed.

## [6.2.2] - 2026-05-18

### Changed

- CLI attach and drive sessions share preparation helpers; behavior is unchanged.

## [6.2.1] - 2026-05-18

### Fixed

- Removed an out-of-scope preview configuration change from the 6.2.0 line.

## [6.2.0] - 2026-05-18

### Added

- `agent-relay view <name>` streams a running agent PTY without taking control or stopping the agent.
- `agent-relay drive <name>` attaches interactively and queues inbound relay messages until the user flushes them.
- `agent-relay passthrough <name>` attaches interactively while inbound relay messages continue to auto-inject.
- `agent-relay new NAME CLI [args...]` starts broker-owned agents, with `--attach`, `--ephemeral`, and spawn-and-attach forms.
- `agent-relay rm <name>` releases broker-owned agents.
- Broker per-agent delivery-mode, pending-queue, and flush routes manage inbound queues.
- TypeScript SDK clients can read snapshots, stream worker output, set delivery mode, inspect pending queues, and flush queued messages.
- `agent-relay replies <agent>` reads worker direct-message replies with JSON, unread, mark-read, sender identity, and cursor options.
- `agent-relay history` and `agent-relay replies` accept message-id `--since` cursors for incremental reads.
- `agent-relay who --json` returns structured status, PID, uptime, and memory fields for scripts.
- `packages/personas` includes a `nextjs-web-steward` persona and workforce v3 persona schema.
- Docs include broker HTTP / WebSocket API reference pages and CLI reference navigation icons.

### Changed

- Broker inbound delivery uses one per-agent queue so `auto_inject` and `manual_flush` preserve ordering consistently.
- CLI attach commands share SDK-backed broker snapshots, delivery mode changes, streams, and flushes.
- PTY readiness checks use the live VT grid and cursor position to avoid false ready states in alternate screens and menus.
- PTY writes from user input and terminal-query replies pass through one FIFO writer.
- Rust and TypeScript telemetry disable PostHog reporting when no `AGENT_RELAY_POSTHOG_KEY` is configured.
- `agent-relay send` uses the orchestrator identity by default so `agent-relay replies <worker>` can correlate worker direct messages.

### Fixed

- `relay.spawn({ task })` returns `success: false` and terminates the agent when task delivery fails after retries.
- Broker worker teardown emits `message_delivery_failed` for dropped pending deliveries so SDK delivery waiters terminate.
- SDK `sendAndWaitForDelivery` waits for terminal delivery confirmation or failure instead of treating `delivery_ack` as final.
- `agent-relay mcp` startup ignores unresolved `RELAY_*` environment placeholders before auto-registering.
- `agent-relay history --from <agent>` returns the newest messages after chronological sorting.
- `agent-relay replies --unread` prints nothing when there are no unread messages.
- Messaging `--limit` values clamp invalid negative inputs.
- SDK `sendInput` routes through the PTY worker protocol so input reaches the agent PTY.

## [6.0.22] - 2026-05-15

### Fixed

- Bump agent-relay-workflow writer timeouts

## [6.0.21] - 2026-05-14

### Added

- Add pr_url verification check

## [6.0.20] - 2026-05-13

### Fixed

- Persist spawned agents across cwd

## [6.0.19] - 2026-05-13

### Added

- Export createContextFactory + its option/return interfaces

## [6.0.18] - 2026-05-12

### Added

- Proactive-runtime — agent-relay CLI bootstrap + DLQ + cloud SDK

## [6.0.17] - 2026-05-12

### Added

- Host @agent-relay/events + @agent-relay/agent in relay

## [6.0.16] - 2026-05-11

### Fixed

- Drain broker stderr alongside stdout after startup
- Replace blocking stdout writer task with tokio::io

## [6.0.14] - 2026-05-10

### Fixed

- Reclaim agent on 409 instead of crashing the broker

## [6.0.13] - 2026-05-09

### Added

- Re-export github primitive from root entry
- Make reliability repair-aware by default

### Fixed

- Wait for matching broker tarball before install

## [6.0.12] - 2026-05-09

### Fixed

- Finish agentToken doc cleanup in types.ts

## [6.0.10] - 2026-05-08

### Added

- Spawn agents from named AgentWorkforce personas
- Add @agentrelay/personas pack

### Changed

- Skip personas package in dist-files check
- Align with @agent-relay scope and lockstep versioning

### Fixed

- Stop stamping default_workspace_id into RELAYFILE_WORKSPACE
- Stop stamping relaycast workspace id into RELAYFILE_WORKSPACE
- Trust at*live*\* agent tokens, drop probe-then-rotate
- Address PR review (Windows paths, TOCTOU, harness validation)
- Tighten validator robustness
- Regenerate lockfile and address review nits

## [6.0.9] - 2026-05-05

### Added

- Add WorkflowBuilder.paths() for multi-repo cloud workflows

### Fixed

- Align communicate transport with current Relaycast API

## [6.0.8] - 2026-05-04

### Added

- Surface phase C multi-repo push results in cloud CLI
- Phase B multi-path tarball upload for cloud workflows

### Fixed

- Exclude volatile workflow files when applying sync patches

## [6.0.6] - 2026-04-30

### Fixed

- Add repository metadata for workflow types
- Publish SDK internal deps before sdk

## [6.0.4] - 2026-04-30

### Fixed

- Publish SDK workflow types before SDK
- Pack github-primitive + workflow-types in smoke; publish workflow-types

## [6.0.3] - 2026-04-29

### Added

- Expose connectProvider() in @agent-relay/cloud SDK
- Expose runScriptWorkflow() in @agent-relay/sdk/workflows
- Bundle @agent-relay/github-primitive at /github subpath

### Fixed

- Update codegen-models workflow to use new Python output path

## [6.0.2] - 2026-04-25

### Fixed

- Drop darwin-x64 verify leg (macos-13 queue stuck again)
- Re-add @agent-relay/cloud to publish-packages matrix

## [6.0.1] - 2026-04-25

### Breaking Changes

- Drop legacy agent-relay/broker\* exports and shipped workspace dirs

### Added

- Restore agent-relay/\* subpath exports via shim re-exports

### Changed

- Fix stale broker checks and PyPI retry

### Fixed

- Drop dead linkResult reference
- Allow shipped workspace packages declared as regular deps
- Unbundle @agent-relay/\* to restore optional-dep broker resolution
- Walk ancestor node_modules for shadowed broker packages
- Install broker optional-deps for CLI users

## [6.0.0] - 2026-04-24

### Added

- ApplySiblingLinks — link sibling-repo packages during workflow setup
- Split broker binaries into per-platform optional-dep packages

### Changed

- Drop darwin-x64 smoke test
- Cross-platform post-publish verification of @agent-relay/sdk
- Skip dist check for broker-\* packages in package-validation
- Add cross-platform smoke test for broker optional-deps
- Update Cursor models to latest

### Fixed

- Keep SIGWINCH on unix, background-thread poll on Windows
- Unbreak Windows build
- Convert rewrites to direct redirects
- Verify-publish-sdk must accept publish-sdk-only too
- Pack @agent-relay/config alongside SDK for smoke test
- Address PR review feedback on broker optional-deps
- Keep broker packages as workspaces so npm ci passes

## [5.0.0] - 2026-04-22

### Changed

- Include publish-sdk-py in summary job

### Fixed

- Repair pre-existing test failures on main
- Address Copilot review on broker resolution
- Ship per-platform wheels with embedded broker (drop runtime download)

## [4.0.40] - 2026-04-22

### Added

- Add browser and github workflow primitives

## [4.0.38] - 2026-04-22

### Fixed

- Retry get_session on 503 + correct quickstart idle wait

## [4.0.37] - 2026-04-22

### Added

- Send workflowPath so the launcher can skip the $HOME upload

## [4.0.36] - 2026-04-22

### Added

- Add credential proxy workflows runtime stack

### Fixed

- Bootstrap for first publish

## [4.0.35] - 2026-04-21

### Added

- Widen @relayfile/sdk dep range to allow 0.2.x + 0.3.x

## [4.0.34] - 2026-04-21

### Fixed

- Mark run failed under continue-on-error when steps fail

## [4.0.33] - 2026-04-20

### Added

- Add --register flag to mcp-args subcommand

### Fixed

- Bundle local mount package

## [4.0.32] - 2026-04-20

### Added

- Add agent-relay mcp-args subcommand
- Add agent activity hook

### Fixed

- Ignore late delivery ack activity

## [4.0.31] - 2026-04-20

### Added

- Align Rust AgentSpawn/AgentRelease with TS schema
- Per-component version properties on every event
- Instrument all CLI commands with rich events

### Fixed

- FileDb in-memory cache authoritative — fixes stale status after disk write failures
- Extract runSignalHandler helper; apply in monitoring
- Is_tty should check stdin, not stdout
- Plug two CliExit regressions flagged by Devin
- Flush queue before process exit; schema cleanup
- Upgrade posthog-node from v4 to v5

## [4.0.30] - 2026-04-19

### Fixed

- Export A2A communicate subpaths

## [4.0.29] - 2026-04-17

### Added

- Add ProcessBackend workflow for cloud sandbox execution

## [4.0.28] - 2026-04-15

### Fixed

- Bundle ssh2 in release pipeline, not just scripts/build-bun.sh

## [4.0.27] - 2026-04-15

### Fixed

- Bundle ssh2 into Bun binary so cloud connect exercises the ssh2 path

## [4.0.26] - 2026-04-15

### Fixed

- Add visible launch checkpoint for cloud connect

## [4.0.25] - 2026-04-15

### Fixed

- Stop cloud connect hangs and re-auth loops

## [4.0.24] - 2026-04-15

### Fixed

- Prefer native Node TS stripping over tsx fallback

## [4.0.23] - 2026-04-14

### Added

- Show workspace key and observer URL in agent-relay status

## [4.0.22] - 2026-04-14

### Added

- Cloud-connect fix workflows (claude hang + utils bundling)

## [4.0.21] - 2026-04-13

### Added

- Env-var auth fallback for headless consumers

### Fixed

- Inbox --agent flag, history DM support, history --from DM context

## [4.0.20] - 2026-04-13

### Changed

- Unify WorkflowTrajectory on agent-trajectories SDK

### Fixed

- Replace esbuild pre-parse with tsx stderr post-processing

## [4.0.19] - 2026-04-13

### Fixed

- Make preParseWorkflowFile async to avoid Bun-compiled CLI hang

## [4.0.18] - 2026-04-13

### Fixed

- Add progress diagnostics and spawnSync to runScriptFile
- History/inbox fetch workspace_key via broker HTTP API

## [4.0.17] - 2026-04-13

### Added

- Workerd export condition + narrow entry + workers-safety probe

### Fixed

- Restore packages/sdk vitest suite to green
- Pre-parse workflow script files with actionable error hints
- Make --resume work for script workflows

## [4.0.16] - 2026-04-12

### Fixed

- Wire Agent Relay MCP for headless OpenCode spawner

## [4.0.15] - 2026-04-12

### Fixed

- History and inbox work without RELAY_API_KEY env var

## [4.0.14] - 2026-04-11

### Added

- Add cloud cancel CLI + fix opencode headless spawn

## [4.0.13] - 2026-04-11

### Fixed

- Retry real install paths in verify-publish

## [4.0.12] - 2026-04-11

### Added

- Add workflow for relay bootstrap and messaging fixes
- Add meta and clean-room relay validation workflows

## [4.0.11] - 2026-04-10

### Fixed

- Log full deterministic step output on failure for cloud visibility

## [4.0.10] - 2026-04-10

### Changed

- Harden macos binary verification

### Fixed

- Skip in-sandbox provisioning when cloud launcher already seeded ACLs
- Harden macos binary smoke checks

## [4.0.9] - 2026-04-10

### Fixed

- Harden npm publish packaging
- Use bun built-in TS validation, remove esbuild dependency
- Npm tarball propagation race in verify-publish and install.sh

## [4.0.6] - 2026-04-10

### Added

- Complete implementation + fix Supermemory adapter

## [4.0.5] - 2026-04-08

### Changed

- Route waitlist signups to cloud

## [4.0.4] - 2026-04-07

### Fixed

- Use local workspace session for symlink/solo mode to avoid 405 on cloud API

## [4.0.3] - 2026-04-07

### Added

- Fast workspace seeding — symlink mount + tar bulk upload
- 30 workflows to wire relayauth/relayfile permissions into workflow runner

### Fixed

- Only prefer sibling relay-dashboard dev build when RELAY_LOCAL_DEV=1
- Install broker binary to BIN_DIR so it's on PATH

## [4.0.1] - 2026-04-06

### Added

- TDD refactoring workflows for runner.ts + main.rs decomposition
- /schedule — RelayCron landing page
- Auto-download relayfile-mount binary on first use

### Changed

- Gitignore .trajectories/ (automated run artifacts)

### Fixed

- Allow anonymous workspace creation in agent-relay on
- Wire .agentignore/.agentreadonly enforcement into agent-relay on

## [4.0.0] - 2026-03-31

### Added

- Default agent-relay on to production cloud endpoints
- Unified workspace ID across relay services

## [3.2.21] - 2026-03-27

### Fixed

- Avoid E2BIG spawn failure and verification token double-count
- Queue outbound messages during RelayObserver reconnect

## [3.2.18] - 2026-03-25

### Fixed

- Remove unused dm_drops_total function to fix clippy dead-code warning

## [3.2.17] - 2026-03-25

### Added

- Add dry-run support and stream CLI output to terminal

### Fixed

- Resolve DM participants for correct routing

## [3.2.16] - 2026-03-25

### Added

- Add http and broker-path subpath exports for Electron apps
- PTY output streaming workflow
- Add integration step type for external services
- Add dynamic channel subscribe/unsubscribe to broker
- Cloud endpoints, API executor, and Communicate SDK v2 protocol
- Communicate Mode SDK (on_relay) for Python and TypeScript
- Add wait/steer message injection modes

### Changed

- Assert injection mode defaults to wait when omitted
- Fix missing MessageInjectionMode imports in test modules
- Bump relaycast crate to v1 for injection mode support

### Fixed

- Add RELAY_SKIP_PROMPT and self-echo filtering
- Ignore failing relaycast DM tests pending relaycast 1.0 API investigation
- Cargo fmt corrections
- Sync lockfile for new UI deps
- Validate channel names at build time and dry-run
- Forward steer mode through relaycast DMs
- Unblock fork PR checks and enforce steer rejection for relaycast DM
- Propagate inbound injection mode on relay_inbound events
- Allow relaycast delivery path to accept steer mode
- Reject steer mode on relaycast-only send path
- Validate send mode and harden steer delivery semantics
- Satisfy rust fmt/clippy for injection mode changes
- Don't block steer injections behind autosuggest gate

## [3.2.15] - 2026-03-23

### Added

- Add RelayObserver proxy client for UI consumers

### Fixed

- Add bypass flag to codex non-interactive spawns

## [3.2.14] - 2026-03-23

### Added

- Add initial Swift SDK and harden workflow output

## [3.2.13] - 2026-03-20

### Fixed

- Ignore non-zero exit codes for opencode non-interactive agents

## [3.2.12] - 2026-03-20

### Added

- Add Codex relay skill for sub-agent communication

## [3.2.11] - 2026-03-20

### Added

- Add workflow defaults abstraction

### Fixed

- Detect Codex boot marker format in PTY startup gate
- Consolidate CLI path resolution
- Reduce WS spawn pre-registration timeout from 15s to 3s

## [3.2.10] - 2026-03-20

### Added

- Workflow to polish CLI output with listr2 + chalk
- CLI session collectors, step-level cwd, and run summary table

### Fixed

- Auto-build local sdk workflows runtime
- MCP tools unavailable for agents spawned via agent_add

## [3.2.8] - 2026-03-18

### Fixed

- Detect claude CLI with inline args for MCP injection

## [3.2.7] - 2026-03-18

### Fixed

- Forward RELAY_WORKSPACES_JSON and RELAY_DEFAULT_WORKSPACE to spawned agent MCP config

## [3.2.6] - 2026-03-17

### Added

- Add reasoning effort metadata to model registry
- Add resize_pty protocol message for remote PTY resize

### Fixed

- Ensure spawned Claude agents get proper MCP config
- Address PR review feedback for resize_pty

## [3.2.4] - 2026-03-17

### Added

- StartFrom + deterministic/worktree step parity
- A2A protocol transport layer — Python (89 tests ✅) + TypeScript
- Add OpenClaw orchestrator skill for headless multi-agent sessions
- Add TS adapters for OpenAI Agents, LangGraph, Google ADK, CrewAI + review fixes
- Add Pi RPC adapter for Python SDK + verify TS Pi adapter exports
- Add Communicate Mode SDK (on_relay) for Python and TypeScript

### Changed

- Add 13 e2e tests for all TS + Python adapters against live Relaycast
- Hide communicate pages from public docs until tested
- Sync package-lock.json after config version bump

### Fixed

- Address latest Devin review findings
- Move framework adapters from dependencies to optional peerDependencies
- Update TS test mock servers to match actual Relaycast API paths
- Address remaining Devin review findings
- Exclude all test files from SDK tsconfig.json too
- Exclude all test files from SDK build config
- Address Devin review findings on Communicate SDK
- Address Barry review feedback on Communicate SDK
- Address Will + Devin review feedback on Communicate SDK
- Address PR review — remove onRelay auto-detect, fix ReDoS regex
- RegisterOrRotate for 409, ws.close timeout, add @sinclair/typebox dep for Pi adapter
- Align Python SDK transport with real Relaycast API surface
- Address Devin review findings
- Exclude vitest test files from SDK build config
- Add @sinclair/typebox to root dependencies for global install
- Address PR review feedback
- Communicate mode spec compliance — adapters, tests, infra
- Critical spec compliance issues from deep review
- Spec compliance — ping/pong, auto-detect module matching
- Add per-adapter subpath exports and withRelay alias
- Sync package-lock.json with package.json

## [3.2.3] - 2026-03-15

### Added

- Add HTTP transport mode; route all CLI commands through SDK

### Changed

- Add tests for droid/opencode auto-accept permission detection

### Fixed

- Use correct broker init subcommand and --api-port flag
- Use broker binary path instead of process.argv[1] for auto-start
- Add RELAY_SKIP_BOOTSTRAP to Codex, Opencode, and Gemini/Droid config paths
- Auto-accept droid/opencode permission prompts with --cwd
- Set RELAY_SKIP_BOOTSTRAP when agent token is pre-registered
- Address review feedback on HTTP client and listing commands
- Auto-accept Claude Code folder trust prompt for spawned agents

## [3.2.2] - 2026-03-14

### Added

- Package plugins as proper platform formats and PRPM collections
- Implement CLI native plugins for OpenCode, Claude Code, and Gemini CLI
- Add deterministic step support to WorkflowBuilder

### Changed

- Update MCP tool name references to 3-level hierarchy

### Fixed

- Suppress codex update prompt in spawned workers
- Remove relay.shutdown() that killed the running broker in status command
- Add jq availability check in before-model-inject.sh
- Make broker API port discovery injectable for testability
- Status command spawns new broker instead of connecting to existing one
- Address Devin review round 2 — error handling, state mutation order, message limit
- Address Devin PR review comments
- Address minor verification gaps across all 3 plugins
- Idle verification loop handles single-fire agent_idle events
- Idle verification loop mirrors runVerification double-occurrence guard
- Non-lead agents in hub-spoke should use idle-as-complete
- Address Devin review feedback on PR
- Use ref-counted Map for activeReviewers instead of Set
- WorkflowBuilder drops preset field and reviewer double-booking

## [3.2.1] - 2026-03-13

### Added

- Point-person-led completion pipeline

## [3.2.0] - 2026-03-13

### Added

- Deterministic workspace key from user + directory

### Changed

- Move skills to dedicated directory with symlinks
- Add workflow smoke matrix for codex and gemini

### Fixed

- Pass --model flag to spawned CLI processes
- Rebind relaycast tokens after workspace switch
- Update MCP tool name references to dot-notation hierarchy
- Inject inter-agent DMs via workspace WebSocket
- Exact flag matching for --mcp-config guard

## [3.1.22] - 2026-03-11

### Fixed

- Install parity and spawn deserialization fallback
- Preserve user MCP servers when spawning Claude from dashboard
- Codex bypass flag → --dangerously-bypass-approvals-and-sandbox

## [3.1.21] - 2026-03-11

### Added

- Wire workspaceName/relaycastBaseUrl options in AgentRelay
- Add multi-workspace support to OpenClaw bridge
- Add skipRelayPrompt flag to skip MCP config injection on spawn
- Wire multi-workspace runtime flows
- Add multi-workspace auth plumbing

### Changed

- Record multi-workspace implementation trail

### Fixed

- SwitchWorkspace clawName, stale alias default, and corrupt JSON handling
- Preserve skip_relay_prompt on restart
- Reset exit info per retry + preserve exit code on spawn failure
- Avoid wiping workspace alias/id when add-workspace updates without flags
- Use timeoutMs directly in nudge loop timeout guard
- Forward skip_relay_prompt in Python SDK and skip pre-registration in broker
- Workspace default handling in add-workspace
- Harden multi-workspace add-workspace default and logging behavior
- Distinguish force-released (nudge exhaustion) from released (idle-complete)
- Address PR review feedback in workflow runner
- Always record failed attempt output for workflow retries
- Pass skipRelayPrompt through spawner headless path and simplify Rust type
- Include exitCode and exitSignal in step events
- Escape TOML string values for codex --config workspace env vars
- Treat force-released agent as step failure, not success
- Correct error message for default workspace lookup failure and forward workspace env vars in MCP snippets
- Use workspace-scoped dedup keys for MCP self-echo pre-seeding
- Allow clippy too_many_arguments on MultiWorkspaceSession::new
- Address multi-workspace code review bugs from PR
- Restore carriage return in wrap retry PTY injection

## [3.1.19] - 2026-03-10

### Fixed

- Resolve install binary verification, uninstall, and version prefix bugs

## [3.1.18] - 2026-03-10

### Added

- Multi-workspace runtime support
- Harden handoffs with auto step owners + per-step reviews

### Fixed

- Rebase release commit on latest main before pushing
- Guard specialist promise in executor supervised path
- Avoid rotating relay agent token on setup

## [3.1.14] - 2026-03-09

### Fixed

- Prevent race condition in relay WS handler binding

## [3.1.13] - 2026-03-09

### Fixed

- Bind relay event handlers after WS connect
- Expose all workspace DM conversations in dashboard

## [3.1.10] - 2026-03-05

### Fixed

- Quote make_latest to prevent openclaw release from hijacking latest

## [3.1.1] - 2026-03-04

### Added

- Add openclaw-relaycast package

### Fixed

- Remove unsupported dashboard flag from dev script

## [3.1.0] - 2026-03-04

### Added

- Make provider spawn transport-driven
- Add direct spawn/message API

### Changed

- Switch runtime contract to provider-driven headless
- Align contract fixture checks with broker event shapes

### Fixed

- Make SDK lifecycle release test more robust

## [3.0.2] - 2026-03-02

### Changed

- Republished 2.3.16 unchanged under the 3.x version line; no functional changes.

## [2.3.16] - 2026-03-02

### Changed

- Stabilize macOS CLI agents timeout
- Allow SDK broker fallback in macOS npx verify
- Accept SDK broker fallback in npx resolution check
- Fix verify-publish PR package resolution
- Accept both relaycast workspace key field shapes
- Restore coverage threshold and fix sdk integration type
- Retrigger checks
- Use published relaycast 0.3.0 crate

### Fixed

- Resolve platform-specific broker binary in SDK
- Use SDK join_channel API for broker channel joins
- Remove relay-pty references from postinstall.js
- Update verify-install to check for agent-relay-broker instead of relay-pty
- Remove redundant registration map_err conversion

## [2.3.14] - 2026-02-19

### Changed

- Auto-generate CHANGELOG on stable release

## [2.1.5] - 2026-01-30

### Added

- Task injection retries: Spawning agents with tasks now automatically retries delivery up to 3 times, preventing silent failures that left agents without their initial instructions.

### Changed

- Injection retry logic added to spawn flow with configurable attempts and backoff.
- Cursor-agent reconciliation ensures agent state matches the editor's cursor position after reconnects.

### Fixed

- Auto-suggestion injection and cursor-agent reconciliation fixed — agents now correctly receive suggestions and cursor state stays in sync.

## [2.1.3] - 2026-01-29

### Added

- Agent-to-agent JSONL watch: Agents can now observe each other's activity streams via JSONL watch, enabling real-time coordination.
- Onboarding improvements: Smoother first-run experience with better prompts and flow handling.
- SQLite dependency removed: Storage layer switched from SQLite to JSONL, reducing native binary requirements and simplifying installation.

### Changed

- Storage backend migrated from SQLite to JSONL flat files, eliminating the native `better-sqlite3` dependency.
- Relay-pty binary resolution rewritten with comprehensive edge case handling for npx, global installs, and monorepo setups.
- Agent-to-agent JSONL watch enables streaming observation of peer agent activity.
- Comprehensive test suite added for relay-pty binary path resolution across install scenarios.
- Bundled dependency audit added to CI.
- Timeout and skip logic for x64 macOS verification on PRs.
- Removed `better-sqlite3` native dependency in favor of JSONL storage.
- macOS x64 verification job removed from CI (slow, low value).

### Fixed

- Relay-pty binary resolution fixed for `npx` usage — no longer requires postinstall scripts, making global installs more reliable.
- Messages path routing corrected for dashboard storage.

## [2.0.37] - 2026-01-28

### Added

- OpenCode HTTP API integration: Full OpenCode provider support via HTTP API, enabling OpenCode as a first-class agent backend.
- File-based continuity: Agents can now save and restore session state through file-based continuity commands, surviving restarts and long operations.
- Performance benchmarking: New benchmarking package for comparing agent configurations and measuring swarm performance.
- MCP client parity: MCP client now aligned with SDK for consistent behavior across both integration paths.

### Changed

- OpenCode HTTP API integration adds a new provider adapter for the OpenCode backend.
- File-based continuity command handling added to orchestrator for session persistence.
- New `listConnectedAgents()` and `removeAgent()` APIs for programmatic agent management.
- Shared client helpers extracted to `@agent-relay/utils` for SDK/MCP consistency.
- MCP client aligned with SDK: `sendAndWait` return types updated to `AckPayload`, `PROTOCOL_VERSION` imported consistently.
- Agent capacity increased to support 10,000 concurrent agents.
- Output buffer bounds enforced to prevent `RangeError` crashes from large payloads.
- Storage reliability and security fixes: health checks, doctor diagnostics, and JSONL handling hardened.
- Stale agent cleanup on process death prevents ghost entries in connected agent lists.
- Relay-pty binary fallback logic improved for cross-platform resolution.
- Post-publish verification workflow added for npm packages with npx, Docker, and macOS tests.
- CJS build artifacts generated during `npm pack` for dual ESM/CJS support.
- Bundled dependencies ensure tarball includes all `@agent-relay` packages.
- macOS CI runners updated (macos-13 → macos-15-large, macos-12 for Intel x64).
- Dashboard publishing removed from relay monorepo (moved to relay-cloud).

### Fixed

- Unbounded output buffer crash fixed: `RangeError` from large agent output no longer crashes the process.
- Storage health reporting and doctor CLI now correctly handle JSONL storage.
- Stale agents cleaned up automatically when their process dies without a clean disconnect.
- CJS exports fixed for `agent-relay` and `@agent-relay/utils` — CommonJS consumers can now `require()` the packages.

## [2.0.25] - 2026-01-27

### Added

- Dashboard moved to relay-cloud: Dashboard package removed from the relay monorepo and migrated to the dedicated relay-cloud repository, simplifying the core package.
- CLI dashboard startup: `--dashboard` flag now launches the dashboard via npx fallback when not locally available.
- Socket length handling: Long socket messages no longer truncated or malformed.
- Stale agent cleanup: Agents whose processes die without clean disconnect are now automatically removed.
- 10K agent capacity: Relay server now supports up to 10,000 concurrent connected agents.

### Changed

- Dashboard package fully removed; CI updated to test daemon via socket instead of HTTP.
- `listConnectedAgents()` and `removeAgent()` APIs added for agent lifecycle management.
- Agent capacity limit raised to 10,000.
- Socket length handling improved in Rust relay-pty core.
- Stale agent cleanup prevents ghost entries when processes exit uncleanly.
- CLI tests no longer conflict with a running local daemon.
- Dashboard publishing workflow removed; package cleanup across workspaces.
- npx fallback added for dashboard startup in CLI.

### Fixed

- Dashboard references cleaned up after package removal to prevent broken imports.
- Socket.rs `warn!` macro indentation corrected for proper Rust compilation.
- CLI tests isolated from running daemon to prevent interference.

## [2.0.20] - 2026-01-26

### Added

- Swarm primitives added to SDK with full documentation and examples.
- CLI auth testing tooling introduced with repeatable scripts and Docker workflows.
- Provider connection UI copy refreshed (OpenCode/Droid messaging updates).
- Improved onboarding reliability for OAuth flows in cloud workspaces.
- `@agent-relay/mcp` package with MCP tools/resources and one-command install.
- Swarm primitives SDK API and examples (`SWARM_CAPABILITIES`, `SWARM_PATTERNS`).
- CLI auth testing package with Docker and scripted flows.
- New roadmap/spec documentation for primitives and multi-server architecture.

### Changed

- Major SDK expansion with swarm primitives, logs API, and protocol types.
- New CLI auth testing package with Dockerized workflows and scripts.
- Relay-pty and wrapper improvements focused on reliability and orchestration.
- Expanded documentation for swarm primitives and testing guides.
- New SDK client capabilities (`client`, `logs`, and protocol types) and expanded test coverage.
- Spawner logic updated for more reliable agent registration and routing.
- Relay-pty orchestration updated in Rust core with supporting wrapper changes.
- Idle detection strengthened in wrapper layer (logic + tests).
- Relay-pty orchestration hardened; additional tests for injection handling.
- Workspace package updates and lockfile refresh.
- New hooks scripts (`scripts/hooks/install.sh`, `scripts/hooks/pre-commit`) for developer workflows.
- Dockerfiles updated for workspace and CLI testing images.
- Added `packages/cli-tester` with auth credential checks and socket client utilities.
- New CLI tester scripts for spawn/registration/auth flows.
- `packages/config` gains CLI auth config updates for cloud onboarding.
- `relay-pty` binary updated for macOS arm64.
- Dynamic import for MCP commands in CLI.
- Spawner and daemon routing adjustments for improved registration and diagnostics.
- Wrapper base class behavior and tests for relay-pty orchestration.
- Updates to workspace Dockerfiles and publish workflow tweaks.
- Package metadata alignment across SDK, dashboard, wrapper, spawner, and api-types.
- Additional instrumentation in relay-pty and orchestrator to support reliability.
- Swarm primitives guide and comprehensive roadmap specification.
- CLI auth testing guide.

### Fixed

- Spawner registration timeouts in cloud workspaces resolved.
- Idle detection behavior made more robust to avoid false positives.
- OAuth URL parsing now handles line-wrapped output from CLI.
- Cloud spawner timeout in agent registration.
- OAuth URL parsing for line-wrapped output in CLI auth flows.
- Idle detection stability in wrapper layer.
- Relay-pty postinstall and codesign handling for macOS builds.
- Minor CI/test issues in relay-pty orchestrator tests.
