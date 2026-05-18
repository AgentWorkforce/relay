import type { ListReposParams, Repo } from '../types.js';
import {
  asArray,
  asRecord,
  booleanValue,
  mapGitHubOwner,
  numberValue,
  optionalRecord,
  optionalString,
  queryWithPerPage,
  repoEndpoint,
  stringValue,
  visibilityValue,
  withActionError,
  type GitHubActionAdapter,
} from './utils.js';

/**
 * List repositories visible to the authenticated GitHub identity.
 *
 * The action delegates to the supplied adapter, so local runtimes use `gh api`
 * and cloud runtimes use the configured Nango or relay-cloud proxy.
 */
export async function listRepos(
  adapter: GitHubActionAdapter,
  options: ListReposParams = {}
): Promise<Repo[]> {
  return withActionError('list GitHub repositories', async () => {
    const query = queryWithPerPage(
      {
        visibility: options.visibility,
        affiliation: options.affiliation,
        sort: options.sort,
        direction: options.direction,
      },
      options.perPage
    );
    const response = await adapter.request<unknown>('GET', '/user/repos', { query });

    return asArray(response, 'repositories').map(mapRepo);
  });
}

/**
 * Fetch a single repository by owner and repository name.
 *
 * The same REST endpoint is used for both local and cloud runtimes through the
 * adapter request abstraction.
 */
export async function getRepo(adapter: GitHubActionAdapter, owner: string, repo: string): Promise<Repo> {
  return withActionError(`get GitHub repository ${owner}/${repo}`, async () => {
    const response = await adapter.request<unknown>('GET', repoEndpoint(owner, repo));
    return mapRepo(response);
  });
}

export function mapRepo(value: unknown): Repo {
  const repo = asRecord(value, 'repository');
  const isPrivate = booleanValue(repo.private);
  const permissions = optionalRecord(repo.permissions);

  return {
    id: numberValue(repo.id),
    name: stringValue(repo.name),
    fullName: stringValue(repo.full_name, stringValue(repo.name)),
    owner: mapGitHubOwner(repo.owner),
    description: optionalString(repo.description),
    private: isPrivate,
    fork: booleanValue(repo.fork),
    createdAt: stringValue(repo.created_at),
    updatedAt: stringValue(repo.updated_at),
    pushedAt: stringValue(repo.pushed_at),
    size: numberValue(repo.size),
    stargazersCount: numberValue(repo.stargazers_count),
    watchersCount: numberValue(repo.watchers_count),
    language: optionalString(repo.language),
    forksCount: numberValue(repo.forks_count),
    openIssuesCount: numberValue(repo.open_issues_count),
    defaultBranch: stringValue(repo.default_branch),
    topics: Array.isArray(repo.topics) ? repo.topics.filter(isString) : [],
    visibility: visibilityValue(repo.visibility, isPrivate),
    permissions: permissions
      ? {
          admin: booleanValue(permissions.admin),
          maintain: booleanValue(permissions.maintain),
          push: booleanValue(permissions.push),
          triage: booleanValue(permissions.triage),
          pull: booleanValue(permissions.pull),
        }
      : undefined,
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
