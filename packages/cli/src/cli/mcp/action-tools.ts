import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ActionAuditEvent, AgentRelayActions } from '@agent-relay/sdk/actions';
import { z } from 'zod';

import {
  actionInvocationInput,
  actionToolInputSchema,
  serializableActionDescriptor,
} from './action-schema.js';
import { jsonContent, jsonResult } from './tool-results.js';
import type { AgentClientLike, SessionState } from './types.js';

/** The relay-backed action surface on the live agent client, when available. */
function getRelayAgentActions(
  getAgentClient?: (asIdentity?: string) => AgentClientLike
): AgentClientLike['actions'] | undefined {
  if (!getAgentClient) {
    return undefined;
  }
  try {
    return getAgentClient().actions;
  } catch {
    return undefined;
  }
}

function asInputRecord(input: unknown): Record<string, unknown> | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { input };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register the `list_actions` and `invoke_action` tools plus a dynamic per-action
 * tool for each registered action. Invocation is fire-and-forget through the
 * relay action surface when available, falling back to the in-process registry.
 */
export function registerAgentRelayActionTools(
  server: McpServer,
  actions: AgentRelayActions | undefined,
  getSession: () => SessionState,
  onAuditEvent?: (event: ActionAuditEvent) => Promise<void> | void,
  getAgentClient?: (asIdentity?: string) => AgentClientLike,
  actionToolNames?: Set<string>
): void {
  if (!actions) {
    return;
  }

  /**
   * Fire-and-forget invocation through the relay: returns an immediate ack
   * (with an `invocation_id`) and does NOT run the handler inline. Falls back to
   * the local in-process registry when the relay action surface is unavailable.
   */
  const invokeAction = async (name: string, input: unknown) => {
    const relayActions = getRelayAgentActions(getAgentClient);
    if (relayActions) {
      try {
        const ack = await relayActions.invoke(name, asInputRecord(input));
        return jsonContent({ ok: true, status: 'invoked', invocation: ack });
      } catch (error) {
        return { ...jsonContent({ ok: false, error: errorMessage(error) }), isError: true };
      }
    }

    const session = getSession();
    const result = await actions.invoke({
      name,
      input,
      context: {
        caller: { name: session.agentName ?? 'mcp', type: 'agent' },
        emit: onAuditEvent,
      },
    });
    return result.ok ? jsonContent(result) : { ...jsonContent(result), isError: true };
  };

  server.registerTool(
    'list_actions',
    {
      title: 'List Actions',
      description: 'List Agent Relay actions available to this agent.',
      inputSchema: {},
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      jsonContent({
        actions: (await actions.list({ visibility: 'agent' })).map(serializableActionDescriptor),
      })
  );

  server.registerTool(
    'invoke_action',
    {
      title: 'Invoke Action',
      description:
        'Invoke a registered Agent Relay action by name. Fire-and-forget: returns an ack with an invocation id; the result arrives asynchronously to the action handler.',
      inputSchema: {
        name: z.string().describe('Registered action name'),
        input: z.unknown().describe('Action input payload'),
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, input }: { name: string; input: unknown }) => invokeAction(name, input)
  );

  void actions
    .list({ visibility: 'agent' })
    .then((descriptors) => {
      for (const descriptor of descriptors) {
        actionToolNames?.add(descriptor.name);
        server.registerTool(
          descriptor.name,
          {
            title: descriptor.name,
            description: descriptor.description,
            inputSchema: actionToolInputSchema(descriptor.inputSchema),
            outputSchema: jsonResult,
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
          },
          async (args: unknown) => invokeAction(descriptor.name, actionInvocationInput(descriptor, args))
        );
      }
    })
    .catch(() => undefined);
}
