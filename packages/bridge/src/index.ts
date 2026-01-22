// Re-export config types without duplicating names
export type { ProjectConfig } from '@agent-relay/config/bridge-config';
export * from './types.js';
export * from './multi-project-client.js';
export * from './utils.js';
export { escapeForShell, escapeForTmux } from './utils.js';

// Shadow CLI selection
export {
  selectShadowCli,
  type ShadowCli,
  type ShadowMode,
  type ShadowCliSelection,
} from './shadow-cli.js';

// Agent spawner
export {
  AgentSpawner,
  readWorkersMetadata,
  getWorkerLogsDir,
  type AgentSpawnerOptions,
  type CloudPersistenceHandler,
  type OnAgentDeathCallback,
} from './spawner.js';
