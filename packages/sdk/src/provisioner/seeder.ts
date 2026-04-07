import { RelayFileClient } from '@relayfile/sdk';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';

interface BulkWriteResponseShape {
  written?: number;
  errorCount?: number;
  errors?: unknown;
}

interface ImportResponseShape {
  imported?: number;
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

interface GitSeedFilesResult {
  files: string[];
  usedGit: boolean;
}

const DEFAULT_EXCLUDED_DIRS = ['.relay', '.git', 'node_modules'];
const DEFAULT_EXCLUDED_FILES = new Set(['.relayfile-mount-state.json']);
const BATCH_SIZE = 50;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
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
    result.add(normalized.split(path.sep).join('/'));
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

function isPathInExcludedDir(relativePath: string, excludeDirs: Set<string>): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.') {
    return false;
  }

  const segments = normalized.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const prefix = segments.slice(0, i + 1).join('/');
    if (excludeDirs.has(prefix) || excludeDirs.has(segments[i])) {
      return true;
    }
  }

  return false;
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

    if (excludeDirs.has(nextRelative)) {
      continue;
    }

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

function parseImportResponse(payload: unknown): number {
  if (!payload || typeof payload !== 'object') {
    throw new Error('import endpoint returned an invalid JSON payload');
  }

  const parsed = payload as ImportResponseShape;
  if (typeof parsed.imported !== 'number') {
    throw new Error('import endpoint response did not include an imported count');
  }

  return parsed.imported;
}

function createTarballFromRelativePaths(rootDir: string, relativePaths: string[]): Promise<Buffer> {
  const tarStream = tar.create(
    { gzip: true, cwd: rootDir, portable: true, follow: true, noDirRecurse: relativePaths.length === 0 },
    relativePaths.length > 0 ? relativePaths : ['.']
  );
  const chunks: Buffer[] = [];

  return (async () => {
    for await (const chunk of tarStream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  })();
}

function listGitSeedFiles(rootDir: string, excludes: Set<string>): GitSeedFilesResult {
  try {
    const gitFiles = execSync('git ls-files -z --cached --others --exclude-standard', {
      cwd: rootDir,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    return {
      usedGit: true,
      files: gitFiles
        .split('\0')
        .filter(Boolean)
        .filter((filePath) => !DEFAULT_EXCLUDED_FILES.has(path.posix.basename(filePath)))
        .filter((filePath) => !isPathInExcludedDir(filePath, excludes))
        .sort((a, b) => a.localeCompare(b)),
    };
  } catch {
    return { files: [], usedGit: false };
  }
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

async function createSeedTarball(rootDir: string, excludeDirs: string[]): Promise<Buffer> {
  const absoluteRoot = path.resolve(rootDir);
  const excludes = normalizeExcludeDirs([...DEFAULT_EXCLUDED_DIRS, ...excludeDirs]);

  const gitSeedFiles = listGitSeedFiles(absoluteRoot, excludes);
  if (gitSeedFiles.usedGit) {
    return createTarballFromRelativePaths(absoluteRoot, gitSeedFiles.files);
  }

  const seedPaths: string[] = [];
  collectSeedPaths(absoluteRoot, '', excludes, seedPaths);
  const relativePaths = seedPaths
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => path.relative(absoluteRoot, filePath).split(path.sep).join('/'));

  return createTarballFromRelativePaths(absoluteRoot, relativePaths);
}

async function seedWorkspaceBatch(
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

export async function seedWorkspaceTar(
  baseUrl: string,
  token: string,
  workspaceId: string,
  projectDir: string,
  excludeDirs: string[]
): Promise<number> {
  const workspace = normalizeWorkspaceId(workspaceId);
  const rootDir = path.resolve(projectDir);
  let tarball: Buffer;
  try {
    tarball = await createSeedTarball(rootDir, excludeDirs);
  } catch (error) {
    throw new Error(
      `tar seed failed for workspace ${workspace}: unable to create tarball (${String(error)})`
    );
  }
  const url = `${normalizeBaseUrl(baseUrl)}/v1/workspaces/${encodeURIComponent(workspace)}/fs/import`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/gzip',
        'X-Correlation-Id': `seed-tar-${workspace}-${Date.now()}`,
      },
      body: new Uint8Array(tarball),
    });
  } catch (error) {
    throw new Error(`tar seed failed for workspace ${workspace}: request failed (${String(error)})`);
  }

  if (response.status === 404) {
    return seedWorkspaceBatch(baseUrl, token, workspaceId, projectDir, excludeDirs);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`tar seed failed for workspace ${workspace}: HTTP ${response.status} ${body}`.trim());
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`tar seed failed for workspace ${workspace}: invalid JSON response (${String(error)})`);
  }

  try {
    return parseImportResponse(payload);
  } catch (error) {
    throw new Error(`tar seed failed for workspace ${workspace}: ${String(error)}`);
  }
}

export async function seedWorkspace(
  baseUrl: string,
  token: string,
  workspaceId: string,
  projectDir: string,
  excludeDirs: string[]
): Promise<number> {
  if (process.env.RELAY_SEED_TAR === '0') {
    return seedWorkspaceBatch(baseUrl, token, workspaceId, projectDir, excludeDirs);
  }

  try {
    return await seedWorkspaceTar(baseUrl, token, workspaceId, projectDir, excludeDirs);
  } catch {
    return seedWorkspaceBatch(baseUrl, token, workspaceId, projectDir, excludeDirs);
  }
}
