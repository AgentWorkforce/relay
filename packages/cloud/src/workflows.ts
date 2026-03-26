import fs from "node:fs/promises";
import path from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import ignore from "ignore";
import * as tar from "tar";

import { ensureAuthenticated, authorizedApiFetch } from "./auth.js";
import { defaultApiUrl, type WorkflowFileType, type RunWorkflowResponse, type WorkflowLogsResponse, type SyncPatchResponse } from "./types.js";

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

type RunWorkflowOptions = {
  apiUrl?: string;
  fileType?: WorkflowFileType;
  syncCode?: boolean;
};

const CODE_SYNC_EXCLUDES = [
  ".git",
  "node_modules",
  ".sst",
  ".next",
  ".open-next",
  ".env",
  ".env.*",
  ".env.local",
  ".env.production",
  "*.pem",
  "*.key",
  "credentials.json",
  ".aws",
  ".ssh",
];

function validateYamlWorkflow(content: string): void {
  const hasField = (field: string) =>
    new RegExp(`^${field}\\s*:`, "m").test(content);

  if (!hasField("version")) {
    throw new Error('missing required field "version"');
  }
  if (!hasField("swarm")) {
    throw new Error('missing required field "swarm"');
  }
  if (!hasField("agents")) {
    throw new Error('missing required field "agents"');
  }
  if (!hasField("workflows")) {
    throw new Error('missing required field "workflows"');
  }
}

async function validateTypeScriptWorkflow(content: string): Promise<void> {
  try {
    const { execSync } = await import("node:child_process");
    execSync("npx --yes esbuild --bundle=false --format=esm --loader=ts", {
      input: content,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
  } catch (error) {
    const err = error as { status?: number; killed?: boolean; stderr?: unknown };
    if (err.killed || !err.status) {
      console.error("TypeScript validation skipped: esbuild not available or timed out");
      return;
    }
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    const message = stderr || "TypeScript validation failed";
    throw new Error(`Workflow file has syntax errors:\n${message}`);
  }
}

export function inferWorkflowFileType(filePath: string): WorkflowFileType | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    case ".py":
      return "py";
    default:
      return null;
  }
}

export function shouldSyncCodeByDefault(
  _workflowArg: string,
  _explicitFileType?: WorkflowFileType,
): boolean {
  return true;
}

export async function resolveWorkflowInput(
  workflowArg: string,
  explicitFileType?: WorkflowFileType,
): Promise<ResolvedWorkflowInput> {
  const looksLikeFile = path.isAbsolute(workflowArg) ||
    workflowArg.includes(path.sep) ||
    inferWorkflowFileType(workflowArg) !== null;

  try {
    const stat = await fs.stat(workflowArg);
    if (!stat.isFile()) {
      throw new Error(`Workflow path is not a file: ${workflowArg}`);
    }

    const fileType = explicitFileType ?? inferWorkflowFileType(workflowArg);
    if (!fileType) {
      throw new Error(`Could not infer workflow type from ${workflowArg}. Use --file-type.`);
    }

    const workflow = await fs.readFile(workflowArg, "utf-8");
    return { workflow, fileType };
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  if (looksLikeFile) {
    throw new Error(`Workflow file not found: ${workflowArg}`);
  }

  return {
    workflow: workflowArg,
    fileType: explicitFileType ?? "yaml",
  };
}

export async function runWorkflow(
  workflowArg: string,
  options: RunWorkflowOptions = {},
): Promise<RunWorkflowResponse> {
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  let auth = await ensureAuthenticated(apiUrl);
  const input = await resolveWorkflowInput(workflowArg, options.fileType);

  if (input.fileType === "ts") {
    await validateTypeScriptWorkflow(input.workflow);
  } else if (input.fileType === "yaml") {
    console.error("Validating workflow...");
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
    console.error("Preparing run...");
    const { response: prepResponse, auth: prepAuth } = await authorizedApiFetch(auth, "/api/v1/workflows/prepare", {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    auth = prepAuth;

    const prepPayload = await readJsonResponse(prepResponse);
    if (!prepResponse.ok) {
      throw new Error(`Workflow prepare failed: ${describeResponseError(prepResponse, prepPayload)}`);
    }

    if (!isPrepareWorkflowResponse(prepPayload)) {
      throw new Error("Workflow prepare response was not valid JSON.");
    }

    const prepared = prepPayload;
    console.error(`  Prepared in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const t1 = Date.now();
    console.error("Creating tarball...");
    const s3Client = createScopedS3Client(prepared.s3Credentials);
    const tarball = await createTarball(process.cwd());
    console.error(`  Tarball: ${(tarball.length / 1024).toFixed(0)}KB in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

    const t2 = Date.now();
    console.error("Uploading to S3...");
    const key = scopedCodeKey(prepared.s3Credentials.prefix, prepared.s3CodeKey);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: prepared.s3Credentials.bucket,
        Key: key,
        Body: tarball,
        ContentType: "application/gzip",
      }),
    );
    console.error(`  Uploaded in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

    requestBody.runId = prepared.runId;
    requestBody.s3CodeKey = prepared.s3CodeKey;
  }

  const t3 = Date.now();
  console.error("Launching workflow...");
  const { response, auth: updatedAuth } = await authorizedApiFetch(
    auth,
    "/api/v1/workflows/run",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    },
  );
  auth = updatedAuth;

  console.error(`  Launched in ${((Date.now() - t3) / 1000).toFixed(1)}s`);

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Workflow run failed: ${describeResponseError(response, payload)}`);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { runId?: unknown }).runId !== "string" ||
    typeof (payload as { status?: unknown }).status !== "string"
  ) {
    throw new Error("Workflow run response was not valid JSON.");
  }

  return payload as RunWorkflowResponse;
}

export async function getRunStatus(
  runId: string,
  options: { apiUrl?: string } = {},
): Promise<Record<string, unknown>> {
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl);
  const { response } = await authorizedApiFetch(
    auth,
    `/api/v1/workflows/runs/${encodeURIComponent(runId)}`,
    {
      headers: { Accept: "application/json" },
    },
  );

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Status request failed: ${describeResponseError(response, payload)}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Status response was not valid JSON.");
  }

  return payload as Record<string, unknown>;
}

export async function cancelWorkflow(
  runId: string,
  options: { apiUrl?: string } = {},
): Promise<{ runId: string; status: string }> {
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl);
  const { response } = await authorizedApiFetch(
    auth,
    `/api/v1/workflows/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
  );

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Cancel failed: ${describeResponseError(response, payload)}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Cancel response was not valid JSON.");
  }

  return payload as { runId: string; status: string };
}

export async function getRunLogs(
  runId: string,
  options: {
    apiUrl?: string;
    offset?: number;
    sandboxId?: string;
  } = {},
): Promise<WorkflowLogsResponse> {
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl);
  const searchParams = new URLSearchParams();
  if (typeof options.offset === "number") {
    searchParams.set("offset", String(options.offset));
  }
  if (options.sandboxId) {
    searchParams.set("sandboxId", options.sandboxId);
  }

  const requestPath = `/api/v1/workflows/runs/${encodeURIComponent(runId)}/logs${searchParams.size ? `?${searchParams.toString()}` : ""}`;

  const { response } = await authorizedApiFetch(auth, requestPath, {
    headers: { Accept: "application/json" },
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Log request failed: ${describeResponseError(response, payload)}`);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { content?: unknown }).content !== "string" ||
    typeof (payload as { offset?: unknown }).offset !== "number" ||
    typeof (payload as { totalSize?: unknown }).totalSize !== "number" ||
    typeof (payload as { done?: unknown }).done !== "boolean"
  ) {
    throw new Error("Log response was not valid JSON.");
  }

  return payload as WorkflowLogsResponse;
}

export async function syncWorkflowPatch(
  runId: string,
  options: { apiUrl?: string } = {},
): Promise<SyncPatchResponse> {
  const apiUrl = options.apiUrl ?? defaultApiUrl();
  let auth = await ensureAuthenticated(apiUrl);

  // Verify the run is completed
  const { response: statusResponse, auth: a1 } = await authorizedApiFetch(
    auth,
    `/api/v1/workflows/runs/${encodeURIComponent(runId)}`,
    { headers: { Accept: "application/json" } },
  );
  auth = a1;

  if (!statusResponse.ok) {
    const payload = await readJsonResponse(statusResponse);
    throw new Error(`Failed to fetch run status: ${describeResponseError(statusResponse, payload)}`);
  }

  const runData = (await statusResponse.json()) as { status?: string };
  if (runData.status !== "completed" && runData.status !== "failed" && runData.status !== "cancelled") {
    throw new Error(`Run is still ${runData.status ?? "unknown"}. Wait for completion before syncing.`);
  }

  // Download the patch
  const { response } = await authorizedApiFetch(
    auth,
    `/api/v1/workflows/runs/${encodeURIComponent(runId)}/patch`,
    { headers: { Accept: "application/json" } },
  );

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Patch download failed: ${describeResponseError(response, payload)}`);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof (payload as { hasChanges?: unknown }).hasChanges !== "boolean"
  ) {
    throw new Error("Patch response was not valid JSON.");
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
  if (typeof payload === "string" && payload.trim()) {
    return `${response.status} ${response.statusText}: ${payload.trim()}`;
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const message = record.error ?? record.message;
    if (typeof message === "string" && message.trim()) {
      return `${response.status} ${response.statusText}: ${message.trim()}`;
    }
  }

  return `${response.status} ${response.statusText}`;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isPrepareWorkflowResponse(payload: unknown): payload is PrepareWorkflowResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const record = payload as Record<string, unknown>;
  const s3Creds = record.s3Credentials;
  if (!s3Creds || typeof s3Creds !== "object" || Array.isArray(s3Creds)) {
    return false;
  }

  const creds = s3Creds as Record<string, unknown>;
  return (
    typeof record.runId === "string" &&
    typeof record.s3CodeKey === "string" &&
    typeof creds.accessKeyId === "string" &&
    typeof creds.secretAccessKey === "string" &&
    typeof creds.sessionToken === "string" &&
    typeof creds.bucket === "string" &&
    typeof creds.prefix === "string"
  );
}

function createScopedS3Client(s3Credentials: S3Credentials): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
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
    const { execSync } = await import("node:child_process");
    const gitFiles = execSync("git ls-files -z", {
      cwd: absoluteRoot,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const files = gitFiles.split("\0").filter(Boolean);
    if (files.length > 0) {
      const tarStream = tar.create(
        { gzip: true, cwd: absoluteRoot, portable: true },
        files,
      );
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
        if (!normalized || normalized === ".") return true;
        return !ig.ignores(normalized);
      },
    },
    ["."],
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
    const gitignoreContent = await fs.readFile(path.join(rootDir, ".gitignore"), "utf-8");
    ig.add(gitignoreContent);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  return ig;
}

function normalizeEntryPath(entryPath: string): string {
  return entryPath.replace(/^\.\//, "").replace(/\\/g, "/");
}

function scopedCodeKey(prefix: string, key: string): string {
  return [prefix, key].filter(Boolean).join("/");
}
