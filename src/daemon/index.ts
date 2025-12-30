// Core daemon infrastructure (per-project)
export * from './server.js';
export * from './router.js';
export * from './connection.js';
export * from './agent-registry.js';
export * from './registry.js';

// Multi-workspace orchestrator (dashboard-first)
export * from './types.js';
export * from './orchestrator.js';
export * from './workspace-manager.js';
export * from './agent-manager.js';
