import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import ignore from 'ignore';
import * as tar from 'tar';

import { ensureAuthenticated, authorizedApiFetch } from './auth.js';
import {
  defaultApiUrl,
  type WorkflowFileType,
  type RunWorkflowResponse,
  type WorkflowLogsResponse,
  type SyncPatchResponse,
  type PathSubmission,
} from './types.js';

type ResolvedWorkflowInput = {
  workflow: string;
  fileType: WorkflowFileType;
  sourceFileType?: WorkflowFileType;
};

type S3Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  bucket: string;
  prefix: string;
};

type PrepareWorkflowResponse = {
  runId: string;
  s3Credentials: S3Credentials;
  s3CodeKey: string;
};

type WorkflowPathDefinition = {
  name: string;
  path: string;
  pushBranch?: string;
  pushBase?: string;
  pushPrBody?: string;
};

type RunWorkflowOptions = {
  apiUrl?: string;
  fileType?: WorkflowFileType;
  syncCode?: boolean;
};

const CODE_SYNC_EXCLUDES = [
  '.git',
  'node_modules',
  '.sst',
  '.next',
  '.open-next',
  '.env',
  '.env.*',
  '.env.local',
  '.env.production',
  '*.pem',
  '*.key',
  'credentials.json',
  '.aws',
  '.ssh',
];
const PATH_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function validateYamlWorkflow(content: string): void {
  const hasField = (field: string) => new RegExp(`^${field}\\s*:`, 'm').test(content);

  if (!hasField('version')) {
    throw new Error('missing required field "version"');
  }
  if (!hasField('swarm')) {
    throw new Error('missing required field "swarm"');
  }
  if (!hasField('agents')) {
    throw new Error('missing required field "agents"');
  }
  if (!hasField('workflows')) {
    throw new Error('missing required field "workflows"');
  }
}

function stripYamlScalar(raw: string): string {
  let value = raw.trim();
  const commentIndex = value.search(/\s#/);
  if (commentIndex !== -1) {
    value = value.slice(0, commentIndex).trim();
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function assignPathField(target: Partial<WorkflowPathDefinition>, text: string): void {
  const colonIdx = text.indexOf(':');
  if (colonIdx === -1) return;
  const key = text.slice(0, colonIdx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return;
  const value = stripYamlScalar(text.slice(colonIdx + 1).trim());
  switch (key) {
    case 'name':
      target.name = value;
      break;
    case 'path':
      target.path = value;
      break;
    case 'pushBranch':
      target.pushBranch = value;
      break;
    case 'pushBase':
      target.pushBase = value;
      break;
    case 'pushPrBody':
      target.pushPrBody = value;
      break;
  }
}

function parseYamlWorkflowPaths(content: string): WorkflowPathDefinition[] {
  const paths: WorkflowPathDefinition[] = [];
  const lines = content.split(/\r?\n/);
  let inPaths = false;
  let baseIndent = 0;
  let current: Partial<WorkflowPathDefinition> | null = null;

  const flush = () => {
    if (current?.name && current.path) {
      paths.push({
        name: current.name,
        path: current.path,
        ...(current.pushBranch ? { pushBranch: current.pushBranch } : {}),
        ...(current.pushBase ? { pushBase: current.pushBase } : {}),
        ...(current.pushPrBody ? { pushPrBody: current.pushPrBody } : {}),
      });
    }
    current = null;
  };

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = rawLine.trim();

    if (!inPaths) {
      if (/^paths\s*:/.test(trimmed)) {
        inPaths = true;
        baseIndent = indent;
      }
      continue;
    }

    if (indent <= baseIndent && !trimmed.startsWith('-')) {
      break;
    }

    if (trimmed.startsWith('-')) {
      flush();
      current = {};
      const rest = trimmed.slice(1).trim();
      if (rest) assignPathField(current, rest);
      continue;
    }

    if (current) {
      assignPathField(current, trimmed);
    }
  }
  flush();

  return paths;
}

function findMatchingBracket(source: string, startIndex: number, open: string, close: string): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i] as '"' | "'" | '`' | string;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function extractPathArrayLiterals(source: string): string[] {
  const literals: string[] = [];

  const propertyPattern = /\bpaths\s*:/g;
  let propertyMatch: RegExpExecArray | null;
  while ((propertyMatch = propertyPattern.exec(source)) !== null) {
    const arrayStart = source.indexOf('[', propertyPattern.lastIndex);
    if (arrayStart === -1) continue;
    const arrayEnd = findMatchingBracket(source, arrayStart, '[', ']');
    if (arrayEnd !== -1) {
      literals.push(source.slice(arrayStart, arrayEnd + 1));
      propertyPattern.lastIndex = arrayEnd + 1;
    }
  }

  const methodPattern = /\.paths\s*\(/g;
  let methodMatch: RegExpExecArray | null;
  while ((methodMatch = methodPattern.exec(source)) !== null) {
    const arrayStart = source.indexOf('[', methodPattern.lastIndex);
    if (arrayStart === -1) continue;
    const arrayEnd = findMatchingBracket(source, arrayStart, '[', ']');
    if (arrayEnd !== -1) {
      literals.push(source.slice(arrayStart, arrayEnd + 1));
      methodPattern.lastIndex = arrayEnd + 1;
    }
  }

  return literals;
}

function extractObjectLiterals(arrayLiteral: string): string[] {
  const objects: string[] = [];
  for (let i = 0; i < arrayLiteral.length; i += 1) {
    if (arrayLiteral[i] !== '{') continue;
    const end = findMatchingBracket(arrayLiteral, i, '{', '}');
    if (end === -1) break;
    objects.push(arrayLiteral.slice(i, end + 1));
    i = end;
  }
  return objects;
}

function readStringProperty(objectLiteral: string, propertyName: string): string | null {
  const pattern = new RegExp(`\\b${propertyName}\\s*:\\s*(['"])(.*?)\\1`, 's');
  const match = objectLiteral.match(pattern);
  return match?.[2] ?? null;
}

function parseTypeScriptWorkflowPaths(content: string): WorkflowPathDefinition[] {
  const paths: WorkflowPathDefinition[] = [];
  for (const literal of extractPathArrayLiterals(content)) {
    for (const objectLiteral of extractObjectLiterals(literal)) {
      const name = readStringProperty(objectLiteral, 'name');
      const pathValue = readStringProperty(objectLiteral, 'path');
      if (name && pathValue) {
        const pushBranch = readStringProperty(objectLiteral, 'pushBranch');
        const pushBase = readStringProperty(objectLiteral, 'pushBase');
        const pushPrBody = readStringProperty(objectLiteral, 'pushPrBody');
        paths.push({
          name,
          path: pathValue,
          ...(pushBranch ? { pushBranch } : {}),
          ...(pushBase ? { pushBase } : {}),
          ...(pushPrBody ? { pushPrBody } : {}),
        });
      }
    }
  }
  return paths;
}

export function parseWorkflowPaths(content: string, fileType: WorkflowFileType): WorkflowPathDefinition[] {
  if (fileType === 'yaml') {
    return parseYamlWorkflowPaths(content);
  }
  if (fileType === 'ts') {
    return parseTypeScriptWorkflowPaths(content);
  }
  return [];
}

async function validateTypeScriptWorkflow(content: string): Promise<void> {
  // Strategy: use bun's built-in TS transpiler when available (the CLI is
  // bun-compiled, so this covers the common case with zero external deps).
  // Fall back to esbuild for Node.js environments, and skip validation
  // gracefully if neither is available — the cloud sandbox will catch real
  // syntax errors at execution time anyway.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Bun = (globalThis as any).Bun;
  if (typeof Bun !== 'undefined') {
    try {
      // Bun.build validates TS syntax during transpilation. A syntax error
      // throws synchronously or returns build failures.
      const result = await Bun.build({
        stdin: { contents: content, loader: 'ts' },
        throw: false,
      });
      if (!result.success && result.logs?.length) {
        const errors = result.logs
          .filter((l: { level?: string }) => l.level === 'error')
          .map((l: { message?: string }) => l.message)
          .join('\n');
        if (errors) {
          throw new Error(`Workflow file has syntax errors:\n${errors}`);
        }
      }
      return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Workflow file has syntax errors')) {
        throw error;
      }
      // Bun.build failed for a non-syntax reason — skip validation
      return;
    }
  }

  // Fallback: try esbuild via npx (for Node.js environments)
  try {
    const { execSync } = await import('node:child_process');
    execSync('npx --yes esbuild --loader=ts', {
      input: content,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch (error) {
    const err = error as { status?: number; killed?: boolean; stderr?: unknown };
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim() : '';
    // Skip validation when esbuild/npx is unavailable: killed by timeout,
    // no exit status, exit 127 (command not found), or stderr mentions
    // "command not found" / "not found".
    if (err.killed || !err.status || err.status === 127 || /command not found|not found/i.test(stderr)) {
      return;
    }
    const message = stderr || 'TypeScript validation failed';
    throw new Error(`Workflow file has syntax errors:\n${message}`);
  }
}

export function inferWorkflowFileType(filePath: string): WorkflowFileType | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.py':
      return 'py';
    default:
      return null;
  }
}

export function shouldSyncCodeByDefault(_workflowArg: string, _explicitFileType?: WorkflowFileType): boolean {
  return true;
}

function normalizeRepoName(repoName: string): string {
  return repoName.replace(/\.git$/i, '');
}

function parseGitHubPath(pathname: string): { repoOwner: string; repoName: string } | null {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2) return null;
  const repoOwner = parts[0];
  const repoName = normalizeRepoName(parts[1]);
  if (!repoOwner || !repoName) return null;
  return { repoOwner, repoName };
}

export function parseGitHubRemote(remote: string): { repoOwner: string; repoName: string } | null {
  const trimmed = remote.trim();
  const scpMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)\/?$/i);
  if (scpMatch) {
    return {
      repoOwner: scpMatch[1],
      repoName: normalizeRepoName(scpMatch[2]),
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null;
    return parseGitHubPath(url.pathname);
  } catch {
    return null;
  }
}

function parseGitHubRemoteForPath(absPath: string): { repoOwner: string; repoName: string } | null {
  try {
    const remote = execFileSync('git', ['-C', absPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return parseGitHubRemote(remote);
  } catch {
    return null;
  }
}

export async function resolveWorkflowInput(
  workflowArg: string,
  explicitFileType?: WorkflowFileType
): Promise<ResolvedWorkflowInput> {
  const looksLikeFile =
    path.isAbsolute(workflowArg) ||
    workflowArg.includes(path.sep) ||
    inferWorkflowFileType(workflowArg) !== null;

  try {
    const workflow = await fs.readFile(workflowArg, 'utf-8');
    const fileType = explicitFileType ?? inferWorkflowFileType(workflowArg);
    if (!fileType) {
      throw new Error(`Could not infer workflow type from ${workflowArg}. Use --file-type.`);
    }
    return { workflow, fileType };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EISDIR') {
      throw new Error(`Workflow path is not a file: ${workflowArg}`);
    }
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  if (looksLikeFile) {
    throw new Error(`Workflow file not found: ${workflowArg}`);
  }

  return {
    workflow: workflowArg,
    fileType: explicitFileType ?? 'yaml',
  };
}

export async function runWorkflow(
  workflowArg: string,
  options: RunWorkflowOptions = {}
): Promise<RunWorkflowResponse> {
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  let auth = await ensureAuthenticated(apiUrl);
  const input = await resolveWorkflowInput(workflowArg, options.fileType);

  if (input.fileType === 'ts') {
    await validateTypeScriptWorkflow(input.workflow);
  } else if (input.fileType === 'yaml') {
    console.error('Validating workflow...');
    validateYamlWorkflow(input.workflow);
  }

  const syncCode = options.syncCode ?? shouldSyncCodeByDefault(workflowArg, options.fileType);
  const requestBody: Record<string, unknown> = {
    workflow: input.workflow,
    fileType: input.fileType,
  };
  if (input.sourceFileType) {
    requestBody.sourceFileType = input.sourceFileType;
  }

  if (syncCode) {
    const t0 = Date.now();
    console.error('Preparing run...');
    const { response: prepResponse, auth: prepAuth } = await authorizedApiFetch(
      auth,
      '/api/v1/workflows/prepare',
      {
        method: 'POST',
        headers: { Accept: 'application/json' },
      }
    );
    auth = prepAuth;

    const prepPayload = await readJsonResponse(prepResponse);
    if (!prepResponse.ok) {
      throw new Error(`Workflow prepare failed: ${describeResponseError(prepResponse, prepPayload)}`);
    }

    if (!isPrepareWorkflowResponse(prepPayload)) {
      throw new Error('Workflow prepare response was not valid JSON.');
    }

    const prepared = prepPayload;
    console.error(`  Prepared in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const s3Client = createScopedS3Client(prepared.s3Credentials);
    requestBody.runId = prepared.runId;

    const declaredPaths = parseWorkflowPaths(input.workflow, input.fileType);
    if (declaredPaths.length > 0) {
      const seenNames = new Set<string>();
      const pathSubmissions: PathSubmission[] = [];
      const resolvedPathRoots: string[] = [];

      console.error(`Creating ${declaredPaths.length} path tarball(s)...`);
      for (const pathDef of declaredPaths) {
        if (!PATH_NAME_RE.test(pathDef.name) || seenNames.has(pathDef.name)) {
          throw new Error(`Invalid or duplicate workflow path name: ${pathDef.name}`);
        }
        seenNames.add(pathDef.name);

        const absolutePath = path.resolve(process.cwd(), pathDef.path);
        resolvedPathRoots.push(absolutePath);
        const s3CodeKey = `code-${pathDef.name}.tar.gz`;

        const t1 = Date.now();
        const tarball = await createTarball(absolutePath);
        console.error(
          `  ${pathDef.name}: ${(tarball.length / 1024).toFixed(0)}KB in ${((Date.now() - t1) / 1000).toFixed(1)}s`
        );

        const t2 = Date.now();
        const key = scopedCodeKey(prepared.s3Credentials.prefix, s3CodeKey);
        await s3Client.send(
          new PutObjectCommand({
            Bucket: prepared.s3Credentials.bucket,
            Key: key,
            Body: tarball,
            ContentType: 'application/gzip',
          })
        );
        console.error(`  ${pathDef.name}: uploaded in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

        const repo = parseGitHubRemoteForPath(absolutePath);
        pathSubmissions.push({
          name: pathDef.name,
          s3CodeKey,
          ...(repo ? { repoOwner: repo.repoOwner, repoName: repo.repoName } : {}),
          ...(pathDef.pushBranch ? { pushBranch: pathDef.pushBranch } : {}),
          ...(pathDef.pushBase ? { pushBase: pathDef.pushBase } : {}),
          ...(pathDef.pushPrBody ? { pushPrBody: pathDef.pushPrBody } : {}),
        });
      }

      requestBody.paths = pathSubmissions;
      let workflowPath: string | null = null;
      for (const root of resolvedPathRoots) {
        workflowPath = relativizeWorkflowPathFromRoot(workflowArg, root);
        if (workflowPath) break;
      }
      if (workflowPath) {
        requestBody.workflowPath = workflowPath;
      }
    } else {
      const t1 = Date.now();
      console.error('Creating tarball...');
      const tarball = await createTarball(process.cwd());
      console.error(
        `  Tarball: ${(tarball.length / 1024).toFixed(0)}KB in ${((Date.now() - t1) / 1000).toFixed(1)}s`
      );

      const t2 = Date.now();
      console.error('Uploading to S3...');
      const key = scopedCodeKey(prepared.s3Credentials.prefix, prepared.s3CodeKey);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: prepared.s3Credentials.bucket,
          Key: key,
          Body: tarball,
          ContentType: 'application/gzip',
        })
      );
      console.error(`  Uploaded in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

      requestBody.s3CodeKey = prepared.s3CodeKey;

      // Send the workflow's path inside the synced tarball so the cloud
      // launcher can set WORKFLOW_FILE directly — no $HOME upload dance,
      // sibling-relative imports (e.g. `../shared/models.ts`) resolve
      // against the repo layout. The tarball was produced from
      // process.cwd(), so relativize the user-typed argument against cwd.
      //
      // Absolute paths outside cwd OR paths that would escape the tarball
      // via `..` are dropped silently — the server falls back to the
      // legacy $HOME upload path in that case.
      const workflowPath = relativizeWorkflowPath(workflowArg);
      if (workflowPath) {
        requestBody.workflowPath = workflowPath;
      }
    }
  }

  const t3 = Date.now();
  console.error('Launching workflow...');
  const { response, auth: updatedAuth } = await authorizedApiFetch(auth, '/api/v1/workflows/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  auth = updatedAuth;

  console.error(`  Launched in ${((Date.now() - t3) / 1000).toFixed(1)}s`);

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Workflow run failed: ${describeResponseError(response, payload)}`);
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof (payload as { runId?: unknown }).runId !== 'string' ||
    typeof (payload as { status?: unknown }).status !== 'string'
  ) {
    throw new Error('Workflow run response was not valid JSON.');
  }

  return payload as RunWorkflowResponse;
}

export async function getRunStatus(
  runId: string,
  options: { apiUrl?: string } = {}
): Promise<Record<string, unknown>> {
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl);
  const { response } = await authorizedApiFetch(auth, `/api/v1/workflows/runs/${encodeURIComponent(runId)}`, {
    headers: { Accept: 'application/json' },
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Status request failed: ${describeResponseError(response, payload)}`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Status response was not valid JSON.');
  }

  return payload as Record<string, unknown>;
}

export async function cancelWorkflow(
  runId: string,
  options: { apiUrl?: string } = {}
): Promise<{ runId: string; status: string }> {
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl);
  const { response } = await authorizedApiFetch(
    auth,
    `/api/v1/workflows/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: 'POST',
      headers: { Accept: 'application/json' },
    }
  );

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Cancel failed: ${describeResponseError(response, payload)}`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Cancel response was not valid JSON.');
  }

  return payload as { runId: string; status: string };
}

export async function getRunLogs(
  runId: string,
  options: {
    apiUrl?: string;
    offset?: number;
    sandboxId?: string;
  } = {}
): Promise<WorkflowLogsResponse> {
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl);
  const searchParams = new URLSearchParams();
  if (typeof options.offset === 'number') {
    searchParams.set('offset', String(options.offset));
  }
  if (options.sandboxId) {
    searchParams.set('sandboxId', options.sandboxId);
  }

  const requestPath = `/api/v1/workflows/runs/${encodeURIComponent(runId)}/logs${searchParams.size ? `?${searchParams.toString()}` : ''}`;

  const { response } = await authorizedApiFetch(auth, requestPath, {
    headers: { Accept: 'application/json' },
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Log request failed: ${describeResponseError(response, payload)}`);
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof (payload as { content?: unknown }).content !== 'string' ||
    typeof (payload as { offset?: unknown }).offset !== 'number' ||
    typeof (payload as { totalSize?: unknown }).totalSize !== 'number' ||
    typeof (payload as { done?: unknown }).done !== 'boolean'
  ) {
    throw new Error('Log response was not valid JSON.');
  }

  return payload as WorkflowLogsResponse;
}

export async function syncWorkflowPatch(
  runId: string,
  options: { apiUrl?: string } = {}
): Promise<SyncPatchResponse> {
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  let auth = await ensureAuthenticated(apiUrl);

  // Verify the run is completed
  const { response: statusResponse, auth: a1 } = await authorizedApiFetch(
    auth,
    `/api/v1/workflows/runs/${encodeURIComponent(runId)}`,
    { headers: { Accept: 'application/json' } }
  );
  auth = a1;

  if (!statusResponse.ok) {
    const payload = await readJsonResponse(statusResponse);
    throw new Error(`Failed to fetch run status: ${describeResponseError(statusResponse, payload)}`);
  }

  const runData = (await statusResponse.json()) as { status?: string };
  if (runData.status !== 'completed' && runData.status !== 'failed' && runData.status !== 'cancelled') {
    throw new Error(`Run is still ${runData.status ?? 'unknown'}. Wait for completion before syncing.`);
  }

  // Download the patch
  const { response } = await authorizedApiFetch(
    auth,
    `/api/v1/workflows/runs/${encodeURIComponent(runId)}/patch`,
    { headers: { Accept: 'application/json' } }
  );

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Patch download failed: ${describeResponseError(response, payload)}`);
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    (typeof (payload as { hasChanges?: unknown }).hasChanges !== 'boolean' &&
      (!('patches' in payload) || typeof (payload as { patches?: unknown }).patches !== 'object'))
  ) {
    throw new Error('Patch response was not valid JSON.');
  }

  return payload as SyncPatchResponse;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function readJsonResponse(response: Response): Promise<unknown> {
  const rawBody = await response.text();
  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
}

function describeResponseError(response: Response, payload: unknown): string {
  if (typeof payload === 'string' && payload.trim()) {
    return `${response.status} ${response.statusText}: ${payload.trim()}`;
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const message = record.error ?? record.message;
    if (typeof message === 'string' && message.trim()) {
      return `${response.status} ${response.statusText}: ${message.trim()}`;
    }
  }

  return `${response.status} ${response.statusText}`;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isPrepareWorkflowResponse(payload: unknown): payload is PrepareWorkflowResponse {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }

  const record = payload as Record<string, unknown>;
  const s3Creds = record.s3Credentials;
  if (!s3Creds || typeof s3Creds !== 'object' || Array.isArray(s3Creds)) {
    return false;
  }

  const creds = s3Creds as Record<string, unknown>;
  return (
    typeof record.runId === 'string' &&
    typeof record.s3CodeKey === 'string' &&
    typeof creds.accessKeyId === 'string' &&
    typeof creds.secretAccessKey === 'string' &&
    typeof creds.sessionToken === 'string' &&
    typeof creds.bucket === 'string' &&
    typeof creds.prefix === 'string'
  );
}

function createScopedS3Client(s3Credentials: S3Credentials): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: s3Credentials.accessKeyId,
      secretAccessKey: s3Credentials.secretAccessKey,
      sessionToken: s3Credentials.sessionToken,
    },
  });
}

async function createTarball(rootDir: string): Promise<Buffer> {
  const absoluteRoot = path.resolve(rootDir);

  try {
    const { execSync } = await import('node:child_process');
    const gitFiles = execSync('git ls-files -z', {
      cwd: absoluteRoot,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files = gitFiles.split('\0').filter(Boolean);
    if (files.length > 0) {
      const tarStream = tar.create({ gzip: true, cwd: absoluteRoot, portable: true }, files);
      const chunks: Buffer[] = [];
      for await (const chunk of tarStream) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks);
    }
  } catch {
    // Not a git repo or git not available — fall back to ignore-based filter
  }

  const ig = await buildIgnoreMatcher(absoluteRoot);
  const tarStream = tar.create(
    {
      gzip: true,
      cwd: absoluteRoot,
      portable: true,
      filter(entryPath: string): boolean {
        const normalized = normalizeEntryPath(entryPath);
        if (!normalized || normalized === '.') return true;
        return !ig.ignores(normalized);
      },
    },
    ['.']
  );

  const chunks: Buffer[] = [];
  for await (const chunk of tarStream) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }

  return Buffer.concat(chunks);
}

async function buildIgnoreMatcher(rootDir: string): Promise<ignore.Ignore> {
  const ig = ignore();
  ig.add(CODE_SYNC_EXCLUDES);

  try {
    const gitignoreContent = await fs.readFile(path.join(rootDir, '.gitignore'), 'utf-8');
    ig.add(gitignoreContent);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  return ig;
}

function normalizeEntryPath(entryPath: string): string {
  return entryPath.replace(/^\.\//, '').replace(/\\/g, '/');
}

function scopedCodeKey(prefix: string, key: string): string {
  return [prefix, key].filter(Boolean).join('/');
}

/**
 * Turn the user-typed workflow path into a path **relative to the tarball
 * root** (process.cwd()) that the cloud launcher can append to
 * `/project/` to locate the file inside the synced code tree.
 *
 * Returns `null` when the result would escape the tarball (absolute
 * outside cwd, or contains `..`). Callers drop the hint in that case —
 * the server falls back to the legacy $HOME upload path, which still
 * works (it just breaks sibling-relative imports, the pre-existing
 * behaviour this field was added to fix).
 */
export function relativizeWorkflowPath(workflowArg: string): string | null {
  return relativizeWorkflowPathFromRoot(workflowArg, process.cwd());
}

function relativizeWorkflowPathFromRoot(workflowArg: string, rootDir: string): string | null {
  const absolute = path.resolve(process.cwd(), workflowArg);
  let rel = path.relative(rootDir, absolute);
  if (rel.length === 0) return null;
  // Normalize to forward slashes so the server-side validator (which
  // runs on Linux Lambda) gets the same shape regardless of the CLI OS.
  rel = rel.split(path.sep).join('/');
  if (rel.startsWith('../') || rel === '..') return null;
  if (path.isAbsolute(rel)) return null;
  return rel;
}
