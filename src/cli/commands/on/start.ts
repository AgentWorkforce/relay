import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { mintToken } from './token.js';
import { seedWorkspace as seedWorkspaceFiles } from './workspace.js';

interface OnOptions {
  agent?: string;
  workspace?: string;
  portAuth: string;
  portFile: string;
}

interface RelayConfigAgent {
  name: string;
  scopes: string[];
}

interface RelayConfig {
  version?: string;
  workspace: string;
  signing_secret: string;
  agents: RelayConfigAgent[];
}

interface CompiledAgentEntry {
  name?: string;
  readonlyPatterns?: unknown;
  ignoredPatterns?: unknown;
}

type LogFn = (...args: unknown[]) => void;

interface CleanupState {
  mountProc?: ChildProcessWithoutNullStreams;
  mountLogPath?: string;
  mountDir?: string;
  projectDir: string;
  relayDir: string;
  workspace: string;
  readonlyPatterns: string[];
  ignoredPatterns: string[];
}

interface WorkspaceJoinResponse {
  workspaceId: string;
  token: string;
  relayfileUrl: string;
  relaycastApiKey?: string;
  joinCommand: string;
}

interface WorkspaceSession extends WorkspaceJoinResponse {
  created: boolean;
}

type FetchFn = typeof fetch;

interface WorkspaceSessionRequest {
  authBase: string;
  fallbackRelayfileUrl: string;
  requestedWorkspaceId?: string;
  workspaceName?: string;
  agentName: string;
  scopes: string[];
  signingSecret?: string;
  relayDir?: string;
  relaycastBaseUrl?: string;
  fetchFn?: FetchFn;
}

interface LocalWorkspaceEntry {
  relaycastApiKey?: string;
  relayfileUrl?: string;
  createdAt?: string;
  agents?: string[];
}

type LocalWorkspaceRegistry = Record<string, LocalWorkspaceEntry>;

const DEFAULT_SEED_EXCLUDES = ['.relay', '.git', 'node_modules'];
const DEFAULT_RELAYCAST_BASE_URL = 'https://api.relaycast.dev';
const WORKSPACE_ID_PREFIX = 'rw_';
const WORKSPACE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function normalizeLineList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function normalizeBaseUrl(input: string): string {
  if (!input) return input;
  return input.startsWith('http://') || input.startsWith('https://')
    ? input.replace(/\/$/, '')
    : `http://127.0.0.1:${input}`;
}

function parseJsonConfig(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as unknown;
}

function parseYamlConfig(raw: string): unknown {
  const parsed = parseYaml(raw) as unknown;
  return parsed;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return fallback;
  const values = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
  return values.length > 0 ? values : fallback;
}

function toString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function buildJoinCommand(workspaceId: string): string {
  return `agent-relay on <cli> --workspace ${workspaceId}`;
}

function normalizeWorkspaceId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function generateWorkspaceId(): string {
  const bytes = randomBytes(8);
  let suffix = '';
  for (let index = 0; index < 8; index += 1) {
    suffix += WORKSPACE_ID_ALPHABET[bytes[index] % WORKSPACE_ID_ALPHABET.length];
  }
  return `${WORKSPACE_ID_PREFIX}${suffix}`;
}

function sanitizePathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function toWorkspaceRegistryEntry(value: unknown): LocalWorkspaceEntry {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const entry = value as Record<string, unknown>;
  const relaycastApiKey =
    typeof entry.relaycastApiKey === 'string' && entry.relaycastApiKey.trim()
      ? entry.relaycastApiKey.trim()
      : undefined;
  const relayfileUrl =
    typeof entry.relayfileUrl === 'string' && entry.relayfileUrl.trim()
      ? entry.relayfileUrl.trim()
      : undefined;
  const createdAt =
    typeof entry.createdAt === 'string' && entry.createdAt.trim() ? entry.createdAt.trim() : undefined;
  const agents = Array.isArray(entry.agents)
    ? entry.agents
        .filter((agent): agent is string => typeof agent === 'string')
        .map((agent) => agent.trim())
        .filter((agent) => agent.length > 0)
    : undefined;

  return {
    ...(relaycastApiKey ? { relaycastApiKey } : {}),
    ...(relayfileUrl ? { relayfileUrl } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(agents && agents.length > 0 ? { agents } : {}),
  };
}

function getWorkspaceRegistryPath(relayDir: string): string {
  return path.join(relayDir, 'workspaces.json');
}

function readWorkspaceRegistry(relayDir?: string): LocalWorkspaceRegistry {
  if (!relayDir) {
    return {};
  }

  const registryPath = getWorkspaceRegistryPath(relayDir);
  if (!existsSync(registryPath)) {
    return {};
  }

  const raw = readFileSync(registryPath, 'utf8').trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const registry: LocalWorkspaceRegistry = {};
  for (const [workspaceId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const normalizedId = normalizeWorkspaceId(workspaceId);
    if (!normalizedId) continue;
    registry[normalizedId] = toWorkspaceRegistryEntry(entry);
  }
  return registry;
}

function writeWorkspaceRegistry(relayDir: string, registry: LocalWorkspaceRegistry): void {
  ensureDirectory(relayDir);
  writeFileSync(getWorkspaceRegistryPath(relayDir), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

function updateWorkspaceRegistry(
  relayDir: string | undefined,
  workspaceId: string,
  update: LocalWorkspaceEntry & { agentName?: string }
): LocalWorkspaceEntry {
  const existingRegistry = readWorkspaceRegistry(relayDir);
  const existing = existingRegistry[workspaceId] ?? {};
  const agents = [...new Set([...(existing.agents ?? []), ...(update.agentName ? [update.agentName] : [])])];
  const next: LocalWorkspaceEntry = {
    ...existing,
    ...(update.relaycastApiKey ? { relaycastApiKey: update.relaycastApiKey } : {}),
    relayfileUrl: update.relayfileUrl ?? existing.relayfileUrl,
    createdAt: update.createdAt ?? existing.createdAt ?? new Date().toISOString(),
    ...(agents.length > 0 ? { agents } : {}),
  };

  if (relayDir) {
    existingRegistry[workspaceId] = next;
    writeWorkspaceRegistry(relayDir, existingRegistry);
  }

  return next;
}

async function postWorkspaceApi(
  fetchFn: FetchFn,
  url: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': `agent-relay-on-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`workspace API request failed (${response.status}): ${raw}`.trim());
  }

  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`workspace API returned invalid JSON: ${String(error)}`);
  }
}

function parseCreateWorkspaceResponse(
  payload: unknown,
  requestedWorkspaceId?: string
): {
  workspaceId: string;
  token: string;
  relayfileUrl: string;
  relaycastApiKey?: string;
  joinCommand: string;
} {
  const root = toRecord(payload);
  const data = toRecord(root.data);
  const workspaceId = toString(
    data.workspaceId,
    toString(data.id, toString(root.workspaceId, toString(root.id, requestedWorkspaceId)))
  );

  if (!workspaceId) {
    throw new Error('workspace create response is missing workspaceId');
  }

  return {
    workspaceId,
    token: toString(data.token, toString(root.token)),
    relayfileUrl: normalizeBaseUrl(toString(data.relayfileUrl, toString(root.relayfileUrl))),
    relaycastApiKey:
      toString(
        data.relaycastApiKey,
        toString(
          data.apiKey,
          toString(
            data.api_key,
            toString(root.relaycastApiKey, toString(root.apiKey, toString(root.api_key)))
          )
        )
      ) || undefined,
    joinCommand: toString(data.joinCommand, toString(root.joinCommand, buildJoinCommand(workspaceId))),
  };
}

function parseJoinWorkspaceResponse(payload: unknown, requestedWorkspaceId: string): WorkspaceJoinResponse {
  const root = toRecord(payload);
  const data = toRecord(root.data);
  const workspaceId = toString(
    data.workspaceId,
    toString(data.id, toString(root.workspaceId, toString(root.id, requestedWorkspaceId)))
  );
  const token = toString(data.token, toString(root.token));

  if (!workspaceId) {
    throw new Error('workspace join response is missing workspaceId');
  }
  if (!token) {
    throw new Error(`workspace join response for ${workspaceId} is missing token`);
  }

  return {
    workspaceId,
    token,
    relayfileUrl: normalizeBaseUrl(toString(data.relayfileUrl, toString(root.relayfileUrl))),
    relaycastApiKey:
      toString(
        data.relaycastApiKey,
        toString(
          data.apiKey,
          toString(
            data.api_key,
            toString(root.relaycastApiKey, toString(root.apiKey, toString(root.api_key)))
          )
        )
      ) || undefined,
    joinCommand: toString(data.joinCommand, toString(root.joinCommand, buildJoinCommand(workspaceId))),
  };
}

async function joinWorkspaceSession(
  fetchFn: FetchFn,
  authBase: string,
  workspaceId: string,
  agentName: string,
  scopes: string[]
): Promise<WorkspaceJoinResponse> {
  const body: Record<string, unknown> = { agentName };
  if (scopes.length > 0) {
    body.scopes = scopes;
  }

  const payload = await postWorkspaceApi(
    fetchFn,
    `${authBase}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/join`,
    body
  );
  return parseJoinWorkspaceResponse(payload, workspaceId);
}

async function createRelaycastWorkspace(
  fetchFn: FetchFn,
  baseUrl: string,
  workspaceName: string
): Promise<{ apiKey: string; createdAt?: string }> {
  const response = await fetchFn(`${normalizeBaseUrl(baseUrl)}/v1/workspaces`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': `agent-relay-on-relaycast-${Date.now()}`,
    },
    body: JSON.stringify({ name: workspaceName }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`relaycast workspace create failed (${response.status}): ${raw}`.trim());
  }

  const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : {};
  const root = toRecord(parsed);
  const data = toRecord(root.data);
  const apiKey = toString(data.apiKey, toString(data.api_key, toString(root.apiKey, toString(root.api_key))));

  if (!apiKey) {
    throw new Error('relaycast workspace create response is missing apiKey');
  }

  return {
    apiKey,
    createdAt:
      toString(
        data.createdAt,
        toString(data.created_at, toString(root.createdAt, toString(root.created_at)))
      ) || undefined,
  };
}

async function requestLocalWorkspaceSession(options: WorkspaceSessionRequest): Promise<WorkspaceSession> {
  const fetchFn = options.fetchFn ?? fetch;
  const relayDir = options.relayDir;
  const signingSecret = toString(options.signingSecret);
  const requestedWorkspaceId = normalizeWorkspaceId(options.requestedWorkspaceId);

  if (!relayDir) {
    throw new Error('relayDir is required for local workspace sessions');
  }
  if (!signingSecret) {
    throw new Error('signingSecret is required for local workspace sessions');
  }

  const workspaceId = requestedWorkspaceId ?? generateWorkspaceId();
  const existing = readWorkspaceRegistry(relayDir)[workspaceId];
  if (requestedWorkspaceId && !existing) {
    throw new Error(`workspace ${workspaceId} is not registered locally`);
  }

  let relaycastApiKey = toString(existing?.relaycastApiKey) || undefined;
  let createdAt = toString(existing?.createdAt) || undefined;
  if (!relaycastApiKey) {
    const created = await createRelaycastWorkspace(
      fetchFn,
      options.relaycastBaseUrl ?? process.env.RELAYCAST_BASE_URL ?? DEFAULT_RELAYCAST_BASE_URL,
      toString(options.workspaceName, workspaceId)
    );
    relaycastApiKey = created.apiKey;
    createdAt = created.createdAt ?? createdAt;
  }

  const registryEntry = updateWorkspaceRegistry(relayDir, workspaceId, {
    relaycastApiKey,
    relayfileUrl: existing?.relayfileUrl ?? options.fallbackRelayfileUrl,
    createdAt,
    agentName: options.agentName,
  });

  return {
    created: !requestedWorkspaceId,
    workspaceId,
    token: mintToken({
      secret: signingSecret,
      agentName: options.agentName,
      workspace: workspaceId,
      scopes: options.scopes,
    }),
    relayfileUrl: registryEntry.relayfileUrl ?? options.fallbackRelayfileUrl,
    relaycastApiKey: registryEntry.relaycastApiKey,
    joinCommand: buildJoinCommand(workspaceId),
  };
}

export async function requestWorkspaceSession(options: WorkspaceSessionRequest): Promise<WorkspaceSession> {
  const fetchFn = options.fetchFn ?? fetch;
  const requestedWorkspaceId = normalizeWorkspaceId(options.requestedWorkspaceId);

  if (isLocalBaseUrl(options.authBase) && options.relayDir && options.signingSecret) {
    return requestLocalWorkspaceSession({ ...options, fetchFn, requestedWorkspaceId });
  }

  if (requestedWorkspaceId) {
    const joined = await joinWorkspaceSession(
      fetchFn,
      options.authBase,
      requestedWorkspaceId,
      options.agentName,
      options.scopes
    );

    const relaycastApiKey =
      joined.relaycastApiKey ?? readWorkspaceRegistry(options.relayDir)[joined.workspaceId]?.relaycastApiKey;
    updateWorkspaceRegistry(options.relayDir, joined.workspaceId, {
      relaycastApiKey,
      relayfileUrl: joined.relayfileUrl || options.fallbackRelayfileUrl,
      agentName: options.agentName,
    });

    return {
      created: false,
      workspaceId: joined.workspaceId,
      token: joined.token,
      relayfileUrl: joined.relayfileUrl || options.fallbackRelayfileUrl,
      relaycastApiKey,
      joinCommand: joined.joinCommand,
    };
  }

  const generatedWorkspaceId = generateWorkspaceId();
  const createBody: Record<string, unknown> = {
    workspaceId: generatedWorkspaceId,
  };
  if (toString(options.workspaceName)) {
    createBody.name = options.workspaceName;
  }

  const created = parseCreateWorkspaceResponse(
    await postWorkspaceApi(fetchFn, `${options.authBase}/api/v1/workspaces/create`, createBody),
    generatedWorkspaceId
  );

  let token = created.token;
  let relayfileUrl = created.relayfileUrl;
  let relaycastApiKey = created.relaycastApiKey;
  if (!token || !relayfileUrl) {
    const joined = await joinWorkspaceSession(
      fetchFn,
      options.authBase,
      created.workspaceId,
      options.agentName,
      options.scopes
    );
    token = joined.token;
    relayfileUrl = joined.relayfileUrl || relayfileUrl;
    relaycastApiKey = relaycastApiKey ?? joined.relaycastApiKey;
  }

  if (!token) {
    throw new Error(`workspace ${created.workspaceId} did not return a token`);
  }

  updateWorkspaceRegistry(options.relayDir, created.workspaceId, {
    relaycastApiKey,
    relayfileUrl: relayfileUrl || options.fallbackRelayfileUrl,
    agentName: options.agentName,
  });

  return {
    created: true,
    workspaceId: created.workspaceId,
    token,
    relayfileUrl: relayfileUrl || options.fallbackRelayfileUrl,
    relaycastApiKey,
    joinCommand: created.joinCommand,
  };
}

function normalizeAgents(rawAgents: unknown): RelayConfigAgent[] {
  const fallbackScopes = [
    'relayfile:*:*:*',
    'relayauth:*:manage:*',
    'relayauth:*:read:*',
    'fs:read',
    'fs:write',
  ];
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    return [{ name: 'default-agent', scopes: fallbackScopes }];
  }

  const parsed = rawAgents
    .map((entry) => toRecord(entry))
    .map((entry, index) => ({
      name: toString(entry.name, `agent-${index + 1}`),
      scopes: toStringArray(entry.scopes, fallbackScopes),
    }))
    .filter((entry) => entry.name.length > 0);

  return parsed.length > 0 ? parsed : [{ name: 'default-agent', scopes: fallbackScopes }];
}

function loadConfigFromFile(configPath: string, projectDir: string): RelayConfig {
  const raw = readFileSync(configPath, 'utf8');
  let parsed: unknown;

  if (path.extname(configPath).toLowerCase() === '.json') {
    parsed = parseJsonConfig(raw);
  } else {
    parsed = parseYamlConfig(raw);
  }

  const root = toRecord(parsed);
  const payload = toRecord(root.data) as Record<string, unknown>;
  const fallbackWorkspace = path.basename(projectDir);
  const fallbackSecret = process.env.SIGNING_KEY ?? 'dev-relay-secret';

  const workspace = toString(payload.workspace, toString(root.workspace, fallbackWorkspace));
  const signing_secret = toString(payload.signing_secret, toString(root.signing_secret, fallbackSecret));
  const agents = normalizeAgents(payload.agents ?? root.agents);

  return { workspace, signing_secret, agents };
}

function writeGeneratedZeroConfig(
  configPath: string,
  projectDir: string,
  overridesAgentName?: string
): RelayConfig {
  const fallbackWorkspace = path.basename(projectDir);
  const fallbackSecret = process.env.SIGNING_KEY ?? 'dev-relay-secret';
  const defaultAgent = overridesAgentName ?? 'default-agent';
  const config: RelayConfig = {
    version: '1',
    workspace: fallbackWorkspace,
    signing_secret: fallbackSecret,
    agents: [
      {
        name: defaultAgent,
        scopes: ['relayfile:*:*:*', 'relayauth:*:manage:*', 'relayauth:*:read:*', 'fs:read', 'fs:write'],
      },
    ],
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return config;
}

function resolveConfig(projectDir: string, relayDir: string, requestedAgent?: string): RelayConfig {
  const explicitYaml = path.join(projectDir, 'relay.yaml');
  if (existsSync(explicitYaml)) {
    return loadConfigFromFile(explicitYaml, projectDir);
  }

  const cachedConfig = path.join(relayDir, 'config.json');
  if (existsSync(cachedConfig)) {
    return loadConfigFromFile(cachedConfig, projectDir);
  }

  const generatedPath = path.join(relayDir, 'generated', 'relay-zero-config.json');
  return writeGeneratedZeroConfig(generatedPath, projectDir, requestedAgent);
}

function resolveRelayfileRoot(projectDir: string): string {
  const candidates = [
    process.env.RELAYFILE_ROOT,
    path.resolve(projectDir, '..', 'relayfile'),
    path.resolve(projectDir, '..', '..', 'relayfile'),
    path.resolve(process.cwd(), '..', 'relayfile'),
  ].filter((value): value is string => !!value);

  for (const candidate of candidates) {
    const mountBin = path.join(candidate, 'bin', 'relayfile-mount');
    if (existsSync(mountBin)) return candidate;
  }
  return candidates[0] ?? path.resolve(projectDir, 'relayfile');
}

function isCommandAvailable(command: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'sh';
  const args = process.platform === 'win32' ? [command] : ['-lc', `command -v "${command}" >/dev/null 2>&1`];
  const proc = spawnSync(checker, args, { stdio: ['ignore', 'ignore', 'ignore'] });
  return proc.status === 0;
}

async function waitForHttpHealthy(url: string, attempts = 12): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {
      // Retry until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function runCommandCapture(command: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    proc.stderr.on('data', (chunk: string) => {
      output += chunk;
    });

    proc.on('error', (error) => {
      reject(error);
    });

    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve(output);
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${typeof code === 'number' ? code : 'unknown'}`;
      const detail = output.trim();
      reject(new Error(detail || `command failed with ${reason}`));
    });
  });
}

function normalizeRelativePosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function globMatch(filePath: string, rawPattern: string): boolean {
  const pattern = normalizeRelativePosix(rawPattern.trim());
  const target = normalizeRelativePosix(filePath);
  if (!pattern) return false;

  if (!/[\\*?\[]/.test(pattern)) {
    if (pattern.endsWith('/')) {
      return target === pattern.slice(0, -1) || target.startsWith(`${pattern}`);
    }
    return target === pattern || target.startsWith(`${pattern}/`);
  }

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '__STAR__')
    .replace(/\\\?/g, '__QMARK__')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    .replace(/__STAR__/g, '\\*')
    .replace(/__QMARK__/g, '\\?');
  const withDirectory = `^${escaped}$`;
  return new RegExp(withDirectory).test(target);
}

function isPathIgnored(relPath: string, patterns: string[]): boolean {
  const normalized = normalizeRelativePosix(relPath);
  return patterns.some((pattern) => globMatch(normalized, pattern));
}

function extractPermissionPatternsFromCompiled(
  compiledPath: string,
  agentName: string
): { readonlyPatterns: string[]; ignoredPatterns: string[] } {
  if (!existsSync(compiledPath)) {
    return { readonlyPatterns: [], ignoredPatterns: [] };
  }

  const parsed = toRecord(JSON.parse(readFileSync(compiledPath, 'utf8')) as unknown);
  const agents = Array.isArray(parsed.agents) ? (parsed.agents as unknown[]) : [];
  const entry = agents
    .map((raw) => toRecord(raw) as Record<string, unknown>)
    .find((item) => String(item.name ?? '') === agentName) as
    | (CompiledAgentEntry & Record<string, unknown>)
    | undefined;

  return {
    readonlyPatterns: toStringArray(entry?.readonlyPatterns, []),
    ignoredPatterns: toStringArray(entry?.ignoredPatterns, []),
  };
}

function collectPermissionPatternsFromDotfiles(projectDir: string): {
  readonlyPatterns: string[];
  ignoredPatterns: string[];
} {
  const readonlyFile = path.join(projectDir, '.agentreadonly');
  const ignoreFile = path.join(projectDir, '.agentignore');
  return {
    readonlyPatterns: normalizeLineList(readIfExists(readonlyFile)),
    ignoredPatterns: normalizeLineList(readIfExists(ignoreFile)),
  };
}

function readIfExists(filePath: string, fallback: string = ''): string {
  if (!existsSync(filePath)) return fallback;
  return readFileSync(filePath, 'utf8');
}

function buildPermissionDoc(
  agentName: string,
  readonlyPatterns: string[],
  ignoredPatterns: string[]
): string {
  const readonlyList = readonlyPatterns.length > 0 ? readonlyPatterns.join('\n') : '(none)';
  const ignoredList = ignoredPatterns.length > 0 ? ignoredPatterns.join('\n') : '(none)';
  return `# Workspace Permissions

This workspace is managed by the relay.
File access is controlled by project-local .agentignore and .agentreadonly.

## Read-only files (cannot be modified)
${readonlyList || '(none)'}

## Hidden files (not available in this workspace)
${ignoredList || '(none)'}

## Writable files
All other files can be read and modified freely.

If you get "permission denied", the file is read-only.
Changes to read-only files will be automatically reverted.
Do not attempt to chmod files — permissions will be restored.

Agent: ${agentName}
`;
}

function ensureDirectory(pathValue: string): void {
  mkdirSync(pathValue, { recursive: true });
}

function ensureStateDirs(relayDir: string): void {
  ensureDirectory(path.join(relayDir, 'tokens'));
  ensureDirectory(path.join(relayDir, 'logs'));
  ensureDirectory(path.join(relayDir, 'generated'));
  ensureDirectory(path.join(relayDir, 'mounts'));
}

function findAgentConfig(config: RelayConfig, requestedAgent?: string): RelayConfigAgent {
  if (requestedAgent) {
    const match = config.agents.find((agent) => agent.name === requestedAgent);
    if (match) return match;
    const fallback = config.agents[0];
    if (fallback) {
      return {
        ...fallback,
        name: requestedAgent,
      };
    }
    return { name: requestedAgent, scopes: ['relayfile:*:*:*'] };
  }
  return config.agents[0] ?? { name: 'default-agent', scopes: ['relayfile:*:*:*'] };
}

function countFilesForSync(baseDir: string): number {
  let total = 0;
  const stack = [baseDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.relay') continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        total += 1;
      }
    }
  }
  return total;
}

function listFiles(baseDir: string): string[] {
  const files: string[] = [];
  const stack = [baseDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.relay') continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function hasWriteAccess(filePath: string): boolean {
  try {
    accessSync(filePath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function fileNeedsSync(
  sourcePath: string,
  readonlyPatterns: string[],
  mountDir: string,
  projectDir: string
): boolean {
  const relPath = normalizeRelativePosix(path.relative(mountDir, sourcePath));
  const absTargetPath = path.join(projectDir, relPath);
  if (relPath.startsWith('../') || relPath.startsWith('.agent-relay')) return false;
  if (isPathIgnored(relPath, readonlyPatterns)) return false;
  if (existsSync(absTargetPath) && hasSameContent(sourcePath, absTargetPath)) return false;
  return true;
}

function hasSameContent(left: string, right: string): boolean {
  try {
    const leftContent = readFileSync(left);
    const rightContent = readFileSync(right);
    return leftContent.equals(rightContent);
  } catch {
    return false;
  }
}

async function syncWritableFilesBack(
  mountDir: string,
  projectDir: string,
  readonlyPatterns: string[],
  ignoredPatterns: string[]
): Promise<number> {
  let synced = 0;
  const files = listFiles(mountDir);
  for (const sourceFile of files) {
    const relative = path.relative(mountDir, sourceFile);
    if (relative === '' || relative.startsWith('..')) continue;
    if (relative === '.agent-relay' || normalizeRelativePosix(relative) === '_PERMISSIONS.md') continue;
    if (isPathIgnored(relative, readonlyPatterns)) continue;
    if (isPathIgnored(relative, ignoredPatterns)) continue;
    if (!hasWriteAccess(sourceFile)) continue;

    if (!fileNeedsSync(sourceFile, readonlyPatterns, mountDir, projectDir)) {
      continue;
    }

    const targetPath = path.join(projectDir, relative);
    ensureDirectory(path.dirname(targetPath));
    cpSync(sourceFile, targetPath, { force: true });
    synced += 1;
  }
  return synced;
}

function pickDeniedCount(syncOutput: string): number {
  const match = syncOutput.match(/skipping denied file/gi);
  return match ? match.length : 0;
}

function generateTokenFromScript(
  config: RelayConfig,
  agent: RelayConfigAgent,
  log: LogFn,
  error: LogFn
): string | null {
  try {
    return mintToken({
      secret: config.signing_secret,
      agentName: agent.name,
      workspace: config.workspace,
      scopes: agent.scopes,
    });
  } catch (err) {
    error('Failed to mint token:', err);
    log('Set a valid token path or provision tokens manually if token minting fails.');
    return null;
  }
}

function ensureProcessRunning(processRef: ChildProcessWithoutNullStreams): boolean {
  return processRef.exitCode === null && !processRef.killed;
}

function isLocalBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

function killMountProcess(processRef: ChildProcessWithoutNullStreams): Promise<void> {
  if (processRef.exitCode !== null || !processRef.pid) return Promise.resolve();
  processRef.kill('SIGTERM');
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (processRef.exitCode === null && processRef.pid) {
        processRef.kill('SIGKILL');
      }
      resolve();
    }, 1200);
    processRef.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function getSandboxFlags(cli: string): string[] {
  const name = path.basename(cli);
  switch (name) {
    case 'claude':
      return ['--dangerously-skip-permissions'];
    case 'codex':
      return ['--dangerously-bypass-approvals-and-sandbox'];
    case 'gemini':
      return ['--yolo'];
    case 'aider':
      return ['--yes'];
    default:
      return [];
  }
}

async function ensureProvisioned(
  config: RelayConfig,
  agent: RelayConfigAgent,
  relayfileRoot: string,
  projectDir: string,
  tokenPath: string,
  log: LogFn,
  error: LogFn,
  deps: any
): Promise<string> {
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf8').trim();
  }

  if (typeof deps?.provision === 'function') {
    await deps.provision(config, { ...agent });
    if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf8').trim();
  }

  if (typeof deps?.provisionAgentToken === 'function') {
    const generated = await deps.provisionAgentToken({ config, agent, tokenPath });
    if (typeof generated === 'string' && generated.trim()) {
      const generatedToken = generated.trim();
      writeFileSync(tokenPath, `${generatedToken}\n`, { encoding: 'utf8', mode: 0o600 });
      return generatedToken;
    }
  }

  const generatedToken = generateTokenFromScript(config, agent, log, error);
  if (generatedToken) {
    ensureDirectory(path.dirname(tokenPath));
    writeFileSync(tokenPath, `${generatedToken}\n`, { encoding: 'utf8', mode: 0o600 });
    return generatedToken;
  }

  throw new Error(`missing token for ${agent.name}: ${tokenPath}. Run provisioning before launching relay.`);
}

async function ensureServices(
  authBase: string,
  fileBase: string,
  deps: any,
  log: LogFn,
  error: LogFn
): Promise<void> {
  const needsLocalAuth = isLocalBaseUrl(authBase);
  const needsLocalFile = isLocalBaseUrl(fileBase);
  if (!needsLocalAuth && !needsLocalFile) {
    return;
  }

  const authHealthy = !needsLocalAuth || (await waitForHttpHealthy(authBase));
  const fileHealthy = !needsLocalFile || (await waitForHttpHealthy(fileBase));
  if (authHealthy && fileHealthy) return;

  if (typeof deps?.ensureServicesRunning === 'function') {
    await deps.ensureServicesRunning(authBase, fileBase);
    const postAuthHealthy = !needsLocalAuth || (await waitForHttpHealthy(authBase));
    const postFileHealthy = !needsLocalFile || (await waitForHttpHealthy(fileBase));
    if (postAuthHealthy && postFileHealthy) return;
  }

  if (typeof deps?.startServices === 'function') {
    await deps.startServices({ authBase, fileBase });
    const postAuthHealthy = !needsLocalAuth || (await waitForHttpHealthy(authBase));
    const postFileHealthy = !needsLocalFile || (await waitForHttpHealthy(fileBase));
    if (postAuthHealthy && postFileHealthy) return;
  }

  error('Relay services are not ready.');
  if (needsLocalAuth) {
    error(`- relayauth (${authBase}/health): ${authHealthy ? 'healthy' : 'unhealthy'}`);
  }
  if (needsLocalFile) {
    error(`- relayfile (${fileBase}/health): ${fileHealthy ? 'healthy' : 'unhealthy'}`);
  }
  throw new Error('Start relay services before running relay on; or pass a dependency that can launch them.');
}

async function cleanupRun(state: CleanupState, agentName: string, log: LogFn): Promise<void> {
  if (!state.mountProc && !state.mountDir && !state.mountLogPath) return;
  const mountDir = state.mountDir;
  if (state.mountProc) {
    await killMountProcess(state.mountProc);
  }

  let synced = 0;
  if (mountDir && existsSync(mountDir)) {
    synced = await syncWritableFilesBack(
      mountDir,
      state.projectDir,
      state.readonlyPatterns,
      state.ignoredPatterns
    );
    log(`  ✓ ${synced} file(s) synced back`);
    try {
      rmSync(mountDir, { recursive: true, force: true });
    } catch {
      // Workspace cleanup is best-effort.
    }
  }

  log(`Cleaned relay mount for ${agentName}`);
}

export async function goOnTheRelay(
  cli: string,
  options: OnOptions,
  extraArgs: string[],
  deps: any
): Promise<void> {
  const log: LogFn = (deps?.log as LogFn) ?? ((...args: unknown[]) => console.log(...args));
  const error: LogFn = (deps?.error as LogFn) ?? ((...args: unknown[]) => console.error(...args));
  const exit: (code: number) => never | void =
    (deps?.exit as (code: number) => never | void) ?? ((code: number) => process.exit(code));

  const projectDir = process.cwd();
  const relayDir = path.join(projectDir, '.relay');

  if (!isCommandAvailable('node') || !isCommandAvailable('npx')) {
    throw new Error('node and npx must be available in PATH to run relay.');
  }

  ensureStateDirs(relayDir);
  const defaultAgentName = toString(options.agent, path.basename(cli));
  const config = resolveConfig(projectDir, relayDir, defaultAgentName);
  const agent = findAgentConfig(config, defaultAgentName);
  const authBase = normalizeBaseUrl(options.portAuth);
  const fileBase = normalizeBaseUrl(options.portFile);
  const relayfileRoot = resolveRelayfileRoot(projectDir);
  const mountBin = path.join(relayfileRoot, 'bin', 'relayfile-mount');

  if (!existsSync(mountBin)) {
    throw new Error(`missing relayfile mount binary: ${mountBin}`);
  }

  await ensureServices(authBase, fileBase, deps, log, error);

  const workspaceSession = await requestWorkspaceSession({
    authBase,
    fallbackRelayfileUrl: fileBase,
    requestedWorkspaceId: options.workspace,
    workspaceName: config.workspace,
    agentName: agent.name,
    scopes: agent.scopes,
    signingSecret: config.signing_secret,
    relayDir,
    relaycastBaseUrl: process.env.RELAYCAST_BASE_URL,
    fetchFn: typeof deps?.fetch === 'function' ? (deps.fetch as FetchFn) : undefined,
  });

  if (workspaceSession.created) {
    await seedWorkspaceFiles(
      workspaceSession.relayfileUrl,
      workspaceSession.token,
      workspaceSession.workspaceId,
      projectDir,
      DEFAULT_SEED_EXCLUDES
    );
  }

  const mountDir = path.join(
    relayDir,
    `workspace-${sanitizePathComponent(workspaceSession.workspaceId)}-${sanitizePathComponent(agent.name)}`
  );
  mkdirSync(mountDir, { recursive: true });
  const mountLogPath = path.join(relayDir, 'logs', `${agent.name}-mount.log`);
  writeFileSync(mountLogPath, '', 'utf8');

  const onceArgs = [
    '--base-url',
    workspaceSession.relayfileUrl,
    '--workspace',
    workspaceSession.workspaceId,
    '--token',
    workspaceSession.token,
    '--local-dir',
    mountDir,
    '--once',
  ];

  let initialSyncOutput = '';
  log(`Mounting workspace at ${mountDir}...`);
  try {
    initialSyncOutput = await runCommandCapture(mountBin, onceArgs);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`initial workspace sync failed for ${agent.name}: ${message}`);
  }

  const deniedCount = pickDeniedCount(initialSyncOutput);
  const compiledPath = path.join(relayDir, 'compiled-acl.json');
  const compiled = extractPermissionPatternsFromCompiled(compiledPath, agent.name);
  const fallback = collectPermissionPatternsFromDotfiles(projectDir);
  const readonlyPatterns =
    compiled.readonlyPatterns.length > 0 ? compiled.readonlyPatterns : fallback.readonlyPatterns;
  const ignoredPatterns =
    compiled.ignoredPatterns.length > 0 ? compiled.ignoredPatterns : fallback.ignoredPatterns;
  const permsDoc = buildPermissionDoc(agent.name, readonlyPatterns, ignoredPatterns);
  writeFileSync(path.join(mountDir, '_PERMISSIONS.md'), permsDoc, 'utf8');

  const projectDeny = path.join(projectDir, '.agentdeny');
  if (existsSync(projectDeny)) {
    cpSync(projectDeny, path.join(mountDir, '.agentdeny'), { force: true });
  }

  const mountedFiles = countFilesForSync(mountDir);
  log(`On the relay as ${agent.name}`);
  log(`  Workspace: ${workspaceSession.workspaceId}`);
  log(`  Join: ${workspaceSession.joinCommand}`);
  log(`  Mounted files: ${mountedFiles}`);
  log(`  Permissions denied (initial sync): ${deniedCount}`);
  const sandboxFlags = getSandboxFlags(cli);
  if (sandboxFlags.length > 0) {
    log(`  Sandbox: relay-enforced (${sandboxFlags.join(' ')})`);
  }

  const cleanupState: CleanupState = {
    mountDir,
    mountLogPath,
    projectDir,
    relayDir,
    workspace: workspaceSession.workspaceId,
    readonlyPatterns,
    ignoredPatterns,
  };

  let mountProc: ChildProcessWithoutNullStreams | undefined;
  let agentProc: ReturnType<typeof spawn> | undefined;
  let cleanupDone = false;

  const finalizeCleanup = async (): Promise<void> => {
    if (cleanupDone) return;
    cleanupDone = true;
    cleanupState.mountProc = mountProc;
    await cleanupRun(cleanupState, agent.name, log);
  };

  try {
    const mountArgs = [
      '--base-url',
      workspaceSession.relayfileUrl,
      '--workspace',
      workspaceSession.workspaceId,
      '--token',
      workspaceSession.token,
      '--local-dir',
      mountDir,
    ];
    const mountedProc: ChildProcessWithoutNullStreams = spawn(mountBin, mountArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    mountProc = mountedProc;

    mountedProc.stdout.on('data', (chunk: Buffer) => {
      appendFileSync(mountLogPath, chunk);
    });
    mountedProc.stderr.on('data', (chunk: Buffer) => {
      appendFileSync(mountLogPath, chunk);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 600);
      mountedProc.on('error', (spawnError) => {
        clearTimeout(timer);
        reject(spawnError);
      });
      mountedProc.on('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (!ensureProcessRunning(mountedProc)) {
      throw new Error(`mount process for ${agent.name} exited before continuing`);
    }

    cleanupState.mountProc = mountProc;

    let agentExitCode = 0;
    await new Promise<void>((resolve, reject) => {
      const envVars = {
        ...process.env,
        RELAYFILE_TOKEN: workspaceSession.token,
        RELAYFILE_BASE_URL: workspaceSession.relayfileUrl,
        RELAYFILE_WORKSPACE: workspaceSession.workspaceId,
        RELAY_WORKSPACE_ID: workspaceSession.workspaceId,
        RELAY_DEFAULT_WORKSPACE: workspaceSession.workspaceId,
        RELAY_WORKSPACE: mountDir,
        RELAY_AGENT_NAME: agent.name,
        ...(workspaceSession.relaycastApiKey
          ? {
              RELAY_API_KEY: workspaceSession.relaycastApiKey,
              RELAY_WORKSPACES_JSON: JSON.stringify([
                {
                  workspace_id: workspaceSession.workspaceId,
                  api_key: workspaceSession.relaycastApiKey,
                },
              ]),
            }
          : {}),
      };

      agentProc = spawn(cli, [...sandboxFlags, ...extraArgs], {
        cwd: mountDir,
        stdio: 'inherit',
        env: envVars,
      });

      const cleanupHook = async () => {
        if (agentProc && !agentProc.killed) {
          agentProc.kill('SIGTERM');
        }
        await finalizeCleanup();
        resolve();
      };

      process.once('SIGINT', cleanupHook);
      process.once('SIGTERM', cleanupHook);

      agentProc.on('error', (err) => {
        process.removeListener('SIGINT', cleanupHook);
        process.removeListener('SIGTERM', cleanupHook);
        reject(err);
      });

      agentProc.on('close', (code, signal) => {
        process.removeListener('SIGINT', cleanupHook);
        process.removeListener('SIGTERM', cleanupHook);
        if (typeof code === 'number') {
          agentExitCode = code;
        } else if (signal === 'SIGINT') {
          agentExitCode = 130;
        } else if (signal === 'SIGTERM') {
          agentExitCode = 143;
        } else {
          agentExitCode = 1;
        }
        resolve();
      });
      // Finalization happens in outer finally.
    });

    await finalizeCleanup();
    log('Off the relay.');
    exit(agentExitCode);
  } finally {
    await finalizeCleanup();
  }
}
