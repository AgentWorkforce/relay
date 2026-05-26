/**
 * General agent identity, CLI, and permission types.
 *
 * These are SDK-level primitives — the CLI registry, provisioner, and any
 * other broker-adjacent code consume them directly. Workflow-shaped types
 * (RelayYamlConfig, WorkflowStep, SwarmPattern, etc.) live in @relayflows/core.
 */

// ── CLI identity ────────────────────────────────────────────────────────────

export type AgentCli =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'aider'
  | 'goose'
  | 'opencode'
  | 'droid'
  | 'cursor'
  | 'cursor-agent'
  | 'agent'
  | 'api';

// ── Agent shape primitives ──────────────────────────────────────────────────

export type AgentPreset = 'lead' | 'worker' | 'reviewer' | 'analyst';

/** Resource and behavioral constraints for an agent. */
export interface AgentConstraints {
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  model?: string;
  /** Silence duration in seconds before the agent is considered idle (0 = disabled, default: 30). */
  idleThresholdSecs?: number;
}

/** Optional credential settings for an agent. */
export interface AgentCredentialConfig {
  /** Opt the agent into credential proxy mode. */
  proxy?: boolean;
  /** Override the provider used for proxy credential resolution. */
  provider?: string;
}

// ── Permission types ────────────────────────────────────────────────────────

/**
 * Access preset for role-based permission shortcuts.
 *
 *   readonly    → read all non-ignored files, write nothing
 *   readwrite   → read and write all non-ignored files (default behavior)
 *   restricted  → read/write only explicitly listed paths
 *   full        → read and write everything, including normally-ignored files
 */
export type AccessPreset = 'readonly' | 'readwrite' | 'restricted' | 'full';

/** Fine-grained network permission with allowlist/denylist. */
export interface NetworkPermissions {
  /** Host:port pairs the agent may connect to (e.g. ['registry.npmjs.org:443']). */
  allow?: string[];
  /** Host:port patterns to block (e.g. ['*'] to deny all except allowed). */
  deny?: string[];
}

/** Network permission: boolean to allow/deny all, or object for fine-grained control. */
export type NetworkPermission = boolean | NetworkPermissions;

/** Glob-based file permission scopes for an agent. */
export interface FilePermissions {
  /** Glob patterns the agent may read (e.g. ['src/**', 'docs/**']). */
  read?: string[];
  /** Glob patterns the agent may write (e.g. ['src/tests/**']). */
  write?: string[];
  /** Glob patterns the agent must never access (e.g. ['.env', 'secrets/**']).
   *  Deny rules take precedence over read/write grants. */
  deny?: string[];
}

/** Reusable named permission profile shared by one or more agents. */
export interface PermissionProfileDefinition {
  description?: string;
  why?: string;
  access?: AccessPreset;
  inherit?: boolean;
  files?: FilePermissions;
  scopes?: string[];
  network?: NetworkPermission;
  exec?: string[];
}

/**
 * Permission configuration for an agent.
 *
 * All fields are optional — omitting `permissions` entirely preserves the
 * default behavior (inherit dotfiles, readwrite access).
 *
 * Resolution order (later overrides earlier):
 *   1. Dotfile patterns (.agentignore / .agentreadonly) when `inherit` is true
 *   2. `access` preset expands into base file rules
 *   3. Explicit `files` globs merge on top
 *   4. `deny` patterns always win (applied last)
 *   5. `scopes` are appended verbatim to the token
 */
export interface AgentPermissions {
  description?: string;
  profile?: string;
  why?: string;
  access?: AccessPreset;
  inherit?: boolean;
  files?: FilePermissions;
  scopes?: string[];
  network?: NetworkPermission;
  exec?: string[];
}

// ── Compiled permission output ──────────────────────────────────────────────

/** Identifies where a permission rule originated. */
export interface PermissionSource {
  type: 'dotfile' | 'preset' | 'yaml' | 'scope';
  label: string;
  ruleCount: number;
}

/**
 * The result of compiling an agent's permissions. Used to:
 *   1. Mint the agent's relayauth token (scopes)
 *   2. Configure the relayfile mount (readonlyPaths, readwritePaths, deniedPaths)
 *   3. Enforce runtime restrictions (network, exec allowlist)
 */
export interface CompiledAgentPermissions {
  agentName: string;
  workspace: string;
  effectiveAccess: AccessPreset;
  inherited: boolean;
  sources: PermissionSource[];
  readonlyPatterns: string[];
  readwritePatterns: string[];
  deniedPatterns: string[];
  readonlyPaths: string[];
  readwritePaths: string[];
  deniedPaths: string[];
  scopes: string[];
  network?: NetworkPermission;
  exec?: string[];
  acl: Record<string, string[]>;
  summary: {
    readonly: number;
    readwrite: number;
    denied: number;
    customScopes: number;
  };
}
