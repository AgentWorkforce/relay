# Package Split Plan

## Overview

Split the current `@agent-relay/openclaw` monolith (2780 LOC across 8 source files) into two packages with a clean one-way dependency: `@relaycast/openclaw` owns SDK/bridge primitives (config detection, types, stateless delivery) while `@agent-relay/openclaw` retains orchestration (gateway, spawn management, MCP server, CLI, identity, setup). The new primitives package lives at `packages/relaycast-openclaw`. This eliminates circular dependency risk, reduces install weight for SDK consumers, and establishes a clear architectural boundary. The migration uses a staged 3-phase rollout with deprecated re-exports to avoid hard breaks.

## Package Ownership

### `@relaycast/openclaw` (SDK/bridge primitives — `packages/relaycast-openclaw`)
- `config.ts` — `openclawHome()`, `detectOpenClaw()`, `hasValidConfig()` (internal), `loadGatewayConfig(configPath?)`, `saveGatewayConfig(config, configPath?)`, internal `resolveHome()` helper
- `types.ts` — `GatewayConfig`, `OpenClawDetection`, `InboundMessage`, `DeliveryResult`, `RelaySenderLike`, `DEFAULT_OPENCLAW_GATEWAY_PORT`
- `inject.ts` — `deliverMessage(message, clawName, sender)` (stateless single-send, no fallback chain)
- No heavy dependencies (`@agent-relay/sdk`, `dockerode`, `ws` removed from this package)

### `@agent-relay/openclaw` (orchestration layer — `packages/openclaw`)
- `gateway.ts` — `InboundGateway`, `OpenClawGatewayClient`, device identity, realtime routing, delivery strategy with fallback chain, embedded control HTTP server
- `resolve-gateway-config-path.ts` — new helper deriving Relaycast-specific config path (`workspace/relaycast/.env`) from `detectOpenClaw()` result
- `setup.ts` — full setup orchestration (workspace create/join, mcporter wiring, gateway bootstrap)
- `cli.ts` — `relay-openclaw` CLI commands
- `control.ts` — `spawnOpenClaw()`, `listOpenClaws()`, `releaseOpenClaw()`
- `mcp/` — MCP server and tool definitions
- `spawn/` — `SpawnManager`, Docker/process providers
- `runtime/` — `runtimeSetup()`, config writing, dist patching
- `identity/` — model refs, agent names, soul/identity generation
- `auth/` — `convertCodexAuth()`
- Depends on `@relaycast/openclaw` (one-way only)

## Migration Phases

### Phase 1: Prepare `@relaycast/openclaw` — Size: **M**

| Path | Action | What happens |
|---|---|---|
| `packages/relaycast-openclaw/package.json` | create | New package manifest, description "Relaycast/OpenClaw integration primitives", optional peer dep on `@agent-relay/openclaw` for transitional re-exports |
| `packages/relaycast-openclaw/tsconfig.json` | create | Standard TS build config (`rootDir: src`, `outDir: dist`) |
| `packages/relaycast-openclaw/src/types.ts` | create | `GatewayConfig`, `InboundMessage`, `DeliveryResult`, `RelaySenderLike`, `DEFAULT_OPENCLAW_GATEWAY_PORT` |
| `packages/relaycast-openclaw/src/config.ts` | create | `openclawHome`, `detectOpenClaw`, `hasValidConfig`, internal `resolveHome()`; explicit precedence (`OPENCLAW_CONFIG_PATH` > `OPENCLAW_HOME` > probe); throw on invalid env path; optional `configPath` on load/save; atomic temp-file+rename save |
| `packages/relaycast-openclaw/src/inject.ts` | create | `deliverMessage(message, clawName, sender)` with required `RelaySenderLike`; no fallback chain |
| `packages/relaycast-openclaw/src/index.ts` | create | Export primitives; add transitional `@deprecated` orchestration re-exports proxying to `@agent-relay/openclaw` |
| `packages/relaycast-openclaw/src/__tests__/config.test.ts` | create | Coverage for env precedence, invalid env-path throw, probe tie-breaks, explicit `configPath`, atomic write |
| `packages/relaycast-openclaw/src/__tests__/inject.test.ts` | create | Coverage for required sender contract and single-send behavior |
| `.dependency-cruiser.cjs` | create | Enforce no import from `@relaycast/openclaw` -> `@agent-relay/openclaw` (except transitional proxy) |
| `.github/workflows/` (CI files) | modify | Add boundary check command; include `packages/relaycast-openclaw/**` in path filters |

**Version bump**: `@relaycast/openclaw` minor bump (e.g. `3.2.0`). No changes to `@agent-relay/openclaw` in this phase.

### Phase 2: Update `@agent-relay/openclaw` — Size: **L**

**Files deleted** (ownership moved to `@relaycast/openclaw`):

| Path | Action |
|---|---|
| `packages/openclaw/src/config.ts` | delete |
| `packages/openclaw/src/types.ts` | delete |
| `packages/openclaw/src/inject.ts` | delete |

**Files created/modified**:

| Path | Action | What happens |
|---|---|---|
| `packages/openclaw/package.json` | modify | Add `@relaycast/openclaw` as direct dependency |
| `packages/openclaw/src/resolve-gateway-config-path.ts` | create | Encapsulates `workspace/relaycast/.env` derivation from `detectOpenClaw()` |
| `packages/openclaw/src/gateway.ts` | modify | Import primitives from `@relaycast/openclaw`; keep fallback strategy in `InboundGateway`; implement identity behavior (workspace-level key at `{openclawHome}/workspace/relaycast/.device-identity.json`, stable ID from `clawName+fingerprint`, OPENCLAW_HOME change warning, read-only ephemeral fallback) |
| `packages/openclaw/src/setup.ts` | modify | Import `detectOpenClaw`, `saveGatewayConfig`, types from `@relaycast/openclaw`; pass explicit path via `resolveGatewayConfigPath()` |
| `packages/openclaw/src/cli.ts` | modify | Import `loadGatewayConfig` from `@relaycast/openclaw`; use explicit config path |
| `packages/openclaw/src/spawn/docker.ts` | modify | Import `DEFAULT_OPENCLAW_GATEWAY_PORT` from `@relaycast/openclaw` |
| `packages/openclaw/src/index.ts` | modify | Remove local exports of moved symbols; re-export from `@relaycast/openclaw` with `@deprecated` (2 minor versions) |

**Import rewrites**:
- `gateway.ts`: `./config.js` + `./types.js` -> `@relaycast/openclaw`; add `deliverMessage`, `RelaySenderLike`
- `setup.ts`: `./config.js` + `./types.js` -> `@relaycast/openclaw`; add `./resolve-gateway-config-path.js`
- `cli.ts`: `./config.js` -> `@relaycast/openclaw`; add `./resolve-gateway-config-path.js`
- `spawn/docker.ts`: `../types.js` -> `@relaycast/openclaw`

**New tests**:
- `__tests__/resolve-gateway-config-path.test.ts` — path derivation for both variants
- `__tests__/gateway-delivery-strategy.test.ts` — relay single-send + fallback-to-WS
- `__tests__/device-identity.test.ts` — persistence path, OPENCLAW_HOME change, read-only fallback

**Modified tests**: `gateway-control.test.ts`, `ws-client.test.ts` — update mocks for new import boundaries.

**Verification**: `npm --workspace packages/openclaw run test` passes; `tsc --noEmit` clean for both packages.

### Phase 3: Clean break (next major) — Size: **S**
- Remove deprecated orchestration re-exports from `@relaycast/openclaw`
- Remove deprecated primitive re-exports from `@agent-relay/openclaw`
- Drop optional peer dependency
- Ship codemod (`npx @relaycast/openclaw-migrate`) for remaining consumers

**Verification checklist**:
1. `OPENCLAW_CONFIG_PATH` invalid path throws immediately (no silent fallback)
2. `OPENCLAW_CONFIG_PATH` valid file overrides `OPENCLAW_HOME`; `OPENCLAW_HOME` overrides probe
3. `saveGatewayConfig(..., configPath)` writes via temp+rename and preserves parseability
4. `relay-openclaw status` loads config via explicit `resolveGatewayConfigPath()`
5. Gateway delivery order: relay sender first; on failure, OpenClaw WS fallback
6. Identity file at `{openclawHome}/workspace/relaycast/.device-identity.json`; device ID stable by `clawName + key fingerprint`
7. Changing `OPENCLAW_HOME` regenerates identity and logs warning
8. Read-only identity path triggers warn-level ephemeral in-memory fallback
9. Deprecated re-exports compile from both packages during transition period

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Breaking imports for existing consumers | High | Deprecated re-exports in both packages for 2 minor versions; codemod for automated migration |
| `deliverMessage` behavior drift during signature change | High | Fallback logic explicitly moved to `InboundGateway`; stateless primitive tested in isolation |
| Config path mismatch after `resolveGatewayConfigPath()` split | High | Explicit `configPath` parameter on load/save; `resolveGatewayConfigPath()` encapsulates convention |
| Device identity churn in Docker | Medium | Identity keyed on `clawName + fingerprint` (not filesystem path); ephemeral fallback for read-only mounts |
| Circular dependency accidentally introduced | Medium | `dependency-cruiser` rule + CI enforcement; `import type` for deprecated re-exports |
| `gateway.ts` monolith (1450 LOC) accumulates more logic | Medium | Post-split backlog: decompose into `delivery-strategy.ts`, `control-server.ts`, `device-identity.ts`, `realtime-router.ts` |
| Version skew between packages | Medium | Peer dependency version range; integration tests spanning both packages |

## Recommended First PR

**Phase 1 only**: Create `packages/relaycast-openclaw` with the primitives package (`config.ts`, `types.ts`, `inject.ts`). This PR:

1. Adds the refined primitives with the new API surface (`resolveHome()` helper, explicit precedence, atomic write, `configPath` parameter, `RelaySenderLike` signature)
2. Includes unit tests for config detection, load/save, and stateless delivery
3. Adds deprecated re-exports of orchestration symbols (temporary, removed in Phase 3)
4. Does **not** touch `@agent-relay/openclaw` yet — that package continues working as-is
5. Adds `dependency-cruiser` config to enforce one-way dependency from the start

This is the lowest-risk entry point: it publishes the new package without breaking existing consumers, and Phase 2 can proceed incrementally once Phase 1 is validated in production.
