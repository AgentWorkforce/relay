import {
  githubIssuePath,
  githubPullRequestPath,
  githubRepoPrefix,
} from '@relayfile/adapter-github/path-mapper';

export function fixtureTitle(runId) {
  return `[DISPOSABLE DEMO ${runId}] GitHub subscriptions`;
}

/** Resolve the same title-based directory that GitHub ingestion writes. */
export function fixturePathGlob(fixture, scope, runId) {
  const [owner, repo, extra] = fixture.repo.split('/');
  if (!owner || !repo || extra || !Number.isSafeInteger(fixture.pr) || fixture.pr < 1)
    throw new Error('A repository and positive fixture PR number are required');
  if (scope === 'repo') return `${githubRepoPrefix(owner, repo)}/**`;
  if (!['issue', 'pr'].includes(scope)) throw new Error('subscriptionScope must be issue, pr or repo');
  const recordPath = (scope === 'pr' ? githubPullRequestPath : githubIssuePath)(
    owner,
    repo,
    fixture.pr,
    fixtureTitle(runId)
  );
  return `${recordPath.slice(0, recordPath.lastIndexOf('/'))}/**`;
}

export function assertProducerWorkspace(expected, actual) {
  if (!expected || expected !== actual)
    throw new Error(
      `Relayfile producer workspace mismatch: expected ${expected || '(unset)'}, got ${actual || '(unset)'}`
    );
}
