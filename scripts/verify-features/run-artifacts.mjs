import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const DEFAULT_COMPLETED_RETENTION = 20;
const DEFAULT_INCOMPLETE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const CANONICAL_FILES = Object.freeze([
  'checks.jsonl',
  'verdict.json',
  'alert-primary-envelope.json',
  'alert-followup-envelope.json',
  'escalation-posthog.json',
  'escalation-github-issue.json',
  'escalation-draft-pr.json',
  'escalation-slack-primary.json',
  'escalation-slack-followup.json',
  'failure-assessment.json',
  'provenance.env',
  'caps.env',
  'autofix.env',
  'issue-url.txt',
  'pr-url.txt',
  'fix-integrity.env',
  'fix-summary.md',
]);

function assertPathSegment(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..' || value.includes('.pruning-')) {
    throw new Error(`${label} must be a single safe path segment`);
  }
}

function ensureRealDirectory(directory, label) {
  try {
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`${label} must be a real directory, not a symlink or non-directory`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      mkdirSync(directory, { recursive: false });
    } catch (mkdirError) {
      if (mkdirError.code !== 'EEXIST') throw mkdirError;
      const metadata = lstatSync(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`${label} must be a real directory, not a symlink or non-directory`);
      }
    }
  }
}

function replaceWithSymlink(linkPath, target, nonce, type, platform = process.platform) {
  const temporaryLink = `${linkPath}.${nonce}.tmp`;
  rmSync(temporaryLink, { force: true });
  try {
    symlinkSync(target, temporaryLink, type);
    // Windows cannot atomically replace an existing symlink with rename.
    // A brief missing latest-run pointer is preferable to making every
    // verifier invocation after the first fail during setup.
    if (platform === 'win32') {
      let lastError;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        rmSync(linkPath, { force: true });
        try {
          renameSync(temporaryLink, linkPath);
          return;
        } catch (error) {
          lastError = error;
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        }
      }
      throw lastError;
    }
    renameSync(temporaryLink, linkPath);
  } finally {
    rmSync(temporaryLink, { force: true });
  }
}

/**
 * Give every verifier invocation private writable state while preserving the
 * historical top-level artifact paths for consumers. The canonical links all
 * point through one `current` symlink, so switching that symlink publishes a
 * whole run atomically on POSIX and through a retrying replacement on Windows;
 * a crashed newest run stays visibly incomplete instead of exposing an older
 * verdict as current.
 */
export function prepareRunArtifacts(root, runId, nonce, { platform = process.platform } = {}) {
  assertPathSegment(runId, 'runId');
  assertPathSegment(nonce, 'nonce');

  const runs = path.join(root, 'runs');
  const artifacts = path.join(runs, runId);
  mkdirSync(root, { recursive: true });
  ensureRealDirectory(runs, 'artifact runs directory');
  mkdirSync(artifacts, { recursive: false });

  for (const file of CANONICAL_FILES) {
    replaceWithSymlink(path.join(root, file), path.posix.join('current', file), nonce, 'file', platform);
  }
  replaceWithSymlink(path.join(root, 'current'), path.posix.join('runs', runId), nonce, 'dir', platform);
  pruneRunArtifacts(root, { currentRunId: runId });
  return artifacts;
}

export function markRunArtifactsComplete(artifacts, runId) {
  assertPathSegment(runId, 'runId');
  writeFileSync(
    path.join(artifacts, '.complete'),
    `${JSON.stringify({ runId, completedAt: new Date().toISOString() })}\n`,
    { flag: 'wx' }
  );
}

/**
 * Retain the newest completed runs and leave every recent incomplete run
 * alone. A directory is eligible for count-based deletion only after its
 * owner writes `.complete`; abandoned incomplete runs get a seven-day grace
 * period. The current canonical target is never removed. Concurrent pruners
 * may select the same immutable completed directory, so ENOENT is benign.
 */
export function pruneRunArtifacts(
  root,
  {
    currentRunId,
    keepCompleted = DEFAULT_COMPLETED_RETENTION,
    incompleteMaxAgeMs = DEFAULT_INCOMPLETE_MAX_AGE_MS,
    now = Date.now(),
  } = {}
) {
  if (currentRunId) assertPathSegment(currentRunId, 'currentRunId');
  if (!Number.isSafeInteger(keepCompleted) || keepCompleted < 1) {
    throw new Error('keepCompleted must be a positive integer');
  }
  if (!Number.isSafeInteger(incompleteMaxAgeMs) || incompleteMaxAgeMs < 0) {
    throw new Error('incompleteMaxAgeMs must be a non-negative integer');
  }
  const runs = path.join(root, 'runs');
  try {
    const metadata = lstatSync(runs);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('artifact runs directory must be a real directory, not a symlink or non-directory');
    }
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  let canonicalRunId;
  try {
    const currentTarget = readlinkSync(path.join(root, 'current'));
    const resolvedTarget = path.resolve(root, currentTarget);
    if (path.dirname(resolvedTarget) === path.resolve(runs)) canonicalRunId = path.basename(resolvedTarget);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let entries;
  let claimedForDeletion;
  try {
    const directories = readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    claimedForDeletion = directories
      .filter((entry) => entry.name.includes('.pruning-'))
      .map((entry) => path.join(runs, entry.name));
    entries = directories.filter((entry) => !entry.name.includes('.pruning-'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const completed = [];
  const abandoned = [];
  for (const entry of entries) {
    if (entry.name === currentRunId || entry.name === canonicalRunId) continue;
    const directory = path.join(runs, entry.name);
    try {
      const completion = statSync(path.join(directory, '.complete'));
      completed.push({ directory, completedAt: completion.mtimeMs });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        if (now - statSync(directory).mtimeMs >= incompleteMaxAgeMs) abandoned.push(directory);
      } catch (directoryError) {
        if (directoryError.code !== 'ENOENT') throw directoryError;
      }
    }
  }

  completed.sort((left, right) => right.completedAt - left.completedAt);
  const targets = [...completed.slice(keepCompleted).map(({ directory }) => directory), ...abandoned];
  const removed = [];
  for (const target of targets) {
    const claimed = `${target}.pruning-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      renameSync(target, claimed);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    removed.push(target);
    rmSync(claimed, { recursive: true, force: true });
  }
  for (const claimed of claimedForDeletion) {
    rmSync(claimed, { recursive: true, force: true });
  }
  return removed;
}
