# GitHub Workflow Primitive

A workflow primitive that enables agents to interact with GitHub repositories using both local `gh` CLI commands and cloud-based Nango-connected GitHub API, designed to complement existing integration primitives.

## Package Structure

```
packages/primitives/github/
├── DESIGN.md                 # This design document
├── README.md                # Package overview
├── package.json             # Package manifest
├── vitest.config.ts         # Package test config
├── src/
│   ├── index.ts            # Main exports
│   ├── constants.ts        # Shared runtime defaults
│   ├── types.ts            # TypeScript interfaces
│   ├── client.ts           # High-level typed client facade
│   ├── adapter.ts          # Runtime detection, factory, base adapter
│   ├── local-runtime.ts    # Local gh CLI implementation
│   ├── cloud-runtime.ts    # Cloud Nango and relay-cloud implementation
│   ├── workflow-step.ts    # Workflow step executor
│   ├── actions/            # GitHub action implementations
│   │   ├── branches.ts     # listBranches, createBranch operations
│   │   ├── commits.ts      # listCommits, createCommit operations
│   │   ├── repos.ts        # listRepos, getRepo operations
│   │   ├── issues.ts       # listIssues, createIssue, etc.
│   │   ├── pulls.ts        # listPRs, getPR, createPR, updatePR, mergePR
│   │   ├── files.ts        # listFiles, readFile, createFile, updateFile, deleteFile
│   │   ├── users.ts        # getUser, listOrganizations operations
│   │   └── utils.ts        # Shared request, mapping, and validation helpers
│   └── __tests__/
│       └── github-actions.test.ts
├── templates/              # Workflow templates
│   └── repository-inspection.yaml
├── docs/
│   └── actions.md         # Action reference
└── examples/
    ├── github-client.ts   # Standalone client usage
    └── github-step.ts     # Workflow step usage
```

## TypeScript Interfaces

### Core Action Types

```typescript
// GitHub action types that map to workflow step actions
export type GitHubAction =
  | 'listRepos'
  | 'getRepo'
  | 'listIssues'
  | 'createIssue'
  | 'updateIssue'
  | 'closeIssue'
  | 'listPRs'
  | 'getPR'
  | 'createPR'
  | 'updatePR'
  | 'mergePR'
  | 'listFiles'
  | 'readFile'
  | 'createFile'
  | 'updateFile'
  | 'deleteFile'
  | 'createBranch'
  | 'listBranches'
  | 'listCommits'
  | 'createCommit'
  | 'getUser'
  | 'listOrganizations';

// Runtime detection
export type GitHubRuntime = 'local' | 'cloud';

// GitHub configuration for both runtimes
export interface GitHubConfig {
  /** Runtime mode - auto-detected if not specified */
  runtime?: GitHubRuntime;
  /** For local runtime: gh CLI path (default: 'gh') */
  ghPath?: string;
  /** For cloud runtime: Nango connection details */
  nango?: {
    connectionId?: string;
    providerConfigKey?: string;
  };
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Enable retry on rate limit (default: true) */
  retryOnRateLimit?: boolean;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
}

// Repository reference
export interface RepositoryRef {
  /** Repository owner/organization */
  owner: string;
  /** Repository name */
  repo: string;
  /** Full repository name (owner/repo) */
  fullName?: string;
}

// File reference within repository
export interface FileRef extends RepositoryRef {
  /** File path within repository */
  path: string;
  /** Git branch/ref (default: main/master) */
  ref?: string;
}
```

### Action Parameter Interfaces

```typescript
// Repository operations
export interface ListReposParams {
  /** Filter by visibility */
  visibility?: 'all' | 'public' | 'private';
  /** Filter by affiliation */
  affiliation?: 'owner' | 'collaborator' | 'organization_member';
  /** Sort order */
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
  /** Sort direction */
  direction?: 'asc' | 'desc';
  /** Maximum results (default: 30) */
  perPage?: number;
}

export interface GetRepoParams {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
}

// Issue operations
export interface ListIssuesParams extends RepositoryRef {
  /** Filter by state */
  state?: 'open' | 'closed' | 'all';
  /** Filter by assignee */
  assignee?: string;
  /** Filter by labels (comma-separated) */
  labels?: string;
  /** Sort order */
  sort?: 'created' | 'updated' | 'comments';
  /** Sort direction */
  direction?: 'asc' | 'desc';
  /** Maximum results (default: 30) */
  perPage?: number;
}

export interface CreateIssueParams extends RepositoryRef {
  /** Issue title */
  title: string;
  /** Issue body */
  body?: string;
  /** Assignee username */
  assignee?: string;
  /** Labels to apply */
  labels?: string[];
  /** Milestone number */
  milestone?: number;
}

export interface UpdateIssueParams extends RepositoryRef {
  /** Issue number */
  issueNumber: number;
  /** Updated title */
  title?: string;
  /** Updated body */
  body?: string;
  /** Updated state */
  state?: 'open' | 'closed';
  /** Updated assignee */
  assignee?: string;
  /** Updated labels */
  labels?: string[];
}

// Pull request operations
export interface ListPRsParams extends RepositoryRef {
  /** Filter by state */
  state?: 'open' | 'closed' | 'all';
  /** Filter by base branch */
  base?: string;
  /** Filter by head branch */
  head?: string;
  /** Sort order */
  sort?: 'created' | 'updated' | 'popularity';
  /** Sort direction */
  direction?: 'asc' | 'desc';
  /** Maximum results (default: 30) */
  perPage?: number;
}

export interface CreatePRParams extends RepositoryRef {
  /** PR title */
  title: string;
  /** PR body */
  body?: string;
  /** Base branch to merge into */
  base: string;
  /** Head branch to merge from */
  head: string;
  /** Mark as draft */
  draft?: boolean;
  /** Maintainer can modify */
  maintainerCanModify?: boolean;
}

export interface MergePRParams extends RepositoryRef {
  /** PR number */
  pullNumber: number;
  /** Merge method */
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  /** Commit title for merge */
  commitTitle?: string;
  /** Commit message for merge */
  commitMessage?: string;
}

// File operations
export interface ListFilesParams extends RepositoryRef {
  /** Directory path (default: root) */
  path?: string;
  /** Git branch/ref (default: main/master) */
  ref?: string;
}

export interface ReadFileParams extends FileRef {}

export interface CreateFileParams extends FileRef {
  /** File content */
  content: string;
  /** Commit message */
  message: string;
  /** Branch to commit to (default: main/master) */
  branch?: string;
  /** Author information */
  author?: {
    name: string;
    email: string;
  };
}

export interface UpdateFileParams extends CreateFileParams {
  /** SHA of file being replaced */
  sha: string;
}

export interface DeleteFileParams extends FileRef {
  /** SHA of file being deleted */
  sha: string;
  /** Commit message */
  message: string;
  /** Branch to commit to (default: main/master) */
  branch?: string;
}
```

### Response Types

```typescript
// Repository information
export interface Repository {
  id: number;
  name: string;
  fullName: string;
  owner: {
    login: string;
    type: string;
  };
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

// Issue information
export interface Issue {
  number: number;
  id: number;
  title: string;
  body?: string;
  user: {
    login: string;
    type: string;
  };
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

// Pull request information
export interface PullRequest {
  number: number;
  id: number;
  title: string;
  body?: string;
  user: {
    login: string;
    type: string;
  };
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

// File information
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
  content?: string; // Base64 encoded for files
  encoding?: string;
  target?: string; // For symlinks
}

// Action execution result
export interface GitHubActionResult {
  /** Whether action succeeded */
  success: boolean;
  /** Action output (JSON stringified for complex objects) */
  output: string;
  /** Error message if action failed */
  error?: string;
  /** Additional metadata */
  metadata?: {
    /** API rate limit remaining */
    rateLimitRemaining?: number;
    /** Rate limit reset time */
    rateLimitReset?: string;
    /** Runtime used (local/cloud) */
    runtime?: GitHubRuntime;
    /** Request execution time in ms */
    executionTime?: number;
    /** Whether request was retried */
    retried?: boolean;
  };
}
```

## Abstract Client Interface

The core abstraction that enables dual runtime support:

```typescript
/**
 * Abstract GitHub client that can be implemented for both local and cloud runtimes
 */
export abstract class GitHubClient {
  protected config: GitHubConfig;

  constructor(config: GitHubConfig) {
    this.config = config;
  }

  // Runtime detection
  abstract getRuntime(): GitHubRuntime;
  abstract isAuthenticated(): Promise<boolean>;
  abstract getCurrentUser(): Promise<{ login: string; name?: string }>;

  // Repository operations
  abstract listRepositories(params?: ListReposParams): Promise<Repository[]>;
  abstract getRepository(params: GetRepoParams): Promise<Repository>;

  // Issue operations
  abstract listIssues(params: ListIssuesParams): Promise<Issue[]>;
  abstract createIssue(params: CreateIssueParams): Promise<Issue>;
  abstract updateIssue(params: UpdateIssueParams): Promise<Issue>;
  abstract closeIssue(params: { owner: string; repo: string; issueNumber: number }): Promise<Issue>;

  // Pull request operations
  abstract listPullRequests(params: ListPRsParams): Promise<PullRequest[]>;
  abstract getPullRequest(params: { owner: string; repo: string; pullNumber: number }): Promise<PullRequest>;
  abstract createPullRequest(params: CreatePRParams): Promise<PullRequest>;
  abstract updatePullRequest(params: UpdatePRParams): Promise<PullRequest>;
  abstract mergePullRequest(params: MergePRParams): Promise<PullRequest>;

  // File operations
  abstract listFiles(params: ListFilesParams): Promise<FileInfo[]>;
  abstract readFile(params: ReadFileParams): Promise<string>;
  abstract createFile(params: CreateFileParams): Promise<void>;
  abstract updateFile(params: UpdateFileParams): Promise<FileInfo>;
  abstract deleteFile(params: DeleteFileParams): Promise<void>;

  // Branch operations
  abstract listBranches(params: RepositoryRef): Promise<Array<{ name: string; commit: { sha: string } }>>;
  abstract createBranch(params: RepositoryRef & { branch: string; fromBranch?: string }): Promise<void>;

  // Commit and identity operations
  abstract listCommits(params: ListCommitsParams): Promise<CommitInfo[]>;
  abstract createCommit(params: CreateCommitParams): Promise<CommitInfo>;
  abstract getUser(params?: GetUserParams): Promise<GitHubUserSummary>;
  abstract listOrganizations(params?: ListOrganizationsParams): Promise<OrganizationInfo[]>;
}
```

## Runtime Detection and Client Factory

```typescript
/**
 * Detects the appropriate runtime and creates the correct client
 */
export class GitHubClientFactory {
  /**
   * Auto-detect runtime and create appropriate client
   */
  static async create(config: GitHubConfig = {}): Promise<GitHubClient> {
    const runtime = config.runtime || (await this.detectRuntime());

    switch (runtime) {
      case 'local':
        return new LocalGitHubClient(config);
      case 'cloud':
        return new CloudGitHubClient(config);
      default:
        throw new Error(`Unsupported GitHub runtime: ${runtime}`);
    }
  }

  /**
   * Detect runtime based on environment
   */
  private static async detectRuntime(): Promise<GitHubRuntime> {
    // Check for cloud environment indicators
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL || process.env.RAILWAY_ENVIRONMENT) {
      return 'cloud';
    }

    // Check for Nango configuration
    if (process.env.NANGO_SECRET_KEY) {
      return 'cloud';
    }

    // Check if gh CLI is available
    try {
      const { execSync } = await import('child_process');
      execSync('gh --version', { stdio: 'pipe' });
      return 'local';
    } catch {
      // Fall back to cloud if gh CLI not available
      return 'cloud';
    }
  }

  /**
   * Test runtime availability and authentication
   */
  static async testRuntime(runtime: GitHubRuntime, config: GitHubConfig): Promise<boolean> {
    try {
      const client = runtime === 'local' ? new LocalGitHubClient(config) : new CloudGitHubClient(config);

      return await client.isAuthenticated();
    } catch {
      return false;
    }
  }
}
```

## Step Configuration Schema

GitHub steps integrate into workflows using the existing integration step pattern:

```yaml
steps:
  - name: list-user-repos
    type: integration
    integration: github
    action: listRepos
    params:
      visibility: 'all'
      sort: 'updated'
      perPage: 50

  - name: get-repo-details
    type: integration
    integration: github
    action: getRepo
    params:
      owner: 'octocat'
      repo: 'Hello-World'

  - name: create-feature-branch
    type: integration
    integration: github
    action: createBranch
    params:
      owner: '{{steps.get-repo-details.output.owner.login}}'
      repo: '{{steps.get-repo-details.output.name}}'
      branch: 'feature/{{workflow.featureName}}'
      fromBranch: 'main'

  - name: update-readme
    type: integration
    integration: github
    action: updateFile
    params:
      owner: '{{steps.get-repo-details.output.owner.login}}'
      repo: '{{steps.get-repo-details.output.name}}'
      path: 'README.md'
      content: '{{steps.generate-readme.output}}'
      message: 'Update README with new features'
      branch: 'feature/{{workflow.featureName}}'
      sha: '{{steps.read-current-readme.output.sha}}'

  - name: create-pull-request
    type: integration
    integration: github
    action: createPR
    params:
      owner: '{{steps.get-repo-details.output.owner.login}}'
      repo: '{{steps.get-repo-details.output.name}}'
      title: 'Add {{workflow.featureName}} feature'
      body: |
        ## Summary
        {{steps.generate-pr-description.output}}

        ## Changes
        - Updated README.md

        Auto-generated by relay workflow
      base: 'main'
      head: 'feature/{{workflow.featureName}}'
```

### Global GitHub Configuration

GitHub configuration can be set at the workflow level:

```yaml
# Global GitHub configuration
githubConfig:
  runtime: 'auto' # or "local" or "cloud"
  timeout: 30000
  retryOnRateLimit: true
  maxRetries: 3
  # For cloud runtime
  nango:
    connectionId: 'github-main'
    providerConfigKey: 'github'

steps:
  # GitHub steps inherit global config
  - name: list-issues
    type: integration
    integration: github
    action: listIssues
    params:
      owner: 'myorg'
      repo: 'myrepo'
      state: 'open'
```

### Step-Level Configuration Override

Individual steps can override global GitHub config:

```yaml
steps:
  - name: emergency-hotfix
    type: integration
    integration: github
    action: createPR
    params:
      owner: 'myorg'
      repo: 'myrepo'
      title: 'HOTFIX: Critical security patch'
      body: 'Emergency security fix'
      base: 'main'
      head: 'hotfix/security'
      # Step-specific GitHub config
      githubConfig:
        timeout: 60000 # Longer timeout for critical operations
        maxRetries: 5
```

## Example Workflow Usage

### 1. Issue Triage Workflow

```yaml
version: '1.0'
name: github-issue-triage
description: Automatically triage and label new GitHub issues

githubConfig:
  runtime: 'auto'
  retryOnRateLimit: true

steps:
  - name: fetch-new-issues
    type: integration
    integration: github
    action: listIssues
    params:
      owner: '{{workflow.repoOwner}}'
      repo: '{{workflow.repoName}}'
      state: 'open'
      sort: 'created'
      perPage: 20

  - name: analyze-issues
    type: agent
    agent: issue-analyzer
    task: |
      Analyze these GitHub issues and suggest labels and priorities:
      {{steps.fetch-new-issues.output}}

  - name: apply-labels
    type: integration
    integration: github
    action: updateIssue
    params:
      owner: '{{workflow.repoOwner}}'
      repo: '{{workflow.repoName}}'
      issueNumber: '{{steps.analyze-issues.output.issueNumber}}'
      labels: '{{steps.analyze-issues.output.suggestedLabels}}'

  - name: create-triage-report
    type: integration
    integration: github
    action: createIssue
    params:
      owner: '{{workflow.repoOwner}}'
      repo: '{{workflow.repoName}}'
      title: 'Daily Issue Triage Report - {{workflow.date}}'
      body: |
        ## Triaged Issues
        {{steps.analyze-issues.output.report}}

        ## Summary
        - New issues: {{steps.analyze-issues.output.newCount}}
        - High priority: {{steps.analyze-issues.output.highPriorityCount}}
        - Needs attention: {{steps.analyze-issues.output.needsAttentionCount}}
      labels: ['triage', 'automation']
```

### 2. Pull Request Review Workflow

```yaml
version: '1.0'
name: automated-pr-review
description: Automated code review and feedback for pull requests

githubConfig:
  runtime: 'cloud' # Use cloud for webhook integration
  nango:
    connectionId: 'github-bot'

steps:
  - name: get-pr-details
    type: integration
    integration: github
    action: getPR
    params:
      owner: '{{workflow.prOwner}}'
      repo: '{{workflow.prRepo}}'
      pullNumber: '{{workflow.prNumber}}'

  - name: get-changed-files
    type: integration
    integration: github
    action: listFiles
    params:
      owner: '{{workflow.prOwner}}'
      repo: '{{workflow.prRepo}}'
      ref: '{{steps.get-pr-details.output.head.sha}}'

  - name: review-code-changes
    type: agent
    agent: code-reviewer
    task: |
      Review this pull request:

      **PR Details:**
      {{steps.get-pr-details.output}}

      **Changed Files:**
      {{steps.get-changed-files.output}}

      Provide feedback on code quality, security, and best practices.

  - name: update-pr-description
    type: integration
    integration: github
    action: updatePR
    params:
      owner: '{{workflow.prOwner}}'
      repo: '{{workflow.prRepo}}'
      pullNumber: '{{workflow.prNumber}}'
      body: |
        {{steps.get-pr-details.output.body}}

        ---

        ## 🤖 Automated Review
        {{steps.review-code-changes.output.feedback}}

        ### 📊 Analysis Summary
        {{steps.review-code-changes.output.summary}}
```

### 3. Repository Sync Workflow

```yaml
version: '1.0'
name: multi-repo-sync
description: Synchronize changes across multiple repositories

githubConfig:
  runtime: 'local' # Use local for development workflow
  ghPath: '/usr/local/bin/gh'

steps:
  - name: list-target-repos
    type: integration
    integration: github
    action: listRepos
    params:
      affiliation: 'owner'
      sort: 'updated'
      perPage: 100

  - name: filter-repos
    type: agent
    agent: repo-filter
    task: |
      Filter repositories that need the update:
      {{steps.list-target-repos.output}}

      Only include repositories with topics: ["{{workflow.targetTopic}}"]

  - name: create-sync-branches
    type: integration
    integration: github
    action: createBranch
    params:
      owner: '{{item.owner.login}}'
      repo: '{{item.name}}'
      branch: 'sync/{{workflow.syncId}}'
      fromBranch: '{{item.defaultBranch}}'
    # This would iterate over filtered repos

  - name: apply-template-changes
    type: integration
    integration: github
    action: createFile
    params:
      owner: '{{item.owner.login}}'
      repo: '{{item.name}}'
      path: '{{workflow.templateFile}}'
      content: '{{steps.generate-template.output}}'
      message: 'Sync: Update {{workflow.templateFile}}'
      branch: 'sync/{{workflow.syncId}}'

  - name: create-sync-prs
    type: integration
    integration: github
    action: createPR
    params:
      owner: '{{item.owner.login}}'
      repo: '{{item.name}}'
      title: 'Sync: {{workflow.changeDescription}}'
      body: |
        ## 🔄 Repository Sync

        This PR synchronizes changes across the organization:

        ### Changes
        {{workflow.changeDescription}}

        ### Files Modified
        - {{workflow.templateFile}}

        Auto-generated by repo sync workflow
      base: '{{item.defaultBranch}}'
      head: 'sync/{{workflow.syncId}}'
      draft: false
```

## Error Handling and Fallback Strategy

The GitHub primitive implements robust error handling with automatic fallback:

```typescript
export class GitHubExecutor implements WorkflowExecutor {
  async executeIntegrationStep(
    step: WorkflowStep,
    resolvedParams: Record<string, string>,
    context: { workspaceId?: string }
  ): Promise<{ output: string; success: boolean }> {
    if (step.integration !== 'github') {
      throw new Error(`GitHubExecutor only handles github integration steps`);
    }

    try {
      // Try primary client first
      const primaryClient = await this.createClient(step.githubConfig);
      const result = await this.executeAction(primaryClient, step.action, resolvedParams);

      return {
        output: JSON.stringify(result.output),
        success: result.success,
      };
    } catch (primaryError) {
      // Try fallback runtime if primary fails
      try {
        const fallbackClient = await this.createFallbackClient(step.githubConfig);
        const result = await this.executeAction(fallbackClient, step.action, resolvedParams);

        return {
          output: JSON.stringify({
            ...result.output,
            _fallbackUsed: true,
            _primaryError: primaryError.message,
          }),
          success: result.success,
        };
      } catch (fallbackError) {
        return {
          output: JSON.stringify({
            error: primaryError.message,
            fallbackError: fallbackError.message,
            runtime: await this.detectRuntime(),
          }),
          success: false,
        };
      }
    }
  }

  private async createClient(config: GitHubConfig = {}): Promise<GitHubClient> {
    return await GitHubClientFactory.create(config);
  }

  private async createFallbackClient(config: GitHubConfig = {}): Promise<GitHubClient> {
    const currentRuntime = config.runtime || (await GitHubClientFactory.detectRuntime());
    const fallbackRuntime = currentRuntime === 'local' ? 'cloud' : 'local';

    const fallbackConfig = {
      ...config,
      runtime: fallbackRuntime,
    };

    return await GitHubClientFactory.create(fallbackConfig);
  }
}
```

## Migration Path from sage/github-tool.ts

For existing workflows using sage/github-tool.ts, migration is straightforward:

### Before (sage/github-tool.ts)

```yaml
steps:
  - name: create-issue
    type: sage
    sage: github-tool
    params:
      action: 'create_issue'
      repo: 'owner/repo'
      title: 'Bug report'
      body: 'Description'
```

### After (GitHub Primitive)

```yaml
steps:
  - name: create-issue
    type: integration
    integration: github
    action: createIssue
    params:
      owner: 'owner'
      repo: 'repo'
      title: 'Bug report'
      body: 'Description'
```

### Migration Utility

A migration utility helps convert existing workflows:

```typescript
/**
 * Migrate sage github-tool steps to GitHub primitive
 */
export function migrateSageGithubSteps(workflow: any): any {
  const migratedWorkflow = { ...workflow };

  migratedWorkflow.steps = workflow.steps.map((step: any) => {
    if (step.type === 'sage' && step.sage === 'github-tool') {
      return {
        ...step,
        type: 'integration',
        integration: 'github',
        action: convertSageAction(step.params.action),
        params: convertSageParams(step.params),
      };
    }
    return step;
  });

  return migratedWorkflow;
}

function convertSageAction(sageAction: string): string {
  const actionMap: Record<string, string> = {
    create_issue: 'createIssue',
    list_issues: 'listIssues',
    create_pr: 'createPR',
    list_repos: 'listRepos',
    read_file: 'readFile',
    create_file: 'createFile',
  };

  return actionMap[sageAction] || sageAction;
}

function convertSageParams(sageParams: any): any {
  // Convert repo: "owner/repo" to owner: "owner", repo: "repo"
  if (sageParams.repo && typeof sageParams.repo === 'string' && sageParams.repo.includes('/')) {
    const [owner, repo] = sageParams.repo.split('/', 2);
    return {
      ...sageParams,
      owner,
      repo,
      repo: undefined, // Remove old format
    };
  }

  return sageParams;
}
```

## Implementation Status

### Core Infrastructure

- [x] Abstract GitHub client interface
- [x] Runtime detection and client factory
- [x] Local client implementation (gh CLI wrapper)
- [x] Cloud client implementation (Nango plus relay-cloud fallback)
- [x] Workflow step executor integration

### Action Coverage

- [x] Repository operations (list, get)
- [x] Issue operations (list, create, update, close)
- [x] Pull request operations (list, create, get, update, merge)
- [x] File operations (list, read, create, update, delete)
- [x] Branch operations (list, create)
- [x] Commit operations (list, create)
- [x] User and organization operations

### Package Readiness

- [x] Error handling and retry logic
- [x] Unit tests for action dispatch and fallback behavior
- [x] README, action docs, workflow template, and examples
- [ ] Migration utility from sage/github-tool
- [ ] Performance optimization and caching
- [ ] CI/CD integration coverage in the top-level workflow

This design provides a comprehensive GitHub integration primitive that seamlessly supports both local development and cloud production environments, with automatic fallback capabilities and a clear migration path from existing tools.
