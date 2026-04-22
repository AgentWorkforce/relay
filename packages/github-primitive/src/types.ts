export type GitHubRuntime = 'local' | 'cloud';

export type GitHubRuntimePreference = GitHubRuntime | 'auto';

export type GitHubRuntimeDetectionSource = 'config' | 'environment' | 'nango' | 'gh-cli' | 'fallback';

export type GitHubApiRequestMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export enum GitHubAction {
  ListRepos = 'listRepos',
  GetRepo = 'getRepo',
  ListIssues = 'listIssues',
  CreateIssue = 'createIssue',
  UpdateIssue = 'updateIssue',
  CloseIssue = 'closeIssue',
  ListPRs = 'listPRs',
  GetPR = 'getPR',
  CreatePR = 'createPR',
  UpdatePR = 'updatePR',
  MergePR = 'mergePR',
  ListFiles = 'listFiles',
  ReadFile = 'readFile',
  CreateFile = 'createFile',
  UpdateFile = 'updateFile',
  DeleteFile = 'deleteFile',
  CreateBranch = 'createBranch',
  ListBranches = 'listBranches',
  ListCommits = 'listCommits',
  CreateCommit = 'createCommit',
  GetUser = 'getUser',
  ListOrganizations = 'listOrganizations',
}

export type GitHubActionName = `${GitHubAction}`;

export const GITHUB_ACTIONS = Object.values(GitHubAction);

export type GitHubJsonPrimitive = string | number | boolean | null;
export type GitHubQueryValue = string | number | boolean | null | undefined;
export type GitHubQueryParams = Record<string, GitHubQueryValue | GitHubQueryValue[]>;

export interface GitHubNangoConfig {
  /** Nango connection id for the GitHub integration. */
  connectionId?: string;
  /** Nango provider config key. Defaults to github when omitted. */
  providerConfigKey?: string;
  /** Nango secret key. Defaults to NANGO_SECRET_KEY. */
  secretKey?: string;
  /** Nango API host. Defaults to https://api.nango.dev. */
  baseUrl?: string;
}

export interface GitHubRelayCloudConfig {
  /** Relay cloud API base URL. Defaults to RELAY_CLOUD_API_URL or CLOUD_API_URL. */
  apiUrl?: string;
  /** Relay cloud bearer token. Defaults to RELAY_CLOUD_API_TOKEN, CLOUD_API_ACCESS_TOKEN, or WORKSPACE_TOKEN. */
  accessToken?: string;
  /** Cloud workspace id, when available. */
  workspaceId?: string;
  /** Cloud workspace token, when distinct from accessToken. */
  workspaceToken?: string;
  /** Relay cloud GitHub proxy endpoint. */
  endpoint?: string;
}

export interface GitHubRuntimeConfig {
  /** Runtime mode. Auto-detected when omitted or set to auto. */
  runtime?: GitHubRuntimePreference;
  /** For local runtime: gh CLI path. Defaults to gh. */
  ghPath?: string;
  /** Working directory for local gh commands. */
  cwd?: string;
  /** Environment used by runtime detection and local gh commands. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** For cloud runtime: Nango connection details. */
  nango?: GitHubNangoConfig;
  /** Optional relay-cloud fallback proxy configuration. */
  relayCloud?: GitHubRelayCloudConfig;
  /** Request timeout in ms. Defaults to 30000. */
  timeout?: number;
  /** Enable retry on rate limit or transient errors. Defaults to true. */
  retryOnRateLimit?: boolean;
  /** Maximum retry attempts. Defaults to 3. */
  maxRetries?: number;
  /** User agent sent by cloud runtime requests. */
  userAgent?: string;
  /** Fetch implementation override for tests or custom runtimes. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface RequiredGitHubRuntimeConfig extends GitHubRuntimeConfig {
  runtime: GitHubRuntimePreference;
  ghPath: string;
  env: Record<string, string | undefined>;
  nango: GitHubNangoConfig;
  relayCloud: GitHubRelayCloudConfig;
  timeout: number;
  retryOnRateLimit: boolean;
  maxRetries: number;
  userAgent: string;
}

export interface GitHubRuntimeAvailability {
  runtime: GitHubRuntime;
  available: boolean;
  authenticated?: boolean;
  reason: string;
  details?: Record<string, string | number | boolean>;
  error?: string;
}

export interface GitHubRuntimeDetectionResult {
  runtime: GitHubRuntime;
  requestedRuntime: GitHubRuntimePreference;
  source: GitHubRuntimeDetectionSource;
  available: boolean;
  reason: string;
  checkedAt: string;
  local: GitHubRuntimeAvailability;
  cloud: GitHubRuntimeAvailability;
}

export interface GitHubApiRequestOptions {
  query?: GitHubQueryParams;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface GitHubUserSummary {
  login: string;
  name?: string;
  id?: number;
  type?: string;
}

export interface RepositoryRef {
  owner: string;
  repo: string;
  fullName?: string;
}

export interface FileRef extends RepositoryRef {
  path: string;
  ref?: string;
}

export interface ListReposParams {
  visibility?: 'all' | 'public' | 'private';
  affiliation?: 'owner' | 'collaborator' | 'organization_member';
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  direction?: 'asc' | 'desc';
  perPage?: number;
}

export type GetRepoParams = RepositoryRef;

export interface ListIssuesParams extends RepositoryRef {
  state?: 'open' | 'closed' | 'all';
  assignee?: string;
  labels?: string;
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
  perPage?: number;
}

export interface CreateIssueParams extends RepositoryRef {
  title: string;
  body?: string;
  assignee?: string;
  labels?: string[];
  milestone?: number;
}

export interface UpdateIssueParams extends RepositoryRef {
  issueNumber: number;
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  assignee?: string;
  labels?: string[];
}

export interface CloseIssueParams extends RepositoryRef {
  issueNumber: number;
}

export interface ListPRsParams extends RepositoryRef {
  state?: 'open' | 'closed' | 'all';
  base?: string;
  head?: string;
  sort?: 'created' | 'updated' | 'popularity';
  direction?: 'asc' | 'desc';
  perPage?: number;
}

export interface GetPRParams extends RepositoryRef {
  pullNumber: number;
}

export interface CreatePRParams extends RepositoryRef {
  title: string;
  body?: string;
  base: string;
  head: string;
  draft?: boolean;
  maintainerCanModify?: boolean;
}

export interface UpdatePRParams extends RepositoryRef {
  pullNumber: number;
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  base?: string;
  maintainerCanModify?: boolean;
}

export interface MergePRParams extends RepositoryRef {
  pullNumber: number;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  commitTitle?: string;
  commitMessage?: string;
}

export interface ListFilesParams extends RepositoryRef {
  path?: string;
  ref?: string;
}

export type ReadFileParams = FileRef;

export interface CreateFileParams extends FileRef {
  content: string;
  message: string;
  branch?: string;
  author?: GitHubCommitAuthor;
}

export interface UpdateFileParams extends CreateFileParams {
  sha: string;
}

export interface DeleteFileParams extends FileRef {
  sha: string;
  message: string;
  branch?: string;
  author?: GitHubCommitAuthor;
}

export interface CreateBranchParams extends RepositoryRef {
  branch: string;
  fromBranch?: string;
}

export interface ListCommitsParams extends RepositoryRef {
  sha?: string;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  perPage?: number;
}

export interface CreateCommitParams extends RepositoryRef {
  message: string;
  tree: string;
  parents: string[];
  author?: GitHubCommitAuthor;
  committer?: GitHubCommitAuthor;
}

export interface GetUserParams {
  username?: string;
}

export interface ListOrganizationsParams {
  username?: string;
  perPage?: number;
}

export interface GitHubOwner {
  login: string;
  type: string;
  id?: number;
  avatarUrl?: string;
  htmlUrl?: string;
}

export interface Repository {
  id: number;
  name: string;
  fullName: string;
  owner: GitHubOwner;
  description?: string;
  private: boolean;
  fork: boolean;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  size: number;
  stargazersCount: number;
  watchersCount: number;
  language?: string;
  forksCount: number;
  openIssuesCount: number;
  defaultBranch: string;
  topics: string[];
  visibility: 'public' | 'private' | 'internal';
  permissions?: {
    admin: boolean;
    maintain: boolean;
    push: boolean;
    triage: boolean;
    pull: boolean;
  };
}

export type Repo = Repository;

export interface Issue {
  number: number;
  id: number;
  title: string;
  body?: string;
  user: GitHubOwner;
  labels: Array<{
    name: string;
    color: string;
    description?: string;
  }>;
  state: 'open' | 'closed';
  locked: boolean;
  assignee?: {
    login: string;
  };
  assignees: Array<{
    login: string;
  }>;
  milestone?: {
    number: number;
    title: string;
  };
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  authorAssociation: string;
  reactions: {
    totalCount: number;
  };
}

export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body?: string;
  user: GitHubOwner;
  state: 'open' | 'closed';
  draft: boolean;
  locked: boolean;
  mergeable?: boolean;
  mergeableState: string;
  merged: boolean;
  mergedAt?: string;
  mergedBy?: {
    login: string;
  };
  base: {
    ref: string;
    sha: string;
    repo: {
      name: string;
      fullName: string;
    };
  };
  head: {
    ref: string;
    sha: string;
    repo?: {
      name: string;
      fullName: string;
    };
  };
  requestedReviewers: Array<{
    login: string;
  }>;
  labels: Array<{
    name: string;
    color: string;
  }>;
  commentsCount: number;
  reviewCommentsCount: number;
  commitsCount: number;
  additionsCount: number;
  deletionsCount: number;
  changedFilesCount: number;
  createdAt: string;
  updatedAt: string;
}

export type PR = PullRequest;

export interface FileInfo {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  htmlUrl: string;
  gitUrl: string;
  downloadUrl?: string;
  type: 'file' | 'dir';
  content?: string;
  encoding?: string;
  target?: string;
}

export type GitHubFile = FileInfo;

export interface BranchInfo {
  name: string;
  commit: {
    sha: string;
    url?: string;
  };
  protected?: boolean;
}

export interface CommitInfo {
  sha: string;
  url?: string;
  htmlUrl?: string;
  message?: string;
  author?: GitHubCommitAuthor & {
    date?: string;
  };
  committer?: GitHubCommitAuthor & {
    date?: string;
  };
}

export interface GitHubCommitAuthor {
  name: string;
  email: string;
}

export interface OrganizationInfo {
  login: string;
  id: number;
  description?: string;
  url?: string;
  avatarUrl?: string;
}

export interface GitHubActionResult<TOutput = unknown> {
  success: boolean;
  output: string;
  data?: TOutput;
  error?: string;
  metadata?: {
    rateLimitRemaining?: number;
    rateLimitReset?: string;
    runtime?: GitHubRuntime;
    executionTime?: number;
    retried?: boolean;
  };
}

export interface GitHubActionParamsMap {
  [GitHubAction.ListRepos]: ListReposParams | undefined;
  [GitHubAction.GetRepo]: GetRepoParams;
  [GitHubAction.ListIssues]: ListIssuesParams;
  [GitHubAction.CreateIssue]: CreateIssueParams;
  [GitHubAction.UpdateIssue]: UpdateIssueParams;
  [GitHubAction.CloseIssue]: CloseIssueParams;
  [GitHubAction.ListPRs]: ListPRsParams;
  [GitHubAction.GetPR]: GetPRParams;
  [GitHubAction.CreatePR]: CreatePRParams;
  [GitHubAction.UpdatePR]: UpdatePRParams;
  [GitHubAction.MergePR]: MergePRParams;
  [GitHubAction.ListFiles]: ListFilesParams;
  [GitHubAction.ReadFile]: ReadFileParams;
  [GitHubAction.CreateFile]: CreateFileParams;
  [GitHubAction.UpdateFile]: UpdateFileParams;
  [GitHubAction.DeleteFile]: DeleteFileParams;
  [GitHubAction.CreateBranch]: CreateBranchParams;
  [GitHubAction.ListBranches]: RepositoryRef;
  [GitHubAction.ListCommits]: ListCommitsParams;
  [GitHubAction.CreateCommit]: CreateCommitParams;
  [GitHubAction.GetUser]: GetUserParams | undefined;
  [GitHubAction.ListOrganizations]: ListOrganizationsParams | undefined;
}

export interface GitHubActionOutputMap {
  [GitHubAction.ListRepos]: Repository[];
  [GitHubAction.GetRepo]: Repository;
  [GitHubAction.ListIssues]: Issue[];
  [GitHubAction.CreateIssue]: Issue;
  [GitHubAction.UpdateIssue]: Issue;
  [GitHubAction.CloseIssue]: Issue;
  [GitHubAction.ListPRs]: PullRequest[];
  [GitHubAction.GetPR]: PullRequest;
  [GitHubAction.CreatePR]: PullRequest;
  [GitHubAction.UpdatePR]: PullRequest;
  [GitHubAction.MergePR]: PullRequest;
  [GitHubAction.ListFiles]: FileInfo[];
  [GitHubAction.ReadFile]: string;
  [GitHubAction.CreateFile]: void;
  [GitHubAction.UpdateFile]: FileInfo;
  [GitHubAction.DeleteFile]: void;
  [GitHubAction.CreateBranch]: void;
  [GitHubAction.ListBranches]: BranchInfo[];
  [GitHubAction.ListCommits]: CommitInfo[];
  [GitHubAction.CreateCommit]: CommitInfo;
  [GitHubAction.GetUser]: GitHubUserSummary;
  [GitHubAction.ListOrganizations]: OrganizationInfo[];
}

export class GitHubApiError extends Error {
  readonly status?: number;
  readonly responseBody?: string;
  readonly responseHeaders?: Record<string, string>;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      status?: number;
      responseBody?: string;
      responseHeaders?: Record<string, string>;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = options.status;
    this.responseBody = options.responseBody;
    this.responseHeaders = options.responseHeaders;
    this.cause = options.cause;
  }
}

export abstract class GitHubClientInterface {
  protected readonly config: RequiredGitHubRuntimeConfig;

  constructor(config: RequiredGitHubRuntimeConfig) {
    this.config = config;
  }

  getRuntimeConfig(): RequiredGitHubRuntimeConfig {
    return this.config;
  }

  abstract getRuntime(): GitHubRuntime;
  abstract isAuthenticated(): Promise<boolean>;
  abstract getCurrentUser(): Promise<GitHubUserSummary>;
  abstract request<TResponse = unknown>(
    method: GitHubApiRequestMethod,
    path: string,
    options?: GitHubApiRequestOptions
  ): Promise<TResponse>;

  abstract executeAction<Name extends GitHubAction>(
    action: Name,
    params: GitHubActionParamsMap[Name]
  ): Promise<GitHubActionResult<GitHubActionOutputMap[Name]>>;
  abstract executeAction<TOutput = unknown>(
    action: GitHubAction | GitHubActionName,
    params?: unknown
  ): Promise<GitHubActionResult<TOutput>>;

  abstract listRepositories(params?: ListReposParams): Promise<Repository[]>;
  abstract getRepository(params: GetRepoParams): Promise<Repository>;
  abstract listIssues(params: ListIssuesParams): Promise<Issue[]>;
  abstract createIssue(params: CreateIssueParams): Promise<Issue>;
  abstract updateIssue(params: UpdateIssueParams): Promise<Issue>;
  abstract closeIssue(params: CloseIssueParams): Promise<Issue>;
  abstract listPullRequests(params: ListPRsParams): Promise<PullRequest[]>;
  abstract getPullRequest(params: GetPRParams): Promise<PullRequest>;
  abstract createPullRequest(params: CreatePRParams): Promise<PullRequest>;
  abstract updatePullRequest(params: UpdatePRParams): Promise<PullRequest>;
  abstract mergePullRequest(params: MergePRParams): Promise<PullRequest>;
  abstract listFiles(params: ListFilesParams): Promise<FileInfo[]>;
  abstract readFile(params: ReadFileParams): Promise<string>;
  abstract createFile(params: CreateFileParams): Promise<void>;
  abstract updateFile(params: UpdateFileParams): Promise<FileInfo>;
  abstract deleteFile(params: DeleteFileParams): Promise<void>;
  abstract listBranches(params: RepositoryRef): Promise<BranchInfo[]>;
  abstract createBranch(params: CreateBranchParams): Promise<void>;
  abstract listCommits(params: ListCommitsParams): Promise<CommitInfo[]>;
  abstract createCommit(params: CreateCommitParams): Promise<CommitInfo>;
  abstract getUser(params?: GetUserParams): Promise<GitHubUserSummary>;
  abstract listOrganizations(params?: ListOrganizationsParams): Promise<OrganizationInfo[]>;
}
