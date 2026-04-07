import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createWorkspace, seedAclRules, seedWorkspace as seedWorkspaceFiles } from './workspace.js';
import {
  compileDotfiles,
  discoverAgents as discoverAgentsFromCore,
  hasDotfiles as hasDotfilesFromCore,
} from './dotfiles.js';
import { mintAgentToken as mintToken } from '../../../../packages/sdk/src/provisioner/token.js';

interface ProvisionConfig {
  relayauthRoot: string;
  relayfileRoot: string;
  secret: string;
  workspace: string;
  projectDir: string;
  portAuth: number;
  portFile: number;
}

interface ProvisionResult {
  agents: Array<{ name: string; tokenPath: string; scopes: string[] }>;
  ignoredCount: number;
  readonlyCount: number;
  seededCount: number;
}

type RelayConfigPayload = {
  acl?: Record<string, string[]>;
};

const DEFAULT_ADMIN_SCOPES = [
  'relayauth:*:manage:*',
  'relayauth:*:read:*',
  'relayfile:*:*:*',
  'fs:read',
  'fs:write',
  'sync:trigger',
  'ops:read',
  'admin:read',
];

function normalizeRoot(dir: string): string {
  return path.resolve(dir);
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function discoverAgents(projectDir: string): string[] {
  const discovered = discoverAgentsFromCore(projectDir);
  return discovered.length > 0 ? discovered : ['default-agent'];
}

function hasDotfiles(projectDir: string): boolean {
  return hasDotfilesFromCore(projectDir);
}

function compileAgent(projectDir: string, workspace: string, agentName: string) {
  return compileDotfiles(projectDir, agentName, workspace);
}

function parseConfigPayload(configPath: string): RelayConfigPayload {
  const raw = fs.readFileSync(configPath, 'utf8');

  try {
    const parsed =
      path.extname(configPath).toLowerCase() === '.json'
        ? (JSON.parse(raw) as unknown)
        : (parseYaml(raw) as unknown);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return parsed as RelayConfigPayload;
  } catch (error) {
    throw new Error(`Failed to parse relay config at ${configPath}: ${String(error)}`);
  }
}

function parseConfigAclCount(configPath: string): number {
  const parsed = parseConfigPayload(configPath);
  return Object.keys(parsed.acl ?? {}).length;
}

function mergeAcl(target: Record<string, string[]>, source: Record<string, string[]>): void {
  for (const [directory, rules] of Object.entries(source)) {
    const current = new Set<string>(target[directory] ?? []);
    for (const rule of rules) {
      current.add(rule);
    }
    target[directory] = [...current].sort();
  }
}

function tokenForScope(
  secret: string,
  subject: string,
  agentName: string,
  workspace: string,
  scopes: string[]
): string {
  const token = mintToken({
    secret,
    agentName,
    workspace,
    scopes,
    ttlSeconds: 3600,
  });
  if (!token) {
    throw new Error(`failed to mint token for ${subject}`);
  }
  return token;
}

export async function provision(config: ProvisionConfig): Promise<ProvisionResult> {
  const projectDir = normalizeRoot(config.projectDir);
  const relayfileBaseUrl = `http://127.0.0.1:${config.portFile}`;

  ensureDir(path.join(projectDir, '.relay'));
  ensureDir(path.join(projectDir, '.relay', 'tokens'));
  ensureDir(path.join(projectDir, '.relay', 'generated'));

  const discoveredAgents = discoverAgents(projectDir);
  const discoveredHasDotfiles = hasDotfiles(projectDir);

  const mergedAcl: Record<string, string[]> = {};
  const agentSummaries: Array<{
    name: string;
    summary: {
      ignored: number;
      readonly: number;
      readwrite: number;
    };
  }> = [];
  const agentResults: Array<{ name: string; tokenPath: string; scopes: string[] }> = [];
  let ignoredCount = 0;
  let readonlyCount = 0;
  let readwriteCount = 0;

  const adminToken = tokenForScope(
    config.secret,
    'relay-admin',
    'relay-admin',
    config.workspace,
    DEFAULT_ADMIN_SCOPES
  );

  for (const agentName of discoveredAgents) {
    const compiled = compileAgent(projectDir, config.workspace, agentName);
    const agentToken = tokenForScope(
      config.secret,
      `agent_${agentName}`,
      agentName,
      config.workspace,
      compiled.scopes
    );

    const tokenPath = path.join(projectDir, '.relay', 'tokens', `${agentName}.jwt`);
    fs.writeFileSync(tokenPath, `${agentToken}\n`, { encoding: 'utf8', mode: 0o600 });

    agentResults.push({
      name: agentName,
      tokenPath,
      scopes: compiled.scopes,
    });

    ignoredCount += compiled.summary.ignored;
    readonlyCount += compiled.summary.readonly;
    readwriteCount += compiled.summary.readwrite;
    agentSummaries.push({
      name: agentName,
      summary: {
        ignored: compiled.summary.ignored,
        readonly: compiled.summary.readonly,
        readwrite: compiled.summary.readwrite,
      },
    });
    mergeAcl(mergedAcl, compiled.acl);
  }

  try {
    await createWorkspace(relayfileBaseUrl, adminToken, config.workspace);
  } catch (error) {
    // Workspace creation is optional for local seeding, but log auth failures
    // to prevent silent token leaks in subsequent seedWorkspaceFiles calls.
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403) {
      throw new Error(
        `Workspace creation failed with auth error (HTTP ${status}). Aborting to prevent token misuse.`
      );
    }
  }
  const seededCount = await seedWorkspaceFiles(relayfileBaseUrl, adminToken, config.workspace, projectDir, [
    '.relay',
    '.git',
    'node_modules',
  ]);
  if (discoveredHasDotfiles) {
    const mergedPayload = {
      workspace: config.workspace,
      acl: mergedAcl,
      summary: {
        ignored: ignoredCount,
        readonly: readonlyCount,
        readwrite: readwriteCount,
      },
      agents: agentSummaries,
    };

    const bundlePath = path.join(projectDir, '.relay', 'compiled-acl.json');
    fs.writeFileSync(bundlePath, `${JSON.stringify(mergedPayload, null, 2)}\n`, { encoding: 'utf8' });
    await seedAclRules(relayfileBaseUrl, adminToken, config.workspace, mergedAcl);
    const aclSeededCount = Object.keys(mergedAcl).length;

    return {
      agents: agentResults,
      ignoredCount,
      readonlyCount,
      seededCount: Math.max(seededCount, aclSeededCount),
    };
  }

  let configSeededCount = seededCount;
  const relayConfigPath = path.join(projectDir, 'relay.yaml');
  if (fs.existsSync(relayConfigPath)) {
    configSeededCount += parseConfigAclCount(relayConfigPath);
  }

  return {
    agents: agentResults,
    ignoredCount,
    readonlyCount,
    seededCount: configSeededCount,
  };
}
