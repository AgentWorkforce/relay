import type {
  AccessPreset,
  AgentPermissions,
  CompiledAgentPermissions,
  FilePermissions,
  PermissionSource,
} from './permissions.js';

// ── Shared helper types ─────────────────────────────────────────────────────

/** Aggregate counts for compiled permissions across provisioned agents. */
export interface ProvisionSummary {
  readonly: number;
  readwrite: number;
  denied: number;
  customScopes: number;
}

/** Convenience shape for a single agent's compiled scopes. */
export interface CompiledAgentScopes {
  agentName: string;
  workspace: string;
  scopes: string[];
  acl: Record<string, string[]>;
  summary: ProvisionSummary;
}

// ── Compiler ────────────────────────────────────────────────────────────────

/** Input to the permission compiler for a single agent. */
export interface CompileInput {
  agentName: string;
  workspace: string;
  projectDir: string;
  permissions: AgentPermissions;
}

// Re-export upstream types for convenience.
export type { AccessPreset, AgentPermissions, CompiledAgentPermissions, FilePermissions, PermissionSource };
