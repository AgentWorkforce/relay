import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  createBranch as createBranchAction,
  listBranches as listBranchesAction,
} from './actions/branches.js';
import { createCommit as createCommitAction, listCommits as listCommitsAction } from './actions/commits.js';
import {
  createFile as createFileAction,
  deleteFile as deleteFileAction,
  listFiles as listFilesAction,
  readFile as readFileAction,
  updateFile as updateFileAction,
} from './actions/files.js';
import {
  createIssue as createIssueAction,
  listIssues as listIssuesAction,
  updateIssue as updateIssueAction,
} from './actions/issues.js';
import {
  createPR as createPRAction,
  getPR as getPRAction,
  listPRs as listPRsAction,
  mergePR as mergePRAction,
  updatePR as updatePRAction,
} from './actions/pulls.js';
import { getRepo as getRepoAction, listRepos as listReposAction } from './actions/repos.js';
import { getUser as getUserAction, listOrganizations as listOrganizationsAction } from './actions/users.js';
import { nonEmpty, trimTrailingSlash } from './actions/utils.js';
import {
  DEFAULT_GH_PATH,
  DEFAULT_MAX_RETRIES,
  DEFAULT_NANGO_BASE_URL,
  DEFAULT_NANGO_PROVIDER_CONFIG_KEY,
  DEFAULT_RELAY_CLOUD_GITHUB_PROXY_ENDPOINT,
  DEFAULT_TIMEOUT,
  DEFAULT_USER_AGENT,
} from './constants.js';
import {
  GitHubAction,
  GitHubApiError,
  GitHubClientInterface,
  type BranchInfo,
  type CloseIssueParams,
  type CommitInfo,
  type CreateBranchParams,
  type CreateCommitParams,
  type CreateFileParams,
  type CreateIssueParams,
  type CreatePRParams,
  type DeleteFileParams,
  type FileInfo,
  type GetPRParams,
  type GetRepoParams,
  type GetUserParams,
  type GitHubActionName,
  type GitHubActionOutputMap,
  type GitHubActionParamsMap,
  type GitHubActionResult,
  type GitHubRuntime,
  type GitHubRuntimeAvailability,
  type GitHubRuntimeConfig,
  type GitHubRuntimeDetectionResult,
  type GitHubRuntimeDetectionSource,
  type Issue,
  type ListCommitsParams,
  type ListFilesParams,
  type ListIssuesParams,
  type ListOrganizationsParams,
  type ListPRsParams,
  type ListReposParams,
  type MergePRParams,
  type OrganizationInfo,
  type PullRequest,
  type ReadFileParams,
  type Repository,
  type RepositoryRef,
  type RequiredGitHubRuntimeConfig,
  type UpdateFileParams,
  type UpdateIssueParams,
  type UpdatePRParams,
} from './types.js';

const execFileAsync = promisify(execFile);

export function normalizeGitHubRuntimeConfig(config: GitHubRuntimeConfig = {}): RequiredGitHubRuntimeConfig {
  const env = config.env ?? process.env;
  const nango = config.nango ?? {};
  const relayCloud = config.relayCloud ?? {};

  return {
    ...config,
    runtime: config.runtime ?? 'auto',
    ghPath: nonEmpty(config.ghPath) ?? nonEmpty(env.GH_PATH) ?? DEFAULT_GH_PATH,
    cwd: config.cwd,
    env,
    timeout: config.timeout ?? DEFAULT_TIMEOUT,
    retryOnRateLimit: config.retryOnRateLimit ?? true,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
    fetch: config.fetch,
    nango: {
      connectionId:
        nonEmpty(nango.connectionId) ??
        nonEmpty(env.NANGO_GITHUB_CONNECTION_ID) ??
        nonEmpty(env.GITHUB_NANGO_CONNECTION_ID) ??
        nonEmpty(env.NANGO_CONNECTION_ID),
      providerConfigKey:
        nonEmpty(nango.providerConfigKey) ??
        nonEmpty(env.NANGO_GITHUB_PROVIDER_CONFIG_KEY) ??
        nonEmpty(env.GITHUB_NANGO_PROVIDER_CONFIG_KEY) ??
        nonEmpty(env.NANGO_PROVIDER_CONFIG_KEY) ??
        DEFAULT_NANGO_PROVIDER_CONFIG_KEY,
      secretKey: nonEmpty(nango.secretKey) ?? nonEmpty(env.NANGO_SECRET_KEY),
      baseUrl:
        trimTrailingSlash(nonEmpty(nango.baseUrl) ?? nonEmpty(env.NANGO_HOST)) ?? DEFAULT_NANGO_BASE_URL,
    },
    relayCloud: {
      apiUrl:
        trimTrailingSlash(
          nonEmpty(relayCloud.apiUrl) ?? nonEmpty(env.RELAY_CLOUD_API_URL) ?? nonEmpty(env.CLOUD_API_URL)
        ) ?? undefined,
      accessToken:
        nonEmpty(relayCloud.accessToken) ??
        nonEmpty(env.RELAY_CLOUD_API_TOKEN) ??
        nonEmpty(env.CLOUD_API_ACCESS_TOKEN) ??
        nonEmpty(env.WORKSPACE_TOKEN),
      workspaceId: nonEmpty(relayCloud.workspaceId) ?? nonEmpty(env.WORKSPACE_ID),
      workspaceToken: nonEmpty(relayCloud.workspaceToken) ?? nonEmpty(env.WORKSPACE_TOKEN),
      endpoint:
        nonEmpty(relayCloud.endpoint) ??
        nonEmpty(env.RELAY_CLOUD_GITHUB_PROXY_ENDPOINT) ??
        DEFAULT_RELAY_CLOUD_GITHUB_PROXY_ENDPOINT,
    },
  };
}

export class GitHubRuntimeDetector {
  static async detect(config: GitHubRuntimeConfig = {}): Promise<GitHubRuntimeDetectionResult> {
    const normalized = normalizeGitHubRuntimeConfig(config);
    const [local, cloud] = await Promise.all([
      this.testRuntime('local', normalized),
      this.testRuntime('cloud', normalized),
    ]);

    const requestedRuntime = normalized.runtime;

    if (requestedRuntime === 'local' || requestedRuntime === 'cloud') {
      const selected = requestedRuntime === 'local' ? local : cloud;
      return detectionResult({
        runtime: requestedRuntime,
        requestedRuntime,
        source: 'config',
        selected,
        local,
        cloud,
        reason: selected.available
          ? `Runtime explicitly configured as ${requestedRuntime}.`
          : `Runtime explicitly configured as ${requestedRuntime}, but availability check failed: ${selected.reason}`,
      });
    }

    if (hasNangoConfig(normalized)) {
      return detectionResult({
        runtime: 'cloud',
        requestedRuntime,
        source: 'nango',
        selected: cloud,
        local,
        cloud,
        reason: cloud.available
          ? 'Using cloud runtime because Nango configuration is available.'
          : `Cloud runtime selected from Nango configuration, but availability check failed: ${cloud.reason}`,
      });
    }

    if (hasCloudEnvironment(normalized.env)) {
      if (cloud.available) {
        return detectionResult({
          runtime: 'cloud',
          requestedRuntime,
          source: 'environment',
          selected: cloud,
          local,
          cloud,
          reason: 'Using cloud runtime because a cloud workspace or deployment environment was detected.',
        });
      }

      if (local.available) {
        return detectionResult({
          runtime: 'local',
          requestedRuntime,
          source: 'gh-cli',
          selected: local,
          local,
          cloud,
          reason:
            'Cloud environment was detected, but cloud credentials were unavailable; using local gh CLI.',
        });
      }
    }

    if (local.available) {
      return detectionResult({
        runtime: 'local',
        requestedRuntime,
        source: 'gh-cli',
        selected: local,
        local,
        cloud,
        reason: 'Using local runtime because gh CLI is available.',
      });
    }

    return detectionResult({
      runtime: 'cloud',
      requestedRuntime,
      source: 'fallback',
      selected: cloud,
      local,
      cloud,
      reason: cloud.available
        ? 'Using cloud runtime because local gh CLI was unavailable.'
        : 'Falling back to cloud runtime because local gh CLI was unavailable; cloud credentials may still be required.',
    });
  }

  static async testRuntime(
    runtime: GitHubRuntime,
    config: GitHubRuntimeConfig = {}
  ): Promise<GitHubRuntimeAvailability> {
    const normalized = normalizeGitHubRuntimeConfig(config);

    if (runtime === 'local') {
      return testLocalRuntime(normalized);
    }

    return testCloudRuntime(normalized);
  }

  static async detectRuntime(config: GitHubRuntimeConfig = {}): Promise<GitHubRuntime> {
    const result = await this.detect(config);
    return result.runtime;
  }
}

export abstract class BaseGitHubAdapter extends GitHubClientInterface {
  private retryUsed = false;

  constructor(config: GitHubRuntimeConfig = {}) {
    super(normalizeGitHubRuntimeConfig(config));
  }

  executeAction<Name extends GitHubAction>(
    action: Name,
    params: GitHubActionParamsMap[Name]
  ): Promise<GitHubActionResult<GitHubActionOutputMap[Name]>>;
  executeAction<TOutput = unknown>(
    action: GitHubAction | GitHubActionName,
    params?: unknown
  ): Promise<GitHubActionResult<TOutput>>;
  async executeAction<TOutput = unknown>(
    action: GitHubAction | GitHubActionName,
    params?: unknown
  ): Promise<GitHubActionResult<TOutput>> {
    const startedAt = Date.now();
    this.retryUsed = false;

    try {
      const data = (await this.dispatchAction(action, params)) as TOutput;
      return {
        success: true,
        output: stringifyOutput(data),
        data,
        metadata: {
          runtime: this.getRuntime(),
          executionTime: Date.now() - startedAt,
          retried: this.retryUsed,
        },
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: errorMessage(error),
        metadata: {
          runtime: this.getRuntime(),
          executionTime: Date.now() - startedAt,
          retried: this.retryUsed,
        },
      };
    }
  }

  async listRepositories(params: ListReposParams = {}): Promise<Repository[]> {
    return listReposAction(this, params);
  }

  async getRepository(params: GetRepoParams): Promise<Repository> {
    return getRepoAction(this, params.owner, params.repo);
  }

  async listIssues(params: ListIssuesParams): Promise<Issue[]> {
    const { owner, repo, ...options } = params;
    return listIssuesAction(this, owner, repo, options);
  }

  async createIssue(params: CreateIssueParams): Promise<Issue> {
    const { owner, repo, title, body, ...options } = params;
    return createIssueAction(this, owner, repo, title, body, options);
  }

  async updateIssue(params: UpdateIssueParams): Promise<Issue> {
    const { owner, repo, issueNumber, ...updates } = params;
    return updateIssueAction(this, owner, repo, issueNumber, updates);
  }

  async closeIssue(params: CloseIssueParams): Promise<Issue> {
    return updateIssueAction(this, params.owner, params.repo, params.issueNumber, {
      state: 'closed',
    });
  }

  async listPullRequests(params: ListPRsParams): Promise<PullRequest[]> {
    const { owner, repo, ...options } = params;
    return listPRsAction(this, owner, repo, options);
  }

  async getPullRequest(params: GetPRParams): Promise<PullRequest> {
    return getPRAction(this, params.owner, params.repo, params.pullNumber);
  }

  async createPullRequest(params: CreatePRParams): Promise<PullRequest> {
    const { owner, repo, title, body, base, head, ...options } = params;
    return createPRAction(this, owner, repo, title, body, base, head, options);
  }

  async updatePullRequest(params: UpdatePRParams): Promise<PullRequest> {
    const { owner, repo, pullNumber, ...updates } = params;
    return updatePRAction(this, owner, repo, pullNumber, updates);
  }

  async mergePullRequest(params: MergePRParams): Promise<PullRequest> {
    const { owner, repo, pullNumber, ...options } = params;
    return mergePRAction(this, owner, repo, pullNumber, options);
  }

  async listFiles(params: ListFilesParams): Promise<FileInfo[]> {
    const { owner, repo, path, ...options } = params;
    return listFilesAction(this, owner, repo, path, options);
  }

  async readFile(params: ReadFileParams): Promise<string> {
    return readFileAction(this, params.owner, params.repo, params.path, params.ref);
  }

  async createFile(params: CreateFileParams): Promise<void> {
    const { owner, repo, path, content, message, ...options } = params;
    return createFileAction(this, owner, repo, path, content, message, options);
  }

  async updateFile(params: UpdateFileParams): Promise<FileInfo> {
    const { owner, repo, path, content, message, sha, ...options } = params;
    return updateFileAction(this, owner, repo, path, content, message, sha, options);
  }

  async deleteFile(params: DeleteFileParams): Promise<void> {
    const { owner, repo, path, sha, message, ...options } = params;
    return deleteFileAction(this, owner, repo, path, sha, message, options);
  }

  async listBranches(params: RepositoryRef): Promise<BranchInfo[]> {
    return listBranchesAction(this, params.owner, params.repo);
  }

  async createBranch(params: CreateBranchParams): Promise<void> {
    return createBranchAction(this, params);
  }

  async listCommits(params: ListCommitsParams): Promise<CommitInfo[]> {
    return listCommitsAction(this, params);
  }

  async createCommit(params: CreateCommitParams): Promise<CommitInfo> {
    return createCommitAction(this, params);
  }

  async getUser(params?: GetUserParams): Promise<GitHubActionOutputMap[GitHubAction.GetUser]> {
    return getUserAction(this, params);
  }

  async listOrganizations(params?: ListOrganizationsParams): Promise<OrganizationInfo[]> {
    return listOrganizationsAction(this, params);
  }

  protected async executeWithRetries<T>(operation: () => Promise<T>): Promise<T> {
    const maxRetries = this.config.retryOnRateLimit ? this.config.maxRetries : 0;
    let attempt = 0;

    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= maxRetries || !this.isRetryableError(error)) {
          throw error;
        }

        attempt += 1;
        this.retryUsed = true;
        await delay(this.retryDelayMs(attempt, error));
      }
    }
  }

  protected isRetryableError(error: unknown): boolean {
    const status = statusFromError(error);
    return status === 403 || status === 429 || (typeof status === 'number' && status >= 500);
  }

  protected retryDelayMs(attempt: number, error: unknown): number {
    const reset = resetHeaderFromError(error);
    if (reset) {
      const resetMs = Number(reset) * 1000;
      if (Number.isFinite(resetMs) && resetMs > Date.now()) {
        return Math.min(resetMs - Date.now(), 60_000);
      }
    }

    return Math.min(500 * 2 ** (attempt - 1), 10_000);
  }

  private async dispatchAction(action: GitHubAction | GitHubActionName, params: unknown): Promise<unknown> {
    switch (action) {
      case GitHubAction.ListRepos:
        return this.listRepositories(params as ListReposParams | undefined);
      case GitHubAction.GetRepo:
        return this.getRepository(params as GetRepoParams);
      case GitHubAction.ListIssues:
        return this.listIssues(params as ListIssuesParams);
      case GitHubAction.CreateIssue:
        return this.createIssue(params as CreateIssueParams);
      case GitHubAction.UpdateIssue:
        return this.updateIssue(params as UpdateIssueParams);
      case GitHubAction.CloseIssue:
        return this.closeIssue(params as CloseIssueParams);
      case GitHubAction.ListPRs:
        return this.listPullRequests(params as ListPRsParams);
      case GitHubAction.GetPR:
        return this.getPullRequest(params as GetPRParams);
      case GitHubAction.CreatePR:
        return this.createPullRequest(params as CreatePRParams);
      case GitHubAction.UpdatePR:
        return this.updatePullRequest(params as UpdatePRParams);
      case GitHubAction.MergePR:
        return this.mergePullRequest(params as MergePRParams);
      case GitHubAction.ListFiles:
        return this.listFiles(params as ListFilesParams);
      case GitHubAction.ReadFile:
        return this.readFile(params as ReadFileParams);
      case GitHubAction.CreateFile:
        return this.createFile(params as CreateFileParams);
      case GitHubAction.UpdateFile:
        return this.updateFile(params as UpdateFileParams);
      case GitHubAction.DeleteFile:
        return this.deleteFile(params as DeleteFileParams);
      case GitHubAction.CreateBranch:
        return this.createBranch(params as CreateBranchParams);
      case GitHubAction.ListBranches:
        return this.listBranches(params as RepositoryRef);
      case GitHubAction.ListCommits:
        return this.listCommits(params as ListCommitsParams);
      case GitHubAction.CreateCommit:
        return this.createCommit(params as CreateCommitParams);
      case GitHubAction.GetUser:
        return this.getUser(params as GetUserParams | undefined);
      case GitHubAction.ListOrganizations:
        return this.listOrganizations(params as ListOrganizationsParams | undefined);
      default:
        throw new Error(`Unsupported GitHub action: ${String(action)}`);
    }
  }
}

export class GitHubAdapterFactory {
  static async create(config: GitHubRuntimeConfig = {}): Promise<GitHubClientInterface> {
    const detection = await GitHubRuntimeDetector.detect(config);
    const runtimeConfig: GitHubRuntimeConfig = {
      ...config,
      runtime: detection.runtime,
    };

    if (detection.runtime === 'local') {
      const { GhCliClient } = await import('./local-runtime.js');
      return new GhCliClient(runtimeConfig);
    }

    const { NangoClient } = await import('./cloud-runtime.js');
    return new NangoClient(runtimeConfig);
  }

  static detect(config: GitHubRuntimeConfig = {}): Promise<GitHubRuntimeDetectionResult> {
    return GitHubRuntimeDetector.detect(config);
  }

  static detectRuntime(config: GitHubRuntimeConfig = {}): Promise<GitHubRuntime> {
    return GitHubRuntimeDetector.detectRuntime(config);
  }

  static testRuntime(
    runtime: GitHubRuntime,
    config: GitHubRuntimeConfig = {}
  ): Promise<GitHubRuntimeAvailability> {
    return GitHubRuntimeDetector.testRuntime(runtime, config);
  }
}

export const GitHubClientFactory = GitHubAdapterFactory;

export function detectGitHubRuntime(config: GitHubRuntimeConfig = {}): Promise<GitHubRuntimeDetectionResult> {
  return GitHubRuntimeDetector.detect(config);
}

export function createGitHubAdapter(config: GitHubRuntimeConfig = {}): Promise<GitHubClientInterface> {
  return GitHubAdapterFactory.create(config);
}

async function testLocalRuntime(config: RequiredGitHubRuntimeConfig): Promise<GitHubRuntimeAvailability> {
  try {
    const { stdout } = await execFileAsync(config.ghPath, ['--version'], {
      cwd: config.cwd,
      env: config.env,
      timeout: Math.min(config.timeout, 5_000),
      maxBuffer: 1024 * 1024,
    });
    const version = String(stdout).split('\n')[0]?.trim();

    return {
      runtime: 'local',
      available: true,
      reason: version ? `gh CLI available: ${version}` : 'gh CLI available.',
      details: version ? { version } : undefined,
    };
  } catch (error) {
    return {
      runtime: 'local',
      available: false,
      reason: `gh CLI was not available at "${config.ghPath}".`,
      error: errorMessage(error),
    };
  }
}

async function testCloudRuntime(config: RequiredGitHubRuntimeConfig): Promise<GitHubRuntimeAvailability> {
  if (hasNangoConfig(config)) {
    return {
      runtime: 'cloud',
      available: true,
      reason: 'Nango configuration is available.',
      details: {
        providerConfigKey: config.nango.providerConfigKey ?? DEFAULT_NANGO_PROVIDER_CONFIG_KEY,
        hasConnectionId: Boolean(config.nango.connectionId),
      },
    };
  }

  if (hasRelayCloudConfig(config)) {
    return {
      runtime: 'cloud',
      available: true,
      reason: 'Relay cloud API configuration is available.',
      details: {
        endpoint: config.relayCloud.endpoint ?? DEFAULT_RELAY_CLOUD_GITHUB_PROXY_ENDPOINT,
        hasWorkspaceId: Boolean(config.relayCloud.workspaceId),
      },
    };
  }

  return {
    runtime: 'cloud',
    available: false,
    reason: 'No Nango or relay-cloud GitHub proxy configuration was found.',
  };
}

function detectionResult(input: {
  runtime: GitHubRuntime;
  requestedRuntime: GitHubRuntimeDetectionResult['requestedRuntime'];
  source: GitHubRuntimeDetectionSource;
  selected: GitHubRuntimeAvailability;
  local: GitHubRuntimeAvailability;
  cloud: GitHubRuntimeAvailability;
  reason: string;
}): GitHubRuntimeDetectionResult {
  return {
    runtime: input.runtime,
    requestedRuntime: input.requestedRuntime,
    source: input.source,
    available: input.selected.available,
    reason: input.reason,
    checkedAt: new Date().toISOString(),
    local: input.local,
    cloud: input.cloud,
  };
}

function hasNangoConfig(config: RequiredGitHubRuntimeConfig): boolean {
  return Boolean(config.nango.secretKey);
}

function hasRelayCloudConfig(config: RequiredGitHubRuntimeConfig): boolean {
  return Boolean(config.relayCloud.apiUrl && config.relayCloud.accessToken);
}

function hasCloudEnvironment(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.WORKSPACE_ID ||
    env.CLOUD_API_URL ||
    env.VERCEL ||
    env.RAILWAY_ENVIRONMENT ||
    env.FLY_APP_NAME ||
    env.AWS_REGION ||
    env.GOOGLE_CLOUD_PROJECT ||
    env.NODE_ENV === 'production'
  );
}

function statusFromError(error: unknown): number | undefined {
  if (error instanceof GitHubApiError) {
    return error.status;
  }

  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }

  return undefined;
}

function resetHeaderFromError(error: unknown): string | undefined {
  const headers =
    error instanceof GitHubApiError
      ? error.responseHeaders
      : typeof error === 'object' && error !== null && 'responseHeaders' in error
        ? (error as { responseHeaders?: Record<string, string> }).responseHeaders
        : undefined;

  return headers?.['x-ratelimit-reset'] ?? headers?.['X-RateLimit-Reset'];
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'undefined') {
    return '';
  }

  return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
