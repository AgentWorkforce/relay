import {
  githubIssuePath,
  githubIssueCommentPath,
  githubPullRequestPath,
  githubRepoPrefix,
  githubReviewPath,
  githubReviewCommentPath,
  githubCheckRunPath,
} from '@relayfile/adapter-github/path-mapper';

export function fixtureExpected(stimulus, record, runId) {
  const [owner, repo, extra] = stimulus.repo.split('/');
  if (!owner || !repo || extra) throw new Error('Invalid fixture repository');
  const id = record.id;
  if (!(typeof id === 'string' && /^\d+$/.test(id)) && !(Number.isSafeInteger(id) && id > 0))
    throw new Error('A lossless provider object ID is required');
  const expected = { id: providerId(id) };
  let canonicalPath;
  switch (stimulus.kind) {
    case 'comment':
      canonicalPath = githubIssueCommentPath(owner, repo, stimulus.pr, id, fixtureTitle(runId));
      expected.issue_url = `https://api.github.com/repos/${stimulus.repo}/issues/${stimulus.pr}`;
      break;
    case 'review':
      canonicalPath = githubReviewPath(owner, repo, id);
      expected.pull_request_url = `https://api.github.com/repos/${stimulus.repo}/pulls/${stimulus.pr}`;
      expected.state = 'commented';
      expected.commit_id = stimulus.headSha;
      expected.submitted_at = record.submitted_at;
      break;
    case 'thread':
      canonicalPath = githubReviewCommentPath(owner, repo, id);
      expected.pull_request_url = `https://api.github.com/repos/${stimulus.repo}/pulls/${stimulus.pr}`;
      expected.commit_id = stimulus.headSha;
      expected.path = stimulus.file;
      expected.line = stimulus.line;
      expected.side = stimulus.side;
      expected.pull_request_review_id = providerId(record.pull_request_review_id);
      break;
    case 'merge':
      canonicalPath = githubPullRequestPath(owner, repo, stimulus.pr, fixtureTitle(runId));
      expected.number = stimulus.pr;
      expected.merged = true;
      expected.merge_commit_sha = record.merge_commit_sha;
      expected.head = { sha: stimulus.headSha };
      expected.base = { ref: stimulus.base };
      break;
    case 'ci':
      canonicalPath = githubCheckRunPath(owner, repo, id);
      expected.head_sha = stimulus.headSha;
      expected.name = record.name;
      expected.status = 'completed';
      expected.conclusion = 'success';
      expected.app = { slug: 'github-actions' };
      break;
    default:
      throw new Error('Unknown provider event kind');
  }
  if (stimulus.kind !== 'ci') expected.user = { login: record.user?.login };
  function complete(value) {
    if (value === undefined || value === null || value === '' || value === 'undefined') return false;
    return typeof value !== 'object' || Object.values(value).every(complete);
  }
  if (!complete(expected)) throw new Error('Incomplete provider fixture identity');
  validateFields(stimulus, expected);
  return { path: canonicalPath, record: expected, runId };
}

function providerId(value) {
  if ((typeof value === 'string' && /^[1-9]\d*$/.test(value)) || (Number.isSafeInteger(value) && value > 0))
    return String(value);
  throw new Error('Incomplete or non-lossless provider association ID');
}

function validateFields(stimulus, record) {
  const text = (value) => typeof value === 'string' && value.trim().length > 0;
  const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  const require = (condition) => {
    if (!condition) throw new Error('Incomplete or invalid provider fixture schema');
  };
  require(typeof stimulus.repo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(stimulus.repo));
  require(Number.isSafeInteger(stimulus.pr) && stimulus.pr > 0);
  providerId(record.id);
  if (stimulus.kind !== 'ci') require(text(record.user?.login));
  if (stimulus.kind !== 'comment') require(sha(stimulus.headSha));
  switch (stimulus.kind) {
    case 'comment':
      require(record.issue_url === `https://api.github.com/repos/${stimulus.repo}/issues/${stimulus.pr}`);
      break;
    case 'review':
      require(
        record.pull_request_url === `https://api.github.com/repos/${stimulus.repo}/pulls/${stimulus.pr}`
      );
      require(record.state === 'commented' && record.commit_id === stimulus.headSha);
      require(
        typeof record.submitted_at === 'string' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(record.submitted_at) &&
          Number.isFinite(Date.parse(record.submitted_at))
      );
      break;
    case 'thread':
      require(
        record.pull_request_url === `https://api.github.com/repos/${stimulus.repo}/pulls/${stimulus.pr}`
      );
      require(record.commit_id === stimulus.headSha && text(stimulus.file) && record.path === stimulus.file);
      require(Number.isSafeInteger(stimulus.line) && stimulus.line > 0 && record.line === stimulus.line);
      require(['LEFT', 'RIGHT'].includes(stimulus.side) && record.side === stimulus.side);
      providerId(record.pull_request_review_id);
      break;
    case 'merge':
      require(record.number === stimulus.pr && record.merged === true && sha(record.merge_commit_sha));
      require(
        record.head?.sha === stimulus.headSha && text(stimulus.base) && record.base?.ref === stimulus.base
      );
      break;
    case 'ci':
      require(record.head_sha === stimulus.headSha && text(record.name));
      require(
        record.status === 'completed' &&
          record.conclusion === 'success' &&
          record.app?.slug === 'github-actions'
      );
      break;
    default:
      throw new Error('Unknown provider event kind');
  }
}

/** External manifests are untrusted proof input: require the whole semantic tuple. */
export function validFixtureExpected(stimulus) {
  try {
    const expected = stimulus.expected;
    if (!expected || typeof expected.runId !== 'string' || !expected.runId) return false;
    if (providerId(stimulus.providerId) !== providerId(expected.record.id)) return false;
    validateFields(stimulus, expected.record);
    const canonical = fixtureExpected(stimulus, expected.record, expected.runId);
    return expected.path === canonical.path;
  } catch {
    return false;
  }
}

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

/** Ignore legacy copies while requiring the exact adapter-owned comment record. */
export function findFixtureCommentMessage(messages, stimulus, runId) {
  const [owner, repo] = stimulus.repo.split('/');
  const canonicalPath = githubIssueCommentPath(
    owner,
    repo,
    stimulus.pr,
    stimulus.commentId,
    fixtureTitle(runId)
  );
  return messages.find(
    (message) =>
      (message.metadata?.path ?? message.metadata?.relayfile?.path) === canonicalPath &&
      message.text?.includes('GHSUB_EVENT_NONCE=' + stimulus.nonce)
  );
}
