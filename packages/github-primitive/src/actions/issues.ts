import type { CreateIssueParams, Issue, ListIssuesParams, UpdateIssueParams } from '../types.js';
import {
  asArray,
  asRecord,
  assertNonEmptyString,
  assertOwnerRepo,
  assertPositiveInteger,
  booleanValue,
  hasDefinedValue,
  mapGitHubOwner,
  mapLogin,
  mapLogins,
  numberValue,
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

export type ListIssueOptions = Omit<ListIssuesParams, 'owner' | 'repo'>;
export type CreateIssueOptions = Omit<CreateIssueParams, 'owner' | 'repo' | 'title' | 'body'>;
export type IssueUpdates = Omit<UpdateIssueParams, 'owner' | 'repo' | 'issueNumber'>;

/**
 * List repository issues.
 *
 * Pull requests are excluded from the repository issues endpoint response so
 * callers receive only true issues. Local and cloud runtimes are handled by the
 * provided adapter.
 */
export async function listIssues(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  options: ListIssueOptions = {}
): Promise<Issue[]> {
  return withActionError(`list GitHub issues for ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    const query = queryWithPerPage(
      {
        state: options.state,
        assignee: options.assignee,
        labels: options.labels,
        sort: options.sort,
        direction: options.direction,
      },
      options.perPage
    );
    const response = await adapter.request<unknown>('GET', repoEndpoint(owner, repo, '/issues'), {
      query,
    });

    return asArray(response, 'issues').filter(isIssueResponse).map(mapIssue);
  });
}

/**
 * Create an issue in a repository.
 *
 * The request body is sent through the adapter request layer, allowing the
 * local `gh api` runtime and the cloud proxy runtime to share the same action.
 */
export async function createIssue(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  title: string,
  body?: string,
  options: CreateIssueOptions = {}
): Promise<Issue> {
  return withActionError(`create GitHub issue in ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    const issueTitle = assertNonEmptyString(title, 'issue title');
    const response = await adapter.request<unknown>('POST', repoEndpoint(owner, repo, '/issues'), {
      body: removeUndefinedValues({
        title: issueTitle,
        body,
        assignees: options.assignee ? [options.assignee] : undefined,
        labels: options.labels,
        milestone: options.milestone,
      }),
    });

    return mapIssue(response);
  });
}

/**
 * Update an existing issue.
 *
 * At least one update field must be supplied. Supported updates include title,
 * body, state, assignee, and labels.
 */
export async function updateIssue(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  number: number,
  updates: IssueUpdates
): Promise<Issue> {
  return withActionError(`update GitHub issue #${number} in ${owner}/${repo}`, async () => {
    assertOwnerRepo(owner, repo);
    assertPositiveInteger(number, 'issue number');

    if (!hasDefinedValue(updates)) {
      throw new Error('At least one issue update field must be provided.');
    }

    const response = await adapter.request<unknown>('PATCH', repoEndpoint(owner, repo, `/issues/${number}`), {
      body: removeUndefinedValues({
        title: updates.title,
        body: updates.body,
        state: updates.state,
        assignees: updates.assignee ? [updates.assignee] : undefined,
        labels: updates.labels,
      }),
    });

    return mapIssue(response);
  });
}

export function mapIssue(value: unknown): Issue {
  const issue = asRecord(value, 'issue');
  const milestone = optionalRecord(issue.milestone);
  const reactions = optionalRecord(issue.reactions);

  return {
    number: numberValue(issue.number),
    id: numberValue(issue.id),
    title: stringValue(issue.title),
    body: optionalString(issue.body),
    user: mapGitHubOwner(issue.user),
    labels: Array.isArray(issue.labels) ? issue.labels.map(mapIssueLabel) : [],
    state: stateValue(issue.state),
    locked: booleanValue(issue.locked),
    assignee: issue.assignee ? mapLogin(issue.assignee) : undefined,
    assignees: mapLogins(issue.assignees),
    milestone: milestone
      ? {
          number: numberValue(milestone.number),
          title: stringValue(milestone.title),
        }
      : undefined,
    commentsCount: numberValue(issue.comments),
    createdAt: stringValue(issue.created_at),
    updatedAt: stringValue(issue.updated_at),
    closedAt: optionalString(issue.closed_at),
    authorAssociation: stringValue(issue.author_association),
    reactions: {
      totalCount: numberValue(reactions?.total_count),
    },
  };
}

function mapIssueLabel(value: unknown): Issue['labels'][number] {
  if (typeof value === 'string') {
    return {
      name: value,
      color: '',
    };
  }

  const label = asRecord(value, 'issue label');
  return {
    name: stringValue(label.name),
    color: stringValue(label.color),
    description: optionalString(label.description),
  };
}

function isIssueResponse(value: unknown): boolean {
  return !('pull_request' in asRecord(value, 'issue'));
}
