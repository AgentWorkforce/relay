import { RelayFileClient } from '@relayfile/sdk';
import fs from 'node:fs';
import path from 'node:path';

interface BulkWriteResponseShape {
  written?: number;
  errorCount?: number;
  errors?: unknown;
}

interface SeedFile {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}

interface SeedFileResult {
  written: number;
  errorCount: number;
  errors: unknown;
}

const DEFAULT_EXCLUDED_DIRS = ['.relay', '.git', 'node_modules'];
const DEFAULT_EXCLUDED_FILES = new Set(['.relayfile-mount-state.json']);
const BATCH_SIZE = 50;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl ?? '').trim().replace(/\/+$/, '');
}

function normalizeWorkspaceId(workspaceId: string): string {
  const value = String(workspaceId ?? '').trim();
  if (!value) {
    throw new Error('workspaceId is required');
  }
  return value;
}

function normalizeExcludeDirs(excludeDirs: string[]): Set<string> {
  const result = new Set<string>();
  for (const dir of excludeDirs) {
    const normalized = String(dir ?? '')
      .trim()
      .replace(/^[/\\]+|[/\\]+$/g, '');
    if (!normalized) {
      continue;
    }
    result.add(normalized);
  }
  return result;
}

function createClient(baseUrl: string, token: string): RelayFileClient {
  return new RelayFileClient({
    baseUrl: normalizeBaseUrl(baseUrl),
    token,
    retry: { maxRetries: 0 },
  });
}

function isUtf8(raw: Buffer): boolean {
  try {
    utf8Decoder.decode(raw);
    return true;
  } catch {
    return false;
  }
}

function buildSeedFilePayload(filePath: string, rootDir: string): SeedFile {
  const relative = path.relative(rootDir, filePath).split(path.sep).join('/');
  const raw = fs.readFileSync(filePath);
  if (isUtf8(raw)) {
    return { path: `/${relative}`, content: raw.toString('utf8'), encoding: 'utf-8' };
  }
  return { path: `/${relative}`, content: raw.toString('base64'), encoding: 'base64' };
}

function collectSeedPaths(
  rootDir: string,
  currentRelative: string,
  excludeDirs: Set<string>,
  output: string[]
): void {
  const absoluteDir = path.join(rootDir, currentRelative);
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    if (excludeDirs.has(entry.name)) {
      continue;
    }
    if (DEFAULT_EXCLUDED_FILES.has(entry.name)) {
      continue;
    }

    const nextRelative = currentRelative ? `${currentRelative}/${entry.name}` : entry.name;
    const absolutePath = path.join(rootDir, nextRelative);

    if (entry.isDirectory()) {
      collectSeedPaths(rootDir, nextRelative, excludeDirs, output);
      continue;
    }

    if (entry.isFile()) {
      output.push(absolutePath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      try {
        const resolved = fs.realpathSync(absolutePath);
        // Prevent symlink traversal outside rootDir (CWE-59)
        if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
          continue;
        }
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          collectSeedPaths(rootDir, nextRelative, excludeDirs, output);
          continue;
        }
        if (stat.isFile()) {
          output.push(absolutePath);
        }
      } catch {
        // Ignore symlinks that cannot be resolved.
      }
    }
  }
}

function parseBulkWriteResponse(payload: unknown): SeedFileResult {
  if (!payload || typeof payload !== 'object') {
    return { written: 0, errorCount: 0, errors: [] };
  }
  const parsed = payload as BulkWriteResponseShape;
  return {
    written: typeof parsed.written === 'number' ? parsed.written : 0,
    errorCount: typeof parsed.errorCount === 'number' ? parsed.errorCount : 0,
    errors: parsed.errors ?? [],
  };
}

async function postBulkWrite(
  baseUrl: string,
  token: string,
  workspaceId: string,
  files: SeedFile[],
  correlationId: string
): Promise<SeedFileResult> {
  const response = await fetch(
    `${normalizeBaseUrl(baseUrl)}/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/bulk`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify({ files }),
    }
  );

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`failed to seed workspace ${workspaceId}: HTTP ${response.status} ${body}`.trim());
  }

  if (!body) {
    return { written: files.length, errorCount: 0, errors: [] };
  }
  try {
    return parseBulkWriteResponse(JSON.parse(body));
  } catch {
    return { written: files.length, errorCount: 0, errors: [] };
  }
}

async function writeBulkWrite(
  baseUrl: string,
  token: string,
  workspaceId: string,
  files: SeedFile[],
  correlationId: string
): Promise<SeedFileResult> {
  const client = createClient(baseUrl, token);
  try {
    const response = await client.bulkWrite({
      workspaceId,
      files,
      correlationId,
    });
    return parseBulkWriteResponse(response);
  } catch (error) {
    if (typeof (error as { status?: number }).status === 'number') {
      throw error;
    }
  }

  return postBulkWrite(baseUrl, token, workspaceId, files, correlationId);
}

export async function createWorkspace(baseUrl: string, token: string, workspaceId: string): Promise<void> {
  const workspace = normalizeWorkspaceId(workspaceId);
  const client = createClient(baseUrl, token);

  const maybeCreateWorkspace = client as unknown as {
    createWorkspace?: (...input: unknown[]) => Promise<unknown>;
  };
  if (typeof maybeCreateWorkspace.createWorkspace === 'function') {
    for (const arg of [workspace, { id: workspace }, { workspaceId: workspace }, { name: workspace }]) {
      try {
        await maybeCreateWorkspace.createWorkspace(arg);
        return;
      } catch {
        // Continue to the next overload candidate, then fallback to HTTP.
      }
    }
  }

  const endpoint = `${normalizeBaseUrl(baseUrl)}/v1/workspaces`;
  const bodyCandidates: Array<Record<string, string>> = [
    { name: workspace },
    { workspace: workspace },
    { workspaceId: workspace },
    { id: workspace },
  ];
  let lastFailure: string | null = null;

  for (const body of bodyCandidates) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Correlation-Id': `create-workspace-${Date.now()}`,
        },
        body: JSON.stringify(body),
      });

      if (
        response.status === 200 ||
        response.status === 201 ||
        response.status === 204 ||
        response.status === 409
      ) {
        return;
      }

      const responseBody = await response.text().catch(() => '');
      lastFailure = `HTTP ${response.status} ${responseBody}`.trim();
      if (response.status < 500 && response.status !== 409) {
        continue;
      }
    } catch (error) {
      lastFailure = String(error);
    }
  }

  if (lastFailure) {
    throw new Error(`Failed to create workspace ${workspace}: ${lastFailure}`);
  }
}

export async function seedWorkspace(
  baseUrl: string,
  token: string,
  workspaceId: string,
  projectDir: string,
  excludeDirs: string[]
): Promise<number> {
  const workspace = normalizeWorkspaceId(workspaceId);
  const rootDir = path.resolve(projectDir);
  const excludes = normalizeExcludeDirs([...DEFAULT_EXCLUDED_DIRS, ...excludeDirs]);
  const seedPaths: string[] = [];
  collectSeedPaths(rootDir, '', excludes, seedPaths);
  const allFiles = seedPaths
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => buildSeedFilePayload(filePath, rootDir));

  let seededCount = 0;
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE);
    const result = await writeBulkWrite(
      baseUrl,
      token,
      workspace,
      batch,
      `seed-workspace-${workspace}-${Date.now()}-${batchIndex}`
    );
    seededCount += result.written;
  }

  return seededCount;
}

export async function seedAclRules(
  baseUrl: string,
  token: string,
  workspaceId: string,
  aclRules: Record<string, string[]>
): Promise<void> {
  const workspace = normalizeWorkspaceId(workspaceId);
  const files = Object.entries(aclRules).map(([dirPath, rules]) => {
    const normalizedDir = String(dirPath ?? '').trim().replace(/\/+$/, '');
    const aclPath = normalizedDir === '' || normalizedDir === '/' ? '/.relayfile.acl' : `${normalizedDir}/.relayfile.acl`;
    return {
      path: aclPath,
      content: JSON.stringify({ semantics: { permissions: rules } }),
      encoding: 'utf-8' as const,
    };
  });

  if (files.length === 0) {
    return;
  }

  const result = await writeBulkWrite(baseUrl, token, workspace, files, `seed-acl-${workspace}-${Date.now()}`);
  if (result.errorCount > 0) {
    const details = result.errors ? JSON.stringify(result.errors) : '[]';
    throw new Error(
      `ACL seeding had ${result.errorCount} error(s) for workspace ${workspace}: ${details}`
    );
  }
}
