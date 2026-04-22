import type { BranchInfo, CreateBranchParams, RepositoryRef } from '../types.js';
import {
  asArray,
  asRecord,
  assertNonEmptyString,
  assertOwnerRepo,
  booleanValue,
  branchEndpoint,
  numberValue,
  repoEndpoint,
  stringValue,
  withActionError,
  type GitHubActionAdapter,
} from './utils.js';

/**
 * List branches for a repository.
 */
export async function listBranches(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string
): Promise<BranchInfo[]> {
  return withActionError(`list GitHub branches for ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    const response = await adapter.request<unknown>('GET', repoEndpoint(owner, repo, '/branches'));
    return asArray(response, 'branches').map(mapBranch);
  });
}

/**
 * Create a branch from another branch, or from the repository default branch.
 */
export async function createBranch(adapter: GitHubActionAdapter, params: CreateBranchParams): Promise<void> {
  const { owner, repo } = params;

  return withActionError(`create GitHub branch ${params.branch} in ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    const branch = assertNonEmptyString(params.branch, 'branch');
    const sourceBranch = params.fromBranch ?? (await getDefaultBranch(adapter, params));
    const source = await getBranch(adapter, owner, repo, sourceBranch);
    const sha = assertNonEmptyString(source.commit.sha, 'source branch sha');

    await adapter.request<unknown>('POST', repoEndpoint(owner, repo, '/git/refs'), {
      body: {
        ref: `refs/heads/${branch}`,
        sha,
      },
    });
  });
}

export async function getBranch(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  branch: string
): Promise<BranchInfo> {
  const response = await adapter.request<unknown>('GET', branchEndpoint(owner, repo, branch));
  return mapBranch(response);
}

export function mapBranch(value: unknown): BranchInfo {
  const branch = asRecord(value, 'branch');
  const commit = asRecord(branch.commit, 'branch commit');

  return {
    name: stringValue(branch.name),
    commit: {
      sha: stringValue(commit.sha),
      url: stringValue(commit.url),
    },
    protected: booleanValue(branch.protected),
  };
}

async function getDefaultBranch(adapter: GitHubActionAdapter, params: RepositoryRef): Promise<string> {
  const response = await adapter.request<unknown>('GET', repoEndpoint(params.owner, params.repo));
  const repository = asRecord(response, 'repository');
  const branch = stringValue(repository.default_branch);

  if (!branch) {
    const id = numberValue(repository.id);
    throw new Error(
      id
        ? `Repository ${params.owner}/${params.repo} did not include a default branch.`
        : `Repository ${params.owner}/${params.repo} was not a valid repository response.`
    );
  }

  return branch;
}
