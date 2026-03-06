# Package Boundary

## @relaycast/openclaw owns

- `config.ts` — detection and config I/O primitives
- `types.ts` — shared types and constants
- `inject.ts` — lightweight bridge delivery
- `openclawHome()` — detect OpenClaw home directory (env vars, variant probing)
- `detectOpenClaw()` — full installation detection (paths, config, variant)
- `hasValidConfig()` (internal) — sync config file validation helper
- `loadGatewayConfig(configPath?: string)` — read gateway config from `.env`; path-agnostic I/O
- `saveGatewayConfig(config, configPath?: string)` — atomic write of gateway config; path-agnostic I/O
- `deliverMessage(message, clawName, sender)` — stateless single-send into OpenClaw skill entrypoint (no fallback chain, no retry, no thread routing)
- `type OpenClawDetection` — detection result (paths, variant, config)
- `type GatewayConfig` — Relaycast workspace connection config
- `type InboundMessage` — normalized inbound message shape
- `type DeliveryResult` — delivery outcome (`ok`, `method`, `error`)
- `type RelaySenderLike` — minimal sender interface (`sendMessage()` contract, decouples from full SDK)
- `DEFAULT_OPENCLAW_GATEWAY_PORT` constant

## @agent-relay/openclaw owns

- `gateway.ts` — `InboundGateway` class, `OpenClawGatewayClient`, `GatewayOptions`, `RelaySender`, device identity persistence/pairing, realtime routing, delivery strategy (fallback chain), embedded control HTTP server (`/spawn`, `/list`, `/release`)
- `resolveGatewayConfigPath()` (new local helper) — derives Relaycast-specific config path from `detectOpenClaw()` result; encapsulates `workspace/relaycast/.env` convention
- `setup.ts` — full setup orchestration (workspace create/join, mcporter wiring, gateway bootstrap, background start), `SetupOptions`, `SetupResult`
- `cli.ts` — `relay-openclaw` CLI commands (`setup`, `gateway`, `spawn`, `list`, `release`, `mcp-server`, `runtime-setup`)
- `control.ts` — `spawnOpenClaw()`, `listOpenClaws()`, `releaseOpenClaw()`, `ClawRunnerControlConfig`, `SpawnOpenClawInput`, `ReleaseOpenClawInput`
- `mcp/server.ts` — `startMcpServer()` exposing spawn/list/release tools
- `mcp/tools.ts` — MCP tool definitions
- `spawn/manager.ts` — `SpawnManager`, `SpawnMode`
- `spawn/docker.ts` — `DockerSpawnProvider`, `DockerSpawnProviderOptions`
- `spawn/process.ts` — `ProcessSpawnProvider`
- `spawn/types.ts` — `SpawnOptions`, `SpawnHandle`, `SpawnProvider`
- `runtime/setup.ts` — `runtimeSetup()`, `RuntimeSetupOptions`
- `runtime/openclaw-config.ts` — `writeOpenClawConfig()`, `OpenClawConfigOptions`
- `runtime/patch.ts` — `patchOpenClawDist()`, `clearJitCache()`
- `identity/*` — `normalizeModelRef()`, `buildAgentName()`, `buildIdentityTask()`, `buildRuntimeIdentityPreamble()`, `renderSoulTemplate()`, `generateSoulMd()`, `generateIdentityMd()`, `writeRuntimeIdentityJson()`, `ensureWorkspace()`, `EnsureWorkspaceOptions`
- `auth/converter.ts` — `convertCodexAuth()`, `ConvertResult`, `CodexAuth`
- `index.ts` — orchestration exports (+ temporary deprecated re-exports of migrated symbols during transition)

## @agent-relay/openclaw imports from @relaycast/openclaw

- `openclawHome` (used in `gateway.ts`)
- `detectOpenClaw` (used in `setup.ts`)
- `loadGatewayConfig` (used in `cli.ts`, with explicit path from `resolveGatewayConfigPath()`)
- `saveGatewayConfig` (used in `setup.ts`, with explicit path from `resolveGatewayConfigPath()`)
- `deliverMessage` (used in `gateway.ts`)
- `DEFAULT_OPENCLAW_GATEWAY_PORT` (used in `gateway.ts`, `spawn/docker.ts`)
- `type GatewayConfig` (used in `gateway.ts`, `setup.ts`)
- `type OpenClawDetection` (used in `setup.ts`)
- `type InboundMessage` (used in `gateway.ts`)
- `type DeliveryResult` (used in `gateway.ts`)
- `type RelaySenderLike` (used in `gateway.ts`)

## Breaking changes

- `detectOpenClaw`, `openclawHome`, `loadGatewayConfig`, `saveGatewayConfig`, `deliverMessage` move from `@agent-relay/openclaw` to `@relaycast/openclaw` — import paths change for all consumers
- `GatewayConfig`, `OpenClawDetection`, `InboundMessage`, `DeliveryResult`, `DEFAULT_OPENCLAW_GATEWAY_PORT` move from `@agent-relay/openclaw` to `@relaycast/openclaw`
- `deliverMessage` signature changes: requires `RelaySenderLike` sender parameter (no optional `AgentRelayClient`, no internal fallback chain); fallback logic moves to `InboundGateway`
- `loadGatewayConfig`/`saveGatewayConfig` accept optional explicit `configPath` parameter; Relaycast-specific default path resolution moves to `@agent-relay/openclaw` via `resolveGatewayConfigPath()`
- `@relaycast/openclaw` removes orchestration exports: `InboundGateway`, `setup`, control API, `spawn/*`, `runtime/*`, `identity/*`, `auth/*`, `mcp/*`, CLI
- `@relaycast/openclaw` drops heavy dependencies: `@agent-relay/sdk`, `dockerode`, runtime/spawn deps
- `@agent-relay/openclaw` adds `@relaycast/openclaw` as a dependency (one-way only, no reverse)
- `@agent-relay/openclaw` re-exports migrated symbols with `@deprecated` for two minor versions; removal in next major

---

## Review feedback resolutions

### BLOCKER 1: Breaking-change rollout underspecified for `@relaycast/openclaw` consumers

**Finding**: `@relaycast/openclaw` drops orchestration exports immediately. Existing consumers hard-break without a safe migration window.

**Resolution**: The boundary is correct — `@relaycast/openclaw` should not carry orchestration exports long-term. However, the rollout needs staging:

1. **Phase 1 (split release)**: `@relaycast/openclaw` adds deprecated re-exports of removed orchestration symbols that proxy to `@agent-relay/openclaw`. This requires `@agent-relay/openclaw` as an optional peer dependency during transition only.
2. **Phase 2 (next minor)**: Ship codemod (`npx @relaycast/openclaw-migrate`) that rewrites imports. Console warnings on deprecated re-exports.
3. **Phase 3 (next major)**: Remove deprecated re-exports, drop optional peer dependency. Clean break.

Updated in Breaking changes: "`@relaycast/openclaw` removes orchestration exports" now reads "staged removal over two minor versions with deprecated re-exports and codemod."

### BLOCKER 2: Device identity behavior across Docker + `OPENCLAW_HOME` override

**Finding**: Identity persistence key may change with runtime path/container mount, causing duplicate identities, broken pairing, and routing instability.

**Resolution**: Device identity is owned by `@agent-relay/openclaw` (`gateway.ts` Ed25519 key management). The boundary is correct — identity stays in the orchestration layer. To prevent the stated failure modes, `@agent-relay/openclaw` must define:

1. **Identity scope**: Workspace-level. Key stored at `{openclawHome}/workspace/relaycast/.device-identity.json`.
2. **Stable key components**: Device ID derived from `clawName` + key fingerprint only — explicitly excludes filesystem path so identity survives mount changes.
3. **`OPENCLAW_HOME` changes**: If `OPENCLAW_HOME` changes and the old identity file isn't at the new path, the gateway generates a new identity and logs a warning. Previous pairings become stale (expected — this is an explicit reconfiguration).
4. **Container ephemeral fallback**: If identity file is unwritable (read-only mount), generate ephemeral in-memory identity per session. Log at `warn` level. No persistence attempted.

This does not change the boundary — it specifies behavior that `@agent-relay/openclaw` must implement during the split.

### WARNING 1: Orchestration-flavored names in `@relaycast/openclaw`

**Finding**: `InboundMessage`, `RelaySenderLike`, `GatewayConfig` couple the primitives package to relay gateway semantics.

**Acknowledged**: The names reflect the actual domain — these types describe Relaycast-to-OpenClaw bridge primitives, not generic transport. Renaming to abstract terms (`BridgeMessage`, `MessageSink`) would obscure intent without adding safety. Instead, document `@relaycast/openclaw` as "Relaycast/OpenClaw integration primitives" in its `package.json` description field. The `RelaySenderLike` name stays — it accurately describes the contract.

### WARNING 2: Circular dependency risk via barrels and deprecated re-exports

**Finding**: One-way dependency is intended but easy to accidentally violate.

**Acknowledged**: During migration, enforce with:
- `dependency-cruiser` rule: `@relaycast/openclaw` must never import from `@agent-relay/openclaw` (except the transitional deprecated re-exports in Phase 1, which proxy the other direction).
- All deprecated re-exports use `import type` where possible to minimize runtime coupling.
- CI check added to fail on circular imports between the two packages.

### WARNING 3: `OPENCLAW_HOME` + variant probing precedence edge cases

**Finding**: Ambiguity around invalid paths, symlinks, permissions, non-deterministic behavior.

**Acknowledged**: The boundary owns this in `@relaycast/openclaw` (`config.ts`). During migration, refactor to:

1. Extract shared `resolveHome()` internal helper (dedup between `openclawHome()` and `detectOpenClaw()`).
2. Explicit precedence: `OPENCLAW_CONFIG_PATH` > `OPENCLAW_HOME` > probe. If env var is set but path is invalid, throw (no silent fallback).
3. Probe tie-break rules documented in JSDoc and tested.

### WARNING 4: `saveGatewayConfig` atomic write not guaranteed

**Finding**: `writeFile()` is not atomic on Docker bind mounts or networked filesystems.

**Acknowledged**: During migration, implement temp-file-in-same-dir + `rename` pattern. Single-writer assumption is valid (config written at setup/CLI time only, not during gateway runtime). Document this assumption in JSDoc.

### WARNING 5: `gateway.ts` monolith risk

**Finding**: `InboundGateway` (1450 LOC) may become a god object post-split.

**Acknowledged**: This is a valid concern but does not affect the package boundary. Post-split backlog item: decompose `gateway.ts` into `delivery-strategy.ts`, `control-server.ts`, `device-identity.ts`, `realtime-router.ts`. Not a blocker for the split itself.

### NOTEs (confirmed, no action required)

- **NOTE 1**: One-way dependency (`@agent-relay/openclaw` -> `@relaycast/openclaw`) confirmed as strong architectural improvement.
- **NOTE 2**: Stateless `deliverMessage` is the right separation; fallback/retry belongs in orchestration.
- **NOTE 3**: `resolveGatewayConfigPath()` in `@agent-relay/openclaw` is a good boundary guard for Relaycast-specific conventions.
