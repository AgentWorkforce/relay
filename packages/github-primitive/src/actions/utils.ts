import {
  GitHubApiError,
  type GitHubApiRequestMethod,
  type GitHubApiRequestOptions,
  type GitHubOwner,
  type GitHubQueryParams,
  type GitHubRuntime,
} from '../types.js';

export interface GitHubActionAdapter {
  getRuntime(): GitHubRuntime;
  request<TResponse = unknown>(
    method: GitHubApiRequestMethod,
    path: string,
    options?: GitHubApiRequestOptions
  ): Promise<TResponse>;
}

export type UnknownRecord = Record<string, unknown>;

export async function withActionError<T>(description: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GitHubApiError) {
      throw new GitHubApiError(`Failed to ${description}: ${error.message}`, {
        status: error.status,
        responseBody: error.responseBody,
        responseHeaders: error.responseHeaders,
        cause: error,
      });
    }

    throw new GitHubApiError(`Failed to ${description}: ${errorMessage(error)}`, { cause: error });
  }
}

export function assertOwnerRepo(owner: string, repo: string): void {
  assertNonEmptyString(owner, 'owner');
  assertNonEmptyString(repo, 'repo');
}

export function assertNonEmptyString(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GitHubApiError(`GitHub ${name} must be a non-empty string.`);
  }

  return value.trim();
}

export function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new GitHubApiError(`GitHub ${name} must be a positive integer.`);
  }

  return value;
}

export function repoEndpoint(owner: string, repo: string, suffix = ''): string {
  assertOwnerRepo(owner, repo);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

export function contentsEndpoint(owner: string, repo: string, path = ''): string {
  const normalizedPath = normalizeRepoPath(path);
  const suffix = normalizedPath ? `/contents/${encodeRepoPath(normalizedPath)}` : '/contents';
  return repoEndpoint(owner, repo, suffix);
}

export function branchEndpoint(owner: string, repo: string, branch: string): string {
  const normalizedBranch = assertNonEmptyString(branch, 'branch');
  return repoEndpoint(owner, repo, `/branches/${encodeURIComponent(normalizedBranch)}`);
}

export function normalizeRepoPath(path: string | undefined): string {
  return path?.trim().replace(/^\/+/, '').replace(/\/+$/, '') ?? '';
}

export function normalizePerPage(perPage: number | undefined): number | undefined {
  if (typeof perPage === 'undefined') {
    return undefined;
  }

  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new GitHubApiError('GitHub perPage must be a positive integer.');
  }

  return Math.min(perPage, 100);
}

export function removeUndefinedValues(
  values: Record<string, unknown>
): Record<string, Exclude<unknown, undefined>> {
  const result: Record<string, Exclude<unknown, undefined>> = {};

  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'undefined') {
      result[key] = value as Exclude<unknown, undefined>;
    }
  }

  return result;
}

export function hasDefinedValue(values: Record<string, unknown>): boolean {
  return Object.values(values).some((value) => typeof value !== 'undefined');
}

export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function appendQuery(path: string, query: GitHubQueryParams | undefined): string {
  if (!query) {
    return path;
  }

  const params = new URLSearchParams();
  for (const [name, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== null && typeof value !== 'undefined') {
        params.append(name, String(value));
      }
    }
  }

  const serialized = params.toString();
  if (!serialized) {
    return path;
  }

  return `${path}${path.includes('?') ? '&' : '?'}${serialized}`;
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function trimTrailingSlash(value: string | undefined): string | undefined {
  const trimmed = nonEmpty(value);
  return trimmed?.replace(/\/+$/, '');
}

export function queryWithPerPage(query: GitHubQueryParams, perPage: number | undefined): GitHubQueryParams {
  const normalizedPerPage = normalizePerPage(perPage);
  return typeof normalizedPerPage === 'undefined'
    ? query
    : {
        ...query,
        per_page: normalizedPerPage,
      };
}

export function asRecord(value: unknown, name: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubApiError(`GitHub API response for ${name} was not an object.`);
  }

  return value as UnknownRecord;
}

export function asArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new GitHubApiError(`GitHub API response for ${name} was not an array.`);
  }

  return value;
}

export function mapGitHubOwner(value: unknown): GitHubOwner {
  const owner = asRecord(value, 'owner');
  return {
    login: stringValue(owner.login),
    type: stringValue(owner.type, 'User'),
    id: numberValue(owner.id),
    avatarUrl: optionalString(owner.avatar_url),
    htmlUrl: optionalString(owner.html_url),
  };
}

export function mapLogin(value: unknown): { login: string } {
  const record = asRecord(value, 'user');
  return {
    login: stringValue(record.login),
  };
}

export function mapLogins(value: unknown): Array<{ login: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(mapLogin);
}

export function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function stateValue(value: unknown): 'open' | 'closed' {
  return value === 'closed' ? 'closed' : 'open';
}

export function visibilityValue(value: unknown, isPrivate: boolean): 'public' | 'private' | 'internal' {
  if (value === 'public' || value === 'private' || value === 'internal') {
    return value;
  }

  return isPrivate ? 'private' : 'public';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeRepoPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
