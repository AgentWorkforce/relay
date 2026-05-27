import type {
  ActionDefinition,
  ActionHandle,
  ActionResult,
  AgentRelayActionDescriptor,
  AgentRelayActions,
  ActionContext,
  InvokeActionInput,
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
    if (!definition) {
      return {
        action: name,
        ok: false,
        error: { code: 'action_not_found', message: `Unknown action: ${name}` },
      };
    }

    await input.context.emit?.({
      type: 'action.invoked',
      action: name,
      caller: input.context.caller.name,
      at: new Date().toISOString(),
    });

    const inputValidation = validateJsonSchemaLite(input.input, definition.inputSchema);
    if (!inputValidation.valid) {
      const message = formatValidationIssues(inputValidation.issues);
      await input.context.emit?.({
        type: 'action.failed',
        action: name,
        caller: input.context.caller.name,
        at: new Date().toISOString(),
        error: message,
      });
      return { action: name, ok: false, error: { code: 'invalid_input', message } };
    }

    const decision = await definition.policy?.(input.input, input.context);
    if (decision && !decision.allowed) {
      await input.context.emit?.({
        type: 'action.denied',
        action: name,
        caller: input.context.caller.name,
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
      const output = await definition.handler(input.input, input.context);
      const outputValidation = validateJsonSchemaLite(output, definition.outputSchema);
      if (!outputValidation.valid) {
        const message = formatValidationIssues(outputValidation.issues);
        await input.context.emit?.({
          type: 'action.failed',
          action: name,
          caller: input.context.caller.name,
          at: new Date().toISOString(),
          error: message,
        });
        return { action: name, ok: false, error: { code: 'invalid_output', message } };
      }
      await input.context.emit?.({
        type: 'action.completed',
        action: name,
        caller: input.context.caller.name,
        at: new Date().toISOString(),
      });
      return { action: name, ok: true, output: output as TOutput };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await input.context.emit?.({
        type: 'action.failed',
        action: name,
        caller: input.context.caller.name,
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
        description: definition.description,
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
      description: definition.description,
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
