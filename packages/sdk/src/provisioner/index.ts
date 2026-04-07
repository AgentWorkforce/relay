import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { getDefaultPermissionAuditPath, PermissionAuditLog } from './audit.js';
import { compileAgentScopes } from './compiler.js';
import { ensureRelayfileMount } from './mount.js';
import { createWorkspaceIfNeeded, seedWorkspace, seedWorkflowAcls } from './seeder.js';
import { DEFAULT_ADMIN_AGENT_NAME, DEFAULT_ADMIN_SCOPES, mintAgentToken } from './token.js';
import type {
  AgentPermissions,
  AgentProvisionMap,
  AgentProvisionResult,
  CompiledAgentPermissions,
  ProvisionResult,
  ProvisionSummary,
  WorkflowProvisionConfig,
} from './types.js';

export * from './compiler.js';
export * from './mount.js';
export * from './seeder.js';
export * from './token.js';
export * from './types.js';
export * from './audit.js';

interface ProvisionableAgent {
  name: string;
  permissions: AgentPermissions;
  resolutionSource: 'configured' | 'auto-discovered';
}

const DEFAULT_AGENT_NAME = 'default-agent';

function discoverAgentNames(projectDir: string): string[] {
  if (!existsSync(projectDir)) {
    return [DEFAULT_AGENT_NAME];
  }

  const agentNames = new Set<string>();

  for (const entry of readdirSync(projectDir)) {
    const match = entry.match(/^\.(.+)\.(agentignore|agentreadonly)$/u);
    if (match?.[1]) {
      agentNames.add(match[1]);
    }
  }

  const discovered = [...agentNames].sort((left, right) => left.localeCompare(right));
  return discovered.length > 0 ? discovered : [DEFAULT_AGENT_NAME];
}

function resolveAgents(config: WorkflowProvisionConfig): ProvisionableAgent[] {
  const configuredAgents = Object.entries(config.agents ?? {});
  if (configuredAgents.length > 0) {
    return configuredAgents.map(([name, permissions]) => ({
      name,
      permissions: permissions ?? {},
      resolutionSource: 'configured',
    }));
  }

  return discoverAgentNames(config.projectDir).map((name) => ({
    name,
    permissions: {},
    resolutionSource: 'auto-discovered',
  }));
}

function buildSummary(compilations: readonly CompiledAgentPermissions[]): ProvisionSummary {
  return compilations.reduce<ProvisionSummary>(
    (summary, compiled) => ({
      readonly: summary.readonly + compiled.summary.readonly,
      readwrite: summary.readwrite + compiled.summary.readwrite,
      denied: summary.denied + compiled.summary.denied,
      customScopes: summary.customScopes + compiled.summary.customScopes,
    }),
    {
      readonly: 0,
      readwrite: 0,
      denied: 0,
      customScopes: 0,
    }
  );
}

function buildAgentResult(
  projectDir: string,
  name: string,
  token: string,
  compiled: CompiledAgentPermissions,
  mountPoint?: string
): AgentProvisionResult {
  return {
    name,
    tokenPath: path.resolve(projectDir, '.relay', 'tokens', `${name}.jwt`),
    token,
    scopes: [...compiled.scopes],
    compiled,
    mountPoint,
  };
}

function sanitizePathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function countAclDirectories(compilations: readonly CompiledAgentPermissions[]): number {
  const directories = new Set<string>();

  for (const compilation of compilations) {
    for (const directory of Object.keys(compilation.acl)) {
      directories.add(directory);
    }
  }

  return directories.size;
}

export async function provisionWorkflowAgents(config: WorkflowProvisionConfig): Promise<ProvisionResult> {
  const audit = new PermissionAuditLog();
  const auditPath = getDefaultPermissionAuditPath(config.projectDir);

  try {
    const agents = resolveAgents(config);
    const tokens = new Map<string, string>();
    const scopes = new Map<string, string[]>();
    const mounts = new Map<string, Awaited<ReturnType<typeof ensureRelayfileMount>>>();
    const agentResults: AgentProvisionMap = {};
    const compilations: CompiledAgentPermissions[] = [];
    const compiledByAgent = new Map<string, CompiledAgentPermissions>();

    for (const agent of agents) {
      audit.log({
        agentName: agent.name,
        action: 'resolve',
        details: {
          source: agent.resolutionSource,
          workspace: config.workspace,
          permissionKeys: Object.keys(agent.permissions).sort(),
        },
      });

      const compiled = compileAgentScopes({
        agentName: agent.name,
        workspace: config.workspace,
        projectDir: config.projectDir,
        permissions: agent.permissions,
      });
      const token = mintAgentToken({
        secret: config.secret,
        agentName: agent.name,
        workspace: config.workspace,
        scopes: compiled.scopes,
        ttlSeconds: config.tokenTtlSeconds,
      });

      audit.log({
        agentName: agent.name,
        action: 'mint',
        details: {
          workspace: config.workspace,
          jwtPath: path.resolve(config.projectDir, '.relay', 'tokens', `${agent.name}.jwt`),
          scopeCount: compiled.scopes.length,
          scopes: [...compiled.scopes],
          ttlSeconds: config.tokenTtlSeconds ?? null,
        },
      });

      tokens.set(agent.name, token);
      scopes.set(agent.name, [...compiled.scopes]);
      compilations.push(compiled);
      compiledByAgent.set(agent.name, compiled);
    }

    const adminScopes = [...(config.adminScopes ?? DEFAULT_ADMIN_SCOPES)];
    const adminToken = mintAgentToken({
      secret: config.secret,
      agentName: DEFAULT_ADMIN_AGENT_NAME,
      workspace: config.workspace,
      scopes: adminScopes,
      ttlSeconds: config.tokenTtlSeconds,
    });

    audit.log({
      agentName: DEFAULT_ADMIN_AGENT_NAME,
      action: 'mint',
      details: {
        workspace: config.workspace,
        role: 'admin',
        scopeCount: adminScopes.length,
        scopes: adminScopes,
        ttlSeconds: config.tokenTtlSeconds ?? null,
      },
    });

    let seededAclCount = 0;
    let seededFileCount = 0;

    if (!config.skipSeeding) {
      await createWorkspaceIfNeeded(config.relayfileBaseUrl, adminToken, config.workspace);
      audit.log({
        agentName: DEFAULT_ADMIN_AGENT_NAME,
        action: 'seed',
        details: {
          workspace: config.workspace,
          step: 'workspace',
          relayfileBaseUrl: config.relayfileBaseUrl,
        },
      });

      seededFileCount = await seedWorkspace(
        config.relayfileBaseUrl,
        adminToken,
        config.workspace,
        config.projectDir,
        config.excludeDirs ?? []
      );
      audit.log({
        agentName: DEFAULT_ADMIN_AGENT_NAME,
        action: 'seed',
        details: {
          workspace: config.workspace,
          step: 'files',
          projectDir: config.projectDir,
          excludeDirs: config.excludeDirs ?? [],
          fileCount: seededFileCount,
        },
      });

      await seedWorkflowAcls({
        relayfileUrl: config.relayfileBaseUrl,
        adminToken,
        workspace: config.workspace,
        agents: compilations.map((compilation) => ({
          name: compilation.agentName,
          acl: compilation.acl,
        })),
      });
      seededAclCount = countAclDirectories(compilations);
      audit.log({
        agentName: DEFAULT_ADMIN_AGENT_NAME,
        action: 'seed',
        details: {
          workspace: config.workspace,
          step: 'acl',
          directoryCount: seededAclCount,
          agentCount: compilations.length,
        },
      });
    }

    if (!config.skipMount) {
      const mountRoot = path.resolve(config.mountBaseDir ?? path.join(config.projectDir, '.relay'));
      try {
        for (const agent of agents) {
          const token = tokens.get(agent.name);
          const compiled = compiledByAgent.get(agent.name);
          if (!token || !compiled) {
            continue;
          }

          const mountHandle = await ensureRelayfileMount({
            binaryPath: config.mountBinaryPath,
            relayfileUrl: config.relayfileBaseUrl,
            workspace: config.workspace,
            token,
            mountPoint: path.join(
              mountRoot,
              `workspace-${sanitizePathComponent(config.workspace)}-${sanitizePathComponent(agent.name)}`
            ),
          });

          mounts.set(agent.name, mountHandle);
          agentResults[agent.name] = buildAgentResult(
            config.projectDir,
            agent.name,
            token,
            compiled,
            mountHandle.mountPoint
          );
        }
      } catch (mountError) {
        for (const [, mount] of mounts) {
          try {
            if (typeof mount.stop === 'function') {
              await mount.stop();
            }
          } catch {
            // Best-effort cleanup — ignore individual stop failures.
          }
        }
        mounts.clear();
        throw mountError;
      }
    } else {
      for (const agent of agents) {
        const token = tokens.get(agent.name);
        const compiled = compiledByAgent.get(agent.name);
        if (!token || !compiled) {
          continue;
        }

        agentResults[agent.name] = buildAgentResult(config.projectDir, agent.name, token, compiled);
      }
    }

    return {
      agents: agentResults,
      agentNames: agents.map((agent) => agent.name),
      adminToken,
      seededFileCount,
      seededAclCount,
      summary: buildSummary(compilations),
      mounts,
      tokens,
      scopes,
    };
  } finally {
    try {
      await audit.writeTo(auditPath);
    } catch (error) {
      if (config.verbose) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to write permission audit to ${auditPath}: ${message}`);
      }
    }

    if (config.verbose) {
      console.info(audit.summary());
    }
  }
}
