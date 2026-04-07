import type {
  AccessPreset,
  AgentPermissions,
  CompiledAgentPermissions,
  FilePermissions,
  PermissionSource,
} from '../workflows/types.js';
import type { MountHandle } from './mount.js';

// ── Input Configuration ────────────────────────────────────────────────────

/** Configuration for provisioning workflow agents. */
export interface WorkflowProvisionConfig {
  /** HMAC secret used to sign JWT tokens. */
  secret: string;

  /** Workspace identifier (e.g. 'my-project'). */
  workspace: string;

  /** Absolute path to the project directory. */
  projectDir: string;

  /** Base URL of the relayfile server (e.g. 'http://127.0.0.1:4080'). */
  relayfileBaseUrl: string;

  /**
   * Agents to provision, keyed by agent name.
   * Each entry carries the AgentPermissions from relay.yaml.
   * When empty/undefined, agents are auto-discovered from dotfiles.
   */
  agents?: Record<string, AgentPermissions>;

  /** JWT token TTL in seconds. Default: 3600 (1 hour). */
  tokenTtlSeconds?: number;

  /**
   * Directories to exclude from workspace seeding.
   * Defaults: ['.relay', '.git', 'node_modules'].
   */
  excludeDirs?: string[];

  /**
   * When true, skip workspace creation and file seeding.
   * Useful when only tokens/ACL are needed.
   */
  skipSeeding?: boolean;

  /**
   * Admin scopes for the workspace management token.
   * Uses DEFAULT_ADMIN_SCOPES when omitted.
   */
  adminScopes?: string[];

  /** Optional explicit relayfile-mount binary path. */
  mountBinaryPath?: string;

  /** Base directory for per-agent mount points. Defaults to <projectDir>/.relay. */
  mountBaseDir?: string;

  /** When true, skip starting relayfile mount processes. */
  skipMount?: boolean;

  /** When true, print a short audit summary to stdout after provisioning. */
  verbose?: boolean;
}

// ── Output ─────────────────────────────────────────────────────────────────

/** Aggregate counts for compiled permissions across provisioned agents. */
export interface ProvisionSummary {
  readonly: number;
  readwrite: number;
  denied: number;
  customScopes: number;
}

/** Convenience shape for a single agent's compiled scopes. */
export interface CompiledAgentScopes {
  /** Agent name. */
  agentName: string;

  /** Workspace identifier. */
  workspace: string;

  /** Final token scopes after compilation. */
  scopes: string[];

  /** Directory ACL rules derived from the compiled permissions. */
  acl: Record<string, string[]>;

  /** Counts for the compiled access model. */
  summary: ProvisionSummary;
}

/** Result of a single agent's provisioning. */
export interface AgentProvisionResult {
  /** Agent name. */
  name: string;

  /** Absolute path to the written JWT file (.relay/tokens/<name>.jwt). */
  tokenPath: string;

  /** The raw JWT string. */
  token: string;

  /** Scopes baked into the token. */
  scopes: string[];

  /** Full compiled permissions (for audit / dry-run output). */
  compiled: CompiledAgentPermissions;

  /** Absolute path to the mounted relayfile workspace for this agent, when active. */
  mountPoint?: string;
}

/** Map of agent names to minted JWT strings. */
export type AgentTokenMap = Record<string, string>;

/** Map of agent names to their provisioning result. */
export type AgentProvisionMap = Record<string, AgentProvisionResult>;

/** Aggregate result of provisionWorkflowAgents(). */
export interface ProvisionResult {
  /** Per-agent results, keyed by agent name. */
  agents: AgentProvisionMap;

  /** Ordered list of agent names (matches iteration order). */
  agentNames: string[];

  /** Workspace-level admin token (used for seeding). */
  adminToken: string;

  /** Number of files seeded to the relayfile workspace. */
  seededFileCount: number;

  /** Number of ACL directory rules seeded. */
  seededAclCount: number;

  /** Aggregate summary across all agents. */
  summary: ProvisionSummary;

  /** Per-agent mounted workspace handles. */
  mounts: Map<string, MountHandle>;

  /** Per-agent minted JWT strings. */
  tokens: Map<string, string>;

  /** Per-agent compiled token scopes. */
  scopes: Map<string, string[]>;
}

// ── Compiler Types ─────────────────────────────────────────────────────────

/** Input to the permission compiler for a single agent. */
export interface CompileInput {
  agentName: string;
  workspace: string;
  projectDir: string;
  permissions: AgentPermissions;
}

// ── Seeder Types ───────────────────────────────────────────────────────────

/** Options for the ACL seeder. */
export interface SeedAclOptions {
  relayfileBaseUrl: string;
  token: string;
  workspace: string;
  aclRules: Record<string, string[]>;
}

/** Options for workspace file seeding. */
export interface SeedWorkspaceOptions {
  relayfileBaseUrl: string;
  token: string;
  workspace: string;
  projectDir: string;
  excludeDirs: string[];
}

/** Minimal debug summary written alongside compiled ACL output. */
export interface AgentAclSummary {
  name: string;
  summary: Pick<ProvisionSummary, 'readonly' | 'readwrite' | 'denied'>;
}

// Re-export upstream types for convenience.
export type { AccessPreset, AgentPermissions, CompiledAgentPermissions, FilePermissions, PermissionSource };
