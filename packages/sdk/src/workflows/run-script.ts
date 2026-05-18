/**
 * Programmatic local runner for `.ts` / `.tsx` / `.py` workflow scripts.
 *
 * This is the body of the `agent-relay run <script>` command extracted into
 * the SDK so other tools (e.g. `ricky run`) can drive the same execution
 * flow without shelling out to the `agent-relay` binary.
 *
 * Behavior is preserved exactly — the relay CLI's `run` command now
 * delegates to `runScriptWorkflow()` with no semantic change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn as spawnProcess, spawnSync } from 'node:child_process';

// ── Types ────────────────────────────────────────────────────────────────────

export type ExecFileSyncLike = typeof execFileSync;

export interface RunScriptWorkflowOptions {
  /** Validate without running. Sets `DRY_RUN=true` in the child env. */
  dryRun?: boolean;
  /** Resume a previously failed workflow run by id. */
  resume?: string;
  /** Start from the given step name, skipping predecessors. */
  startFrom?: string;
  /** Use cached outputs from this previous run id. Pairs with `startFrom`. */
  previousRunId?: string;
}

/**
 * Parsed workflow parse error, normalized from whatever shape the tsx/esbuild
 * subprocess produced on stderr. Decoupling this from any specific error class
 * means the formatter is testable in isolation and works regardless of how
 * the error surfaced (TransformError from tsx, Bun-bundled esbuild error, etc.).
 */
export interface ParsedWorkflowError {
  file: string;
  line?: number;
  column?: number;
  message: string;
  lineText?: string;
}

export interface LocalSdkWorkspace {
  rootDir: string;
  sdkDir: string;
}

interface SpawnRunnerResult {
  status: number | null;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

function diag(msg: string): void {
  try {
    process.stderr.write(`[agent-relay] ${msg}\n`);
  } catch {
    try {
      process.stdout.write(`[agent-relay] ${msg}\n`);
    } catch {
      // Both streams closed — silently give up. Never throw from diag().
    }
  }
}

// ── Local SDK workspace detection ────────────────────────────────────────────

/**
 * Walk upward from `startDir` looking for a workspace where the root
 * `package.json` is `agent-relay` and `packages/sdk/package.json` is
 * `@agent-relay/sdk`. Returns the matched paths or `null`.
 */
export function findLocalSdkWorkspace(startDir: string): LocalSdkWorkspace | null {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    const sdkDir = path.join(current, 'packages', 'sdk');
    const sdkPackageJsonPath = path.join(sdkDir, 'package.json');

    try {
      if (fs.existsSync(packageJsonPath) && fs.existsSync(sdkPackageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { name?: string };
        const sdkPkg = JSON.parse(fs.readFileSync(sdkPackageJsonPath, 'utf8')) as { name?: string };
        if (pkg.name === 'agent-relay' && sdkPkg.name === '@agent-relay/sdk') {
          return { rootDir: current, sdkDir };
        }
      }
    } catch {
      // Ignore parse/read errors and continue walking upward.
    }

    if (current === root) return null;
    current = path.dirname(current);
  }
}

/**
 * When running inside the relay monorepo, ensure `packages/sdk/dist/workflows`
 * is built so the script can resolve `@agent-relay/sdk/workflows`. No-op
 * outside the monorepo or when the build is already present.
 */
export function ensureLocalSdkWorkflowRuntime(
  startDir: string,
  execRunner: ExecFileSyncLike = execFileSync
): void {
  const workspace = findLocalSdkWorkspace(startDir);
  if (!workspace) return;

  const workflowsEntry = path.join(workspace.sdkDir, 'dist', 'workflows', 'index.js');
  if (fs.existsSync(workflowsEntry)) return;

  console.log(
    '[agent-relay] Detected local @agent-relay/sdk workspace without built workflows runtime; building packages/sdk...'
  );
  execRunner('npm', ['run', 'build:sdk'], {
    cwd: workspace.rootDir,
    stdio: 'inherit',
    env: process.env,
  });

  if (!fs.existsSync(workflowsEntry)) {
    throw new Error(`Local SDK workflows runtime is still missing after build: ${workflowsEntry}`);
  }
}

// ── Workflow parse error normalization ───────────────────────────────────────

/**
 * Parse tsx's stderr for the esbuild parse-error fingerprint and extract a
 * normalized {@link ParsedWorkflowError}. Returns null if nothing looks like
 * a parse error — runtime errors, module-not-found, etc. pass through.
 *
 * We match two common esbuild output formats:
 *   1. `/path/file.ts:LINE:COL: ERROR: message` (most common, one-liner)
 *   2. `✘ [ERROR] message\n\n    /path/file.ts:LINE:COL:\n      LINE │ text\n           ╵ pointer`
 *      (pretty-printed, multi-line)
 */
export function parseTsxStderr(stderr: string): ParsedWorkflowError | null {
  // Strip ANSI color codes so our regex isn't thrown off by escape sequences.
  // eslint-disable-next-line no-control-regex
  const clean = stderr.replace(/\x1b\[[0-9;]*m/g, '');

  // Format 1: file:line:col: ERROR: message
  const inlineMatch = clean.match(/(\/[^\s:]+\.(?:ts|tsx|mts|cts)):(\d+):(\d+):\s*ERROR:\s*([^\n]+)/);
  if (inlineMatch) {
    return {
      file: inlineMatch[1]!,
      line: Number(inlineMatch[2]),
      column: Number(inlineMatch[3]),
      message: inlineMatch[4]!.trim(),
    };
  }

  // Format 2: ✘ [ERROR] message ... file:line:col:
  const prettyError = clean.match(/✘\s*\[ERROR\]\s*([^\n]+)/);
  if (prettyError) {
    const locationMatch = clean.match(/(\/[^\s:]+\.(?:ts|tsx|mts|cts)):(\d+):(\d+):/);
    if (locationMatch) {
      return {
        file: locationMatch[1]!,
        line: Number(locationMatch[2]),
        column: Number(locationMatch[3]),
        message: prettyError[1]!.trim(),
      };
    }
  }

  // Format 3: "Transform failed with N errors" — loose fallback, any file+loc pair
  if (/Transform failed with \d+ error/i.test(clean) || /TransformError/.test(clean)) {
    const looseMatch = clean.match(/(\/[^\s:]+\.(?:ts|tsx|mts|cts)):(\d+):(\d+)/);
    if (looseMatch) {
      return {
        file: looseMatch[1]!,
        line: Number(looseMatch[2]),
        column: Number(looseMatch[3]),
        message: 'TypeScript parse error (see tsx output above)',
      };
    }
  }

  return null;
}

/**
 * Format a {@link ParsedWorkflowError} as an actionable workflow-author error
 * message with hints keyed off the most common mistakes in `command:` /
 * `task:` template literals.
 */
export function formatWorkflowParseError(parsed: ParsedWorkflowError): Error {
  const where =
    parsed.line !== undefined
      ? `${parsed.file}:${parsed.line}${parsed.column !== undefined ? `:${parsed.column}` : ''}`
      : parsed.file;

  const hints: string[] = [];
  const text = parsed.message;

  if (/Expected "\}" but found/i.test(text) || /Unterminated template literal/i.test(text)) {
    hints.push(
      'Likely a JavaScript template literal metacharacter inside a `command:` or `task:` block. ' +
        'Inside workflow .ts files every `command: \\`...\\`` is a JavaScript template literal — ' +
        'backticks terminate it and `${...}` triggers JS interpolation before the shell ever sees the string.',
      'Fixes: use single quotes instead of backticks in prose/commit messages; ' +
        'for shell variables use `$VAR` (no braces) or escape as `\\${VAR}`; ' +
        'never write literal `\\n` inside a shell comment (it becomes a real newline).'
    );
  }

  if (/Unexpected "\$"/.test(text)) {
    hints.push(
      'Unexpected `$` inside a template literal usually means `${...}` was interpreted as JS interpolation. ' +
        'Escape it as `\\${...}` or drop the braces and use plain `$VAR`.'
    );
  }

  if (/Expected identifier/.test(text) && /template/i.test(text)) {
    hints.push(
      'A template literal interpolation `${...}` needs a valid JS expression inside. ' +
        'If you meant a shell variable, escape the `$` or drop the braces.'
    );
  }

  const lines = ['', `Workflow file failed to parse: ${where}`, `  ${text}`];
  if (parsed.lineText) {
    lines.push(`  | ${parsed.lineText}`);
    if (parsed.column !== undefined && parsed.column >= 0) {
      lines.push(`  | ${' '.repeat(parsed.column)}^`);
    }
  }
  if (hints.length > 0) {
    lines.push('');
    for (const hint of hints) {
      lines.push(`Hint: ${hint}`);
    }
  }
  lines.push('');

  const wrapped = new Error(lines.join('\n'));
  (wrapped as Error & { code?: string }).code = 'WORKFLOW_PARSE_ERROR';
  return wrapped;
}

// ── Spawn helper ─────────────────────────────────────────────────────────────

/**
 * Spawn a TypeScript runner (tsx, ts-node, npx tsx) with stdin/stdout
 * inherited and stderr tee'd to both the user's terminal and an internal
 * buffer. The buffer is inspected on non-zero exit to produce actionable
 * error messages for workflow parse errors.
 *
 * Why this instead of `spawnSync({ stdio: 'inherit' })`: sync + inherit makes
 * it impossible to post-process stderr. Async + tee gives us the best of
 * both worlds — live progress for the user AND captured stderr for the
 * parse-error wrapper.
 */
async function spawnRunnerWithStderrCapture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<SpawnRunnerResult> {
  return new Promise((resolve) => {
    const child = spawnProcess(command, args, {
      stdio: ['inherit', 'inherit', 'pipe'],
      env,
    });

    let stderrBuf = '';

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderrBuf += text;
      try {
        process.stderr.write(text);
      } catch {
        // stderr closed — keep buffering for post-processing.
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ status: null, stderr: stderrBuf, error: err });
    });

    child.on('close', (status) => {
      resolve({ status, stderr: stderrBuf });
    });
  });
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * Run a `.ts`, `.tsx`, or `.py` workflow script locally.
 *
 * For TypeScript files, tries Node's `--experimental-strip-types` first
 * (Node 22.6+), then falls back to `tsx`, `ts-node`, and finally `npx tsx`.
 * For Python files, tries `python3` then `python`.
 *
 * Throws on non-zero exit. The error message includes the run id (when
 * the script wrote one to `AGENT_RELAY_RUN_ID_FILE`) so callers can resume
 * with `--start-from <step> --previous-run-id <id>`.
 */
export async function runScriptWorkflow(
  filePath: string,
  options: RunScriptWorkflowOptions = {}
): Promise<void> {
  diag(`runScriptWorkflow: resolving ${filePath}`);
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  const runIdFile = path.join(
    process.cwd(),
    '.agent-relay',
    `script-run-id-${process.pid}-${Date.now()}.txt`
  );
  try {
    fs.mkdirSync(path.dirname(runIdFile), { recursive: true });
  } catch {
    // Run-id hint is optional — don't abort if directory is not writable
  }
  const childEnv: NodeJS.ProcessEnv = { ...process.env, AGENT_RELAY_RUN_ID_FILE: runIdFile };
  if (options.dryRun) childEnv.DRY_RUN = 'true';
  if (options.resume) childEnv.RESUME_RUN_ID = options.resume;
  if (options.startFrom) childEnv.START_FROM = options.startFrom;
  if (options.previousRunId) childEnv.PREVIOUS_RUN_ID = options.previousRunId;

  const augmentErrorWithRunId = (err: any): never => {
    try {
      if (fs.existsSync(runIdFile)) {
        const runId = fs.readFileSync(runIdFile, 'utf8').trim();
        if (runId && typeof err?.message === 'string' && !err.message.includes('Run ID:')) {
          err.message += `
Run ID: ${runId}`;
        }
      }
    } catch {
      // Ignore run-id hint failures and preserve the original error.
    } finally {
      try {
        fs.rmSync(runIdFile, { force: true });
      } catch {
        // Ignore cleanup failure.
      }
    }
    throw err;
  };
  const cleanupRunIdFile = () => {
    try {
      fs.rmSync(runIdFile, { force: true });
    } catch {
      /* ignore */
    }
  };

  if (ext === '.ts' || ext === '.tsx') {
    diag('runScriptWorkflow: ensureLocalSdkWorkflowRuntime start');
    ensureLocalSdkWorkflowRuntime(path.dirname(resolved));
    diag('runScriptWorkflow: ensureLocalSdkWorkflowRuntime done');

    // Wrap a runner exit in an actionable workflow parse error if the
    // captured stderr looks like esbuild tripped on a template literal.
    // Otherwise fall through to a plain exit-code error (stderr was
    // already live-streamed to the terminal).
    const wrapRunnerError = (runner: string, result: SpawnRunnerResult): Error => {
      const parsed = parseTsxStderr(result.stderr);
      if (parsed) {
        return formatWorkflowParseError(parsed);
      }
      return new Error(`${runner} exited with code ${result.status}`);
    };

    // Prefer Node's built-in type stripping (Node 22.6+) — no extra deps,
    // no tsx CJS resolver quirks walking node_modules. Falls through to
    // tsx/ts-node on older Nodes (they exit non-zero with an unknown-flag
    // error, not ENOENT, so we treat any non-zero from this runner as a
    // "try the next runner" signal rather than a real user error).
    const runners: Array<{ label: string; bin: string; preArgs: string[] }> = [
      {
        label: 'node --experimental-strip-types',
        bin: 'node',
        preArgs: ['--experimental-strip-types', '--no-warnings=ExperimentalWarning'],
      },
      { label: 'tsx', bin: 'tsx', preArgs: [] },
      { label: 'ts-node', bin: 'ts-node', preArgs: [] },
    ];
    for (const { label, bin, preArgs } of runners) {
      diag(`runScriptWorkflow: trying runner ${label}`);
      const result = await spawnRunnerWithStderrCapture(bin, [...preArgs, resolved], childEnv);
      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
          diag(`runScriptWorkflow: runner ${label} returned ENOENT — trying next`);
          continue;
        }
        return augmentErrorWithRunId(result.error);
      }
      if (result.status !== 0) {
        // Node exits with code 9 ("Invalid Argument") when it doesn't
        // recognise --experimental-strip-types (Node <22.6). Only skip
        // to the next runner for that specific exit code; any other
        // non-zero status is a real script failure.
        if (bin === 'node' && result.status === 9) {
          diag(`runScriptWorkflow: runner ${label} unsupported on this Node (exit 9) — trying next`);
          continue;
        }
        return augmentErrorWithRunId(wrapRunnerError(label, result));
      }
      diag(`runScriptWorkflow: runner ${label} completed exit=0`);
      cleanupRunIdFile();
      return;
    }
    diag('runScriptWorkflow: falling back to npx tsx');
    const npxResult = await spawnRunnerWithStderrCapture('npx', ['tsx', resolved], childEnv);
    if (npxResult.error) {
      return augmentErrorWithRunId(npxResult.error);
    }
    if (npxResult.status !== 0) {
      return augmentErrorWithRunId(wrapRunnerError('npx tsx', npxResult));
    }
    diag('runScriptWorkflow: npx tsx completed');
    cleanupRunIdFile();
    return;
  }
  if (ext === '.py') {
    const runners = ['python3', 'python'];
    for (const runner of runners) {
      diag(`runScriptWorkflow: trying runner ${runner}`);
      const spawnResult = spawnSync(runner, [resolved], {
        stdio: 'inherit',
        env: childEnv,
      });
      if (spawnResult.error) {
        if ((spawnResult.error as NodeJS.ErrnoException).code === 'ENOENT') {
          diag(`runScriptWorkflow: runner ${runner} returned ENOENT — trying next`);
          continue;
        }
        return augmentErrorWithRunId(spawnResult.error);
      }
      if (spawnResult.status !== 0) {
        const err = new Error(`${runner} exited with code ${spawnResult.status}`);
        return augmentErrorWithRunId(err);
      }
      diag(`runScriptWorkflow: runner ${runner} completed exit=0`);
      cleanupRunIdFile();
      return;
    }
    cleanupRunIdFile();
    throw new Error('Python not found. Install Python 3.10+ to run .py workflow files.');
  }
  try {
    fs.rmSync(runIdFile, { force: true });
  } catch {
    // Ignore cleanup failure.
  }
  throw new Error(`Unsupported file type: ${ext}. Use .yaml, .yml, .ts, or .py`);
}
