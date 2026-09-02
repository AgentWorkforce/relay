import { mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

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
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} must be a single safe path segment`);
  }
}

function replaceWithSymlink(linkPath, target, nonce, type) {
  const temporaryLink = `${linkPath}.${nonce}.tmp`;
  rmSync(temporaryLink, { force: true });
  try {
    symlinkSync(target, temporaryLink, type);
    renameSync(temporaryLink, linkPath);
  } finally {
    rmSync(temporaryLink, { force: true });
  }
}

/**
 * Give every verifier invocation private writable state while preserving the
 * historical top-level artifact paths for consumers. The canonical links all
 * point through one `current` symlink, so switching that symlink publishes a
 * whole run atomically; a crashed newest run stays visibly incomplete instead
 * of exposing an older verdict as current.
 */
export function prepareRunArtifacts(root, runId, nonce) {
  assertPathSegment(runId, 'runId');
  assertPathSegment(nonce, 'nonce');

  const runs = path.join(root, 'runs');
  const artifacts = path.join(runs, runId);
  mkdirSync(runs, { recursive: true });
  mkdirSync(artifacts, { recursive: false });

  for (const file of CANONICAL_FILES) {
    replaceWithSymlink(path.join(root, file), path.posix.join('current', file), nonce, 'file');
  }
  replaceWithSymlink(path.join(root, 'current'), path.posix.join('runs', runId), nonce, 'dir');
  return artifacts;
}
