import { describe, expect, it } from 'vitest';

import { BaseGitHubAdapter } from '../adapter.js';
import { NangoClient } from '../cloud-runtime.js';
import {
  GitHubAction,
  type GitHubApiRequestMethod,
  type GitHubApiRequestOptions,
  type GitHubRuntime,
  type GitHubRuntimeConfig,
  type GitHubUserSummary,
} from '../types.js';

interface RecordedRequest {
  method: GitHubApiRequestMethod;
  path: string;
  options: GitHubApiRequestOptions;
}

class RecordingAdapter extends BaseGitHubAdapter {
  readonly requests: RecordedRequest[] = [];

  constructor(config: GitHubRuntimeConfig = {}) {
    super({
      env: {},
      retryOnRateLimit: false,
      ...config,
      runtime: 'local',
    });
  }

  getRuntime(): GitHubRuntime {
    return 'local';
  }

  async isAuthenticated(): Promise<boolean> {
    return true;
  }

  async getCurrentUser(): Promise<GitHubUserSummary> {
    return userResponse;
  }

  async request<TResponse = unknown>(
    method: GitHubApiRequestMethod,
    path: string,
    options: GitHubApiRequestOptions = {}
  ): Promise<TResponse> {
    this.requests.push({ method, path, options });
    return responseFor(method, path, options) as TResponse;
  }
}

describe('GitHub primitive actions', () => {
  it('dispatches every declared action without adapter-layer stubs', async () => {
    const adapter = new RecordingAdapter();

    const cases: Array<[GitHubAction, unknown]> = [
      [GitHubAction.ListRepos, { perPage: 1 }],
      [GitHubAction.GetRepo, repoParams],
      [GitHubAction.ListIssues, { ...repoParams, state: 'open' }],
      [GitHubAction.CreateIssue, { ...repoParams, title: 'Bug' }],
      [GitHubAction.UpdateIssue, { ...repoParams, issueNumber: 1, title: 'Fixed' }],
      [GitHubAction.CloseIssue, { ...repoParams, issueNumber: 1 }],
      [GitHubAction.ListPRs, { ...repoParams, state: 'open' }],
      [GitHubAction.GetPR, { ...repoParams, pullNumber: 1 }],
      [GitHubAction.CreatePR, { ...repoParams, title: 'PR', base: 'main', head: 'feature' }],
      [GitHubAction.UpdatePR, { ...repoParams, pullNumber: 1, title: 'Updated PR' }],
      [GitHubAction.MergePR, { ...repoParams, pullNumber: 1, mergeMethod: 'squash' }],
      [GitHubAction.ListFiles, { ...repoParams, path: 'README.md' }],
      [GitHubAction.ReadFile, { ...repoParams, path: 'README.md' }],
      [GitHubAction.CreateFile, { ...repoParams, path: 'new.md', content: 'hello', message: 'create file' }],
      [
        GitHubAction.UpdateFile,
        { ...repoParams, path: 'README.md', content: 'hello', message: 'update file', sha: 'file-sha' },
      ],
      [
        GitHubAction.DeleteFile,
        { ...repoParams, path: 'README.md', sha: 'file-sha', message: 'delete file' },
      ],
      [GitHubAction.CreateBranch, { ...repoParams, branch: 'feature', fromBranch: 'main' }],
      [GitHubAction.ListBranches, repoParams],
      [GitHubAction.ListCommits, { ...repoParams, perPage: 1 }],
      [
        GitHubAction.CreateCommit,
        { ...repoParams, message: 'commit', tree: 'tree-sha', parents: ['parent-sha'] },
      ],
      [GitHubAction.GetUser, undefined],
      [GitHubAction.ListOrganizations, { perPage: 1 }],
    ];

    for (const [action, params] of cases) {
      const result = await adapter.executeAction(action, params as never);
      expect(result.success, action).toBe(true);
      expect(result.error, action).toBeUndefined();
    }
  });

  it('maps closeIssue to an issue PATCH with closed state', async () => {
    const adapter = new RecordingAdapter();

    await adapter.closeIssue({ ...repoParams, issueNumber: 1 });

    expect(adapter.requests).toContainEqual({
      method: 'PATCH',
      path: '/repos/octo/repo/issues/1',
      options: {
        body: {
          state: 'closed',
        },
      },
    });
  });

  it('keeps the Nango fallback failure inspectable when relay-cloud succeeds', async () => {
    const fetchCalls: string[] = [];
    const client = new NangoClient({
      env: {},
      runtime: 'cloud',
      retryOnRateLimit: false,
      nango: {
        secretKey: 'secret',
        connectionId: 'conn',
        providerConfigKey: 'github',
        baseUrl: 'https://nango.example',
      },
      relayCloud: {
        apiUrl: 'https://relay.example',
        accessToken: 'token',
      },
      fetch: async (input) => {
        fetchCalls.push(String(input));
        if (fetchCalls.length === 1) {
          return new Response('nango unavailable', { status: 502 });
        }
        return new Response(JSON.stringify({ data: userResponse }), { status: 200 });
      },
    });

    await expect(client.getUser()).resolves.toEqual(userResponse);
    expect(fetchCalls).toEqual([
      'https://nango.example/proxy/user',
      'https://relay.example/api/integrations/github/proxy',
    ]);
    expect(client.getLastNangoFallbackError()).toBeInstanceOf(Error);
  });
});

const repoParams = { owner: 'octo', repo: 'repo' };
const ownerResponse = { login: 'octo', type: 'User', id: 1 };
const userResponse = { login: 'octo', name: 'Octo Cat', id: 1, type: 'User' };

const repoResponse = {
  id: 1,
  name: 'repo',
  full_name: 'octo/repo',
  owner: ownerResponse,
  private: false,
  fork: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  pushed_at: '2026-01-03T00:00:00Z',
  size: 10,
  stargazers_count: 5,
  watchers_count: 5,
  language: 'TypeScript',
  forks_count: 1,
  open_issues_count: 2,
  default_branch: 'main',
  topics: ['relay'],
  visibility: 'public',
  permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
};

const issueResponse = {
  number: 1,
  id: 11,
  title: 'Issue',
  body: 'Body',
  user: ownerResponse,
  labels: [],
  state: 'closed',
  locked: false,
  assignee: null,
  assignees: [],
  milestone: null,
  comments: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  closed_at: '2026-01-03T00:00:00Z',
  author_association: 'OWNER',
  reactions: { total_count: 0 },
};

const prResponse = {
  number: 1,
  id: 21,
  title: 'PR',
  body: 'Body',
  user: ownerResponse,
  state: 'open',
  draft: false,
  locked: false,
  mergeable: true,
  mergeable_state: 'clean',
  merged: true,
  merged_at: '2026-01-04T00:00:00Z',
  merged_by: ownerResponse,
  base: { ref: 'main', sha: 'base-sha', repo: { name: 'repo', full_name: 'octo/repo' } },
  head: { ref: 'feature', sha: 'head-sha', repo: { name: 'repo', full_name: 'octo/repo' } },
  requested_reviewers: [],
  labels: [],
  comments: 0,
  review_comments: 0,
  commits: 1,
  additions: 1,
  deletions: 0,
  changed_files: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

const fileResponse = {
  name: 'README.md',
  path: 'README.md',
  sha: 'file-sha',
  size: 5,
  url: 'https://api.github.test/file',
  html_url: 'https://github.test/file',
  git_url: 'https://api.github.test/git/file',
  download_url: 'https://raw.github.test/file',
  type: 'file',
  content: Buffer.from('hello', 'utf8').toString('base64'),
  encoding: 'base64',
};

const branchResponse = {
  name: 'main',
  commit: { sha: 'branch-sha', url: 'https://api.github.test/commit/branch-sha' },
  protected: false,
};

const commitResponse = {
  sha: 'commit-sha',
  url: 'https://api.github.test/commit/commit-sha',
  html_url: 'https://github.test/commit/commit-sha',
  commit: {
    message: 'commit',
    author: { name: 'Octo', email: 'octo@example.com', date: '2026-01-01T00:00:00Z' },
    committer: { name: 'Octo', email: 'octo@example.com', date: '2026-01-01T00:00:00Z' },
  },
};

const orgResponse = {
  login: 'agentworkforce',
  id: 31,
  description: 'Agents',
  url: 'https://api.github.test/orgs/agentworkforce',
  avatar_url: 'https://github.test/avatar.png',
};

function responseFor(
  method: GitHubApiRequestMethod,
  path: string,
  options: GitHubApiRequestOptions
): unknown {
  if (method === 'GET' && path === '/user/repos') return [repoResponse];
  if (method === 'GET' && path === '/repos/octo/repo') return repoResponse;
  if (method === 'GET' && path === '/repos/octo/repo/issues') return [issueResponse];
  if (method === 'POST' && path === '/repos/octo/repo/issues') return issueResponse;
  if (method === 'PATCH' && path === '/repos/octo/repo/issues/1') return issueResponse;
  if (method === 'GET' && path === '/repos/octo/repo/pulls') return [prResponse];
  if (method === 'GET' && path === '/repos/octo/repo/pulls/1') return prResponse;
  if (method === 'POST' && path === '/repos/octo/repo/pulls') return prResponse;
  if (method === 'PATCH' && path === '/repos/octo/repo/pulls/1') return prResponse;
  if (method === 'PUT' && path === '/repos/octo/repo/pulls/1/merge') return { merged: true };
  if (method === 'GET' && path === '/repos/octo/repo/contents/README.md') return fileResponse;
  if (method === 'PUT' && path === '/repos/octo/repo/contents/new.md') return {};
  if (method === 'PUT' && path === '/repos/octo/repo/contents/README.md') {
    return options.body && 'sha' in (options.body as Record<string, unknown>)
      ? { content: fileResponse }
      : {};
  }
  if (method === 'DELETE' && path === '/repos/octo/repo/contents/README.md') return {};
  if (method === 'GET' && path === '/repos/octo/repo/branches/main') return branchResponse;
  if (method === 'POST' && path === '/repos/octo/repo/git/refs') return {};
  if (method === 'GET' && path === '/repos/octo/repo/branches') return [branchResponse];
  if (method === 'GET' && path === '/repos/octo/repo/commits') return [commitResponse];
  if (method === 'POST' && path === '/repos/octo/repo/git/commits') return commitResponse;
  if (method === 'GET' && path === '/user') return userResponse;
  if (method === 'GET' && path === '/user/orgs') return [orgResponse];

  throw new Error(`No fake response for ${method} ${path}`);
}
