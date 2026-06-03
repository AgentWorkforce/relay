# Changelog

All notable changes to Agent Relay will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `@agent-relay/sdk` `relay.addListener(...)` on a workspace client now receives all workspace-visible events: `events.connect()` opens the relaycast 2.5 workspace stream when no agent client is present, so the documented `relay.addListener('message.created', ...)` quickstart path streams without registering an agent.
- `CORE_SIMPLIFICATION_SCOPE.md` documents the SemVer-major Agent Relay package boundary: core SDK communication, delivery, actions, and optional managed harnesses in `@agent-relay/harness-driver`.
- `@agent-relay/sdk` adds normalized messaging, delivery, and action APIs: agents, channels, DMs, threads, reactions, inbox, events, `DeliveryRunner`, and `ActionRegistry`.
- `@agent-relay/sdk` adds the public session/harness contract: `HarnessConfig`, `AgentSession`, session identity, capabilities, delivery modes, message receipts, and session event types.
- `@agent-relay/harness-driver` adds the optional managed harness boundary for broker startup, PTY/headless spawn, release/status, logs/readiness plumbing, and runtime-provided actions such as `agent.create`, `agent.release`, `agent.status`, and `agent.attach` when supported.
- `@agent-relay/harnesses` PTY harnesses (`claude`, `codex`, …) accept `create({ relay })` to spawn a live PTY session into the relay's workspace through `@agent-relay/harness-driver` and return a handle to the running, already-registered agent. One broker is started per relay and shared across agents; `create()` without `relay` still builds a descriptor for externally-run agents.
- `agent-relay mcp` can expose registered SDK actions as explicit MCP tools plus `list_actions` and `invoke_action`.
- `agent-relay mcp` recovers from stale agent tokens mid-session: a 401 carrying `agent_token_invalid` (or the legacy `Invalid agent token` message) now clears the dead token from the MCP session, returns recovery guidance pointing at `register_agent`, and lets strict-named sessions re-register without a process restart.
- `@agent-relay/sdk` exports `isInvalidAgentTokenError`, `isInvalidAgentTokenToolResult`, and `agentTokenRecoveryMessage` for consumers that need the same detection contract outside the bundled MCP server.
- `agent-relay-broker` adds `is_agent_token_invalid`, `is_agent_token_invalid_anyhow`, and `is_agent_token_invalid_code` on `crates/broker/src/relaycast/auth.rs`, and preserves the upstream `RelayError::Api` code through `relay_error_to_anyhow` so the same recovery signal is available to Rust callers.
- GitHub Actions can sync repository traffic views, clones, popular paths, and referrers into PostHog with daily backfill across GitHub's available traffic window.
- Broker and TypeScript SDK structured result contracts add the `submit_result` MCP tool, `agent.waitForResult()`, per-spawn `result.onResult`, and `relay.addListener('agentResult', ...)` for typed JSON worker outcomes.
- `@agent-relay/sdk` and `agent-relay-broker` add broker-executable `pty` and `headless` harness configs, so custom CLIs can be configured without Rust changes while spawn requests remain self-contained.
- `agent-relay-broker` accepts resolved harness configs on spawn and adds a headless app-server driver for delivering Relay messages to existing OpenCode server sessions.
- `@agent-relay/sdk` exposes `AgentRelay.spawnAgent({ runtime, cli, ... })` as the single high-level spawn facade for both PTY and headless agents.
- `@agent-relay/sdk` adds `AgentRelay.getPersonaSpawnPlan(id)` and a `getPersonaSpawnPlan` export for dry-run inspection of a persona's resolved harness argv, skill installs, mount policy, sidecars, and inputs.
- `agent-relay view`, `agent-relay drive`, and `agent-relay passthrough` remain available as top-level attach commands alongside `agent-relay runtime agent attach --mode`.
- `@agent-relay/sdk` `relay.workspace.register(...)` returns a live agent client (identity, `status.becomes(...)`/`tools.called(...)` predicates, and an agent-scoped messaging surface); a single agent in returns one client, an array returns an array.
- `@agent-relay/sdk` adds `relay.workspace.reconnect({ apiToken })` to rehydrate a live agent client from a persisted token.
- `@agent-relay/sdk` adds `relay.addListener(selector, handler)` as the single listener entry point — `selector` is a dotted event name, a `*`/prefix wildcard, or a predicate — delivering one discriminated event object; message events carry a rich `envelope` (`from`/`to`/`channel`/`parent`).
- `@agent-relay/sdk` actions are fire-and-forget over the relay: `relay.registerAction(...)` registers a descriptor and runs the handler on `action.invoked`, reporting the result; outcomes surface as `action.completed` events to `addListener`.
- `@agent-relay/sdk` adds the `relay.webhooks` namespace: `createInbound({ channel })` returns `{ url, token }` for posting `{ message, author }` into a channel, and `subscribe({ url, events, secret, headers })` for outbound HMAC-signed event delivery.
- `@agent-relay/sdk` agent clients send via `sendMessage({ to })` (`#channel`, `@handle`, or an array of `@handle`s for a group DM), `reply({ messageId })`, and `react({ messageId, emoji })`; every message exposes `messageId`.
- `@agent-relay/harnesses` adds `createHuman({ relay, name })` (self-registers a human, returns the live client) and re-exports `defineHarness` plus the harness contract types.
- `agent-relay` forwards CLI origin, orchestrator harness, and distinct client identity context to hosted Relaycast so backend telemetry can distinguish CLI/SDK traffic from raw API calls.

### Changed

- Relay stores per-project runtime state in `.agentworkforce/relay/` (was `.agent-relay/`), and the global data/log home moves from `~/.agent-relay`, `$XDG_DATA_HOME/agent-relay`, and platform equivalents to `agentworkforce/relay`. The `~/.config/agent-relay` config directory is unchanged.
- `agent-relay` installs and resolves dashboard UI assets under the install dir (`~/.agentworkforce/relay/dashboard`) instead of `~/.relay/dashboard`, unifying the on-disk footprint. The broker still reads `~/.relay/dashboard` as a fallback and re-downloads assets to the new location on version mismatch.
- Upgraded relaycast to 2.x (`@relaycast/sdk` and the `relaycast` Rust crate): spawn/release now run as relaycast actions. The broker registers `spawn`/`release` actions on startup and handles `action.invoked` (reading input via the actions API and reporting completion) in place of the removed `command.invoked` protocol; `@agent-relay/openclaw` surfaces `action.invoked` instead of channel slash-commands.
- `agent-relay` and `@agent-relay/sdk` now consume `@relaycast/sdk` 2.5.x, which carries the v8 service contract (reconnect/resolve-by-token, inbound webhooks with bearer tokens, outbound subscription headers + HMAC, the canonical dotted event vocabulary, and the fire-and-forget action invoke/complete endpoints) plus a workspace-scoped realtime stream.
- `@agent-relay/sdk` `AgentSession.release` is now optional and `capabilities.lifecycle.release` is a boolean: provide `release()` only when the capability is `true`.
- `@agent-relay/openclaw` consumes relaycast's unified `message.reacted` event (replacing the separate reaction-added/removed events).
- `README.md` and `packages/sdk/README.md` now present Agent Relay around three public SDK categories: messaging, delivery, and actions.
- `@agent-relay/sdk` actions accept Zod-compatible `safeParse` schemas alongside JSON-schema-lite, and `DeliveryRunner` can deliver inbox items to session targets through `receiveMessage(...)`.
- `agent-relay` keeps default commands focused on messaging, MCP, diagnostics, setup, and telemetry; managed harness lifecycle now lives under `agent-relay driver ...`.
- Root builds now validate the simplified core package set: config, utils, SDK, harness-driver, harnesses, and CLI.
- `@agent-relay/sdk` no longer emits client-side analytics or depends on `@agent-relay/telemetry`; SDK/API attribution uses Relaycast origin metadata instead.
- `agent-relay` CLI telemetry now posts through the hosted ingestion proxy at `https://i.agentrelay.com` by default.

### Deprecated

- `@agent-relay/telemetry` is deprecated as a public npm package; telemetry implementation is now internal to the `agent-relay` CLI.
- `agent-relay mcp`: Agent Relay now ships its own MCP stdio server with underscore tool names such as `post_message` and `add_reaction`, and generated MCP configs use `npx -y agent-relay mcp`.
- `agent-relay mcp`: renamed the bundled implementation and command override to Agent Relay MCP (`AGENT_RELAY_MCP_COMMAND`).
- `agent-relay up`: broker startup no longer writes external MCP entries to project `.mcp.json`; spawned agents receive the MCP server through launch-time configuration.
- Release workflow changelog generation now writes concise Keep a Changelog sections and skips web-only, release-only, trajectory, PR-review, placeholder, and withdrawn-tag entries.
- `@agent-relay/openclaw` remains available as an optional OpenClaw adapter package, with managed spawn internals moved to `@agent-relay/harness-driver` instead of the core SDK.
- Workspace setup now leads with creating an Agent Relay workspace through the SDK, MCP, or OpenClaw setup instead of requiring a pre-provisioned Agent Relay API key; existing workspace keys are treated as join secrets.
- `@agent-relay/sdk` `spawnPersona` now runs the full `@agentworkforce/persona-kit` lifecycle (skill installs, mount policy, `CLAUDE.md` / `AGENTS.md` sidecars, persona inputs) before launching the harness, and reverses every side effect when the agent exits. Previously it only translated the harness argv and silently dropped the rest of the schema.

### Breaking Changes

- `@agent-relay/sdk` `relay.workspace.register(...)` returns a live agent client instead of a `{ token }` registration record, and rejects duplicate agent names.
- `@agent-relay/sdk` removes `AgentRelay.as()` / `asAgent()`; act as a registered agent through the client returned by `workspace.register(...)` / `workspace.reconnect({ apiToken })`.
- `@agent-relay/sdk` removes the top-level `relay.sendMessage(...)` (no system sender); send from a registered agent or human client.
- `@agent-relay/sdk` removes `relay.on(...)` and `relay.notify(...)`; use `relay.addListener(...)` (the fluent predicate builders are still accepted as selectors).
- `@agent-relay/sdk` removes the public `relay.actions` register/invoke namespace; use `relay.registerAction(...)` and react to `action.completed` via `addListener`.
- Relay's on-disk state directory is renamed from `.agent-relay/` to `.agentworkforce/relay/`, and the global `~/.agent-relay`, `$XDG_DATA_HOME/agent-relay`, platform data dirs, and broker log dirs move under `agentworkforce/relay`. Existing brokers and state under the old paths are not migrated.
- `@agent-relay/sdk` is scoped to communication primitives; managed broker startup, PTY/headless harness spawning, workflow supervision, and harness lifecycle helpers move to optional `@agent-relay/harness-driver`.
- `@agent-relay/sdk` removes root and subpath exports for broker clients, spawn facades, PTY/headless helpers, workflow/consensus/shadow helpers, communicate adapters, browser/worker entry points, and GitHub/Slack primitive adapters.
- `agent-relay` removes spawn-first, workflow/swarm, DLQ, activity, log, and `on` command trees from the default CLI package.
- `@agent-relay/sdk` swaps `@agentworkforce/harness-kit` + `@agentworkforce/workload-router` for `@agentworkforce/persona-kit@^3`. The persona tier system, the `tier` option on `spawnPersona`, the legacy relay-side `PersonaFile` / `PersonaTier` / `PersonaTierSpec` / `ResolvedPersona` / `PersonaSpawnSpec` / `MaterializedConfigFile` types, and the `buildPersonaSpawnSpec` / `materializePersonaConfigFiles` / `restorePersonaConfigFiles` helpers are removed. `loadPersona` now returns the canonical `PersonaSpec`, and `spawnPersona({ persona })` takes a `PersonaSpec` instead of a resolved persona.
- `@agent-relay/sdk` removes persona support from the SDK surface: the `./personas` subpath, persona helper/type exports, `AgentRelay.spawnPersona()`, `AgentRelay.getPersonaSpawnPlan()`, and `AgentRelayOptions.personaDirs` are gone. The SDK no longer depends on `@agentworkforce/persona-kit`.
- `@agent-relay/sdk` renames the raw client spawn surface from provider terminology to CLI terminology: `HarnessDriverClient.spawnProvider()` is now `spawnCli()`, `SpawnProviderInput` is now `SpawnCliInput`, and `SpawnHeadlessInput.provider` is now `SpawnHeadlessInput.cli`.
- `@agent-relay/sdk` removes the high-level `AgentRelay.spawnPty()`, `AgentRelay.spawnHeadless()`, positional `AgentRelay.spawn()`, `AgentRelay.spawnAndWait()`, and shorthand CLI spawners such as `relay.claude.spawn()`. Use `AgentRelay.spawnAgent({ cli, ... })`; `runtime` defaults to `"pty"` and `name` defaults from `cli`.
- `agent-relay-broker`'s public Rust protocol types now require typed ID newtypes (`WorkerName`, `DeliveryId`, `EventId`, `WorkspaceId`, `WorkspaceAlias`, `ThreadId`, `AgentId`, `RequestId`, `ChannelName`, `MessageTarget`) on every protocol struct and enum variant in `protocol.rs`, `types.rs`, and `listen_api.rs::ListenApiRequest`. The new wrappers live in `crates/broker/src/lib.rs` under `pub mod ids`. JSON wire format is unchanged because every wrapper is `#[serde(transparent)]`, so the broker ↔ SDK channel and on-disk persisted state remain byte-compatible.
- `agent-relay spawn` and SDK spawn calls now return harness `sessionId` metadata for resumable Claude and Codex PTY sessions.
- `sdk-swift`: renamed the broker client class `RelayCast` → `AgentRelayClient`.
- `@agent-relay/harness-driver` renames the managed broker client and its companion exports: `AgentRelayClient` → `HarnessDriverClient`, `AgentRelayClientOptions` → `HarnessDriverClientOptions`, `AgentRelaySpawnOptions` → `RuntimeSpawnOptions`, `AgentRelayBrokerInitArgs` → `BrokerInitArgs`, `AgentRelayEvents` → `HarnessDriverEvents`, and `AgentRelayProtocolError` → `HarnessDriverProtocolError`.

### Migration Guidance

- Bind to the live client `register(...)` returns instead of a token: `const alice = await relay.workspace.register({ name, type })`, then call `alice.sendMessage(...)` / `alice.channels.join(...)`. Persist `alice.token` to reconnect later with `relay.workspace.reconnect({ apiToken })`; replace `relay.as(token)` with that.
- Replace `relay.sendMessage(...)` with a send from a registered participant (`alice.sendMessage(...)` or a `createHuman(...)` client). The workspace no longer sends as a system identity.
- Replace `relay.on(predicate, handler)` with `relay.addListener(predicate, handler)`, and prefer dotted event names (`relay.addListener('message.created', ...)`); replace `relay.notify(...)` with an inline handler that sends from a participant.
- Replace `relay.actions.register(...)` / `relay.actions.invoke(...)` with `relay.registerAction(...)`; read outcomes from `action.completed` events (the invoking agent gets an ack, not the return value — message it from the handler if it needs the result).
- Read a message id as `message.messageId` (not `message.id`); reply with `reply({ messageId })` and react with `react({ messageId, emoji })`.
- Stop any running broker before upgrading, then remove the stale `.agent-relay/` directory (and `~/.agent-relay`, `$XDG_DATA_HOME/agent-relay` if present) and restart with `agent-relay up`; state is recreated under `.agentworkforce/relay/`. The broker re-adds `.agentworkforce/relay/` to `.git/info/exclude`, leaving any tracked `.agentworkforce/trajectories/` untouched.
- Install `@agent-relay/harness-driver` for code that starts brokers, spawns PTY/headless agents, waits for managed harness state, or runs supervised workflows; keep `@agent-relay/sdk` for identities, messages, delivery/read state, presence, and commands.
- Replace `agent-relay up/status/down` with `agent-relay driver up/status/down` when you want Agent Relay to manage the local harness boundary.
- Replace SDK spawn calls with driver actions (`agent.create`, `agent.release`, `agent.status`) when agents need to request managed harness work through MCP.
- Personas relying on `tiers.*` need to be flattened to a single top-level `harness` / `model` / `systemPrompt`. The shape that persona-kit (and the `agentworkforce` CLI) consumes is now the only supported shape.
- Callers that previously used `spawnPersona` to "just launch the harness" — without persona-kit's skill / mount / sidecar side effects — should use `AgentRelay.getPersonaSpawnPlan(id)` to inspect the plan and call `spawnAgent({ cli, args })` themselves.
- Launch personas through the owning CLI or package and pass the resulting command to `relay.spawnAgent({ cli, ... })` or `relay.spawnAgent({ runtime: "headless", cli, ... })`; for AgentWorkforce personas, use `npx agentworkforce persona run <id>` once available so persona side effects remain CLI-owned.
- Replace high-level `relay.spawnPty(...)`, `relay.spawnHeadless(...)`, `relay.spawn(...)`, `relay.spawnAndWait(...)`, and `relay.<cli>.spawn(...)` calls with `relay.spawnAgent({ cli, ... })`; add `runtime: "headless"` only for headless app-server sessions, and wait explicitly with the returned agent handle when needed.
- Replace `client.spawnProvider({ provider, ... })` with `client.spawnCli({ cli, ... })`; replace `client.spawnHeadless({ provider, ... })` with `client.spawnHeadless({ cli, ... })`.
- Downstream Rust callers must construct identifiers via `relay_broker::ids::{WorkerName, DeliveryId, EventId, MessageTarget, …}` instead of `String`. Each newtype impls `From<String>` / `From<&str>` and `Deref<Target = str>`, so most string-handling code keeps compiling; only construction sites (`HashMap` keys, struct literals, channel sends) need updates.
- Replace ad-hoc target discrimination (`target.starts_with('#')`, `target == "thread"`) with `MessageTarget::kind()` and match on `MessageTargetKind::{Channel, Thread, DirectMessage, Conversation, Worker}`.
- `sdk-swift`: replace `RelayCast(apiKey:baseURL:)` with `AgentRelayClient(apiKey:baseURL:)`. The public API surface is otherwise unchanged.
- Import `HarnessDriverClient` (was `AgentRelayClient`) from `@agent-relay/harness-driver`; the `connect()`/`spawn()` API is unchanged. Update companion type names (`HarnessDriverClientOptions`, `RuntimeSpawnOptions`, `BrokerInitArgs`, `HarnessDriverEvents`, `HarnessDriverProtocolError`) at import sites.

### Removed

- `@agent-relay/config` removes the unused `getGlobalPaths()` and `listProjects()` exports (legacy global-storage helpers) and drops the `.agent-relay.json` project-root config fallback; shadow config now loads only from `.agentworkforce/relay/config.json`.
- `@agent-relay/config` removes the legacy `/tmp/relay-outbox` symlink: `RelayFileWriter` no longer creates it on `ensureDirectories()`, and the `getLegacyOutboxPath()` method and `RelayPaths.legacyOutboxDir` field are gone.
- `agent-relay` drops the legacy `~/.agent-relay/dashboard` static-asset fallback from broker startup. (Uninstall still purges legacy install dirs.)

### Fixed

- `agent-relay local agent list` and `local metrics` now connect only to an existing local broker, so read-only commands no longer start an empty broker and hang after printing results.
- `@agent-relay/cloud`: CLI browser login ignores stray localhost callbacks with an invalid state parameter, so first-time sign-ins are not shown a false hosted error or aborted before the real OAuth callback returns.
- Root package builds now compile `@agent-relay/cloud` before SDK and CLI packages that consume its generated declarations, without rewriting a tracked broker binary.
- `agent-relay-broker` harness configs now report harness PIDs instead of wrapper worker PIDs, validate app-server protocol/auth/host settings at spawn, and give app-server release requests time to finish.
- `@agent-relay/sdk` normalizes broker `pid: null` spawn responses to `undefined` while PTY harness PIDs are reported asynchronously.
- `web`: PR preview SST deploys use and comment the generated CloudFront URL and AWS's managed disabled cache policy instead of creating per-preview Cloudflare DNS records, ACM certificates, and custom CloudFront cache policies.
- `sdk-swift`: broker client now connects to the v7 broker's `/ws` event stream without a legacy `hello`/`hello_ack` handshake and routes `spawnAgent`, `releaseAgent`, channel `post`, and agent `dm` through the broker's HTTP API (`/api/spawn`, `/api/spawned/{name}`, `/api/send`).
- `agent-relay start dashboard.js [cli]` remains available for local dashboard harness workflows.
- `agent-relay workspace` stores workspace keys with owner-only permissions and rejects reserved object-property names.

### Security

- `@agent-relay/slack-primitive` bumps `@slack/web-api` to `^7.16.0`, which raises its transitive `axios` floor to `^1.16.0` and clears GHSA-q8qp-cvcw-x6jj (prototype pollution gadgets in HTTP adapter allowing credential injection) and GHSA-3w6x-2g7m-8v23 (invisible JSON response tampering via `parseReviver`).
- `agent-relay-sdk` drops the `[swarms]` optional extra so `swarms` (and its pinned `litellm==1.76.1`) is no longer a transitive dependency, clearing the LiteLLM Dependabot alerts. The Swarms adapter still works for users who `pip install swarms` themselves.
- `agent-relay-sdk` refreshes `packages/sdk-py/uv.lock` to clear 20 transitive CVEs across `urllib3` (2.6.3→2.7.0), `gitpython` (3.1.46→3.1.50), `pillow` (12.1.1→12.2.0), `python-multipart` (0.0.22→0.0.29), `cryptography` (46.0.6→48.0.0), `authlib` (1.6.9→1.7.2), `idna` (3.11→3.16), `python-dotenv` (1.1.1→1.2.2), `pytest` (9.0.2→9.0.3), and `uv` (0.9.30→0.11.16). Only `starlette` PYSEC-2026-161 remains pending an upstream `google-adk` upper-bound bump.
- `gemini-relay-extension` refreshes its `package-lock.json` to clear `fast-uri` (GHSA path-traversal via percent-encoded dots) and `path-to-regexp` (GHSA sequential-optional-groups DoS), plus moderate alerts on `hono`, `qs`, `ip-address`, `express-rate-limit`, and `@hono/node-server`.

## [8.0.3] - 2026-06-03

### Changed

- Fix post-publish SDK export smoke

## [8.0.2] - 2026-06-03

### Changed

- Web: add /pear Open Graph card with zoomed product screenshot
- Fix publish checks for harness-driver broker path

## [8.0.0] - 2026-06-03

### Added

- Composite status, telemetry-only setup, drop dead modules
- Add SDK-backed workspace/agent/channel/message/integration/capabilities groups + runtime agent subtree
- Restore cloud command group, add runtime alias + top-level lifecycle verbs
- Add create()/new() factories returning registerable agents
- Add listener/predicate DSL (relay.on, event/action/agent predicates)
- Add README facade surface (workspace, sendMessage, registerAction, notify, message overloads)
- Default spawnAgent name and runtime
- Expose provider spawn facade methods

### Changed

- Route telemetry context through CLI, SDK, and cloud
- SDK: workspace-level event stream via relaycast 2.5 (closes)
- Remove vendored openclaw package and orchestrating skill; align MCP name to agent-relay
- Make v8 the default docs version
- Fix npm audit: upgrade vitest to 4.x (resolves critical advisory)
- Move dashboard UI assets under the install dir
- V8 SDK redesign: live agent clients, addListener, fire-and-forget actions, webhooks
- Rename relay state directory to .agentworkforce/relay
- Add Pear by Agent Relay landing page at /pear
- Fix OpenClaw skill route build
- Enhance README with project details and badges
- Complete trajectory and update packages
- Add v8 docs pages and blog UI tweaks
- Harnesses: add create({ relay }) live PTY spawn
- Fix Tailwind oxide lockfile entries
- Update README.md
- Update SDK examples for driver & events
- Remove core simplification scope doc
- Rename runtime package to harness-driver
- Remove in-repo ACP bridge package
- Apply prettier formatting
- Fix package build and security checks
- Upgrade relaycast to 2.0 and support actions
- Update sdk.md to reflect post-split SDK surface
- Rename runtime-agent module to local-agent; drop stray .mcp.json
- Remove stray self-hosting placeholder doc
- Move attach session logic to lib/
- Rename driver namespace to local, restructure agent ops
- Apply pr-reviewer fixes for
- Remove dead bridge plumbing from CoreDependencies
- Drop start/bridge from runtime group; version/update/uninstall are root-only
- Nudge preview-web redeploy (path filter blind past 300-file cap)
- Route interactive attach through RuntimeClient's real WS PTY input
- Add trajectory traces and update runtime/CLI
- Compile-time contract for the full README API + accept real zod schemas
- Use driver subcommand in package-validation CLI smoke
- Drop SDK agent-spawn lifecycle from E2E and export check
- Match E2E command surface and build peripheral packages
- Format pullfrog.yml to satisfy prettier check
- Align CI with simplified core surface
- Update AGENTS.md
- Add `pullfrog.yml` workflow
- Trigger checks after auto-format
- Clean stale package references
- Remove migrated packages from CI workflows
- Remove migrated packages and consolidate shared into utils
- Make workspace setup first-class
- Keep OpenClaw adapter
- Keep ACP bridge adapter
- Align SDK with session contract
- Human writing
- Move delivery policy into harness docs
- Clarify CLI harness message path
- Document message send paths
- Show harness contract as interface
- Flesh out target harness contract
- Document target messaging and delivery contracts
- Adding ideas
- Humans be writing like humans
- More human writing
- Use Zod schemas in action docs
- Clarify Agent Relay README examples
- Simplify Agent Relay core surfaces
- Relocate root configs/assets and add trajectories
- Update spawnAgent examples
- Move MCP tools reference into docs
- Simplify high-level spawn facade
- Remove stale MCP compatibility aliases
- Rename bundled MCP server to Agent Relay MCP
- Remove skills/ directory
- Rename spawn provider api to cli
- Make headless facade cli-based
- Restore persona changelog history
- Remove personas from SDK
- Apply prettier to packages/sdk/src/relaycast-errors.ts
- Mcp: recover from invalid Relaycast agent tokens mid-session
- Clean up after workflow extraction: tests, exports, CI
- Fix CLI imports after cloud-sdk teardown
- Merge @agent-relay/cloud-sdk into @agent-relay/cloud; relayfile bits → @relayfile/sdk
- Extract @agent-relay/cloud-sdk from @agent-relay/sdk
- Break relay → relayflows dep; relay has zero workflow code
- Decouple SDK from workflow knowledge
- Remove workflow code; depend on @relayflows/core via compat shims
- Move doctor repro docs into web
- Move harness runtime docs into web
- Clarify headless app-server worker naming
- Move trajectories under agentworkforce
- Revert "Move trajectories into .agentworkforce"
- Track GitHub traffic in PostHog
- Move trajectories into .agentworkforce
- Collapse /test/ dir into root vitest.setup.ts
- Remove stale openapi.yaml
- Add Prettier auto-format workflow
- Format merge trajectory files
- Fix stale src/cli refs in cli-modules rule and watch script
- Delete unused scripts/build-release.sh
- Remove unused inbox-check hook, tighten descriptions
- Add Swift SDK test job on macOS
- Drop 'not the cloud service' framing
- Skip Node/Rust jobs when only sdk-swift changes
- Move CLI to packages/cli, root becomes workspace orchestrator
- Drop comments narrating removed v6 behavior
- Drop RelayCast deprecated typealias
- Rename RelayCast to AgentRelayClient
- Delete deprecated src/ re-export shims
- Remove unused dev release-plan scaffolding
- Apply prettier across the repo
- Fix SDK spawn pid null handling
- Remove husky, enforce formatting in CI
- Document MCP tool overview
- Use underscore MCP tool names
- Remove harness registry state
- Add broker harness registry
- Fix bootstrap command snapshot
- Default headless harness driver
- Fix harness clippy warnings
- Stop pack:validate from poisoning the node_modules cache
- Clarify harness config naming docs
- Rename harness plans to configs
- Fix harness runtime review issues
- Retrigger CI
- Refine harness adapter docs
- Clarify headless app-server harnesses
- Implement harness runtime plans
- Use workspace tsc instead of network-fetched typescript
- Document harness runtime plan
- Replace stringly-typed protocol IDs with newtypes
- Remove external MCP dependency
- Cache workspace node_modules too
- Return harness session IDs from spawns
- Sdk: forward-compat persona-kit ≥3.0.20 (optional harness/model)
- Sdk: migrate persona spawn to @agentworkforce/persona-kit
- Address CodeRabbit follow-up review on Codex adapter
- Address remaining cubic review comments on Codex adapter
- Address Codex adapter review comments
- Add Codex communicate adapter

### Fixed

- Use local broker commands in smoke tests
- Avoid logging tainted auth data
- Address review — kill, broker flags, tail signal, stale refs
- Pin zod for fresh installs
- Limit turbo concurrency in cold build to prevent OOM
- Use node:crypto randomUUID instead of global crypto
- Remove stale tsconfig paths for deleted packages; increase build memory
- Remove @agent-relay/hooks from package-validation import test
- Correct trailing comma in sdk/package.json exports and regenerate lockfile
- Tolerate stray CLI login callbacks
- Use AgentRelay.spawnAgent instead of removed spawnPty
- Type spawn patch merging
- Avoid headless result contract clobber
- Cd into packages/cli before npm link, not --prefix
- Npm link from packages/cli, not from monorepo root
- Avoid overlapping access on URLComponents query filter
- Revert @relayfile/local-mount to ^0.2.2
- Repair lockfile platform variants + remaining test paths
- Restore install.sh at root, bump local-mount, format script
- Make bundledDependencies work from packages/cli
- Correct URL building and reconnect on register
- Honor model override and harden persona shadow-path test
- Align RelayCast with v7 broker contract
- Bump sdk-py and gemini extension to clear Dependabot alerts
- Restore delivery_id keying for terminal_failed_deliveries

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
