import { GitHubAdapterFactory } from './adapter.js';
import type {
  BranchInfo,
  CommitInfo,
  CreateBranchParams,
  CreateCommitParams,
  CreateFileParams,
  CreateIssueParams,
  CreatePRParams,
  DeleteFileParams,
  GitHubFile,
  GitHubAction,
  GitHubActionName,
  GitHubActionOutputMap,
  GitHubActionParamsMap,
  GitHubActionResult,
  GitHubApiRequestMethod,
  GitHubApiRequestOptions,
  GitHubClientInterface,
  GitHubRuntime,
  GitHubRuntimeConfig,
  GitHubRuntimeDetectionResult,
  GitHubUserSummary,
  Issue,
  ListCommitsParams,
  ListFilesParams,
  ListIssuesParams,
  ListOrganizationsParams,
  ListPRsParams,
  ListReposParams,
  MergePRParams,
  OrganizationInfo,
  PR,
  Repo,
  UpdateFileParams,
  UpdateIssueParams,
  UpdatePRParams,
} from './types.js';

export type GitHubListIssueOptions = Omit<ListIssuesParams, 'owner' | 'repo'>;
export type GitHubCreateIssueOptions = Omit<CreateIssueParams, 'owner' | 'repo' | 'title' | 'body'>;
export type GitHubIssueUpdates = Omit<UpdateIssueParams, 'owner' | 'repo' | 'issueNumber'>;
export type GitHubListPROptions = Omit<ListPRsParams, 'owner' | 'repo'>;
export type GitHubCreatePROptions = Omit<
  CreatePRParams,
  'owner' | 'repo' | 'title' | 'body' | 'base' | 'head'
>;
export type GitHubListFileOptions = Omit<ListFilesParams, 'owner' | 'repo' | 'path'>;
export type GitHubCreateFileOptions = Omit<
  CreateFileParams,
  'owner' | 'repo' | 'path' | 'content' | 'message'
>;
export type GitHubUpdatePROptions = Omit<UpdatePRParams, 'owner' | 'repo' | 'pullNumber'>;
export type GitHubMergePROptions = Omit<MergePRParams, 'owner' | 'repo' | 'pullNumber'>;
export type GitHubUpdateFileOptions = Omit<
  UpdateFileParams,
  'owner' | 'repo' | 'path' | 'content' | 'message' | 'sha'
>;
export type GitHubDeleteFileOptions = Omit<DeleteFileParams, 'owner' | 'repo' | 'path' | 'sha' | 'message'>;
export type GitHubCreateBranchOptions = Omit<CreateBranchParams, 'owner' | 'repo' | 'branch'>;
export type GitHubListCommitOptions = Omit<ListCommitsParams, 'owner' | 'repo'>;
export type GitHubCreateCommitOptions = Omit<
  CreateCommitParams,
  'owner' | 'repo' | 'message' | 'tree' | 'parents'
>;
export type GitHubListOrganizationOptions = Omit<ListOrganizationsParams, 'username'>;

/**
 * High-level GitHub primitive client.
 *
 * The client lazily auto-detects the runtime using the adapter factory and then
 * delegates typed action methods to the selected local `gh` or cloud runtime.
 */
export class GitHubClient {
  private readonly adapterPromise: Promise<GitHubClientInterface>;

  constructor(config: GitHubRuntimeConfig = {}) {
    this.adapterPromise = GitHubAdapterFactory.create(config);
  }

  /**
   * Create a GitHub client and eagerly resolve runtime detection.
   */
  static async create(config: GitHubRuntimeConfig = {}): Promise<GitHubClient> {
    const client = new GitHubClient(config);
    await client.getAdapter();
    return client;
  }

  /**
   * Inspect runtime availability without creating a client.
   */
  static detect(config: GitHubRuntimeConfig = {}): Promise<GitHubRuntimeDetectionResult> {
    return GitHubAdapterFactory.detect(config);
  }

  /**
   * Detect the runtime that would be selected for the supplied configuration.
   */
  static detectRuntime(config: GitHubRuntimeConfig = {}): Promise<GitHubRuntime> {
    return GitHubAdapterFactory.detectRuntime(config);
  }

  /**
   * Return the selected low-level adapter.
   */
  getAdapter(): Promise<GitHubClientInterface> {
    return this.adapterPromise;
  }

  /**
   * Return the runtime selected by auto-detection or explicit configuration.
   */
  async getRuntime(): Promise<GitHubRuntime> {
    return (await this.getAdapter()).getRuntime();
  }

  /**
   * Check whether the selected runtime is authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    return (await this.getAdapter()).isAuthenticated();
  }

  /**
   * Fetch the authenticated GitHub user for the selected runtime.
   */
  async getCurrentUser(): Promise<GitHubUserSummary> {
    return (await this.getAdapter()).getCurrentUser();
  }

  /**
   * Execute a raw GitHub API request through the selected adapter.
   */
  async request<TResponse = unknown>(
    method: GitHubApiRequestMethod,
    path: string,
    options?: GitHubApiRequestOptions
  ): Promise<TResponse> {
    return (await this.getAdapter()).request<TResponse>(method, path, options);
  }

  executeAction<Name extends GitHubAction>(
    action: Name,
    params: GitHubActionParamsMap[Name]
  ): Promise<GitHubActionResult<GitHubActionOutputMap[Name]>>;
  executeAction<TOutput = unknown>(
    action: GitHubAction | GitHubActionName,
    params?: unknown
  ): Promise<GitHubActionResult<TOutput>>;
  /**
   * Execute any registered GitHub primitive action by action name.
   */
  async executeAction<TOutput = unknown>(
    action: GitHubAction | GitHubActionName,
    params?: unknown
  ): Promise<GitHubActionResult<TOutput>> {
    return (await this.getAdapter()).executeAction(action, params);
  }

  /**
   * List repositories visible to the authenticated GitHub identity.
   */
  async listRepos(options: ListReposParams = {}): Promise<Repo[]> {
    return (await this.getAdapter()).listRepositories(options);
  }

  /**
   * Fetch a repository by owner and name.
   */
  async getRepo(owner: string, repo: string): Promise<Repo> {
    return (await this.getAdapter()).getRepository({ owner, repo });
  }

  /**
   * List issues for a repository.
   */
  async listIssues(owner: string, repo: string, options: GitHubListIssueOptions = {}): Promise<Issue[]> {
    return (await this.getAdapter()).listIssues({ owner, repo, ...options });
  }

  /**
   * Create an issue in a repository.
   */
  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body?: string,
    options: GitHubCreateIssueOptions = {}
  ): Promise<Issue> {
    return (await this.getAdapter()).createIssue({ owner, repo, title, body, ...options });
  }

  /**
   * Update an existing issue by issue number.
   */
  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    updates: GitHubIssueUpdates
  ): Promise<Issue> {
    return (await this.getAdapter()).updateIssue({
      owner,
      repo,
      issueNumber: number,
      ...updates,
    });
  }

  /**
   * Close an issue by issue number.
   */
  async closeIssue(owner: string, repo: string, number: number): Promise<Issue> {
    return (await this.getAdapter()).closeIssue({ owner, repo, issueNumber: number });
  }

  /**
   * List pull requests for a repository.
   */
  async listPRs(owner: string, repo: string, options: GitHubListPROptions = {}): Promise<PR[]> {
    return (await this.getAdapter()).listPullRequests({ owner, repo, ...options });
  }

  /**
   * Fetch a pull request by pull request number.
   */
  async getPR(owner: string, repo: string, number: number): Promise<PR> {
    return (await this.getAdapter()).getPullRequest({ owner, repo, pullNumber: number });
  }

  /**
   * Create a pull request.
   */
  async createPR(
    owner: string,
    repo: string,
    title: string,
    body: string | undefined,
    base: string,
    head: string,
    options: GitHubCreatePROptions = {}
  ): Promise<PR> {
    return (await this.getAdapter()).createPullRequest({
      owner,
      repo,
      title,
      body,
      base,
      head,
      ...options,
    });
  }

  /**
   * Update an existing pull request by pull request number.
   */
  async updatePR(owner: string, repo: string, number: number, updates: GitHubUpdatePROptions): Promise<PR> {
    return (await this.getAdapter()).updatePullRequest({
      owner,
      repo,
      pullNumber: number,
      ...updates,
    });
  }

  /**
   * Merge a pull request and return the refreshed pull request.
   */
  async mergePR(
    owner: string,
    repo: string,
    number: number,
    options: GitHubMergePROptions = {}
  ): Promise<PR> {
    return (await this.getAdapter()).mergePullRequest({
      owner,
      repo,
      pullNumber: number,
      ...options,
    });
  }

  /**
   * List files or directories at a repository path.
   */
  async listFiles(
    owner: string,
    repo: string,
    path = '',
    options: GitHubListFileOptions = {}
  ): Promise<GitHubFile[]> {
    return (await this.getAdapter()).listFiles({ owner, repo, path, ...options });
  }

  /**
   * Read a repository file and return decoded UTF-8 content.
   */
  async readFile(owner: string, repo: string, path: string, ref?: string): Promise<string> {
    return (await this.getAdapter()).readFile({ owner, repo, path, ref });
  }

  /**
   * Create a repository file with a commit message.
   */
  async createFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    options: GitHubCreateFileOptions = {}
  ): Promise<void> {
    await (
      await this.getAdapter()
    ).createFile({
      owner,
      repo,
      path,
      content,
      message,
      ...options,
    });
  }

  /**
   * Update a repository file with a commit message.
   */
  async updateFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    sha: string,
    options: GitHubUpdateFileOptions = {}
  ): Promise<GitHubFile> {
    return (await this.getAdapter()).updateFile({
      owner,
      repo,
      path,
      content,
      message,
      sha,
      ...options,
    });
  }

  /**
   * Delete a repository file with a commit message.
   */
  async deleteFile(
    owner: string,
    repo: string,
    path: string,
    sha: string,
    message: string,
    options: GitHubDeleteFileOptions = {}
  ): Promise<void> {
    await (
      await this.getAdapter()
    ).deleteFile({
      owner,
      repo,
      path,
      sha,
      message,
      ...options,
    });
  }

  /**
   * List repository branches.
   */
  async listBranches(owner: string, repo: string): Promise<BranchInfo[]> {
    return (await this.getAdapter()).listBranches({ owner, repo });
  }

  /**
   * Create a branch from another branch, or from the repository default branch.
   */
  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    options: GitHubCreateBranchOptions = {}
  ): Promise<void> {
    await (await this.getAdapter()).createBranch({ owner, repo, branch, ...options });
  }

  /**
   * List repository commits.
   */
  async listCommits(
    owner: string,
    repo: string,
    options: GitHubListCommitOptions = {}
  ): Promise<CommitInfo[]> {
    return (await this.getAdapter()).listCommits({ owner, repo, ...options });
  }

  /**
   * Create a Git commit object.
   */
  async createCommit(
    owner: string,
    repo: string,
    message: string,
    tree: string,
    parents: string[],
    options: GitHubCreateCommitOptions = {}
  ): Promise<CommitInfo> {
    return (await this.getAdapter()).createCommit({
      owner,
      repo,
      message,
      tree,
      parents,
      ...options,
    });
  }

  /**
   * Fetch the authenticated user, or a public user by username.
   */
  async getUser(username?: string): Promise<GitHubUserSummary> {
    return (await this.getAdapter()).getUser(username ? { username } : undefined);
  }

  /**
   * List organizations for the authenticated user, or for a public user.
   */
  async listOrganizations(
    username?: string,
    options: GitHubListOrganizationOptions = {}
  ): Promise<OrganizationInfo[]> {
    return (await this.getAdapter()).listOrganizations({ username, ...options });
  }
}
