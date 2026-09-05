#!/usr/bin/env node

import { spawn, execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readdir, readlink, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { readRegularFileNoFollow } from './safe-file.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RELAY_ROOT = path.resolve(SCRIPT_DIR, '../..');
const DEFAULT_ARTIFACT_DIR = path.join(
  RELAY_ROOT,
  '.workflow-artifacts',
  'diagnose-relay-orchestration-reliability'
);
const MAX_OUTPUT_BYTES = 96 * 1024;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readFlag(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function redact(value) {
  return String(value)
    .replace(/\brk_(?:live|test)_[A-Za-z0-9_-]+\b/g, '[REDACTED_RELAY_KEY]')
    .replace(/\brelay_(?:pa|ws)_[A-Za-z0-9._-]+\b/g, '[REDACTED_RELAY_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/((?:authorization|token|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function bounded(value, maxBytes = MAX_OUTPUT_BYTES, sourceTruncated = false) {
  const cleaned = redact(value);
  const bytes = Buffer.from(cleaned);
  if (bytes.length <= maxBytes && !sourceTruncated) {
    return { value: cleaned, truncated: false };
  }
  const marker = Buffer.from('\n[TRUNCATED]');
  const prefix = bytes.subarray(0, Math.max(0, maxBytes - marker.length)).toString('utf8');
  return { value: `${prefix}${marker}`, truncated: true };
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

// Vitest's "Test Files" summary line reports how many files it actually ran,
// e.g. "Test Files  3 passed (3)" or "Test Files  1 failed | 2 passed (3)".
// The number in parentheses is the total files vitest attempted, regardless
// of a filter silently matching fewer files than were requested on argv.
function parseVitestFileTotal(stdout) {
  const match = stripAnsi(stdout).match(/Test Files\s+.*?\((\d+)\)/);
  return match ? Number(match[1]) : null;
}

function countRequestedTestFiles(args) {
  return args.filter((arg) => arg.endsWith('.test.ts')).length;
}

function repoPaths() {
  const relayfileRoot = path.resolve(process.env.RELAYFILE_REPO ?? path.join(RELAY_ROOT, '../relayfile'));
  const proofDefault = path.join(RELAY_ROOT, '../relayfile-457-proof-0902');
  return {
    relay: RELAY_ROOT,
    cloud: path.resolve(process.env.RELAY_CLOUD_REPO ?? path.join(RELAY_ROOT, '../cloud')),
    relayfile: relayfileRoot,
    relayfileCandidate: path.resolve(process.env.RELAYFILE_CANDIDATE_REPO ?? proofDefault),
    relayfileCloud: path.resolve(
      process.env.RELAYFILE_CLOUD_REPO ?? path.join(RELAY_ROOT, '../relayfile-cloud')
    ),
  };
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export function runDiagnosticCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      stdout = `${stdout}${chunk}`.slice(0, maxOutputBytes + 4096);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      stderr = `${stderr}${chunk}`.slice(0, maxOutputBytes + 4096);
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      const boundedStdout = bounded(stdout, maxOutputBytes, stdoutBytes > maxOutputBytes);
      const boundedStderr = bounded(stderr, maxOutputBytes, stderrBytes > maxOutputBytes);
      resolve({
        command: [command, ...args],
        cwd: options.cwd,
        startedAt,
        durationMs: Date.now() - started,
        timedOut,
        stdout: boundedStdout.value,
        stderr: boundedStderr.value,
        stdoutBytes,
        stderrBytes,
        stdoutTruncated: boundedStdout.truncated,
        stderrTruncated: boundedStderr.truncated,
        ...result,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ exitCode: null, signal: null, error: redact(error.message) });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      finish({ exitCode, signal, error: null });
    });
  });
}

const run = runDiagnosticCommand;

async function git(repo, args) {
  return run('git', ['-C', repo, ...args], { cwd: RELAY_ROOT, timeoutMs: 60_000 });
}

const execFileAsync = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function gateImplementationHash() {
  return sha256(await readFile(fileURLToPath(import.meta.url)));
}

// Trail is required to remain tracked, but Relayflows writes trajectory telemetry
// while a run is in progress. It is evidence about the run, not an input to the
// product/source qualification. Including it makes a frozen run drift merely by
// recording its own progress. Keep the exclusion narrow and explicit.
function isRuntimeTelemetryPath(file) {
  return file === '.agentworkforce/trajectories' || file.startsWith('.agentworkforce/trajectories/');
}

function isRuntimeTelemetryStatusLine(line) {
  const paths = line
    .slice(3)
    .split(' -> ')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''));
  return paths.length > 0 && paths.every(isRuntimeTelemetryPath);
}

// Hash tracked and nonignored untracked contents, including files already dirty.
// Artifacts are excluded because they are the output, not tested source. No raw
// file contents or environment values are serialized into provenance.
async function sourceManifest(repo) {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  const files = [...new Set(stdout.split('\0').filter(Boolean))].sort();
  const manifest = [];
  for (const file of files) {
    if (file.startsWith('.workflow-artifacts/') || isRuntimeTelemetryPath(file)) continue;
    const target = path.join(repo, file);
    try {
      const info = await lstat(target);
      if (info.isDirectory()) {
        const nested = await snapshotRepo(file, target);
        if (!nested.available) throw new Error(`nested source unavailable: ${file}`);
        manifest.push({ file, head: nested.head, contentSha256: nested.contentSha256 });
        continue;
      }
      if (info.isSymbolicLink()) {
        manifest.push({ file, mode: info.mode & 0o777, hash: sha256(await readlink(target)) });
        continue;
      }
      const { bytes, mode } = await readRegularFileNoFollow(target, {
        label: `diagnostic source file ${file}`,
      });
      manifest.push({ file, mode, hash: sha256(bytes) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      manifest.push({ file, missing: true });
    }
  }
  return { contentSha256: sha256(JSON.stringify(manifest)), fileCount: manifest.length, manifest };
}

async function snapshotRepo(name, repo) {
  if (!(await pathExists(repo))) {
    return { name, path: repo, available: false, error: 'repository path is missing' };
  }
  const [top, head, branch, statusResult] = await Promise.all([
    git(repo, ['rev-parse', '--show-toplevel']),
    git(repo, ['rev-parse', 'HEAD']),
    git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repo, ['status', '--short', '--untracked-files=all']),
  ]);
  const successful = [top, head, branch, statusResult].every(
    (item) => item.exitCode === 0 && !item.stdoutTruncated && !item.stderrTruncated
  );
  return {
    name,
    path: repo,
    available: successful,
    head: head.stdout.trim(),
    branch: branch.stdout.trim(),
    dirtyPaths: statusResult.stdout
      .split('\n')
      .filter(Boolean)
      .filter((line) => !isRuntimeTelemetryStatusLine(line))
      .map((line) => line.trim()),
    ...(successful ? await sourceManifest(repo) : {}),
    error: successful ? null : 'git repository inspection failed',
  };
}

async function githubScope(repo) {
  const [issuesResult, mergesResult] = await Promise.all([
    run(
      'gh',
      [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--limit',
        '500',
        '--json',
        'number,title,labels,createdAt,updatedAt,url',
      ],
      { cwd: RELAY_ROOT, timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 }
    ),
    run(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'merged',
        '--limit',
        '100',
        '--json',
        'number,title,mergedAt,url,headRefName,baseRefName',
      ],
      { cwd: RELAY_ROOT, timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 }
    ),
  ]);
  const parse = (result, label) => {
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.signal ||
      result.error ||
      result.stdoutTruncated ||
      result.stderrTruncated
    ) {
      throw new Error(`${repo} ${label} collection failed`);
    }
    const value = JSON.parse(result.stdout);
    if (!Array.isArray(value)) throw new Error(`${repo} ${label} collection returned invalid JSON`);
    return value;
  };
  const openIssues = parse(issuesResult, 'open issue');
  const recentMerges = parse(mergesResult, 'recent merge');
  return {
    repo,
    capturedAt: new Date().toISOString(),
    openIssueCount: openIssues.length,
    openIssues,
    recentMergeCount: recentMerges.length,
    recentMerges,
  };
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
}

async function preflight(artifactDir, runId) {
  if (!SAFE_ID.test(runId)) {
    throw new Error('run id must contain only lowercase letters, digits, and hyphens');
  }
  const blockerPath = path.join(artifactDir, 'BLOCKED_NO_COMMIT.md');
  if (await pathExists(blockerPath)) {
    const blocker = await readFile(blockerPath, 'utf8');
    try {
      const parsed = JSON.parse(blocker);
      if (
        parsed.kind === 'diagnosis-permission-placeholder' &&
        parsed.runId === runId &&
        parsed.file === 'BLOCKED_NO_COMMIT.md'
      ) {
        await unlink(blockerPath);
      }
    } catch {
      // A real blocker from an earlier/resumed run must never be removed.
    }
  }
  // No fallback: relayfileCandidate must resolve to its own worktree. Silently
  // substituting paths.relayfile here (as this used to do) hid the candidate
  // repo's absence from context.json, which let staticGates() run the
  // -candidate go test gates against the *wrong* checkout with no record
  // that the substitution happened (see relay-review F2).
  const paths = repoPaths();
  const repos = await Promise.all(Object.entries(paths).map(([name, repo]) => snapshotRepo(name, repo)));
  const tools = {};
  for (const tool of ['node', 'git', 'gh', 'go', 'relayflows', 'agent-relay', 'daytona']) {
    const result = await run('sh', ['-c', `command -v ${tool}`], {
      cwd: RELAY_ROOT,
      timeoutMs: 10_000,
    });
    tools[tool] = result.exitCode === 0;
  }
  const requiredTools = ['node', 'git', 'gh', 'go', 'relayflows'];
  const missingTools = requiredTools.filter((tool) => !tools[tool]);
  const unavailableRepos = repos.filter((repo) => !repo.available);
  let issueScope = [];
  let issueScopeError = null;
  try {
    issueScope = await Promise.all(
      [
        'AgentWorkforce/relay',
        'AgentWorkforce/cloud',
        'AgentWorkforce/relayfile',
        'AgentWorkforce/relayfile-cloud',
      ].map(githubScope)
    );
  } catch (error) {
    issueScopeError = redact(error instanceof Error ? error.message : String(error));
  }
  const context = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    gateImplementationSha256: await gateImplementationHash(),
    mode: process.env.RELAY_RELIABILITY_MODE ?? 'diagnose',
    writeScope: [path.relative(RELAY_ROOT, artifactDir)],
    prohibitedActions: ['push', 'merge', 'publish', 'deploy', 'production mutation'],
    repos,
    tools,
    issueScope,
    issueScopeError,
    knownIssueFamilies: {
      relay: [
        1604, 1603, 1591, 1563, 1554, 1544, 1541, 1538, 1510, 1460, 1459, 1455, 1448, 1441, 1432, 1416, 1400,
      ],
      cloud: [
        3298, 3277, 3213, 3201, 3179, 3170, 3156, 3146, 3144, 3131, 3128, 3073, 3070, 3061, 2930, 2918, 2834,
        2806, 2775, 2722, 2681, 2680,
      ],
      relayfile: [455, 449, 448, 432, 429, 427, 420, 406, 404, 394, 387, 381, 379, 319, 219, 102, 79],
      relayfileCloud: [183, 179],
    },
  };
  await writeJson(path.join(artifactDir, 'context.json'), context);
  if (missingTools.length || unavailableRepos.length || issueScopeError) {
    throw new Error(
      `preflight failed: missing tools=${missingTools.join(',') || 'none'} unavailable repos=${unavailableRepos.map((repo) => repo.name).join(',') || 'none'} issue scope=${issueScopeError ?? 'ok'}`
    );
  }
  console.log(
    JSON.stringify({
      status: 'PREFLIGHT_OK',
      runId,
      context: path.join(artifactDir, 'context.json'),
      dirtyRepoCount: repos.filter((repo) => repo.dirtyPaths.length > 0).length,
    })
  );
}

function gateSpecs() {
  // No candidate fallback here either (see preflight()): if the -candidate
  // gates' cwd does not exist, `run()` below fails the spawn and the gate is
  // recorded FAIL, rather than silently re-running against paths.relayfile.
  const paths = repoPaths();
  const specs = [
    {
      id: 'relay-fleet-catalog',
      cwd: paths.relay,
      command: 'node',
      args: ['scripts/verify-features/fleet-daytona.mjs', 'validate'],
      timeoutMs: 120_000,
    },
    {
      id: 'relay-cleanroom-fixtures',
      cwd: paths.relay,
      command: 'npx',
      args: [
        'vitest',
        'run',
        'tests/fixtures/verify-cleanroom.test.ts',
        'tests/fixtures/verify-fleet-daytona.test.ts',
        'tests/fixtures/qualification-manifest.test.ts',
        'tests/fixtures/qualification-capabilities.test.ts',
        'tests/fixtures/diagnostic-seal.test.ts',
        'tests/fixtures/diagnostic-source-drift.test.ts',
        'tests/fixtures/relay-package-qualification.test.ts',
      ],
      timeoutMs: 10 * 60 * 1000,
    },
    {
      id: 'cloud-acl-timeout-contract',
      cwd: paths.cloud,
      command: 'node',
      args: [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'vitest.config.ts',
        'tests/relay-workspace-acl-timeout.test.ts',
      ],
      timeoutMs: 10 * 60 * 1000,
    },
    {
      id: 'cloud-fleet-mount-contracts',
      cwd: paths.cloud,
      command: 'node',
      args: [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'vitest.config.ts',
        'packages/web/lib/fleet/sandbox-bridge.test.ts',
        'packages/web/app/api/v1/fleet/nodes/sandbox/ensure/route.test.ts',
        'packages/web/app/api/v1/fleet/nodes/sandbox/route.test.ts',
      ],
      timeoutMs: 20 * 60 * 1000,
    },
    {
      // Exercise the currently checked-out Relayfile repo as well as the
      // candidate worktree. This is deliberately not called "mainline": the
      // captured branch/dirty provenance decides what this evidence qualifies.
      // mountstate/ is candidate-only (the unmerged branch's new package),
      // so this mirrors the candidate gate's other three packages.
      id: 'relayfile-current-checkout-mount-tests',
      cwd: paths.relayfile,
      command: 'go',
      args: ['test', '-count=1', './internal/mountsync/', './cmd/relayfile-mount/', './cmd/relayfile-cli/'],
      timeoutMs: 10 * 60 * 1000,
    },
    {
      id: 'relayfile-once-readiness-candidate',
      cwd: paths.relayfileCandidate,
      command: 'go',
      // -count=1 disables Go's test cache: without it a passing cached result
      // from a previous run is replayed forever and the gate never actually
      // re-executes (relay-review F2, "aggravating detail").
      args: [
        'test',
        '-count=1',
        './internal/mountstate/',
        './internal/mountsync/',
        './cmd/relayfile-mount/',
        './cmd/relayfile-cli/',
      ],
      timeoutMs: 30 * 60 * 1000,
      isCandidateGate: true,
    },
    {
      id: 'relayfile-state-writer-race-candidate',
      cwd: paths.relayfileCandidate,
      command: 'go',
      args: ['test', '-count=1', '-race', './internal/mountstate/', './cmd/relayfile-mount/'],
      timeoutMs: 30 * 60 * 1000,
      isCandidateGate: true,
    },
    {
      // Names the pinning test the -candidate gates above exist to prove
      // (TestMirrorStateWriteKeepsMountsyncFields) so its absence is a FAIL,
      // not silently folded into a passing package-level `go test` (F2).
      id: 'relayfile-candidate-pinning-test',
      cwd: paths.relayfileCandidate,
      command: 'go',
      args: [
        'test',
        '-count=1',
        '-v',
        '-run',
        'TestMirrorStateWriteKeepsMountsyncFields',
        './cmd/relayfile-cli/',
      ],
      timeoutMs: 5 * 60 * 1000,
      isCandidateGate: true,
    },
    {
      id: 'relayfile-cloud-large-fixtures',
      cwd: paths.relayfileCloud,
      command: 'node',
      args: [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--pool=forks',
        '--maxWorkers=1',
        'packages/relayfile/test/load/synthetic-large-workspace.test.ts',
        'packages/relayfile/test/export-manifest.test.ts',
        'packages/relayfile/test/workspace-do-oom.test.ts',
      ],
      timeoutMs: 30 * 60 * 1000,
    },
    {
      // local/sql-variable-limit.test.ts lives outside the default vitest
      // workspace `include` (packages/**/*.test.ts), so it must run under its
      // own local/vitest.config.ts as its own gate rather than being bundled
      // into a filter that silently drops it while still exiting 0 (F1).
      id: 'relayfile-cloud-local-fixtures',
      cwd: paths.relayfileCloud,
      command: 'node',
      args: [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'local/vitest.config.ts',
        'local/sql-variable-limit.test.ts',
      ],
      timeoutMs: 10 * 60 * 1000,
    },
  ];
  return specs;
}

async function staticGates(artifactDir) {
  const specs = gateSpecs();
  const implementationHash = await gateImplementationHash();
  const results = [];
  for (const spec of specs) {
    const before = await snapshotRepo(spec.id, spec.cwd);
    const result = await run(spec.command, spec.args, spec);
    let status =
      result.exitCode === 0 &&
      !result.timedOut &&
      !result.signal &&
      !result.error &&
      !result.stdoutTruncated &&
      !result.stderrTruncated
        ? 'PASS'
        : 'FAIL';
    let statusReason = null;

    // Structural check (F1): a vitest gate that requests N `.test.ts` files
    // must report having actually run N files. A filter/config mismatch that
    // silently matches a strict subset must not report PASS.
    const expectedTestFiles = countRequestedTestFiles(spec.args);
    if (status === 'PASS' && expectedTestFiles > 0 && spec.args.some((arg) => arg.includes('vitest'))) {
      const actualTestFiles = parseVitestFileTotal(result.stdout);
      if (actualTestFiles === null || actualTestFiles !== expectedTestFiles) {
        status = 'FAIL';
        statusReason = `requested ${expectedTestFiles} test file(s), vitest reported ${actualTestFiles ?? 'unknown'}`;
      }
    }

    // Structural check (F2): record which repo/commit a -candidate gate
    // actually ran against, so a silent path substitution can never again go
    // unrecorded in the artifact.
    const after = await snapshotRepo(spec.id, spec.cwd);
    const resolvedHead = before.head ?? null;
    if (
      !before.available ||
      !after.available ||
      before.head !== after.head ||
      before.contentSha256 !== after.contentSha256
    ) {
      status = 'FAIL';
      statusReason = 'source unavailable or changed during gate execution';
    }
    const qualificationScope = spec.isCandidateGate ? 'candidate-checkout' : 'current-checkout';

    results.push({
      id: spec.id,
      ...result,
      resolvedCwd: spec.cwd,
      resolvedHead,
      sourceBefore: before,
      sourceAfter: after,
      gateImplementationSha256: implementationHash,
      qualificationScope,
      status,
      statusReason,
    });
  }
  const checkedOutResults = results.filter((result) => result.qualificationScope === 'current-checkout');
  const candidateResults = results.filter((result) => result.qualificationScope === 'candidate-checkout');
  const summarize = (subset) => ({
    total: subset.length,
    passed: subset.filter((result) => result.status === 'PASS').length,
    failed: subset.filter((result) => result.status === 'FAIL').length,
  });
  const artifact = {
    schemaVersion: 3,
    capturedAt: new Date().toISOString(),
    gateImplementationSha256: implementationHash,
    results,
    summary: {
      ...summarize(results),
      currentCheckout: summarize(checkedOutResults),
      candidateCheckout: summarize(candidateResults),
    },
  };
  await writeJson(path.join(artifactDir, 'static-gates.json'), artifact);
  console.log(JSON.stringify(artifact.summary));
}

async function validateReports(artifactDir) {
  const files = [
    'relay-boundary.md',
    'cloud-boundary.md',
    'relayfile-boundary.md',
    'relayfile-cloud-boundary.md',
  ];
  const headings = [
    '## Boundary contract',
    '## Bugs',
    '## Reproductions',
    '## Acceptance gates',
    '## Residual risks',
  ];
  const problems = [];
  for (const file of files) {
    const target = path.join(artifactDir, file);
    if (!(await pathExists(target))) {
      problems.push(`${file}: missing`);
      continue;
    }
    const content = await readFile(target, 'utf8');
    for (const heading of headings) {
      if (!content.includes(heading)) problems.push(`${file}: missing ${heading}`);
    }
    if (!/\bBUG-[A-Z0-9-]+\b/.test(content)) problems.push(`${file}: no BUG-* finding id`);
  }
  if (problems.length) throw new Error(`report validation failed:\n${problems.join('\n')}`);
  console.log(JSON.stringify({ status: 'REPORTS_OK', files }));
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
}

const BLOCKING_SEVERITIES = ['CRITICAL', 'HIGH'];
const BUG_STATUSES = new Set([
  'IDENTIFIED',
  'CONFIRMED',
  'IN_PROGRESS',
  'BLOCKED',
  'CORRECTED',
  'FIXED',
  'VERIFIED',
  'CLOSED',
  'DISMISSED',
  'DUPLICATE',
]);
const TERMINAL_BUG_STATUSES = new Set(['VERIFIED', 'CLOSED', 'DISMISSED', 'DUPLICATE']);
const REPO_ISSUE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*\b/;
export function isPromotionBlockingBug(bug) {
  return BLOCKING_SEVERITIES.includes(bug.severity) && !TERMINAL_BUG_STATUSES.has(bug.status);
}
const BOUNDARY_REPORT_FILES = [
  'relay-boundary.md',
  'cloud-boundary.md',
  'relayfile-boundary.md',
  'relayfile-cloud-boundary.md',
];

async function validateLedger(artifactDir) {
  const target = path.join(artifactDir, 'bug-ledger.json');
  const ledger = JSON.parse(await readFile(target, 'utf8'));
  if (ledger.schemaVersion !== 1) throw new Error('bug ledger schemaVersion must equal 1');
  if (!['RED', 'YELLOW', 'GREEN', 'BLOCKED'].includes(ledger.verdict)) {
    throw new Error('bug ledger verdict is invalid');
  }
  if (!Array.isArray(ledger.bugs) || ledger.bugs.length === 0) {
    throw new Error('bug ledger must contain at least one bug');
  }
  const ids = new Set();
  for (const [index, bug] of ledger.bugs.entries()) {
    const prefix = `bugs[${index}]`;
    // 'owner' is required by the workflow prompt ("Give every finding a
    // stable id, severity, confidence, owner, evidence, ...") but was not
    // enforced here, so all 31 bugs in one prior run omitted it (F10).
    for (const field of [
      'id',
      'title',
      'repo',
      'component',
      'severity',
      'status',
      'confidence',
      'owner',
      'fix',
      'acceptanceGate',
      'releaseGate',
    ]) {
      requireString(bug[field], `${prefix}.${field}`);
    }
    if (!/^BUG-[A-Z0-9_-]+$/.test(bug.id)) throw new Error(`${prefix}.id is invalid`);
    if (ids.has(bug.id)) throw new Error(`duplicate bug id ${bug.id}`);
    ids.add(bug.id);
    if (!BUG_STATUSES.has(bug.status)) throw new Error(`${prefix}.status is invalid: ${bug.status}`);
    if (!Array.isArray(bug.evidence) || bug.evidence.length === 0) {
      throw new Error(`${prefix}.evidence must be non-empty`);
    }
    bug.evidence.forEach((entry, evidenceIndex) =>
      requireString(entry, `${prefix}.evidence[${evidenceIndex}]`)
    );
    if (!Array.isArray(bug.reproduction) || bug.reproduction.length === 0) {
      throw new Error(`${prefix}.reproduction must be non-empty`);
    }
    bug.reproduction.forEach((entry, reproductionIndex) =>
      requireString(entry, `${prefix}.reproduction[${reproductionIndex}]`)
    );
    for (const field of ['gateIds', 'relatedIssues', 'relatedBugIds']) {
      if (!Array.isArray(bug[field])) throw new Error(`${prefix}.${field} must be an array`);
      if (new Set(bug[field]).size !== bug[field].length)
        throw new Error(`${prefix}.${field} must not contain duplicates`);
      bug[field].forEach((entry, entryIndex) => requireString(entry, `${prefix}.${field}[${entryIndex}]`));
    }
    for (const [issueIndex, issue] of bug.relatedIssues.entries()) {
      if (!REPO_ISSUE.test(issue))
        throw new Error(`${prefix}.relatedIssues[${issueIndex}] must start with owner/repo#number`);
    }
  }
  const bugsById = new Map(ledger.bugs.map((bug) => [bug.id, bug]));
  for (const [index, bug] of ledger.bugs.entries()) {
    for (const [relatedIndex, relatedId] of bug.relatedBugIds.entries()) {
      if (relatedId === bug.id || !bugsById.has(relatedId)) {
        throw new Error(`bugs[${index}].relatedBugIds[${relatedIndex}] references an invalid bug id`);
      }
    }
  }
  if (!Array.isArray(ledger.unknowns)) throw new Error('unknowns must be an array');
  const unknownIds = new Set();
  for (const [index, unknown] of ledger.unknowns.entries()) {
    const prefix = `unknowns[${index}]`;
    for (const field of ['id', 'title', 'description', 'impact', 'owner', 'investigation']) {
      requireString(unknown[field], `${prefix}.${field}`);
    }
    if (!/^UNKNOWN-[A-Z0-9_-]+$/.test(unknown.id)) throw new Error(`${prefix}.id is invalid`);
    if (unknownIds.has(unknown.id)) throw new Error(`duplicate unknown id ${unknown.id}`);
    unknownIds.add(unknown.id);
    if (typeof unknown.blocksPromotion !== 'boolean') {
      throw new Error(`${prefix}.blocksPromotion must be boolean`);
    }
    if (!Array.isArray(unknown.blockingBugIds)) {
      throw new Error(`${prefix}.blockingBugIds must be an array`);
    }
    unknown.blockingBugIds.forEach((bugId, bugIndex) => {
      requireString(bugId, `${prefix}.blockingBugIds[${bugIndex}]`);
      if (!bugsById.has(bugId)) {
        throw new Error(`${prefix}.blockingBugIds[${bugIndex}] references missing bug id ${bugId}`);
      }
    });
    if (!Array.isArray(unknown.gateIds)) throw new Error(`${prefix}.gateIds must be an array`);
    if (new Set(unknown.gateIds).size !== unknown.gateIds.length)
      throw new Error(`${prefix}.gateIds must not contain duplicates`);
    unknown.gateIds.forEach((gateId, gateIndex) => requireString(gateId, `${prefix}.gateIds[${gateIndex}]`));
  }
  if (!ledger.releaseQualification || typeof ledger.releaseQualification !== 'object') {
    throw new Error('releaseQualification is required');
  }
  const promotionBlockingUnknownIds = ledger.releaseQualification.promotionBlockingUnknownIds;
  if (!Array.isArray(promotionBlockingUnknownIds)) {
    throw new Error('releaseQualification.promotionBlockingUnknownIds must be an array');
  }
  const promotionBlockingUnknownIdSet = new Set();
  promotionBlockingUnknownIds.forEach((unknownId, index) => {
    requireString(unknownId, `releaseQualification.promotionBlockingUnknownIds[${index}]`);
    if (!unknownIds.has(unknownId)) {
      throw new Error(
        `releaseQualification.promotionBlockingUnknownIds[${index}] references missing unknown id ${unknownId}`
      );
    }
    promotionBlockingUnknownIdSet.add(unknownId);
  });
  const unknownsBlockingPromotion = ledger.unknowns
    .filter((unknown) => unknown.blocksPromotion === true)
    .map((unknown) => unknown.id);
  const missingPromotionBlockingUnknowns = unknownsBlockingPromotion.filter(
    (unknownId) => !promotionBlockingUnknownIdSet.has(unknownId)
  );
  if (missingPromotionBlockingUnknowns.length) {
    throw new Error(
      `unknowns marked blocksPromotion are missing from releaseQualification.promotionBlockingUnknownIds: ${missingPromotionBlockingUnknowns.join(', ')}`
    );
  }
  const listedButNotBlocking = promotionBlockingUnknownIds.filter((unknownId) => {
    const unknown = ledger.unknowns.find((entry) => entry.id === unknownId);
    return unknown?.blocksPromotion !== true;
  });
  if (listedButNotBlocking.length) {
    throw new Error(
      `releaseQualification.promotionBlockingUnknownIds includes unknowns not marked blocksPromotion: ${listedButNotBlocking.join(', ')}`
    );
  }

  // F12: the ledger's own severity histogram must be computed, not
  // hand-typed prose that can silently drift from the actual bug list.
  const computedSeverityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const bug of ledger.bugs) {
    if (!(bug.severity in computedSeverityCounts))
      throw new Error(`bugs[].severity has unknown value ${bug.severity}`);
    computedSeverityCounts[bug.severity] += 1;
  }
  if (!ledger.severityCounts || typeof ledger.severityCounts !== 'object') {
    throw new Error('ledger.severityCounts is required (computed histogram, prevents summary miscounts)');
  }
  for (const key of Object.keys(computedSeverityCounts)) {
    if (ledger.severityCounts[key] !== computedSeverityCounts[key]) {
      throw new Error(
        `ledger.severityCounts.${key} is ${ledger.severityCounts[key]}, but ${computedSeverityCounts[key]} bugs actually carry severity ${key}`
      );
    }
  }

  // F11: every open CRITICAL/HIGH bug must be in the machine-readable
  // promotion blocker list, not just described in prose.
  const forbidden = ledger.releaseQualification.promotionForbiddenUntilFixed;
  if (!Array.isArray(forbidden))
    throw new Error('releaseQualification.promotionForbiddenUntilFixed must be an array');
  const forbiddenIds = new Set();
  forbidden.forEach((entry, index) => {
    requireString(entry?.bugId, `promotionForbiddenUntilFixed[${index}].bugId`);
    requireString(entry?.severity, `promotionForbiddenUntilFixed[${index}].severity`);
    requireString(entry?.reason, `promotionForbiddenUntilFixed[${index}].reason`);
    const bug = bugsById.get(entry.bugId);
    if (!bug) throw new Error(`promotionForbiddenUntilFixed[${index}] references missing bug`);
    if (entry.severity !== bug.severity)
      throw new Error(`promotionForbiddenUntilFixed[${index}] severity disagrees with ${bug.id}`);
    if (forbiddenIds.has(entry.bugId))
      throw new Error(`promotionForbiddenUntilFixed contains duplicate ${entry.bugId}`);
    forbiddenIds.add(entry.bugId);
  });
  const missingFromForbidden = ledger.bugs
    .filter(isPromotionBlockingBug)
    .map((bug) => bug.id)
    .filter((id) => !forbiddenIds.has(id));
  if (missingFromForbidden.length) {
    throw new Error(
      `unresolved CRITICAL/HIGH bugs missing from releaseQualification.promotionForbiddenUntilFixed: ${missingFromForbidden.join(', ')}`
    );
  }

  // Review findings tied two Cloud bugs to the wrong implementation module.
  // Keep the structured routing fields aligned with the residual code path
  // named in the bug body, so repair work cannot be dispatched to the wrong
  // file while the prose says otherwise.
  const launchWorkerClassificationGap = bugsById.get('BUG-CLOUD-LAUNCH-WORKER-ERROR-CLASSIFICATION-GAP');
  if (launchWorkerClassificationGap) {
    if (!/launch-worker/i.test(launchWorkerClassificationGap.component)) {
      throw new Error(
        'BUG-CLOUD-LAUNCH-WORKER-ERROR-CLASSIFICATION-GAP.component must point at launch-worker'
      );
    }
    if (!/launch-worker/i.test(launchWorkerClassificationGap.releaseGate)) {
      throw new Error(
        'BUG-CLOUD-LAUNCH-WORKER-ERROR-CLASSIFICATION-GAP.releaseGate must name the launch-worker suite'
      );
    }
  }
  const aclReadbackGap = bugsById.get('BUG-CLOUD-RELAYFILE-ACL-PUT-NO-READBACK-VERIFICATION');
  if (aclReadbackGap) {
    if (
      !/relay-workspaces/i.test(aclReadbackGap.component) ||
      /launch-runner/i.test(aclReadbackGap.component)
    ) {
      throw new Error(
        'BUG-CLOUD-RELAYFILE-ACL-PUT-NO-READBACK-VERIFICATION.component must point at relay-workspaces, not launch-runner'
      );
    }
    if (
      !/relay-workspaces/i.test(aclReadbackGap.releaseGate) ||
      /launch-runner/i.test(aclReadbackGap.releaseGate)
    ) {
      throw new Error(
        'BUG-CLOUD-RELAYFILE-ACL-PUT-NO-READBACK-VERIFICATION.releaseGate must name relay-workspaces, not launch-runner'
      );
    }
  }

  const staleImageBug = bugsById.get('BUG-CLOUD-DAYTONA-SNAPSHOT-STALE-IMAGE-MISMATCH');
  if (staleImageBug) {
    const staleImageText = [...staleImageBug.evidence, ...staleImageBug.reproduction].join('\n');
    const contradictionPatterns = [
      /Before this fix, no bug id, static gate, or promotionForbiddenUntilFixed entry existed/i,
      /contains no version, image, or snapshot assertion of any kind/i,
      /Confirm no static gate or promotionForbiddenUntilFixed entry blocks promotion/i,
    ];
    for (const pattern of contradictionPatterns) {
      if (pattern.test(staleImageText)) {
        throw new Error(
          'BUG-CLOUD-DAYTONA-SNAPSHOT-STALE-IMAGE-MISMATCH still contains pre-fix contradiction text about missing gates or promotion blockers'
        );
      }
    }
  }

  // F8: qualification evidence captured on an image other than the release
  // under test must be flagged with a first-class bug, not left as prose.
  const imageVersions = ledger.releaseQualification.independentlyVerifiedImageVersions;
  if (!Array.isArray(imageVersions) || imageVersions.length === 0) {
    throw new Error('releaseQualification.independentlyVerifiedImageVersions must be a non-empty array');
  }
  for (const [index, entry] of imageVersions.entries()) {
    for (const field of ['image', 'pinnedVersion', 'correspondingReleaseCommit', 'discrepancyRisk']) {
      requireString(entry[field], `independentlyVerifiedImageVersions[${index}].${field}`);
    }
    if (/^HIGH|^CRITICAL/i.test(entry.discrepancyRisk)) {
      const flagged = ledger.bugs.find(
        (bug) => forbiddenIds.has(bug.id) && /stale|snapshot/i.test(`${bug.title} ${bug.evidence.join(' ')}`)
      );
      if (!flagged) {
        throw new Error(
          `independentlyVerifiedImageVersions[${index}] reports a ${entry.discrepancyRisk.split(':')[0]} discrepancy but no promotion-blocking bug documents it`
        );
      }
    }
    if (/^[0-9a-f]{7,40}$/i.test(entry.correspondingReleaseCommit)) {
      const packageAtCommit = await git(RELAY_ROOT, [
        'show',
        `${entry.correspondingReleaseCommit}:package.json`,
      ]);
      let versionAtCommit;
      try {
        versionAtCommit = JSON.parse(packageAtCommit.stdout).version;
      } catch {
        // The structured error below covers a missing commit, missing file,
        // truncated output, or invalid package metadata without trusting prose.
      }
      if (
        packageAtCommit.exitCode !== 0 ||
        packageAtCommit.stdoutTruncated ||
        versionAtCommit !== entry.pinnedVersion
      ) {
        throw new Error(
          `independentlyVerifiedImageVersions[${index}].correspondingReleaseCommit does not contain package version ${entry.pinnedVersion}`
        );
      }
    }
  }
  const fleetMatrix = ledger.releaseQualification.fleetMatrix;
  if (fleetMatrix && Array.isArray(fleetMatrix.testCases)) {
    fleetMatrix.testCases.forEach((testCase, index) =>
      requireString(testCase.imageVersion, `fleetMatrix.testCases[${index}].imageVersion`)
    );
  }
  const freshAttempts = ledger.releaseQualification.daytonaTwoFreshAttempts;
  if (Array.isArray(freshAttempts)) {
    freshAttempts.forEach((attempt, index) =>
      requireString(attempt.imageVersion, `daytonaTwoFreshAttempts[${index}].imageVersion`)
    );
  }

  // F8: the stale-image guard previously only fired when the ledger ITSELF
  // wrote a matching discrepancyRisk string ("HIGH..."/"CRITICAL..."), so it
  // never actually compared the captured imageVersion against the release
  // under qualification -- a future ledger could self-declare "LOW risk" on
  // a stale image and pass unnoticed. Compute the comparison and require
  // every mismatched fleetMatrix/daytonaTwoFreshAttempts entry to carry an
  // explicit qualifies:false quarantine flag plus a non-empty note, rather
  // than trusting a self-declared risk string alone.
  const relayPackageJson = JSON.parse(await readFile(path.join(RELAY_ROOT, 'package.json'), 'utf8'));
  const releaseVersionUnderQualification =
    ledger.releaseQualification.targetReleaseVersion ?? relayPackageJson.version;
  requireString(
    releaseVersionUnderQualification,
    'releaseQualification.targetReleaseVersion (or relay package.json "version")'
  );
  const HEX_SHA = /^[0-9a-f]{7,40}$/i;
  const promotionEligible =
    ledger.verdict === 'GREEN' || ledger.releaseQualification.promotionProhibited === false;
  // This command certifies diagnosis capture only. A release attestation verifier
  // is not implemented here; never turn metadata/prose into release approval.
  // See release-contract.json and BLOCKED_NO_COMMIT.md for the missing verifier.
  if (promotionEligible) {
    throw new Error(
      'diagnosis-only gate cannot certify GREEN or release eligibility; independent release provenance and complete runtime qualification verifier required'
    );
  }
  if (ledger.releaseQualification.promotionProhibited !== true) {
    throw new Error('diagnosis capture must explicitly prohibit promotion');
  }
  for (const [index, entry] of imageVersions.entries()) {
    const pinMismatch = entry.pinnedVersion !== releaseVersionUnderQualification;
    if (promotionEligible) {
      if (pinMismatch) {
        throw new Error(
          `independentlyVerifiedImageVersions[${index}] pins ${entry.pinnedVersion}, but promotion-eligible diagnoses must match the release under qualification (${releaseVersionUnderQualification})`
        );
      }
      if (!HEX_SHA.test(entry.correspondingReleaseCommit)) {
        throw new Error(
          `independentlyVerifiedImageVersions[${index}].correspondingReleaseCommit must be a 7-40 character hex SHA before a diagnosis can be GREEN or promotion-eligible`
        );
      }
    } else if (
      pinMismatch &&
      !HEX_SHA.test(entry.correspondingReleaseCommit) &&
      !/^HIGH|^CRITICAL/i.test(entry.discrepancyRisk)
    ) {
      throw new Error(
        `independentlyVerifiedImageVersions[${index}] pins ${entry.pinnedVersion} against release ${releaseVersionUnderQualification} with an unverifiable correspondingReleaseCommit ("${entry.correspondingReleaseCommit}") and a discrepancyRisk that is not HIGH/CRITICAL`
      );
    }
  }
  function requireQuarantineIfMismatched(entries, label, noteField) {
    entries.forEach((entry, index) => {
      if (entry.imageVersion === releaseVersionUnderQualification) return;
      if (entry.qualifies !== false) {
        throw new Error(
          `${label}[${index}].imageVersion (${entry.imageVersion}) does not match the release under qualification (${releaseVersionUnderQualification}), but qualifies is not explicitly set to false`
        );
      }
      requireString(entry[noteField], `${label}[${index}].${noteField} (required when qualifies is false)`);
    });
  }
  if (fleetMatrix && Array.isArray(fleetMatrix.testCases)) {
    requireQuarantineIfMismatched(fleetMatrix.testCases, 'fleetMatrix.testCases', 'imageVersionNote');
  }
  if (Array.isArray(freshAttempts)) {
    requireQuarantineIfMismatched(freshAttempts, 'daytonaTwoFreshAttempts', 'imageVersionNote');
  }
  if (promotionEligible && unknownsBlockingPromotion.length) {
    throw new Error(
      `diagnosis cannot be GREEN or promotion-eligible while blocking unknowns remain open: ${unknownsBlockingPromotion.join(', ')}`
    );
  }

  await validateCleanupEvidence(ledger);
  console.log(
    JSON.stringify({ status: 'LEDGER_OK', bugs: ledger.bugs.length, unknowns: ledger.unknowns.length })
  );
  return ledger;
}

// F9: every bug id mentioned in a boundary report must
// resolve to a ledger bug id, or be explicitly carried in
// ledger.reconciliation as mergedInto/dismissed with a target or reason.
// Otherwise a HIGH/CONFIRMED finding can vanish between synthesis steps with
// nothing detecting the loss (this happened to BUG-RELAYFILE-CLOUD-MOUNT-FLUSH-NON-FATAL).
async function reconcileBoundaryFindings(artifactDir, ledger) {
  const ledgerIds = new Set(ledger.bugs.map((bug) => bug.id));
  const reconciliation = ledger.reconciliation ?? {};
  const problems = [];
  for (const file of BOUNDARY_REPORT_FILES) {
    const target = path.join(artifactDir, file);
    if (!(await pathExists(target))) continue;
    const content = await readFile(target, 'utf8');
    const reportIds = new Set([...content.matchAll(/\bBUG-[A-Z0-9_-]+\b/g)].map((match) => match[0]));
    for (const id of reportIds) {
      const carried = ledgerIds.has(id);
      const reconciled = reconciliation[id] && (reconciliation[id].target || reconciliation[id].reason);
      if (!carried && !reconciled) {
        problems.push(`${file}: ${id} is filed but absent from bug-ledger.json and unreconciled`);
      }
    }
  }
  if (problems.length) throw new Error(`boundary-report reconciliation failed:\n${problems.join('\n')}`);
  console.log(JSON.stringify({ status: 'RECONCILIATION_OK' }));
}

async function validateCleanupEvidence(ledger) {
  const inventory = ledger.releaseQualification.cleanupInventory;
  if (!inventory) throw new Error('cleanup inventory required');
  const gap = ledger.unknowns.find((u) => u.id === 'UNKNOWN-CLEANUP-TIMESTAMPED-INVENTORY');
  const ambient = inventory.historicalAmbient;
  if (!ambient || ambient.ownedByInvestigation !== false || ambient.currentState !== 'UNKNOWN')
    throw new Error('historical ambient inventory must not be classified as investigation-owned or current');
  if (ambient.total !== ambient.started + ambient.stopped)
    throw new Error('ambient inventory count mismatch');
  const board = inventory.manualBoard;
  const ids = board?.ownedSandboxIds;
  if (
    !Array.isArray(ids) ||
    ids.length !== 4 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-f0-9-]{36}$/.test(id))
  )
    throw new Error('manual cleanup requires four unique exact owned sandbox IDs');
  const baseline = await readFile(
    path.join(RELAY_ROOT, 'tests/relayflows/cleanroom/FLEET_DAYTONA_MANUAL_2026-09-04.md'),
    'utf8'
  );
  if (ids.some((id) => !baseline.includes(id)))
    throw new Error('owned sandbox ID lacks durable baseline evidence');
  if (board.finalStatus !== 'ALL_DELETED' || board.baselineCount !== 100 || board.finalCount !== 100)
    throw new Error('manual final cleanup contradicts durable baseline');
  if (board.cpuDelta !== null || board.baselineTimestamp !== null || board.finalTimestamp !== null)
    throw new Error(
      'historical timestamp/CPU attribution requires new independently captured inventory; none exists in durable baseline'
    );
  if (!gap?.blocksPromotion) throw new Error('missing timestamped inventory must remain a blocking unknown');
  const repeated = inventory.repeatedHardenedBoards;
  if (
    repeated?.identityCleanupSloPassed !== false ||
    repeated.identityCleanupSloSeconds !== 120 ||
    repeated.eventualIdentityCleanup !== 'ALL_EXACT_OWNED_IDENTITIES_ABSENT' ||
    !Number.isInteger(repeated.postCleanupRosterCensusRecords) ||
    repeated.postCleanupRosterCensusRecords < 0 ||
    !(
      repeated.eventualIdentityCleanupLatencySeconds === null ||
      (Number.isFinite(repeated.eventualIdentityCleanupLatencySeconds) &&
        repeated.eventualIdentityCleanupLatencySeconds > repeated.identityCleanupSloSeconds)
    )
  )
    throw new Error('eventual identity absence cannot erase failed 120s cleanup SLO');
  if (inventory.cancelledRuns?.status !== 'MANUALLY_CANCELLED')
    throw new Error('historical cancelled runs must not be classified as pending');
  if (
    !Array.isArray(inventory.outstandingOwnedResources) ||
    inventory.outstandingOwnedResources.length ||
    ledger.releaseQualification.cleanupRequired?.length
  )
    throw new Error(
      'no evidenced outstanding investigation resources: require a fresh ownership inventory before marking resources outstanding'
    );
}

function assertExactIds(rows, expected, label) {
  if (!Array.isArray(rows)) throw new Error(`${label}: missing results`);
  const ids = rows.map((r) => r.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== expected.length ||
    expected.some((id) => !ids.includes(id))
  ) {
    throw new Error(`${label}: missing, unexpected or duplicate IDs`);
  }
}

async function validateStaticEvidence(artifact, ledger, checkProvenance = true) {
  if (artifact.schemaVersion !== 3) throw new Error('static gate schemaVersion must equal 3');
  const specs = gateSpecs();
  assertExactIds(
    artifact.results,
    specs.map((s) => s.id),
    'static gate inventory'
  );
  const failed = [];
  for (const result of artifact.results) {
    const spec = specs.find((s) => s.id === result.id);
    if (
      !Number.isFinite(result.durationMs) ||
      result.durationMs < 0 ||
      !Number.isFinite(Date.parse(result.startedAt)) ||
      typeof result.timedOut !== 'boolean' ||
      typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string' ||
      !Number.isInteger(result.stdoutBytes) ||
      result.stdoutBytes < 0 ||
      !Number.isInteger(result.stderrBytes) ||
      result.stderrBytes < 0 ||
      typeof result.stdoutTruncated !== 'boolean' ||
      typeof result.stderrTruncated !== 'boolean' ||
      !(result.exitCode === null || Number.isInteger(result.exitCode)) ||
      !(result.signal === null || typeof result.signal === 'string') ||
      !(result.error === null || typeof result.error === 'string')
    )
      throw new Error(`${result.id}: invalid execution record`);
    if (
      JSON.stringify(result.command) !== JSON.stringify([spec.command, ...spec.args]) ||
      result.cwd !== spec.cwd
    )
      throw new Error(`${result.id}: wrong command or cwd`);
    let failure =
      result.exitCode !== 0 ||
      result.timedOut ||
      result.stdoutTruncated ||
      result.stderrTruncated ||
      Boolean(result.signal) ||
      Boolean(result.error) ||
      Boolean(result.statusReason);
    const expected = countRequestedTestFiles(spec.args);
    if (
      expected &&
      spec.args.some((arg) => arg.includes('vitest')) &&
      parseVitestFileTotal(result.stdout) !== expected
    )
      failure = true;
    if (
      result.id === 'relayfile-candidate-pinning-test' &&
      !/--- PASS: TestMirrorStateWriteKeepsMountsyncFields/.test(result.stdout)
    )
      failure = true;
    if (result.status !== (failure ? 'FAIL' : 'PASS'))
      throw new Error(`${result.id}: status contradicts execution`);
    if (failure) failed.push(result.id);
    if (checkProvenance) {
      if (result.qualificationScope !== (spec.isCandidateGate ? 'candidate-checkout' : 'current-checkout'))
        throw new Error(`${result.id}: incorrect checkout qualification scope`);
      if (
        !result.resolvedHead ||
        !result.sourceBefore?.contentSha256 ||
        !result.sourceAfter?.contentSha256 ||
        result.sourceBefore.head !== result.resolvedHead ||
        result.sourceAfter.head !== result.resolvedHead ||
        result.sourceBefore.contentSha256 !== result.sourceAfter.contentSha256
      )
        throw new Error(`${result.id}: missing or changing source provenance`);
      const current = await snapshotRepo(spec.id, spec.cwd);
      if (current.head !== result.resolvedHead || current.contentSha256 !== result.sourceAfter.contentSha256)
        throw new Error(`${result.id}: source contents drifted`);
      if (result.gateImplementationSha256 !== (await gateImplementationHash()))
        throw new Error(`${result.id}: gate implementation drifted`);
    }
  }
  const summarize = (rows) => ({
    total: rows.length,
    passed: rows.filter((r) => r.status === 'PASS').length,
    failed: rows.filter((r) => r.status === 'FAIL').length,
  });
  const expectedSummary = {
    ...summarize(artifact.results),
    currentCheckout: summarize(artifact.results.filter((r) => r.qualificationScope === 'current-checkout')),
    candidateCheckout: summarize(
      artifact.results.filter((r) => r.qualificationScope === 'candidate-checkout')
    ),
  };
  for (const key of ['total', 'passed', 'failed'])
    if (artifact.summary?.[key] !== expectedSummary[key]) throw new Error(`static summary mismatch: ${key}`);
  if (checkProvenance) {
    for (const group of ['currentCheckout', 'candidateCheckout'])
      for (const key of ['total', 'passed', 'failed'])
        if (artifact.summary?.[group]?.[key] !== expectedSummary[group][key])
          throw new Error(`static summary mismatch: ${group}.${key}`);
    if (artifact.gateImplementationSha256 !== (await gateImplementationHash()))
      throw new Error('static artifact gate hash drifted');
  }
  const uncovered = failed.filter(
    (id) =>
      ![...ledger.bugs, ...ledger.unknowns].some(
        (entry) => Array.isArray(entry.gateIds) && entry.gateIds.includes(id)
      )
  );
  if (uncovered.length)
    throw new Error(
      `static gates failed with no structured bug/unknown gateIds coverage: ${uncovered.join(', ')}`
    );
  return { status: 'STATIC_EVIDENCE_OK', total: specs.length, failed: failed.length };
}

const REQUIRED_TRANSITIONS = [
  'persist',
  'enqueue',
  'delivery',
  'claim',
  'create',
  'ownership',
  'mount',
  'enroll',
  'spawn',
  'inject',
  'release',
  'reclaim',
];
const REQUIRED_FAULTS = [
  'enqueue-failure',
  'never-claimed',
  'duplicate-restart',
  'quota-before-after-create',
  'disconnect-timeout',
  'acl-get-put-body-stall',
  'acl-network-timeout',
  'acl-429-retry-after',
  'acl-5xx',
  'acl-permanent-4xx',
  'acl-ambiguous-put',
  'acl-concurrent-principal',
  'acl-deadline',
  'acl-secret-body',
  'websocket-failure',
  'oversized-checkpoint-reset',
  'cancel-create-mount-enroll',
  'release-during-spawn',
  'cleanup-reconcile',
  'deployed-reaper-dlq',
  'attach-503',
  'image-smoke',
  'broker-timeout-cleanup',
];
const REQUIRED_ACCEPTANCE = [
  'image-smoke',
  'clean-build',
  'zero-one-agent',
  'scoped-mount-injection',
  'no-mount',
  'oversized-containment',
  'owned-cleanup',
  'five-lifecycles',
  'full-cleanroom',
  'independent-review',
  'full-root-scale',
  'fleet-95-operations',
  'flush-fatal-deployment',
];
const DIAGNOSIS_SEAL_FILES = [
  'context.json',
  'relay-boundary.md',
  'cloud-boundary.md',
  'relayfile-boundary.md',
  'relayfile-cloud-boundary.md',
  'static-gates.json',
  'bug-ledger.json',
  'coverage-contract.json',
];
async function validateCoverage(artifactDir, ledger) {
  const c = JSON.parse(await readFile(path.join(artifactDir, 'coverage-contract.json'), 'utf8'));
  if (c.schemaVersion !== 1 || c.kind !== 'relay-orchestration-coverage' || c.mode !== 'diagnosis') {
    throw new Error('coverage contract must be schemaVersion 1, relay-orchestration-coverage, diagnosis');
  }
  const requiredFields = [
    'owner',
    'component',
    'bindingConfiguration',
    'timeout',
    'idempotency',
    'terminalState',
    'cleanupOwner',
    'evidence',
    'fixture',
    'conditions',
  ];
  const coverageRows = [];
  const validateBlockedRow = (item, label) => {
    for (const field of requiredFields) requireString(item[field], `${label}.${item.id}.${field}`);
    if (item.status !== 'BLOCKED') {
      throw new Error(
        `${item.id}: diagnosis mode cannot mark runtime coverage ${JSON.stringify(item.status)}`
      );
    }
    requireString(item.blockingUnknownId, `${label}.${item.id}.blockingUnknownId`);
    const unknown = ledger.unknowns.find((entry) => entry.id === item.blockingUnknownId);
    if (!unknown?.blocksPromotion || !(unknown.gateIds ?? []).includes(item.id)) {
      throw new Error(`${item.id}: missing bidirectional owned blocking gap`);
    }
    coverageRows.push(item);
  };
  for (const [group, inventory] of [
    ['transitions', REQUIRED_TRANSITIONS],
    ['faults', REQUIRED_FAULTS],
    ['acceptance', REQUIRED_ACCEPTANCE],
  ]) {
    assertExactIds(c[group], inventory, group);
    for (const item of c[group]) validateBlockedRow(item, group);
  }
  const matrix = JSON.parse(
    await readFile(path.join(RELAY_ROOT, 'tests/relayflows/cleanroom/fleet-daytona.matrix.json'), 'utf8')
  );
  assertExactIds(
    c.fleetOperations,
    matrix.operations.map((o) => o.id),
    'Fleet operation coverage'
  );
  for (const operation of c.fleetOperations) {
    validateBlockedRow(operation, 'fleetOperations');
    const matrixOperation = matrix.operations.find((entry) => entry.id === operation.id);
    if (
      operation.matrixContract?.id !== matrixOperation.id ||
      operation.matrixContract?.group !== matrixOperation.group ||
      operation.matrixContract?.expect !== matrixOperation.expect
    ) {
      throw new Error(`${operation.id}: Fleet matrix contract mismatch`);
    }
  }
  const coverageIds = new Set(coverageRows.map((row) => row.id));
  if (coverageIds.size !== 143 || coverageRows.length !== 143) {
    throw new Error(`coverage contract must contain exactly 143 unique rows, got ${coverageRows.length}`);
  }
  for (const unknown of ledger.unknowns) {
    for (const gateId of unknown.gateIds ?? []) {
      if (coverageIds.has(gateId)) {
        const row = coverageRows.find((entry) => entry.id === gateId);
        if (row?.blockingUnknownId !== unknown.id) {
          throw new Error(`${unknown.id}/${gateId}: coverage mapping is not bidirectional`);
        }
      }
    }
  }
  console.log(
    JSON.stringify({
      status: 'COVERAGE_CONTRACT_OK',
      transitions: c.transitions.length,
      faults: c.faults.length,
      acceptance: c.acceptance.length,
      fleetOperations: c.fleetOperations.length,
      runtimeQualified: false,
    })
  );
}

async function diagnosisSealPayload(artifactDir) {
  for (const required of DIAGNOSIS_SEAL_FILES) {
    if (!(await pathExists(path.join(artifactDir, required)))) {
      throw new Error(`diagnosis seal required file is missing: ${required}`);
    }
  }
  const excluded = new Set([
    'diagnosis-seal.json',
    'diagnosis-final-claude.json',
    'diagnosis-final-codex.json',
    'campaign-summary.json',
  ]);
  const names = (await readdir(artifactDir, { recursive: true }))
    .map((name) => String(name).split(path.sep).join('/'))
    .filter((name) => !excluded.has(name))
    .sort();
  const files = [];
  for (const name of names) {
    const target = path.join(artifactDir, name);
    const info = await lstat(target);
    if (info.isDirectory()) continue;
    const { bytes } = await readRegularFileNoFollow(target, {
      label: `diagnosis seal artifact ${name}`,
    });
    files.push({ name, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  const gateImplementationSha256 = await gateImplementationHash();
  return {
    schemaVersion: 1,
    kind: 'relay-orchestration-diagnosis-seal',
    files,
    gateImplementationSha256,
    artifactSetSha256: sha256(JSON.stringify({ files, gateImplementationSha256 })),
  };
}

async function validateContextProvenance(artifactDir) {
  const context = JSON.parse(await readFile(path.join(artifactDir, 'context.json'), 'utf8'));
  const currentRepos = await Promise.all(context.repos.map((repo) => snapshotRepo(repo.name, repo.path)));
  const drift = [];
  for (const before of context.repos) {
    const after = currentRepos.find((repo) => repo.name === before.name);
    if (
      !before.contentSha256 ||
      !after?.contentSha256 ||
      before.head !== after.head ||
      before.contentSha256 !== after.contentSha256 ||
      JSON.stringify(before.dirtyPaths) !== JSON.stringify(after.dirtyPaths)
    ) {
      drift.push(before.name);
    }
  }
  if (context.gateImplementationSha256 !== (await gateImplementationHash())) {
    drift.push('gate implementation');
  }
  if (drift.length) {
    throw new Error(
      `source evidence missing or drifted (does not establish who changed it): ${drift.join(', ')}`
    );
  }
  return context;
}

async function sealDiagnosis(artifactDir, runId) {
  const blocked = path.join(artifactDir, 'BLOCKED_NO_COMMIT.md');
  if (await pathExists(blocked)) throw new Error(`blocked artifact exists: ${blocked}`);
  await validateReports(artifactDir);
  const ledger = await validateLedger(artifactDir);
  await reconcileBoundaryFindings(artifactDir, ledger);
  const staticGatesArtifact = JSON.parse(await readFile(path.join(artifactDir, 'static-gates.json'), 'utf8'));
  await validateStaticEvidence(staticGatesArtifact, ledger);
  await validateCoverage(artifactDir, ledger);
  await validateContextProvenance(artifactDir);
  const payload = await diagnosisSealPayload(artifactDir);
  const seal = { ...payload, runId, createdAt: new Date().toISOString() };
  await writeJson(path.join(artifactDir, 'diagnosis-seal.json'), seal);
  console.log(JSON.stringify({ status: 'DIAGNOSIS_SEALED', artifactSetSha256: seal.artifactSetSha256 }));
}

async function validateDiagnosisSeal(artifactDir) {
  const target = path.join(artifactDir, 'diagnosis-seal.json');
  const seal = JSON.parse(await readFile(target, 'utf8'));
  const current = await diagnosisSealPayload(artifactDir);
  if (
    seal.schemaVersion !== current.schemaVersion ||
    seal.kind !== current.kind ||
    seal.gateImplementationSha256 !== current.gateImplementationSha256 ||
    seal.artifactSetSha256 !== current.artifactSetSha256 ||
    JSON.stringify(seal.files) !== JSON.stringify(current.files)
  ) {
    throw new Error('diagnosis seal does not match the current artifact set');
  }
  return seal;
}

async function validateFinalDiagnosisReview(artifactDir, file, role, seal) {
  const review = JSON.parse(await readFile(path.join(artifactDir, file), 'utf8'));
  if (
    review.version !== 1 ||
    review.kind !== 'diagnosis-final-review' ||
    review.role !== role ||
    review.artifactSetSha256 !== seal.artifactSetSha256
  ) {
    throw new Error(`${file} is not bound to the current diagnosis seal`);
  }
  if (review.verdict !== 'pass' || !Array.isArray(review.findings) || review.findings.length !== 0) {
    throw new Error(`${file} does not provide finding-free independent signoff`);
  }
  for (const field of ['evidenceIntegrity', 'coverageAssessment', 'remainingProductRisk']) {
    requireString(review[field], `${file}.${field}`);
  }
  return review;
}

async function accept(artifactDir) {
  await validateReports(artifactDir);
  const ledger = await validateLedger(artifactDir);
  await reconcileBoundaryFindings(artifactDir, ledger);
  const blocked = path.join(artifactDir, 'BLOCKED_NO_COMMIT.md');
  if (await pathExists(blocked)) throw new Error(`blocked artifact exists: ${blocked}`);

  // F3: a failed static gate used to be invisible to accept() entirely.
  // Require the artifact to exist and either be all-green, or have every
  // failed gate id accounted for by a bug or an unknown.
  const staticGatesTarget = path.join(artifactDir, 'static-gates.json');
  if (!(await pathExists(staticGatesTarget))) {
    throw new Error(`static-gates.json is missing; run \`static-gates\` before accept`);
  }
  const staticGatesArtifact = JSON.parse(await readFile(staticGatesTarget, 'utf8'));
  await validateStaticEvidence(staticGatesArtifact, ledger);
  await validateCoverage(artifactDir, ledger);

  const seal = await validateDiagnosisSeal(artifactDir);
  await validateFinalDiagnosisReview(
    artifactDir,
    'diagnosis-final-claude.json',
    'fresh-claude-signoff',
    seal
  );
  await validateFinalDiagnosisReview(artifactDir, 'diagnosis-final-codex.json', 'fresh-codex-signoff', seal);
  await validateContextProvenance(artifactDir);
  await writeJson(path.join(artifactDir, 'campaign-summary.json'), {
    schemaVersion: 1,
    acceptedAt: new Date().toISOString(),
    status: 'DIAGNOSIS_ACCEPTED',
    productVerdict: 'see bug-ledger.json',
    reposUnchanged: true,
  });
  console.log(JSON.stringify({ status: 'DIAGNOSIS_ACCEPTED', artifactDir }));
}

async function main() {
  const action = process.argv[2];
  const artifactDir = path.resolve(readFlag('--artifact', DEFAULT_ARTIFACT_DIR));
  const runId = readFlag('--run-id', process.env.RELAY_RELIABILITY_RUN_ID ?? 'local-diagnosis');
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  if (action === 'preflight') return preflight(artifactDir, runId);
  if (action === 'static-gates') return staticGates(artifactDir);
  if (action === 'validate-reports') return validateReports(artifactDir);
  if (action === 'validate-ledger') return validateLedger(artifactDir);
  if (action === 'validate-coverage') return validateCoverage(artifactDir, await validateLedger(artifactDir));
  if (action === 'validate-static') {
    const ledger = await validateLedger(artifactDir);
    console.log(
      JSON.stringify(
        await validateStaticEvidence(
          JSON.parse(await readFile(path.join(artifactDir, 'static-gates.json'), 'utf8')),
          ledger
        )
      )
    );
    return;
  }
  if (action === 'seal') return sealDiagnosis(artifactDir, runId);
  if (action === 'accept') return accept(artifactDir);
  throw new Error(`unknown action ${JSON.stringify(action)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(redact(error instanceof Error ? (error.stack ?? error.message) : String(error)));
    process.exit(1);
  });
}

export {
  diagnosisSealPayload,
  isRuntimeTelemetryPath,
  snapshotRepo,
  sourceManifest,
  validateDiagnosisSeal,
  validateFinalDiagnosisReview,
};
