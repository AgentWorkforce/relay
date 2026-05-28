import type {
  ActionDefinition,
  ActionHandle,
  ActionResult,
  AgentRelayActionDescriptor,
  AgentRelayActions,
  ActionContext,
  ActionSchema,
  ActionValidationIssue,
  ActionValidationResult,
  InvokeActionInput,
  ZodLikeSchema,
} from './types.js';
import { ActionNotFoundError, ActionRegistrationError, ActionValidationError } from './errors.js';
import { validateJsonSchemaLite } from './json-schema-lite.js';

export class InMemoryAgentRelayActions implements AgentRelayActions {
  private readonly actions = new Map<string, ActionDefinition>();

  register<TInput, TOutput>(definition: ActionDefinition<TInput, TOutput>): ActionHandle {
    const name = normalizeActionName(definition.name);

    if (!name) {
      throw new ActionRegistrationError('Action name is required');
    }

    if (this.actions.has(name)) {
      throw new ActionRegistrationError(`Action already registered: ${name}`);
    }
    this.actions.set(name, {
      ...definition,
      name,
      description: definition.description ?? name,
      inputSchema: definition.inputSchema ?? definition.input,
      outputSchema: definition.outputSchema ?? definition.output,
      visibility: definition.visibility ?? 'agent',
    } as ActionDefinition);
    return {
      unregister: () => {
        this.actions.delete(name);
      },
    };
  }

  async invoke<TOutput = unknown>(input: InvokeActionInput): Promise<ActionResult<TOutput>> {
    const name = normalizeActionName(input.name);
    const definition = this.actions.get(name);
    const context = actionContext(input);
    if (!definition) {
      return {
        action: name,
        ok: false,
        error: { code: 'action_not_found', message: `Unknown action: ${name}` },
      };
    }

    await context.emit?.({
      type: 'action.invoked',
      action: name,
      caller: context.caller.name,
      at: new Date().toISOString(),
    });

    const inputValidation = validateActionSchema(input.input, definition.inputSchema);
    if (!inputValidation.valid) {
      const message = formatValidationIssues(inputValidation.issues);
      await context.emit?.({
        type: 'action.failed',
        action: name,
        caller: context.caller.name,
        at: new Date().toISOString(),
        error: message,
      });
      return { action: name, ok: false, error: { code: 'invalid_input', message } };
    }

    const actionInput = inputValidation.value as Parameters<typeof definition.handler>[0];
    const decision = await definition.policy?.(actionInput, context);
    if (decision && !decision.allowed) {
      await context.emit?.({
        type: 'action.denied',
        action: name,
        caller: context.caller.name,
        at: new Date().toISOString(),
        reason: decision.reason,
      });
      return {
        action: name,
        ok: false,
        error: { code: 'action_denied', message: decision.reason ?? 'Action denied' },
      };
    }

    try {
      const output = await definition.handler(actionInput, context);
      const outputValidation = validateActionSchema(output, definition.outputSchema);
      if (!outputValidation.valid) {
        const message = formatValidationIssues(outputValidation.issues);
        await context.emit?.({
          type: 'action.failed',
          action: name,
          caller: context.caller.name,
          at: new Date().toISOString(),
          error: message,
        });
        return { action: name, ok: false, error: { code: 'invalid_output', message } };
      }
      await context.emit?.({
        type: 'action.completed',
        action: name,
        caller: context.caller.name,
        at: new Date().toISOString(),
      });
      return { action: name, ok: true, output: outputValidation.value as TOutput };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await context.emit?.({
        type: 'action.failed',
        action: name,
        caller: context.caller.name,
        at: new Date().toISOString(),
        error: message,
      });
      return { action: name, ok: false, error: { code: 'action_failed', message } };
    }
  }

  async list(input?: { visibility?: 'agent' | 'human' | 'internal' }): Promise<AgentRelayActionDescriptor[]> {
    return [...this.actions.values()]
      .filter((definition) => !input?.visibility || (definition.visibility ?? 'agent') === input.visibility)
      .map((definition) => ({
        name: definition.name,
        description: definition.description ?? definition.name,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        visibility: definition.visibility ?? 'agent',
      }));
  }

  get(name: string): AgentRelayActionDescriptor | undefined {
    const definition = this.actions.get(normalizeActionName(name));
    if (!definition) {
      return undefined;
    }

    return {
      name: definition.name,
      description: definition.description ?? definition.name,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      visibility: definition.visibility ?? 'agent',
    };
  }

  has(name: string): boolean {
    return this.actions.has(normalizeActionName(name));
  }

  unregister(name: string): boolean {
    return this.actions.delete(normalizeActionName(name));
  }

  clear(): void {
    this.actions.clear();
  }

  async execute<TOutput = unknown>(
    name: string,
    input: unknown,
    context: ActionContext = { caller: { name: 'sdk' } }
  ): Promise<TOutput> {
    const result = await this.invoke<TOutput>({ name, input, context });
    if (result.ok) {
      return result.output as TOutput;
    }

    const actionName = normalizeActionName(name);
    if (result.error?.code === 'action_not_found') {
      throw new ActionNotFoundError(actionName);
    }
    if (result.error?.code === 'invalid_input') {
      throw new ActionValidationError(actionName, 'input', [{ path: '$', message: result.error.message }]);
    }
    if (result.error?.code === 'invalid_output') {
      throw new ActionValidationError(actionName, 'output', [{ path: '$', message: result.error.message }]);
    }

    throw new Error(result.error?.message ?? `Action failed: ${actionName}`);
  }
}

export class ActionRegistry extends InMemoryAgentRelayActions {}

function normalizeActionName(name: string): string {
  return name.trim();
}

function formatValidationIssues(issues: { path: string; message: string }[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
}

interface ValidatedActionValue extends ActionValidationResult {
  value: unknown;
}

function validateActionSchema(input: unknown, schema: ActionSchema | undefined): ValidatedActionValue {
  if (isZodLikeSchema(schema)) {
    const result = schema.safeParse(input);
    if (result.success) {
      return { valid: true, issues: [], value: result.data };
    }

    return {
      valid: false,
      issues: zodIssues(result.error),
      value: input,
    };
  }

  return {
    ...validateJsonSchemaLite(input, schema),
    value: input,
  };
}

function isZodLikeSchema(schema: ActionSchema | undefined): schema is ZodLikeSchema {
  return Boolean(
    schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  );
}

function zodIssues(error: {
  issues?: Array<{ path?: Array<string | number>; message: string }>;
}): ActionValidationIssue[] {
  const issues = error.issues ?? [];
  if (issues.length === 0) {
    return [{ path: '$', message: 'invalid value' }];
  }

  return issues.map((issue) => ({
    path: formatZodPath(issue.path ?? []),
    message: issue.message,
  }));
}

function formatZodPath(path: Array<string | number>): string {
  if (path.length === 0) return '$';
  let result = '$';
  for (const part of path) {
    result = typeof part === 'number' ? `${result}[${part}]` : `${result}.${part}`;
  }
  return result;
}

function actionContext(input: InvokeActionInput): ActionContext {
  return {
    ...input.context,
    caller: input.context?.caller ?? input.caller ?? { name: 'sdk' },
    workspaceId: input.context?.workspaceId ?? input.workspaceId,
    messaging: input.context?.messaging ?? input.messaging,
    emit: input.context?.emit ?? input.emit,
  };
}
