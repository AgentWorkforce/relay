import type { RunnerStepExecutor, WorkflowStep } from '@agent-relay/sdk/workflows';

import { GitHubClient } from './client.js';
import type {
  GitHubActionName,
  GitHubActionParamsMap,
  GitHubActionResult,
  GitHubRuntime,
  GitHubRuntimeConfig,
  RepositoryRef,
} from './types.js';
import { GITHUB_ACTIONS } from './types.js';

export type GitHubStepOutputMode = 'data' | 'result' | 'summary' | 'raw' | 'none';
export type GitHubStepOutputFormat = 'json' | 'text';

type RepoParamKeys = 'owner' | 'repo';
type ParamsFor<TName extends GitHubActionName> = TName extends keyof GitHubActionParamsMap
  ? GitHubActionParamsMap[TName]
  : Record<string, unknown>;
type StripRepoParams<TParams> = Omit<TParams, Extract<keyof TParams, RepoParamKeys>> &
  Partial<Pick<TParams, Extract<keyof TParams, RepoParamKeys>>>;

export type GitHubStepParams<TName extends GitHubActionName = GitHubActionName> = [
  NonNullable<ParamsFor<TName>>,
] extends [never]
  ? Record<string, unknown>
  : StripRepoParams<NonNullable<ParamsFor<TName>>>;

export interface GitHubStepOutputConfig {
  /** Which action result becomes the workflow step output. Defaults to "data". */
  mode?: GitHubStepOutputMode;
  /** Emit JSON for structured chaining or text for simple downstream interpolation. Defaults to "json". */
  format?: GitHubStepOutputFormat;
  /** Select a nested field from the projected output, e.g. "number" or "data.htmlUrl". */
  path?: string;
  /** Include adapter metadata such as runtime and timing in JSON output. Defaults false. */
  includeMetadata?: boolean;
  /** Include the selected runtime in JSON output. Defaults false. */
  includeRuntime?: boolean;
  /** Pretty-print JSON output. Defaults false. */
  pretty?: boolean;
}

export interface GitHubStepConfig<TName extends GitHubActionName = GitHubActionName> {
  /** Unique step name within the workflow. */
  name: string;
  /** Dependencies in the Relay workflow DAG. */
  dependsOn?: string[];
  /** GitHub action to execute. */
  action: TName;
  /** Repository in owner/repo format. Used as owner and repo params for repository-scoped actions. */
  repo?: string | RepositoryRef;
  /** Action-specific parameters. Values may include workflow templates such as {{steps.plan.output}}. */
  params?: GitHubStepParams<TName>;
  /** Runtime settings for local gh CLI, cloud/Nango, or auto detection. */
  config?: GitHubRuntimeConfig;
  /** Controls the string captured as {{steps.<name>.output}}. */
  output?: GitHubStepOutputConfig;
  /** Workflow step timeout in milliseconds. */
  timeoutMs?: number;
  /** Number of retry attempts when the workflow runner retries this integration step. */
  retries?: number;
}

export interface GitHubStepExecutionContext {
  workspaceId?: string;
  client?: GitHubClient;
  config?: GitHubRuntimeConfig;
}

export interface GitHubStepExecutionResult<TOutput = unknown> {
  success: boolean;
  output: string;
  result: GitHubActionResult<TOutput>;
  runtime?: GitHubRuntime;
  error?: string;
}

export interface GitHubIntegrationStepResult {
  output: string;
  success: boolean;
}

type ResolvedParams = Record<string, unknown>;

const GITHUB_INTEGRATION = 'github';
const RESERVED_PARAM_KEYS = new Set([
  'action',
  'config',
  'githubConfig',
  'output',
  'params',
  'actionParams',
  'repository',
  'runtime',
  'ghPath',
  'timeout',
  'retryOnRateLimit',
  'maxRetries',
]);

/**
 * Create a Relay integration step that can be used in TypeScript workflows or
 * emitted into .relay YAML. Complex params/config objects are serialized so the
 * workflow template resolver can interpolate values before execution.
 */
export function createGitHubStep<TName extends GitHubActionName>(
  config: GitHubStepConfig<TName>
): WorkflowStep {
  validateGitHubStepConfig(config);

  const params: Record<string, string> = {};

  if (config.repo !== undefined) {
    params.repo = repoToString(config.repo);
  }
  if (config.params !== undefined) {
    params.params = JSON.stringify(config.params);
  }
  if (config.config !== undefined) {
    params.config = JSON.stringify(config.config);
  }
  if (config.output !== undefined) {
    params.output = JSON.stringify(config.output);
  }

  const step: WorkflowStep = {
    name: config.name,
    type: 'integration',
    integration: GITHUB_INTEGRATION,
    action: config.action,
    params,
  };

  if (config.dependsOn !== undefined) step.dependsOn = config.dependsOn;
  if (config.timeoutMs !== undefined) step.timeoutMs = config.timeoutMs;
  if (config.retries !== undefined) step.retries = config.retries;

  return step;
}

export class GitHubStepExecutor implements RunnerStepExecutor {
  constructor(private readonly options: GitHubRuntimeConfig = {}) {}

  async executeAgentStep(): Promise<string> {
    throw new Error('GitHubStepExecutor only executes GitHub integration steps.');
  }

  async execute<TOutput = unknown>(
    config: GitHubStepConfig,
    context: GitHubStepExecutionContext = {}
  ): Promise<GitHubStepExecutionResult<TOutput>> {
    validateGitHubStepConfig(config);

    const runtimeConfig = mergeRuntimeConfig(this.options, context.config, config.config);
    if (context.workspaceId && !runtimeConfig.relayCloud?.workspaceId) {
      runtimeConfig.relayCloud = {
        ...runtimeConfig.relayCloud,
        workspaceId: context.workspaceId,
      };
    }

    const client = context.client ?? new GitHubClient(runtimeConfig);
    const actionParams = buildActionParams(config);
    const result = await client.executeAction<TOutput>(config.action, actionParams);
    const runtime = result.metadata?.runtime ?? (await safeGetRuntime(client));
    const output = formatStepOutput(config, result, runtime);

    return {
      success: result.success,
      output,
      result,
      runtime,
      error: result.error,
    };
  }

  async executeIntegrationStep(
    step: WorkflowStep,
    resolvedParams: Record<string, string>,
    context: { workspaceId?: string } = {}
  ): Promise<GitHubIntegrationStepResult> {
    if (step.integration !== GITHUB_INTEGRATION) {
      return {
        success: false,
        output: `GitHubStepExecutor only handles "${GITHUB_INTEGRATION}" integration steps`,
      };
    }

    try {
      const config = githubStepConfigFromWorkflowStep(step, resolvedParams);
      const result = await this.execute(config, context);

      return {
        success: result.success,
        output: result.success ? result.output : result.output || result.error || 'GitHub step failed',
      };
    } catch (error) {
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function githubStepConfigFromWorkflowStep(
  step: WorkflowStep,
  resolvedParams: Record<string, string>
): GitHubStepConfig {
  const params = normalizeResolvedParams(resolvedParams);
  const action = step.action as GitHubActionName | undefined;

  if (!action) {
    throw new Error(`GitHub step "${step.name}" requires an action`);
  }

  const config =
    readJsonParam<GitHubRuntimeConfig>(params.config ?? params.githubConfig, 'config') ??
    runtimeConfigFromParams(params);
  const output = readJsonParam<GitHubStepOutputConfig>(params.output, 'output') ?? undefined;
  const repo = readRepositoryParam(params);
  const actionParams = readActionParams(params);

  return {
    name: step.name,
    dependsOn: step.dependsOn,
    action,
    repo,
    params: actionParams,
    config,
    output,
    timeoutMs: step.timeoutMs,
    retries: step.retries,
  };
}

function validateGitHubStepConfig(config: GitHubStepConfig): void {
  if (!config.name) {
    throw new Error('GitHub step requires a non-empty name');
  }
  if (!config.action || typeof config.action !== 'string') {
    throw new Error(`GitHub step "${config.name}" requires an action name`);
  }
  if (!GITHUB_ACTIONS.includes(config.action as never)) {
    throw new Error(`GitHub step "${config.name}" uses unsupported action "${config.action}"`);
  }
  if (config.repo !== undefined) {
    parseRepositoryRef(config.repo);
  }
  if (config.params !== undefined && !isRecord(config.params)) {
    throw new Error(`GitHub step "${config.name}" params must be an object`);
  }
}

function buildActionParams(config: GitHubStepConfig): unknown {
  const repo = config.repo === undefined ? undefined : parseRepositoryRef(config.repo);
  const params = config.params ? ({ ...config.params } as Record<string, unknown>) : {};
  const merged = repo ? { ...repo, ...params } : params;

  return Object.keys(merged).length === 0 ? undefined : merged;
}

function readActionParams(params: ResolvedParams): Record<string, unknown> {
  const serializedParams = params.params ?? params.actionParams;
  if (serializedParams !== undefined) {
    const parsed = readJsonParam<Record<string, unknown>>(serializedParams, 'params');
    if (parsed === undefined) return {};
    if (!isRecord(parsed)) {
      throw new Error('GitHub step params.params must be a JSON object');
    }
    return parsed;
  }

  const actionParams: Record<string, unknown> = {};
  const repoValue = params.repo;
  const repoIsRepositoryRef =
    params.owner === undefined && typeof repoValue === 'string' && repoValue.includes('/');

  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_PARAM_KEYS.has(key)) continue;
    if (key === 'repo' && repoIsRepositoryRef) continue;
    actionParams[key] = value;
  }

  return actionParams;
}

function readRepositoryParam(params: ResolvedParams): string | RepositoryRef | undefined {
  const value = params.repository ?? (params.owner === undefined ? params.repo : undefined);
  if (value === undefined) return undefined;
  if (typeof value === 'string' || isRecord(value)) {
    return parseRepositoryRef(value);
  }
  throw new Error('GitHub step repo must be in owner/repo format');
}

function runtimeConfigFromParams(params: ResolvedParams): GitHubRuntimeConfig | undefined {
  const config: GitHubRuntimeConfig = {};

  if (typeof params.runtime === 'string') {
    config.runtime = params.runtime as GitHubRuntimeConfig['runtime'];
  }
  if (typeof params.ghPath === 'string') {
    config.ghPath = params.ghPath;
  }
  if (typeof params.timeout === 'number') {
    config.timeout = params.timeout;
  }
  if (typeof params.retryOnRateLimit === 'boolean') {
    config.retryOnRateLimit = params.retryOnRateLimit;
  }
  if (typeof params.maxRetries === 'number') {
    config.maxRetries = params.maxRetries;
  }

  return Object.keys(config).length === 0 ? undefined : config;
}

function mergeRuntimeConfig(...configs: Array<GitHubRuntimeConfig | undefined>): GitHubRuntimeConfig {
  const merged: GitHubRuntimeConfig = {};

  for (const config of configs) {
    if (!config) continue;

    Object.assign(merged, config);
    if (config.nango) {
      merged.nango = {
        ...merged.nango,
        ...config.nango,
      };
    }
    if (config.relayCloud) {
      merged.relayCloud = {
        ...merged.relayCloud,
        ...config.relayCloud,
      };
    }
    if (config.env) {
      merged.env = {
        ...merged.env,
        ...config.env,
      };
    }
  }

  return merged;
}

function formatStepOutput<TOutput>(
  config: GitHubStepConfig,
  result: GitHubActionResult<TOutput>,
  runtime?: GitHubRuntime
): string {
  const outputConfig = config.output ?? {};
  const mode = outputConfig.mode ?? 'data';
  const format = outputConfig.format ?? 'json';

  if (mode === 'none') {
    return '';
  }

  let projection = buildOutputProjection(mode, result, runtime, outputConfig);

  if (outputConfig.path) {
    projection = resolvePath(projection, outputConfig.path);
  }

  if (format === 'text') {
    return projectionToText(projection);
  }

  return JSON.stringify(projection, undefined, outputConfig.pretty ? 2 : undefined);
}

function buildOutputProjection<TOutput>(
  mode: GitHubStepOutputMode,
  result: GitHubActionResult<TOutput>,
  runtime: GitHubRuntime | undefined,
  outputConfig: GitHubStepOutputConfig
): unknown {
  if (mode === 'raw') {
    return result.output;
  }

  if (mode === 'summary') {
    return withOptionalMetadata(summarizeResult(result, runtime), result, runtime, outputConfig);
  }

  if (mode === 'result') {
    const projected: Record<string, unknown> = {
      success: result.success,
      output: result.output,
    };
    if (result.data !== undefined) projected.data = result.data;
    if (result.error !== undefined) projected.error = result.error;

    return withOptionalMetadata(projected, result, runtime, outputConfig);
  }

  const data = result.data ?? (result.output ? result.output : null);
  return withOptionalMetadata(data, result, runtime, outputConfig);
}

function summarizeResult<TOutput>(
  result: GitHubActionResult<TOutput>,
  runtime?: GitHubRuntime
): Record<string, unknown> {
  if (!result.success) {
    return {
      success: false,
      error: result.error ?? 'GitHub action failed',
      runtime,
    };
  }

  const data = result.data;
  if (Array.isArray(data)) {
    return {
      success: true,
      count: data.length,
      items: data.slice(0, 10).map(summarizeValue),
      runtime,
    };
  }

  return {
    success: true,
    value: summarizeValue(data ?? result.output),
    runtime,
  };
}

function summarizeValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const summary: Record<string, unknown> = {};
  for (const key of [
    'fullName',
    'name',
    'number',
    'title',
    'state',
    'path',
    'sha',
    'type',
    'defaultBranch',
    'visibility',
    'private',
    'createdAt',
    'updatedAt',
    'htmlUrl',
    'url',
  ]) {
    if (value[key] !== undefined) {
      summary[key] = value[key];
    }
  }

  return Object.keys(summary).length > 0 ? summary : value;
}

function withOptionalMetadata<TOutput>(
  value: unknown,
  result: GitHubActionResult<TOutput>,
  runtime: GitHubRuntime | undefined,
  outputConfig: GitHubStepOutputConfig
): unknown {
  if (!outputConfig.includeMetadata && !outputConfig.includeRuntime) {
    return value;
  }

  const metadata: Record<string, unknown> = {};
  if (outputConfig.includeRuntime && runtime !== undefined) metadata.runtime = runtime;
  if (outputConfig.includeMetadata && result.metadata !== undefined) {
    Object.assign(metadata, result.metadata);
  }

  return { value, metadata };
}

function projectionToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';

  if (Array.isArray(value)) {
    return value.map((entry) => projectionToText(entry)).join('\n');
  }

  if (isRecord(value)) {
    if ('output' in value) return projectionToText(value.output);
    if ('value' in value) return projectionToText(value.value);
    if ('data' in value) return projectionToText(value.data);
    if ('content' in value) return projectionToText(value.content);
    if ('body' in value) return projectionToText(value.body);
    if ('title' in value) return projectionToText(value.title);
    if ('fullName' in value) return projectionToText(value.fullName);
    if ('path' in value) return projectionToText(value.path);
    if ('url' in value) return projectionToText(value.url);
  }

  return JSON.stringify(value);
}

function resolvePath(value: unknown, path: string): unknown {
  if (!path) return value;

  let current = value;
  for (const segment of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (isRecord(current)) {
      current = current[segment];
      continue;
    }
    return undefined;
  }

  return current;
}

function parseRepositoryRef(repo: string | RepositoryRef | Record<string, unknown>): RepositoryRef {
  if (typeof repo === 'string') {
    const [owner, name, ...rest] = repo.split('/');
    if (!owner || !name || rest.length > 0) {
      throw new Error(`GitHub repo must be in owner/repo format: ${repo}`);
    }

    return {
      owner,
      repo: name,
      fullName: `${owner}/${name}`,
    };
  }

  const owner = typeof repo.owner === 'string' ? repo.owner : undefined;
  const name = typeof repo.repo === 'string' ? repo.repo : undefined;
  if (!owner || !name) {
    throw new Error('GitHub repo object requires owner and repo');
  }

  return {
    owner,
    repo: name,
    fullName: typeof repo.fullName === 'string' ? repo.fullName : `${owner}/${name}`,
  };
}

function repoToString(repo: string | RepositoryRef): string {
  return typeof repo === 'string' ? repo : `${repo.owner}/${repo.repo}`;
}

async function safeGetRuntime(client: GitHubClient): Promise<GitHubRuntime | undefined> {
  try {
    return await client.getRuntime();
  } catch {
    return undefined;
  }
}

function normalizeResolvedParams(params: Record<string, string>): ResolvedParams {
  const normalized: ResolvedParams = {};
  for (const [key, value] of Object.entries(params)) {
    normalized[key] = coerceScalar(value);
  }
  return normalized;
}

function coerceScalar(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

function readJsonParam<T>(value: unknown, name: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return value as T;

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(
      `GitHub step params.${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
