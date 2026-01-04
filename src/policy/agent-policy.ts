/**
 * Agent Policy Service
 *
 * Manages agent permissions and rules with multi-level fallback:
 * 1. Repo-level policy (.claude/agents/*.md)
 * 2. Workspace-level policy (from cloud API)
 * 3. Built-in safe defaults
 *
 * Provides spawn authorization, tool permission checks, and audit logging.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findAgentConfig, type AgentConfig } from '../utils/agent-config.js';

import os from 'node:os';

/**
 * PRPM-style policy file format (YAML or JSON)
 *
 * Policy files are loaded from (in order of precedence):
 * 1. User-level: ~/.config/agent-relay/policies/*.yaml (NOT in source control)
 * 2. Cloud: Workspace config from dashboard (stored in database)
 *
 * PRPM packages install to the user-level location to avoid polluting repos.
 * Install via: prpm install @org/strict-agent-rules --global
 *
 * Example policy file (~/.config/agent-relay/policies/strict-rules.yaml):
 * ```yaml
 * name: strict-spawn-rules
 * version: 1.0.0
 * description: Restrict agent spawning to leads only
 *
 * agents:
 *   - name: Lead
 *     canSpawn: ["*"]
 *     canMessage: ["*"]
 *   - name: Worker*
 *     canSpawn: []
 *     canMessage: ["Lead", "Coordinator"]
 *
 * settings:
 *   requireExplicitAgents: false
 *   auditEnabled: true
 * ```
 */

/**
 * Agent policy definition
 */
export interface AgentPolicy {
  /** Agent name pattern (supports wildcards: "Lead", "Worker*", "*") */
  name: string;
  /** Allowed tools (empty = all allowed, ["none"] = no tools) */
  allowedTools?: string[];
  /** Agents this agent can spawn (empty = can spawn any) */
  canSpawn?: string[];
  /** Agents this agent can message (empty = can message any) */
  canMessage?: string[];
  /** Maximum concurrent spawns allowed */
  maxSpawns?: number;
  /** Rate limit: messages per minute */
  rateLimit?: number;
  /** Whether this agent can be spawned by others */
  canBeSpawned?: boolean;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Workspace-level policy configuration
 */
export interface WorkspacePolicy {
  /** Default policy for agents without explicit config */
  defaultPolicy: AgentPolicy;
  /** Named agent policies */
  agents: AgentPolicy[];
  /** Global settings */
  settings: {
    /** Require explicit agent definitions (reject unknown agents) */
    requireExplicitAgents: boolean;
    /** Enable audit logging */
    auditEnabled: boolean;
    /** Maximum total agents */
    maxTotalAgents: number;
  };
}

/**
 * Policy decision with reasoning
 */
export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  policySource: 'repo' | 'local' | 'workspace' | 'default';
  matchedPolicy?: AgentPolicy;
}

/**
 * Audit log entry
 */
export interface AuditEntry {
  timestamp: number;
  action: 'spawn' | 'message' | 'tool' | 'release';
  actor: string;
  target?: string;
  decision: PolicyDecision;
  context?: Record<string, unknown>;
}

/** Built-in safe defaults when no policy exists */
const DEFAULT_POLICY: AgentPolicy = {
  name: '*',
  allowedTools: undefined, // All tools allowed by default
  canSpawn: undefined, // Can spawn any agent
  canMessage: undefined, // Can message any agent
  maxSpawns: 10,
  rateLimit: 60, // 60 messages per minute
  canBeSpawned: true,
};

/** Restrictive defaults for unknown agents in strict mode */
const STRICT_DEFAULT_POLICY: AgentPolicy = {
  name: '*',
  allowedTools: ['Read', 'Grep', 'Glob'], // Read-only by default
  canSpawn: [], // Cannot spawn
  canMessage: ['Lead', 'Coordinator'], // Can only message leads
  maxSpawns: 0,
  rateLimit: 10,
  canBeSpawned: false,
};

/**
 * Cloud policy fetcher interface
 * Implement this to fetch workspace policies from cloud API
 */
export interface CloudPolicyFetcher {
  getWorkspacePolicy(workspaceId: string): Promise<WorkspacePolicy | null>;
}

export class AgentPolicyService {
  private projectRoot: string;
  private workspaceId?: string;
  private cloudFetcher?: CloudPolicyFetcher;
  private cachedWorkspacePolicy?: WorkspacePolicy;
  private cachedLocalPolicy?: WorkspacePolicy;
  private policyCacheExpiry = 0;
  private localPolicyCacheExpiry = 0;
  private auditLog: AuditEntry[] = [];
  private strictMode: boolean;

  /** Cache TTL in milliseconds (5 minutes) */
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;
  /** Local policy cache TTL (1 minute - files can change) */
  private static readonly LOCAL_CACHE_TTL_MS = 60 * 1000;
  /** Maximum audit log entries to keep in memory */
  private static readonly MAX_AUDIT_ENTRIES = 1000;

  constructor(options: {
    projectRoot: string;
    workspaceId?: string;
    cloudFetcher?: CloudPolicyFetcher;
    strictMode?: boolean;
  }) {
    this.projectRoot = options.projectRoot;
    this.workspaceId = options.workspaceId;
    this.cloudFetcher = options.cloudFetcher;
    this.strictMode = options.strictMode ?? false;
  }

  /**
   * Get the user-level policies directory
   * Uses ~/.config/agent-relay/policies/ (not in source control)
   */
  private getUserPoliciesDir(): string {
    const configDir = process.env.AGENT_RELAY_CONFIG_DIR ??
      path.join(os.homedir(), '.config', 'agent-relay');
    return path.join(configDir, 'policies');
  }

  /**
   * Load policies from user-level directory (PRPM-installable)
   * Files are YAML/JSON with agent policy definitions
   * Location: ~/.config/agent-relay/policies/*.yaml
   */
  private loadLocalPolicies(): WorkspacePolicy | null {
    // Check cache
    if (this.cachedLocalPolicy && Date.now() < this.localPolicyCacheExpiry) {
      return this.cachedLocalPolicy;
    }

    const policiesDir = this.getUserPoliciesDir();
    if (!fs.existsSync(policiesDir)) {
      return null;
    }

    try {
      const files = fs.readdirSync(policiesDir).filter(f =>
        f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json')
      );

      if (files.length === 0) {
        return null;
      }

      // Merge all policy files
      const mergedAgents: AgentPolicy[] = [];
      let mergedSettings: WorkspacePolicy['settings'] = {
        requireExplicitAgents: false,
        auditEnabled: true,
        maxTotalAgents: 50,
      };
      let mergedDefault: AgentPolicy = { ...DEFAULT_POLICY };

      for (const file of files) {
        const filePath = path.join(policiesDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        let parsed: Record<string, unknown>;
        if (file.endsWith('.json')) {
          parsed = JSON.parse(content);
        } else {
          // Simple YAML parsing for policy files
          parsed = this.parseSimpleYaml(content);
        }

        // Merge agents
        if (Array.isArray(parsed.agents)) {
          for (const agent of parsed.agents) {
            if (agent && typeof agent === 'object' && 'name' in agent) {
              mergedAgents.push(agent as AgentPolicy);
            }
          }
        }

        // Merge settings (later files override)
        if (parsed.settings && typeof parsed.settings === 'object') {
          mergedSettings = { ...mergedSettings, ...parsed.settings as Record<string, unknown> };
        }

        // Merge default policy
        if (parsed.defaultPolicy && typeof parsed.defaultPolicy === 'object') {
          mergedDefault = { ...mergedDefault, ...parsed.defaultPolicy as AgentPolicy };
        }
      }

      const policy: WorkspacePolicy = {
        defaultPolicy: mergedDefault,
        agents: mergedAgents,
        settings: mergedSettings,
      };

      this.cachedLocalPolicy = policy;
      this.localPolicyCacheExpiry = Date.now() + AgentPolicyService.LOCAL_CACHE_TTL_MS;

      return policy;
    } catch (err) {
      console.error('[policy] Failed to load local policies:', err);
      return null;
    }
  }

  /**
   * Simple YAML parser for policy files
   * Handles basic key: value and arrays
   */
  private parseSimpleYaml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = content.split('\n');
    let _currentKey = '';
    let currentArray: unknown[] | null = null;
    let currentObject: Record<string, unknown> | null = null;
    let indent = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Calculate indentation
      const lineIndent = line.length - line.trimStart().length;

      // Array item
      if (trimmed.startsWith('- ')) {
        const value = trimmed.slice(2).trim();

        // Object in array (e.g., "- name: Worker")
        if (value.includes(':')) {
          const [key, val] = value.split(':').map(s => s.trim());
          currentObject = { [key]: this.parseValue(val) };
          if (currentArray) {
            currentArray.push(currentObject);
          }
        } else {
          // Simple array value
          if (currentArray) {
            currentArray.push(this.parseValue(value));
          }
        }
        continue;
      }

      // Key: value pair
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const key = trimmed.slice(0, colonIdx).trim();
        const value = trimmed.slice(colonIdx + 1).trim();

        // If we're inside an object in an array
        if (currentObject && lineIndent > indent) {
          currentObject[key] = this.parseValue(value);
          continue;
        }

        // Top-level or section key
        if (value === '' || value === '|' || value === '>') {
          // Start of array or nested object
          _currentKey = key;
          currentArray = [];
          currentObject = null;
          indent = lineIndent;
          result[key] = currentArray;
        } else {
          // Simple key: value
          if (lineIndent === 0) {
            result[key] = this.parseValue(value);
            _currentKey = '';
            currentArray = null;
            currentObject = null;
          } else if (currentObject) {
            currentObject[key] = this.parseValue(value);
          }
        }
      }
    }

    return result;
  }

  /**
   * Parse a YAML value string
   */
  private parseValue(value: string): unknown {
    if (!value || value === '~' || value === 'null') return null;
    if (value === 'true') return true;
    if (value === 'false') return false;

    // Array notation [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      if (!inner.trim()) return [];
      return inner.split(',').map(s => {
        const trimmed = s.trim().replace(/^["']|["']$/g, '');
        return trimmed;
      });
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      return parseFloat(value);
    }

    // String (remove quotes if present)
    return value.replace(/^["']|["']$/g, '');
  }

  /**
   * Check if an agent can spawn another agent
   */
  async canSpawn(
    spawnerName: string,
    targetName: string,
    targetCli: string
  ): Promise<PolicyDecision> {
    const spawnerPolicy = await this.getAgentPolicy(spawnerName);
    const targetPolicy = await this.getAgentPolicy(targetName);

    // Check if target can be spawned
    if (targetPolicy.matchedPolicy?.canBeSpawned === false) {
      const decision: PolicyDecision = {
        allowed: false,
        reason: `Agent "${targetName}" is not allowed to be spawned`,
        policySource: targetPolicy.policySource,
        matchedPolicy: targetPolicy.matchedPolicy,
      };
      this.audit('spawn', spawnerName, targetName, decision, { cli: targetCli });
      return decision;
    }

    // Check if spawner can spawn
    const canSpawnList = spawnerPolicy.matchedPolicy?.canSpawn;
    if (canSpawnList !== undefined && canSpawnList.length > 0) {
      const canSpawn = this.matchesPattern(targetName, canSpawnList);
      if (!canSpawn) {
        const decision: PolicyDecision = {
          allowed: false,
          reason: `Agent "${spawnerName}" is not allowed to spawn "${targetName}"`,
          policySource: spawnerPolicy.policySource,
          matchedPolicy: spawnerPolicy.matchedPolicy,
        };
        this.audit('spawn', spawnerName, targetName, decision, { cli: targetCli });
        return decision;
      }
    }

    // Check max spawns (would need spawn count tracking - placeholder)
    const decision: PolicyDecision = {
      allowed: true,
      reason: 'Spawn permitted by policy',
      policySource: spawnerPolicy.policySource,
      matchedPolicy: spawnerPolicy.matchedPolicy,
    };
    this.audit('spawn', spawnerName, targetName, decision, { cli: targetCli });
    return decision;
  }

  /**
   * Check if an agent can send a message to another agent
   */
  async canMessage(
    senderName: string,
    recipientName: string
  ): Promise<PolicyDecision> {
    const senderPolicy = await this.getAgentPolicy(senderName);

    const canMessageList = senderPolicy.matchedPolicy?.canMessage;
    if (canMessageList !== undefined && canMessageList.length > 0) {
      const canMessage = this.matchesPattern(recipientName, canMessageList);
      if (!canMessage) {
        const decision: PolicyDecision = {
          allowed: false,
          reason: `Agent "${senderName}" is not allowed to message "${recipientName}"`,
          policySource: senderPolicy.policySource,
          matchedPolicy: senderPolicy.matchedPolicy,
        };
        this.audit('message', senderName, recipientName, decision);
        return decision;
      }
    }

    const decision: PolicyDecision = {
      allowed: true,
      reason: 'Message permitted by policy',
      policySource: senderPolicy.policySource,
      matchedPolicy: senderPolicy.matchedPolicy,
    };
    this.audit('message', senderName, recipientName, decision);
    return decision;
  }

  /**
   * Check if an agent can use a specific tool
   */
  async canUseTool(agentName: string, toolName: string): Promise<PolicyDecision> {
    const policy = await this.getAgentPolicy(agentName);

    const allowedTools = policy.matchedPolicy?.allowedTools;
    if (allowedTools !== undefined) {
      // ["none"] means no tools allowed
      if (allowedTools.length === 1 && allowedTools[0] === 'none') {
        const decision: PolicyDecision = {
          allowed: false,
          reason: `Agent "${agentName}" is not allowed to use any tools`,
          policySource: policy.policySource,
          matchedPolicy: policy.matchedPolicy,
        };
        this.audit('tool', agentName, toolName, decision);
        return decision;
      }

      // Check if tool is in allowed list
      const allowed = this.matchesPattern(toolName, allowedTools);
      if (!allowed) {
        const decision: PolicyDecision = {
          allowed: false,
          reason: `Agent "${agentName}" is not allowed to use tool "${toolName}"`,
          policySource: policy.policySource,
          matchedPolicy: policy.matchedPolicy,
        };
        this.audit('tool', agentName, toolName, decision);
        return decision;
      }
    }

    const decision: PolicyDecision = {
      allowed: true,
      reason: 'Tool usage permitted by policy',
      policySource: policy.policySource,
      matchedPolicy: policy.matchedPolicy,
    };
    this.audit('tool', agentName, toolName, decision);
    return decision;
  }

  /**
   * Get the effective policy for an agent
   * Fallback chain: repo config → user PRPM policies → cloud workspace → defaults
   */
  async getAgentPolicy(agentName: string): Promise<{
    matchedPolicy: AgentPolicy;
    policySource: 'repo' | 'local' | 'workspace' | 'default';
  }> {
    // 1. Try repo-level config (.claude/agents/*.md)
    const repoConfig = findAgentConfig(agentName, this.projectRoot);
    if (repoConfig) {
      return {
        matchedPolicy: this.configToPolicy(repoConfig),
        policySource: 'repo',
      };
    }

    // 2. Try user-level PRPM policies (~/.config/agent-relay/policies/*.yaml)
    const localPolicy = this.loadLocalPolicies();
    if (localPolicy) {
      // Check for strict mode in local policy
      if (localPolicy.settings?.requireExplicitAgents) {
        const matchedPolicy = this.findMatchingPolicy(agentName, localPolicy.agents);
        if (matchedPolicy) {
          return { matchedPolicy, policySource: 'local' };
        }
        // Unknown agent in strict mode
        return {
          matchedPolicy: { ...STRICT_DEFAULT_POLICY, name: agentName },
          policySource: 'local',
        };
      }

      // Find matching policy
      const matchedPolicy = this.findMatchingPolicy(agentName, localPolicy.agents);
      if (matchedPolicy) {
        return { matchedPolicy, policySource: 'local' };
      }

      // Use local default
      if (localPolicy.defaultPolicy) {
        return {
          matchedPolicy: { ...localPolicy.defaultPolicy, name: agentName },
          policySource: 'local',
        };
      }
    }

    // 3. Try workspace-level policy from cloud
    const workspacePolicy = await this.getWorkspacePolicy();
    if (workspacePolicy) {
      // Check for strict mode
      if (workspacePolicy.settings?.requireExplicitAgents) {
        // In strict mode, unknown agents get restrictive defaults
        const matchedPolicy = this.findMatchingPolicy(agentName, workspacePolicy.agents);
        if (matchedPolicy) {
          return { matchedPolicy, policySource: 'workspace' };
        }
        // Unknown agent in strict mode
        return {
          matchedPolicy: { ...STRICT_DEFAULT_POLICY, name: agentName },
          policySource: 'workspace',
        };
      }

      // Find matching policy
      const matchedPolicy = this.findMatchingPolicy(agentName, workspacePolicy.agents);
      if (matchedPolicy) {
        return { matchedPolicy, policySource: 'workspace' };
      }

      // Use workspace default
      if (workspacePolicy.defaultPolicy) {
        return {
          matchedPolicy: { ...workspacePolicy.defaultPolicy, name: agentName },
          policySource: 'workspace',
        };
      }
    }

    // 4. Fall back to built-in defaults
    const defaultPolicy = this.strictMode ? STRICT_DEFAULT_POLICY : DEFAULT_POLICY;
    return {
      matchedPolicy: { ...defaultPolicy, name: agentName },
      policySource: 'default',
    };
  }

  /**
   * Get workspace policy from cloud (with caching)
   */
  private async getWorkspacePolicy(): Promise<WorkspacePolicy | null> {
    if (!this.workspaceId || !this.cloudFetcher) {
      return null;
    }

    // Check cache
    if (this.cachedWorkspacePolicy && Date.now() < this.policyCacheExpiry) {
      return this.cachedWorkspacePolicy;
    }

    try {
      const policy = await this.cloudFetcher.getWorkspacePolicy(this.workspaceId);
      if (policy) {
        this.cachedWorkspacePolicy = policy;
        this.policyCacheExpiry = Date.now() + AgentPolicyService.CACHE_TTL_MS;
      }
      return policy;
    } catch (err) {
      console.error('[policy] Failed to fetch workspace policy:', err);
      // Return cached policy if available, even if expired
      return this.cachedWorkspacePolicy ?? null;
    }
  }

  /**
   * Find matching policy from a list (supports wildcards)
   */
  private findMatchingPolicy(agentName: string, policies: AgentPolicy[]): AgentPolicy | null {
    // First try exact match
    const exactMatch = policies.find(p => p.name.toLowerCase() === agentName.toLowerCase());
    if (exactMatch) return exactMatch;

    // Then try pattern match
    for (const policy of policies) {
      if (this.matchesPattern(agentName, [policy.name])) {
        return policy;
      }
    }

    return null;
  }

  /**
   * Check if a name matches any pattern in the list
   * Supports: exact match, prefix* match, *suffix match, * (all)
   */
  private matchesPattern(name: string, patterns: string[]): boolean {
    const lowerName = name.toLowerCase();
    for (const pattern of patterns) {
      const lowerPattern = pattern.toLowerCase();

      // Wildcard all
      if (lowerPattern === '*') return true;

      // Exact match
      if (lowerPattern === lowerName) return true;

      // Prefix match (e.g., "Worker*" matches "WorkerA")
      if (lowerPattern.endsWith('*')) {
        const prefix = lowerPattern.slice(0, -1);
        if (lowerName.startsWith(prefix)) return true;
      }

      // Suffix match (e.g., "*Lead" matches "TeamLead")
      if (lowerPattern.startsWith('*')) {
        const suffix = lowerPattern.slice(1);
        if (lowerName.endsWith(suffix)) return true;
      }
    }
    return false;
  }

  /**
   * Convert AgentConfig to AgentPolicy
   */
  private configToPolicy(config: AgentConfig): AgentPolicy {
    return {
      name: config.name,
      allowedTools: config.allowedTools,
      // Other fields come from defaults since repo config doesn't specify them
      canSpawn: undefined,
      canMessage: undefined,
      maxSpawns: 10,
      rateLimit: 60,
      canBeSpawned: true,
    };
  }

  /**
   * Record an audit entry
   */
  private audit(
    action: AuditEntry['action'],
    actor: string,
    target: string | undefined,
    decision: PolicyDecision,
    context?: Record<string, unknown>
  ): void {
    const entry: AuditEntry = {
      timestamp: Date.now(),
      action,
      actor,
      target,
      decision,
      context,
    };

    this.auditLog.push(entry);

    // Trim log if too large
    if (this.auditLog.length > AgentPolicyService.MAX_AUDIT_ENTRIES) {
      this.auditLog = this.auditLog.slice(-AgentPolicyService.MAX_AUDIT_ENTRIES / 2);
    }

    // Log denied actions
    if (!decision.allowed) {
      console.warn(`[policy] DENIED: ${action} by ${actor}${target ? ` -> ${target}` : ''}: ${decision.reason}`);
    }
  }

  /**
   * Get audit log entries
   */
  getAuditLog(options?: {
    limit?: number;
    action?: AuditEntry['action'];
    actor?: string;
    deniedOnly?: boolean;
  }): AuditEntry[] {
    let entries = [...this.auditLog];

    if (options?.action) {
      entries = entries.filter(e => e.action === options.action);
    }
    if (options?.actor) {
      entries = entries.filter(e => e.actor === options.actor);
    }
    if (options?.deniedOnly) {
      entries = entries.filter(e => !e.decision.allowed);
    }
    if (options?.limit) {
      entries = entries.slice(-options.limit);
    }

    return entries;
  }

  /**
   * Clear audit log
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  /**
   * Invalidate cached workspace policy
   */
  invalidateCache(): void {
    this.cachedWorkspacePolicy = undefined;
    this.policyCacheExpiry = 0;
  }

  /**
   * Get a human-readable policy summary for an agent
   * This can be injected into agent prompts to inform them of their permissions
   */
  async getPolicySummary(agentName: string): Promise<string> {
    const { matchedPolicy, policySource } = await this.getAgentPolicy(agentName);

    const lines: string[] = [
      `# Agent Policy for ${agentName}`,
      `Source: ${policySource}`,
      '',
    ];

    // Tools
    if (matchedPolicy.allowedTools) {
      if (matchedPolicy.allowedTools.length === 1 && matchedPolicy.allowedTools[0] === 'none') {
        lines.push('**Tools**: No tools allowed');
      } else {
        lines.push(`**Allowed Tools**: ${matchedPolicy.allowedTools.join(', ')}`);
      }
    } else {
      lines.push('**Tools**: All tools allowed');
    }

    // Spawning
    if (matchedPolicy.canSpawn) {
      if (matchedPolicy.canSpawn.length === 0) {
        lines.push('**Spawning**: Cannot spawn other agents');
      } else {
        lines.push(`**Can Spawn**: ${matchedPolicy.canSpawn.join(', ')}`);
      }
    } else {
      lines.push('**Spawning**: Can spawn any agent');
    }

    // Messaging
    if (matchedPolicy.canMessage) {
      if (matchedPolicy.canMessage.length === 0) {
        lines.push('**Messaging**: Cannot message other agents');
      } else {
        lines.push(`**Can Message**: ${matchedPolicy.canMessage.join(', ')}`);
      }
    } else {
      lines.push('**Messaging**: Can message any agent');
    }

    // Limits
    if (matchedPolicy.maxSpawns !== undefined) {
      lines.push(`**Max Spawns**: ${matchedPolicy.maxSpawns}`);
    }
    if (matchedPolicy.rateLimit !== undefined) {
      lines.push(`**Rate Limit**: ${matchedPolicy.rateLimit} messages/min`);
    }

    return lines.join('\n');
  }

  /**
   * Get a concise policy instruction for injection into agent prompts
   */
  async getPolicyInstruction(agentName: string): Promise<string | null> {
    const { matchedPolicy, policySource: _policySource } = await this.getAgentPolicy(agentName);

    // Only generate instructions if there are restrictions
    const hasRestrictions =
      matchedPolicy.allowedTools !== undefined ||
      matchedPolicy.canSpawn !== undefined ||
      matchedPolicy.canMessage !== undefined;

    if (!hasRestrictions) {
      return null; // No restrictions, no need to inform agent
    }

    const restrictions: string[] = [];

    if (matchedPolicy.allowedTools) {
      if (matchedPolicy.allowedTools.length === 1 && matchedPolicy.allowedTools[0] === 'none') {
        restrictions.push('You are not allowed to use any tools.');
      } else {
        restrictions.push(`You may only use these tools: ${matchedPolicy.allowedTools.join(', ')}.`);
      }
    }

    if (matchedPolicy.canSpawn) {
      if (matchedPolicy.canSpawn.length === 0) {
        restrictions.push('You are not allowed to spawn other agents.');
      } else {
        restrictions.push(`You may only spawn these agents: ${matchedPolicy.canSpawn.join(', ')}.`);
      }
    }

    if (matchedPolicy.canMessage) {
      if (matchedPolicy.canMessage.length === 0) {
        restrictions.push('You are not allowed to message other agents.');
      } else {
        restrictions.push(`You may only message these agents: ${matchedPolicy.canMessage.join(', ')}.`);
      }
    }

    if (restrictions.length === 0) {
      return null;
    }

    return `[Policy Restrictions]\n${restrictions.join('\n')}`;
  }
}

/**
 * Create a policy service for a project
 */
export function createPolicyService(options: {
  projectRoot: string;
  workspaceId?: string;
  cloudFetcher?: CloudPolicyFetcher;
  strictMode?: boolean;
}): AgentPolicyService {
  return new AgentPolicyService(options);
}
