import type {
  CommitInfo,
  CreateCommitParams,
  GitHubCommitAuthor,
  GitHubQueryParams,
  ListCommitsParams,
} from '../types.js';
import {
  asArray,
  asRecord,
  assertNonEmptyString,
  assertOwnerRepo,
  normalizePerPage,
  optionalRecord,
  optionalString,
  removeUndefinedValues,
  repoEndpoint,
  stringValue,
  withActionError,
  type GitHubActionAdapter,
} from './utils.js';

/**
 * List commits for a repository.
 */
export async function listCommits(
  adapter: GitHubActionAdapter,
  params: ListCommitsParams
): Promise<CommitInfo[]> {
  const { owner, repo } = params;

  return withActionError(`list GitHub commits for ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    const query: GitHubQueryParams = {
      sha: params.sha,
      path: params.path,
      author: params.author,
      since: params.since,
      until: params.until,
      per_page: normalizePerPage(params.perPage),
    };

    const response = await adapter.request<unknown>('GET', repoEndpoint(owner, repo, '/commits'), {
      query,
    });

    return asArray(response, 'commits').map(mapCommit);
  });
}

/**
 * Create a Git commit object.
 *
 * This creates the commit object only. Updating a branch ref is intentionally a
 * separate operation so callers can decide when to move refs.
 */
export async function createCommit(
  adapter: GitHubActionAdapter,
  params: CreateCommitParams
): Promise<CommitInfo> {
  const { owner, repo } = params;

  return withActionError(`create GitHub commit in ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    const message = assertNonEmptyString(params.message, 'commit message');
    const tree = assertNonEmptyString(params.tree, 'commit tree');

    if (!Array.isArray(params.parents)) {
      throw new Error('GitHub commit parents must be an array of parent SHAs.');
    }

    const response = await adapter.request<unknown>('POST', repoEndpoint(owner, repo, '/git/commits'), {
      body: removeUndefinedValues({
        message,
        tree,
        parents: params.parents.map((parent) => assertNonEmptyString(parent, 'parent sha')),
        author: params.author,
        committer: params.committer,
      }),
    });

    return mapCommit(response);
  });
}

export function mapCommit(value: unknown): CommitInfo {
  const topLevel = asRecord(value, 'commit');
  const nestedCommit = optionalRecord(topLevel.commit);
  const author = optionalRecord(nestedCommit?.author ?? topLevel.author);
  const committer = optionalRecord(nestedCommit?.committer ?? topLevel.committer);

  return {
    sha: stringValue(topLevel.sha),
    url: optionalString(topLevel.url),
    htmlUrl: optionalString(topLevel.html_url),
    message: optionalString(nestedCommit?.message ?? topLevel.message),
    author: author ? mapCommitAuthor(author) : undefined,
    committer: committer ? mapCommitAuthor(committer) : undefined,
  };
}

function mapCommitAuthor(value: Record<string, unknown>): GitHubCommitAuthor & { date?: string } {
  return {
    name: stringValue(value.name),
    email: stringValue(value.email),
    date: optionalString(value.date),
  };
}
