import type {
  GetUserParams,
  GitHubUserSummary,
  ListOrganizationsParams,
  OrganizationInfo,
} from '../types.js';
import {
  asArray,
  asRecord,
  assertNonEmptyString,
  numberValue,
  optionalString,
  queryWithPerPage,
  stringValue,
  withActionError,
  type GitHubActionAdapter,
} from './utils.js';

/**
 * Fetch the authenticated user, or a public user by username.
 */
export async function getUser(
  adapter: GitHubActionAdapter,
  params: GetUserParams = {}
): Promise<GitHubUserSummary> {
  return withActionError('get GitHub user', async () => {
    const path = params.username
      ? `/users/${encodeURIComponent(assertNonEmptyString(params.username, 'username'))}`
      : '/user';
    const response = await adapter.request<unknown>('GET', path);
    return mapUser(response);
  });
}

/**
 * List organizations for the authenticated user, or for a public user.
 */
export async function listOrganizations(
  adapter: GitHubActionAdapter,
  params: ListOrganizationsParams = {}
): Promise<OrganizationInfo[]> {
  return withActionError('list GitHub organizations', async () => {
    const path = params.username
      ? `/users/${encodeURIComponent(assertNonEmptyString(params.username, 'username'))}/orgs`
      : '/user/orgs';
    const response = await adapter.request<unknown>('GET', path, {
      query: queryWithPerPage({}, params.perPage),
    });

    return asArray(response, 'organizations').map(mapOrganization);
  });
}

export function mapUser(value: unknown): GitHubUserSummary {
  const user = asRecord(value, 'user');
  const login = stringValue(user.login);

  if (!login) {
    throw new Error('GitHub user response did not include a login.');
  }

  return {
    login,
    name: optionalString(user.name),
    id: numberValue(user.id),
    type: optionalString(user.type),
  };
}

export function mapOrganization(value: unknown): OrganizationInfo {
  const organization = asRecord(value, 'organization');

  return {
    login: stringValue(organization.login),
    id: numberValue(organization.id),
    description: optionalString(organization.description),
    url: optionalString(organization.url),
    avatarUrl: optionalString(organization.avatar_url),
  };
}
