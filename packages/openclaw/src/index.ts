// ── Types ──────────────────────────────────────────────────────────────
export type { GatewayConfig, InboundMessage, DeliveryResult } from './types.js';

// ── Gateway ────────────────────────────────────────────────────────────
export { InboundGateway, type GatewayOptions, type RelaySender } from './gateway.js';

// ── Config ─────────────────────────────────────────────────────────────
export {
  detectOpenClaw,
  loadGatewayConfig,
  saveGatewayConfig,
  type OpenClawDetection,
} from './config.js';

// ── Setup ──────────────────────────────────────────────────────────────
export { setup, type SetupOptions, type SetupResult } from './setup.js';

// ── Inject ─────────────────────────────────────────────────────────────
export { deliverMessage } from './inject.js';

// ── Control (ClawRunner API client) ────────────────────────────────────
export {
  spawnOpenClaw,
  listOpenClaws,
  releaseOpenClaw,
  type ClawRunnerControlConfig,
  type SpawnOpenClawInput,
  type ReleaseOpenClawInput,
} from './control.js';

// ── Identity ───────────────────────────────────────────────────────────
export { normalizeModelRef } from './identity/model.js';
export { buildAgentName } from './identity/naming.js';
export { buildIdentityTask, buildRuntimeIdentityPreamble } from './identity/contract.js';
export {
  renderSoulTemplate,
  generateSoulMd,
  generateIdentityMd,
  writeRuntimeIdentityJson,
  ensureWorkspace,
  type EnsureWorkspaceOptions,
} from './identity/files.js';

// ── Auth ───────────────────────────────────────────────────────────────
export { convertCodexAuth, type ConvertResult, type CodexAuth } from './auth/converter.js';

// ── Runtime ────────────────────────────────────────────────────────────
export { writeOpenClawConfig, type OpenClawConfigOptions } from './runtime/openclaw-config.js';
export { patchOpenClawDist, clearJitCache } from './runtime/patch.js';
export { runtimeSetup, type RuntimeSetupOptions } from './runtime/setup.js';

// ── Spawn ──────────────────────────────────────────────────────────────
export type { SpawnOptions, SpawnHandle, SpawnProvider } from './spawn/types.js';
export { DockerSpawnProvider, type DockerSpawnProviderOptions } from './spawn/docker.js';
export { ProcessSpawnProvider } from './spawn/process.js';
export { SpawnManager, type SpawnMode } from './spawn/manager.js';

// ── MCP Server ─────────────────────────────────────────────────────────
export { startMcpServer } from './mcp/server.js';
