/**
 * Bridge Types
 * Types for multi-project orchestration
 */

export interface ProjectConfig {
  /** Absolute path to project root */
  path: string;
  /** Project identifier (derived from path hash) */
  id: string;
  /** Socket path for this project's daemon */
  socketPath: string;
  /** Lead agent name (auto-generated from dirname if not specified) */
  leadName: string;
  /** CLI tool to use (default: claude) */
  cli: string;
}

export interface BridgeConfig {
  /** Projects to bridge */
  projects: ProjectConfig[];
  /** CLI override for all projects */
  cliOverride?: string;
}

export interface LeadInfo {
  /** Lead agent name */
  name: string;
  /** Project this lead manages */
  projectId: string;
  /** Whether lead is currently connected */
  connected: boolean;
}

export interface SpawnRequest {
  /** Worker agent name */
  name: string;
  /** CLI tool (e.g., 'claude', 'claude:opus', 'codex') */
  cli: string;
  /** Initial task to inject */
  task: string;
  /** Who requested the spawn */
  requestedBy: string;
}

export interface SpawnResult {
  success: boolean;
  name: string;
  /** PID of the spawned process (for pty-based workers) */
  pid?: number;
  error?: string;
}

export interface WorkerInfo {
  name: string;
  cli: string;
  task: string;
  spawnedBy: string;
  spawnedAt: number;
  /** PID of the pty process */
  pid?: number;
}
