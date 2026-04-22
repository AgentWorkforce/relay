import type { CreatePRParams, ListPRsParams, MergePRParams, PR, UpdatePRParams } from '../types.js';
import {
  asArray,
  asRecord,
  assertNonEmptyString,
  assertOwnerRepo,
  assertPositiveInteger,
  booleanValue,
  mapGitHubOwner,
  mapLogin,
  mapLogins,
  numberValue,
  hasDefinedValue,
  optionalRecord,
  optionalString,
  queryWithPerPage,
  removeUndefinedValues,
  repoEndpoint,
  stateValue,
  stringValue,
  withActionError,
  type GitHubActionAdapter,
} from './utils.js';

export type ListPROptions = Omit<ListPRsParams, 'owner' | 'repo'>;
export type CreatePROptions = Omit<CreatePRParams, 'owner' | 'repo' | 'title' | 'body' | 'base' | 'head'>;
export type PullRequestUpdates = Omit<UpdatePRParams, 'owner' | 'repo' | 'pullNumber'>;

/**
 * List pull requests for a repository.
 *
 * Query options are mapped to GitHub REST parameters and the adapter determines
 * whether the call is executed through `gh api` or the configured cloud proxy.
 */
export async function listPRs(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  options: ListPROptions = {}
): Promise<PR[]> {
  return withActionError(`list GitHub pull requests for ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    const query = queryWithPerPage(
      {
        state: options.state,
        base: options.base,
        head: options.head,
        sort: options.sort,
        direction: options.direction,
      },
      options.perPage
    );
    const response = await adapter.request<unknown>('GET', repoEndpoint(owner, repo, '/pulls'), {
      query,
    });

    return asArray(response, 'pull requests').map(mapPR);
  });
}

/**
 * Fetch a single pull request by number.
 */
export async function getPR(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  number: number
): Promise<PR> {
  return withActionError(`get GitHub pull request #${number} in ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    assertPositiveInteger(number, 'pull request number');
    const response = await adapter.request<unknown>('GET', repoEndpoint(owner, repo, `/pulls/${number}`));

    return mapPR(response);
  });
}

/**
 * Create a pull request.
 *
 * The supplied base and head refs are passed directly to the GitHub REST API,
 * supporting same-repository branches and owner-qualified fork refs.
 */
export async function createPR(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  title: string,
  body: string | undefined,
  base: string,
  head: string,
  options: CreatePROptions = {}
): Promise<PR> {
  return withActionError(`create GitHub pull request in ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    const prTitle = assertNonEmptyString(title, 'pull request title');
    const baseRef = assertNonEmptyString(base, 'pull request base');
    const headRef = assertNonEmptyString(head, 'pull request head');
    const response = await adapter.request<unknown>('POST', repoEndpoint(owner, repo, '/pulls'), {
      body: removeUndefinedValues({
        title: prTitle,
        body,
        base: baseRef,
        head: headRef,
        draft: options.draft,
        maintainer_can_modify: options.maintainerCanModify,
      }),
    });

    return mapPR(response);
  });
}

/**
 * Update an existing pull request.
 *
 * At least one update field must be provided. GitHub accepts base branch
 * changes and maintainer edit permissions through the same endpoint.
 */
export async function updatePR(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  number: number,
  updates: PullRequestUpdates
): Promise<PR> {
  return withActionError(`update GitHub pull request #${number} in ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    assertPositiveInteger(number, 'pull request number');

    if (!hasDefinedValue(updates)) {
      throw new Error('At least one pull request update field must be provided.');
    }

    const response = await adapter.request<unknown>('PATCH', repoEndpoint(owner, repo, `/pulls/${number}`), {
      body: removeUndefinedValues({
        title: updates.title,
        body: updates.body,
        state: updates.state,
        base: updates.base,
        maintainer_can_modify: updates.maintainerCanModify,
      }),
    });

    return mapPR(response);
  });
}

/**
 * Merge a pull request and return the fresh pull request representation.
 *
 * GitHub's merge endpoint returns a small confirmation payload, so this action
 * fetches the pull request after a successful merge to preserve the typed PR
 * return value used by the primitive.
 */
export async function mergePR(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  number: number,
  options: Omit<MergePRParams, 'owner' | 'repo' | 'pullNumber'> = {}
): Promise<PR> {
  return withActionError(`merge GitHub pull request #${number} in ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    assertPositiveInteger(number, 'pull request number');

    await adapter.request<unknown>('PUT', repoEndpoint(owner, repo, `/pulls/${number}/merge`), {
      body: removeUndefinedValues({
        commit_title: options.commitTitle,
        commit_message: options.commitMessage,
        merge_method: options.mergeMethod,
      }),
    });

    return getPR(adapter, owner, repo, number);
  });
}

export function mapPR(value: unknown): PR {
  const pull = asRecord(value, 'pull request');
  const base = asRecord(pull.base, 'pull request base');
  const head = asRecord(pull.head, 'pull request head');
  const baseRepo = optionalRecord(base.repo);
  const headRepo = optionalRecord(head.repo);

  return {
    number: numberValue(pull.number),
    id: numberValue(pull.id),
    title: stringValue(pull.title),
    body: optionalString(pull.body),
    user: mapGitHubOwner(pull.user),
    state: stateValue(pull.state),
    draft: booleanValue(pull.draft),
    locked: booleanValue(pull.locked),
    mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : undefined,
    mergeableState: stringValue(pull.mergeable_state),
    merged: booleanValue(pull.merged),
    mergedAt: optionalString(pull.merged_at),
    mergedBy: pull.merged_by ? mapLogin(pull.merged_by) : undefined,
    base: {
      ref: stringValue(base.ref),
      sha: stringValue(base.sha),
      repo: {
        name: stringValue(baseRepo?.name),
        fullName: stringValue(baseRepo?.full_name),
      },
    },
    head: {
      ref: stringValue(head.ref),
      sha: stringValue(head.sha),
      repo: headRepo
        ? {
            name: stringValue(headRepo.name),
            fullName: stringValue(headRepo.full_name),
          }
        : undefined,
    },
    requestedReviewers: mapLogins(pull.requested_reviewers),
    labels: Array.isArray(pull.labels) ? pull.labels.map(mapPullLabel) : [],
    commentsCount: numberValue(pull.comments),
    reviewCommentsCount: numberValue(pull.review_comments),
    commitsCount: numberValue(pull.commits),
    additionsCount: numberValue(pull.additions),
    deletionsCount: numberValue(pull.deletions),
    changedFilesCount: numberValue(pull.changed_files),
    createdAt: stringValue(pull.created_at),
    updatedAt: stringValue(pull.updated_at),
  };
}

function mapPullLabel(value: unknown): PR['labels'][number] {
  if (typeof value === 'string') {
    return {
      name: value,
      color: '',
    };
  }

  const label = asRecord(value, 'pull request label');
  return {
    name: stringValue(label.name),
    color: stringValue(label.color),
  };
}
