# Changelog

All notable changes to Agent Relay will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `@agent-relay/harness-driver` adds local fleet sidecar protocol frames for node and handler registration, clean node deregistration, broker handler invocation, handler results, handler-attributed spawns, object-record capability metadata, and sidecar supervision metadata.
- `@agent-relay/cloud` adds a canonical cloud session and active-workspace contract, including `ensureCloudSession`, `resolveActiveWorkspace`, promoted workspace-store APIs, access-token-only `agent-relay cloud session --json`, and `agent-relay workspace active --json` for cross-language consumers.
- `agent-relay-broker` adds a fleet node control plane: a `node_control` client that drives the harness-driver sidecar over the local protocol, runtime wiring that registers nodes and handlers, dispatches broker handler invocations, and attributes handler spawns, with hardened node/handler registration timing.
- `@agent-relay/fleet` ships the fleet node SDK — `defineNode`/`action`/`spawn`/`onMessage` declare a node's typed capabilities and channel-message triggers. Trigger `match` regexes must be flag-free: a flagged regex (e.g. `/ship/i`) is rejected at `defineNode` rather than silently matched case-sensitively — use character classes like `[Ss]hip`.
- `agent-relay fleet serve|nodes|status` runs a fleet node sidecar and inspects registered nodes, and the broker MCP surface adds `query_nodes` and `spawn` tools.
- `@agent-relay/config` `CLI_AUTH_CONFIG` adds an `xai` provider (Grok CLI): `grok login --device-auth` device-code connect, `~/.grok/auth.json` credential capture, and the official x.ai installer as the sandbox fallback — so cloud sandboxes can authenticate the `grok` harness from a connected account instead of an API key.
- `@agent-relay/sdk` wires the durable delivery surface to the Relaycast backend: `inbox.list`, `inbox.subscribe`, `inbox.ack/fail/defer`, and `deliveries.ack/fail/defer` now use the hosted delivery ledger, agent-scoped capabilities report `serverDeliveryState: true`, and `DeliveryRunner` works against Relaycast-backed inbox items.
- Two-node fleet E2E (`tests/e2e/fleet`, `npm run test:e2e`, `Fleet E2E` CI workflow): boots a real relaycast engine plus two `agent-relay fleet serve` nodes (real Rust broker + sidecar each) and asserts the live control wire — boot/register (real broker `Authorization: Bearer` node auth), negative auth, capability-filtered roster, cross-node action dispatch + ack, declarative trigger fire-once with loop guard, end-to-end spawn completion (token mint+inject), capability-routed + least-loaded + resume placement, `capability_mismatch` failure, in-flight reschedule on node death + restart reconcile, and bounded-mailbox TTL dead-letter.

### Changed

- `codex-relay-skill` and `gemini-relay-extension` now default to `https://gateway.relaycast.dev`, matching the `agent-relay` CLI and SDK. Set `RELAY_BASE_URL` to keep using `https://api.relaycast.dev`.
- `agent-relay local agent message hold|flush|auto <name>` now owns local broker delivery controls; the old top-level `agent-relay agent message ...` path was removed.

### Fixed

- `@agent-relay/cloud` now writes cloud auth atomically and serializes file-backed token refreshes across processes, preventing concurrent refreshes from clobbering rotated credentials.
- `@agent-relay/cloud` refresh now fails with typed, timeout-bounded errors and migrates legacy `~/.agent-relay/cloud-auth.json` credentials into the canonical `~/.agentworkforce/relay/cloud-auth.json` store without dual-writing.
- `agent-relay-broker` persists pending deliveries on shutdown and on every queue change, redelivers them on restart, reports timeout-fallback verification explicitly, and emits `delivery_dropped` when the per-worker queue cap evicts a message.

## [8.7.2] - 2026-06-13

### Added

- Add worker CLI client

## [8.7.1] - 2026-06-13

### Fixed

- Refresh lockfile for cloud workspace version

## [8.7.0] - 2026-06-13

### Added

- Unify auth session

### Changed

- Include cloud session commands in bootstrap manifest
- Add infrastructure-failure delivery coverage

## [8.6.0] - 2026-06-11

### Added

- Add xai (Grok CLI) provider to CLI_AUTH_CONFIG

### Changed

- Move local message controls under local agent
- [codex] Fix changelog release attribution

## [8.5.0] - 2026-06-11

### Added

- Wire durable delivery surface to the Relaycast backend

### Fixed

- Make delivery handling durable and observable
- Default plugin base URLs to gateway.relaycast.dev

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
