import { Buffer } from 'node:buffer';

import type {
  CreateFileParams,
  DeleteFileParams,
  GitHubFile,
  ListFilesParams,
  UpdateFileParams,
} from '../types.js';
import {
  asArray,
  asRecord,
  assertNonEmptyString,
  assertOwnerRepo,
  contentsEndpoint,
  normalizeRepoPath,
  numberValue,
  optionalString,
  removeUndefinedValues,
  stringValue,
  withActionError,
  type GitHubActionAdapter,
} from './utils.js';

export type ListFileOptions = Omit<ListFilesParams, 'owner' | 'repo' | 'path'>;
export type CreateFileOptions = Omit<CreateFileParams, 'owner' | 'repo' | 'path' | 'content' | 'message'>;
export type UpdateFileOptions = Omit<
  UpdateFileParams,
  'owner' | 'repo' | 'path' | 'content' | 'message' | 'sha'
>;
export type DeleteFileOptions = Omit<DeleteFileParams, 'owner' | 'repo' | 'path' | 'sha' | 'message'>;

/**
 * List files or directories at a repository path.
 *
 * Directory responses are returned as a file list. If the path points at a
 * single file, the file is returned as a one-item list.
 */
export async function listFiles(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  path = '',
  options: ListFileOptions = {}
): Promise<GitHubFile[]> {
  return withActionError(`list GitHub files at ${owner}/${repo}/${path}`, async () => {
    assertOwnerRepo(owner, repo);
    const response = await adapter.request<unknown>('GET', contentsEndpoint(owner, repo, path), {
      query: {
        ref: options.ref,
      },
    });

    return Array.isArray(response)
      ? asArray(response, 'repository contents').map(mapFile)
      : [mapFile(response)];
  });
}

/**
 * Read a repository file and return decoded UTF-8 content.
 *
 * The GitHub contents API returns base64 encoded file data; this action decodes
 * the payload before returning it to callers.
 */
export async function readFile(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<string> {
  return withActionError(`read GitHub file ${owner}/${repo}/${path}`, async () => {
    assertOwnerRepo(owner, repo);
    assertNonEmptyString(normalizeRepoPath(path), 'file path');
    const response = await adapter.request<unknown>('GET', contentsEndpoint(owner, repo, path), {
      query: {
        ref,
      },
    });
    const file = mapFile(response);

    if (file.type !== 'file') {
      throw new Error(`GitHub path "${path}" is not a file.`);
    }

    if (!file.content) {
      throw new Error(`GitHub file "${path}" did not include content in the API response.`);
    }

    if (file.encoding && file.encoding !== 'base64') {
      throw new Error(`GitHub file "${path}" used unsupported encoding "${file.encoding}".`);
    }

    return Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
  });
}

/**
 * Create a file in a repository.
 *
 * Content is encoded as base64 and committed with the supplied message. The
 * action resolves when GitHub accepts the create request.
 */
export async function createFile(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  options: CreateFileOptions = {}
): Promise<void> {
  return withActionError(`create GitHub file ${owner}/${repo}/${path}`, async () => {
    assertOwnerRepo(owner, repo);
    const normalizedPath = assertNonEmptyString(normalizeRepoPath(path), 'file path');
    const commitMessage = assertNonEmptyString(message, 'commit message');

    await adapter.request<unknown>('PUT', contentsEndpoint(owner, repo, normalizedPath), {
      body: removeUndefinedValues({
        message: commitMessage,
        content: Buffer.from(content, 'utf8').toString('base64'),
        branch: options.branch,
        author: options.author,
      }),
    });
  });
}

/**
 * Update an existing repository file.
 *
 * The file SHA is required by the GitHub contents API to avoid overwriting an
 * unexpected version.
 */
export async function updateFile(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  sha: string,
  options: UpdateFileOptions = {}
): Promise<GitHubFile> {
  return withActionError(`update GitHub file ${owner}/${repo}/${path}`, async () => {
    assertOwnerRepo(owner, repo);
    const normalizedPath = assertNonEmptyString(normalizeRepoPath(path), 'file path');
    const commitMessage = assertNonEmptyString(message, 'commit message');
    const fileSha = assertNonEmptyString(sha, 'file sha');

    const response = await adapter.request<unknown>('PUT', contentsEndpoint(owner, repo, normalizedPath), {
      body: removeUndefinedValues({
        message: commitMessage,
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha: fileSha,
        branch: options.branch,
        author: options.author,
      }),
    });

    const contentRecord = asRecord(response, 'update file response').content;
    return mapFile(contentRecord);
  });
}

/**
 * Delete a repository file with a commit message.
 */
export async function deleteFile(
  adapter: GitHubActionAdapter,
  owner: string,
  repo: string,
  path: string,
  sha: string,
  message: string,
  options: DeleteFileOptions = {}
): Promise<void> {
  return withActionError(`delete GitHub file ${owner}/${repo}/${path}`, async () => {
    assertOwnerRepo(owner, repo);
    const normalizedPath = assertNonEmptyString(normalizeRepoPath(path), 'file path');
    const fileSha = assertNonEmptyString(sha, 'file sha');
    const commitMessage = assertNonEmptyString(message, 'commit message');

    await adapter.request<unknown>('DELETE', contentsEndpoint(owner, repo, normalizedPath), {
      body: removeUndefinedValues({
        message: commitMessage,
        sha: fileSha,
        branch: options.branch,
        author: options.author,
      }),
    });
  });
}

export function mapFile(value: unknown): GitHubFile {
  const file = asRecord(value, 'repository content');
  const type = stringValue(file.type) === 'dir' ? 'dir' : 'file';

  return {
    name: stringValue(file.name),
    path: stringValue(file.path),
    sha: stringValue(file.sha),
    size: numberValue(file.size),
    url: stringValue(file.url),
    htmlUrl: stringValue(file.html_url),
    gitUrl: stringValue(file.git_url),
    downloadUrl: optionalString(file.download_url),
    type,
    content: optionalString(file.content),
    encoding: optionalString(file.encoding),
    target: optionalString(file.target),
  };
}
