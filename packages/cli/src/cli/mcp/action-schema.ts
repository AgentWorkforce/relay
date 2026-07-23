import type {
  ActionSchema,
  AgentRelayActionDescriptor,
  JsonSchemaLiteObject,
  ZodLikeSchema,
} from '@agent-relay/sdk/actions';
import { z } from 'zod';

/**
 * Adapters between the JSON-schema-lite action schema format used by the Agent
 * Relay actions registry and the zod schemas the MCP SDK expects for tool input
 * validation. Also handles serializing descriptors for the `list_actions` tool.
 */

export function isSchemaObject(schema: ActionSchema | undefined): schema is JsonSchemaLiteObject {
  return Boolean(
    schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    typeof (schema as { safeParse?: unknown }).safeParse !== 'function'
  );
}

function getSchemaDescription(schema: ActionSchema | undefined): string | undefined {
  return isSchemaObject(schema) && typeof schema.description === 'string' ? schema.description : undefined;
}

/** Convert a JSON-schema-lite node into an equivalent zod type. */
export function zodFromJsonSchema(schema: ActionSchema | undefined): z.ZodTypeAny {
  if (schema === false) {
    return z.never();
  }

  if (!isSchemaObject(schema)) {
    return z.unknown();
  }

  let zodType: z.ZodTypeAny;
  const schemaType = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (schemaType) {
    case 'array':
      zodType = z.array(zodFromJsonSchema(schema.items));
      break;
    case 'boolean':
      zodType = z.boolean();
      break;
    case 'integer':
      zodType = z.number().int();
      break;
    case 'number':
      zodType = z.number();
      break;
    case 'object':
      if (schema.properties) {
        const required = new Set(schema.required ?? []);
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, childSchema] of Object.entries(schema.properties)) {
          const child = zodFromJsonSchema(childSchema);
          shape[key] = required.has(key) ? child : child.optional();
        }
        zodType = z.object(shape).passthrough();
      } else {
        zodType = z.record(z.string(), z.unknown());
      }
      break;
    case 'string':
      zodType = z.string();
      break;
    default:
      zodType = z.unknown();
      break;
  }

  const description = getSchemaDescription(schema);
  return description ? zodType.describe(description) : zodType;
}

function zodObjectShape(schema: ActionSchema | undefined): Record<string, z.ZodTypeAny> | undefined {
  if (schema instanceof z.ZodObject) {
    return schema.shape;
  }
  return undefined;
}

/** Build the MCP tool `inputSchema` (a zod shape) from an action input schema. */
export function actionToolInputSchema(schema: ActionSchema | undefined): Record<string, z.ZodTypeAny> {
  const zodShape = zodObjectShape(schema);
  if (zodShape) {
    return zodShape;
  }

  if (!isSchemaObject(schema) || schema.type !== 'object') {
    return {
      input: z.unknown().describe('Action input payload. The action registry performs final validation.'),
    };
  }

  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    const child = zodFromJsonSchema(childSchema);
    shape[key] = required.has(key) ? child : child.optional();
  }
  return shape;
}

/**
 * Normalize raw MCP tool args into the shape the action handler expects: object
 * schemas pass through, while scalar/opaque schemas unwrap the `{ input }` envelope.
 */
export function actionInvocationInput(descriptor: AgentRelayActionDescriptor, args: unknown): unknown {
  const schema = descriptor.inputSchema;
  if (zodObjectShape(schema)) {
    return args;
  }
  if (!isSchemaObject(schema) || schema.type !== 'object') {
    return typeof args === 'object' && args !== null && 'input' in args
      ? (args as { input?: unknown }).input
      : args;
  }
  return args;
}

function isZodLikeSchema(schema: ActionSchema | undefined): schema is ZodLikeSchema {
  return Boolean(
    schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  );
}

function serializableActionSchema(schema: ActionSchema): unknown {
  if (isSchemaObject(schema)) {
    return schema;
  }
  if (isZodLikeSchema(schema)) {
    return {
      type: 'zod',
      ...(schema.description ? { description: schema.description } : {}),
    };
  }
  return schema;
}

/** Project an action descriptor into a JSON-serializable form for `list_actions`. */
export function serializableActionDescriptor(
  descriptor: AgentRelayActionDescriptor
): Record<string, unknown> {
  return {
    name: descriptor.name,
    description: descriptor.description,
    visibility: descriptor.visibility,
    ...(descriptor.inputSchema ? { inputSchema: serializableActionSchema(descriptor.inputSchema) } : {}),
    ...(descriptor.outputSchema ? { outputSchema: serializableActionSchema(descriptor.outputSchema) } : {}),
  };
}
