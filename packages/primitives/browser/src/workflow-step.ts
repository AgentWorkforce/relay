import type { RunnerStepExecutor, WorkflowStep } from '@agent-relay/sdk/workflows';

import { BrowserClient, type BrowserClientOptions } from './browser-client.js';
import type {
  ActionResult,
  BrowserActionName,
  BrowserActionParamsMap,
  BrowserActionRequest,
  BrowserConfig,
  BrowserSession,
} from './types.js';

export type BrowserStepOutputMode = 'last' | 'all' | 'captures' | 'summary' | 'none';
export type BrowserStepOutputFormat = 'json' | 'text';

export type BrowserStepAction<TName extends BrowserActionName = BrowserActionName> = {
  [Name in TName]: {
    action: Name;
    params: BrowserActionParamsMap[Name];
    /** Stable key for captured output. Defaults to the zero-based action index. */
    id?: string;
    /** Include this action in output.mode = "captures". Defaults true for extraction actions. */
    capture?: boolean;
    /** Output object key when output.mode = "captures". Defaults to id or action_<index>. */
    outputKey?: string;
    /** Continue running later actions if this action fails. Defaults false. */
    continueOnError?: boolean;
  };
}[TName];

export interface BrowserStepOutputConfig {
  /** Which action results become the workflow step output. Defaults to "last". */
  mode?: BrowserStepOutputMode;
  /** Emit JSON for structured chaining or text for simple downstream interpolation. Defaults to "json". */
  format?: BrowserStepOutputFormat;
  /** Include per-action metadata such as current URL and timing in JSON output. Defaults false. */
  includeMetadata?: boolean;
  /** Include final browser session state in JSON output. Defaults false. */
  includeSession?: boolean;
  /** Pretty-print JSON output. Defaults false. */
  pretty?: boolean;
}

export interface BrowserStepConfig {
  /** Unique step name within the workflow. */
  name: string;
  /** Dependencies in the Relay workflow DAG. */
  dependsOn?: string[];
  /** Browser settings for this step/session. */
  config?: BrowserConfig;
  /** Ordered browser actions to execute in one browser session. */
  actions: BrowserStepAction[];
  /** Controls the string captured as {{steps.<name>.output}}. */
  output?: BrowserStepOutputConfig;
  /** Reuse a named browser session across browser steps. Defaults to the workspace/config session. */
  sessionId?: string;
  /** Close the session after this step, even when persistSession is true. */
  closeSession?: boolean;
  /** Workflow step timeout in milliseconds. */
  timeoutMs?: number;
  /** Number of retry attempts when the workflow runner retries this integration step. */
  retries?: number;
}

export interface BrowserStepExecutionContext {
  workspaceId?: string;
  sessionId?: string;
  client?: BrowserClient;
}

export interface BrowserStepActionRecord<TOutput = unknown> {
  index: number;
  id?: string;
  action: BrowserActionName;
  success: boolean;
  output?: TOutput;
  error?: string;
  metadata?: ActionResult['metadata'];
}

export interface BrowserStepExecutionResult {
  success: boolean;
  output: string;
  results: BrowserStepActionRecord[];
  session: BrowserSession;
  error?: string;
}

export interface BrowserIntegrationStepResult {
  output: string;
  success: boolean;
}

type ResolvedParams = Record<string, unknown>;

const BROWSER_INTEGRATION = 'browser';
const BROWSER_RUN_ACTION = 'run';
const EXTRACTION_ACTIONS = new Set<BrowserActionName>([
  'text',
  'getText',
  'html',
  'getHTML',
  'attribute',
  'getAttribute',
  'screenshot',
  'elementScreenshot',
  'evaluate',
]);

/**
 * Create a Relay integration step that can be used in relay.yaml or passed to
 * WorkflowRunner directly. Complex action/config objects are serialized into
 * params so the existing workflow template resolver can interpolate them.
 */
export function createBrowserStep(config: BrowserStepConfig): WorkflowStep {
  validateBrowserStepConfig(config);

  const params: Record<string, string> = {
    actions: JSON.stringify(config.actions),
  };

  if (config.config !== undefined) {
    params.config = JSON.stringify(config.config);
  }
  if (config.output !== undefined) {
    params.output = JSON.stringify(config.output);
  }
  if (config.sessionId !== undefined) {
    params.sessionId = config.sessionId;
  }
  if (config.closeSession !== undefined) {
    params.closeSession = String(config.closeSession);
  }

  const step: WorkflowStep = {
    name: config.name,
    type: 'integration',
    integration: BROWSER_INTEGRATION,
    action: BROWSER_RUN_ACTION,
    params,
  };

  if (config.dependsOn !== undefined) step.dependsOn = config.dependsOn;
  if (config.timeoutMs !== undefined) step.timeoutMs = config.timeoutMs;
  if (config.retries !== undefined) step.retries = config.retries;

  return step;
}

export class BrowserStepExecutor implements RunnerStepExecutor {
  private readonly sessions = new Map<string, BrowserClient>();

  constructor(private readonly options: BrowserClientOptions = {}) {}

  async executeAgentStep(): Promise<string> {
    throw new Error('BrowserStepExecutor only executes browser integration steps.');
  }

  async execute(
    config: BrowserStepConfig,
    context: BrowserStepExecutionContext = {}
  ): Promise<BrowserStepExecutionResult> {
    validateBrowserStepConfig(config);

    const client = context.client ?? this.getOrCreateClient(config, context);
    const records: BrowserStepActionRecord[] = [];
    let hardFailure: BrowserStepActionRecord | undefined;

    for (let index = 0; index < config.actions.length; index += 1) {
      const action = config.actions[index];
      const started = Date.now();
      const result = await client.executeWorkflowAction(action as BrowserActionRequest);

      const record: BrowserStepActionRecord = {
        index,
        id: action.id,
        action: action.action,
        success: result.success,
        output: result.output,
        error: result.error,
        metadata: result.metadata,
      };
      records.push(record);

      if (!result.success && !action.continueOnError) {
        hardFailure = record;
        break;
      }

      if (!record.metadata) {
        record.metadata = {
          action: action.action,
          sessionId: client.getSession().id,
          currentUrl: client.getCurrentUrl(),
          executionTime: Date.now() - started,
        };
      }
    }

    const session = client.getSession();
    const output = formatStepOutput(config, records, session);
    const success = hardFailure === undefined;

    if (config.closeSession || config.config?.persistSession === false) {
      if (context.client) {
        await context.client.close();
      } else {
        await this.closeSession(this.resolveSessionKey(config, context));
      }
    }

    return {
      success,
      output,
      results: records,
      session,
      error: hardFailure?.error,
    };
  }

  async executeIntegrationStep(
    step: WorkflowStep,
    resolvedParams: Record<string, string>,
    context: { workspaceId?: string } = {}
  ): Promise<BrowserIntegrationStepResult> {
    if (step.integration !== BROWSER_INTEGRATION) {
      return {
        success: false,
        output: `BrowserStepExecutor only handles "${BROWSER_INTEGRATION}" integration steps`,
      };
    }

    try {
      const config = browserStepConfigFromWorkflowStep(step, resolvedParams);
      const result = await this.execute(config, context);

      return {
        success: result.success,
        output: result.success ? result.output : result.output || result.error || 'Browser step failed',
      };
    } catch (error) {
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const client = this.sessions.get(sessionId);
    if (!client) {
      return false;
    }

    await client.close();
    this.sessions.delete(sessionId);
    return true;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((client) => client.close()));
    this.sessions.clear();
  }

  listSessions(): BrowserSession[] {
    return [...this.sessions.values()].map((client) => client.getSession());
  }

  private getOrCreateClient(config: BrowserStepConfig, context: BrowserStepExecutionContext): BrowserClient {
    const key = this.resolveSessionKey(config, context);
    const existing = this.sessions.get(key);

    if (existing) {
      return existing;
    }

    const client = new BrowserClient({
      ...this.options,
      config: {
        ...this.options.config,
        ...config.config,
      },
    });
    this.sessions.set(key, client);
    return client;
  }

  private resolveSessionKey(config: BrowserStepConfig, context: BrowserStepExecutionContext): string {
    if (context.sessionId) return context.sessionId;
    if (config.sessionId) return config.sessionId;

    const workspace = context.workspaceId ?? 'default';
    return `${workspace}:${stableStringify(config.config ?? {})}`;
  }
}

export function browserStepConfigFromWorkflowStep(
  step: WorkflowStep,
  resolvedParams: Record<string, string>
): BrowserStepConfig {
  const params = normalizeResolvedParams(resolvedParams);
  const config = readJsonParam<BrowserConfig>(params.config ?? params.browserConfig, 'config') ?? undefined;
  const output = readJsonParam<BrowserStepOutputConfig>(params.output, 'output') ?? undefined;
  const closeSession =
    params.closeSession === undefined ? undefined : Boolean(coerceScalar(params.closeSession));
  const sessionId = params.sessionId === undefined ? undefined : String(params.sessionId);

  const actions = readActions(step, params);

  return {
    name: step.name,
    dependsOn: step.dependsOn,
    config,
    actions,
    output,
    sessionId,
    closeSession,
    timeoutMs: step.timeoutMs,
    retries: step.retries,
  };
}

function validateBrowserStepConfig(config: BrowserStepConfig): void {
  if (!config.name) {
    throw new Error('Browser step requires a non-empty name');
  }
  if (!Array.isArray(config.actions) || config.actions.length === 0) {
    throw new Error(`Browser step "${config.name}" requires at least one action`);
  }

  for (const [index, action] of config.actions.entries()) {
    if (!action || typeof action !== 'object') {
      throw new Error(`Browser step "${config.name}" action ${index} must be an object`);
    }
    if (!action.action || typeof action.action !== 'string') {
      throw new Error(`Browser step "${config.name}" action ${index} requires an action name`);
    }
    if (action.params === undefined || typeof action.params !== 'object' || action.params === null) {
      throw new Error(`Browser step "${config.name}" action ${index} requires params`);
    }
  }
}

function readActions(step: WorkflowStep, params: ResolvedParams): BrowserStepAction[] {
  const serializedActions = params.actions;
  if (serializedActions !== undefined) {
    const parsed = readJsonParam<BrowserStepAction[]>(serializedActions, 'actions');
    if (!Array.isArray(parsed)) {
      throw new Error('Browser step params.actions must be a JSON array');
    }
    return parsed;
  }

  if (!step.action || step.action === BROWSER_RUN_ACTION) {
    throw new Error(`Browser step "${step.name}" requires params.actions or a browser action`);
  }

  const actionParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (
      key === 'config' ||
      key === 'browserConfig' ||
      key === 'output' ||
      key === 'sessionId' ||
      key === 'closeSession'
    ) {
      continue;
    }
    actionParams[key] = value;
  }

  return [
    {
      action: step.action as BrowserActionName,
      params: actionParams as BrowserActionParamsMap[BrowserActionName],
    } as BrowserStepAction,
  ];
}

function formatStepOutput(
  config: BrowserStepConfig,
  records: BrowserStepActionRecord[],
  session: BrowserSession
): string {
  const outputConfig = config.output ?? {};
  const mode = outputConfig.mode ?? 'last';
  const format = outputConfig.format ?? 'json';

  if (mode === 'none') {
    return '';
  }

  const projection = buildOutputProjection(mode, config.actions, records, session, outputConfig);

  if (format === 'text') {
    return projectionToText(projection);
  }

  return JSON.stringify(projection, undefined, outputConfig.pretty ? 2 : undefined);
}

function buildOutputProjection(
  mode: BrowserStepOutputMode,
  actions: BrowserStepAction[],
  records: BrowserStepActionRecord[],
  session: BrowserSession,
  outputConfig: BrowserStepOutputConfig
): unknown {
  if (mode === 'summary') {
    const failed = records.find((record) => !record.success);
    return withOptionalSession(
      {
        success: failed === undefined,
        actionCount: records.length,
        currentUrl: session.currentUrl,
        failedAction: failed
          ? {
              index: failed.index,
              id: failed.id,
              action: failed.action,
              error: failed.error,
            }
          : undefined,
      },
      session,
      outputConfig
    );
  }

  if (mode === 'all') {
    return withOptionalSession(
      {
        results: records.map((record) => projectRecord(record, outputConfig.includeMetadata ?? false)),
      },
      session,
      outputConfig
    );
  }

  if (mode === 'captures') {
    const captures: Record<string, unknown> = {};

    for (const record of records) {
      const action = record.action;
      const actionConfig = actions[record.index];
      const capture = actionConfig?.capture ?? (EXTRACTION_ACTIONS.has(action) && record.success);
      if (!capture) continue;

      const key = actionConfig?.outputKey ?? actionConfig?.id ?? record.id ?? `action_${record.index}`;
      captures[key] = projectRecord(record, outputConfig.includeMetadata ?? false);
    }

    return withOptionalSession({ captures }, session, outputConfig);
  }

  const last = records.at(-1);
  return withOptionalSession(
    last ? projectRecord(last, outputConfig.includeMetadata ?? false) : null,
    session,
    outputConfig
  );
}

function projectRecord(record: BrowserStepActionRecord, includeMetadata: boolean): unknown {
  const projected: BrowserStepActionRecord = {
    index: record.index,
    action: record.action,
    success: record.success,
  };

  if (record.id !== undefined) projected.id = record.id;
  if (record.output !== undefined) projected.output = record.output;
  if (record.error !== undefined) projected.error = record.error;
  if (includeMetadata && record.metadata !== undefined) projected.metadata = record.metadata;

  return projected;
}

function withOptionalSession(
  value: unknown,
  session: BrowserSession,
  outputConfig: BrowserStepOutputConfig
): unknown {
  if (!outputConfig.includeSession) {
    return value;
  }

  return {
    value,
    session: {
      id: session.id,
      active: session.active,
      currentUrl: session.currentUrl,
      startTime: session.startTime,
      config: session.config,
    },
  };
}

function projectionToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';

  if (isRecord(value)) {
    if ('output' in value) {
      return projectionToText(value.output);
    }
    if ('value' in value) {
      return projectionToText(value.value);
    }
    if ('text' in value) {
      return projectionToText(value.text);
    }
    if ('html' in value) {
      return projectionToText(value.html);
    }
    if ('captures' in value) {
      return JSON.stringify(value.captures);
    }
  }

  if (Array.isArray(value)) {
    return value.map((entry) => projectionToText(entry)).join('\n');
  }

  return JSON.stringify(value);
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
      `Browser step params.${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function stableStringify(value: unknown): string {
  if (!isRecord(value) && !Array.isArray(value)) {
    return JSON.stringify(value);
  }

  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortJson(value[key]);
      return acc;
    }, {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
