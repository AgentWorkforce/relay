// Re-export config types without duplicating names
export type { ProjectConfig } from '@relay/config/bridge-config';
export * from './types.js';
export * from './multi-project-client.js';
export * from './utils.js';
export { escapeForShell, escapeForTmux } from './utils.js';
