import { ensureCloudSession, buildApiUrl, type CloudSession } from '@agent-relay/cloud';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const SHARED_SESSIONS_MCP_PATH = '/api/v1/mcp/shared-sessions';
const HOSTED_MCP_TIMEOUT_MS = 15_000;

export const SHARED_SESSION_TOOL_NAMES = new Set([
  'search_shared_sessions',
  'get_shared_session',
  'get_shared_session_context',
]);

type CloudSessionResolver = (options: {
  interactive: false;
  validateApiUrl: (apiUrl: string) => void;
}) => Promise<CloudSession>;

export interface SharedSessionsMcpClientOptions {
  ensureSession?: CloudSessionResolver;
}

export interface SharedSessionsMcpClientLike {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Terminally cancel discovery/calls and release any hosted MCP transport. */
  close?(): Promise<void>;
}

/** Error shown by the stdio MCP server when no reusable Cloud login exists. */
export class SharedSessionsCloudAuthError extends Error {
  constructor(cause: unknown) {
    super(
      'Shared sessions require a valid Cloud login. Run `agent-relay cloud login` (or `agent-relay cloud login --device` on a headless machine), then restart the MCP server.',
      { cause }
    );
    this.name = 'SharedSessionsCloudAuthError';
  }
}

/** Error shown when the login is valid but cannot read the selected workspace history. */
export class SharedSessionsCloudPermissionError extends Error {
  constructor(cause: unknown) {
    super(
      'Your Cloud login does not have permission to read shared sessions in this workspace. Switch to an authorized workspace or ask a workspace administrator for access.',
      { cause }
    );
    this.name = 'SharedSessionsCloudPermissionError';
  }
}

/** Error raised before Cloud credentials could be sent over an unsafe transport. */
export class SharedSessionsInsecureCloudUrlError extends Error {
  constructor(cause?: unknown) {
    super(
      'Shared sessions refuse to send Cloud credentials over an insecure API URL. Use HTTPS, or HTTP only for localhost, 127.0.0.1, or [::1].',
      { cause }
    );
    this.name = 'SharedSessionsInsecureCloudUrlError';
  }
}

/** Error raised after a discovery client has been terminally cancelled. */
export class SharedSessionsMcpClientClosedError extends Error {
  constructor() {
    super('Shared sessions Cloud discovery was cancelled.');
    this.name = 'SharedSessionsMcpClientClosedError';
  }
}

/** Error raised when the configured Cloud deployment lacks part of the hosted MCP contract. */
export class SharedSessionsUnsupportedDeploymentError extends Error {
  readonly missingTools: string[];

  constructor(missingTools: string[]) {
    super(
      `The configured Cloud deployment does not support shared sessions yet (missing hosted MCP tools: ${missingTools.join(', ')}). Verify CLOUD_API_URL or update the Cloud deployment, then restart the MCP server.`
    );
    this.name = 'SharedSessionsUnsupportedDeploymentError';
    this.missingTools = missingTools;
  }
}

/** A sessions-only server is useful only when Cloud exposes the complete public toolset. */
export function requireCompleteSharedSessionToolset(tools: readonly Pick<Tool, 'name'>[]): void {
  const discovered = new Set(tools.map((tool) => tool.name));
  const missing = [...SHARED_SESSION_TOOL_NAMES].filter((name) => !discovered.has(name));
  if (missing.length > 0) throw new SharedSessionsUnsupportedDeploymentError(missing);
}

/**
 * A small MCP-to-MCP client for the hosted shared-session surface.
 *
 * Cloud owns authentication and refresh. The MCP transport receives a custom
 * fetch implementation backed by the existing Cloud API client, so every
 * initialize/list/call request gets the current bearer after serialized token
 * rotation. `interactive: false` is deliberate: an MCP stdio subprocess must
 * never open a browser or block on device authorization.
 */
export class SharedSessionsMcpClient implements SharedSessionsMcpClientLike {
  private readonly ensureSession: CloudSessionResolver;
  private client: Client | undefined;
  private connectingClient: Client | undefined;
  private connectingTransport: StreamableHTTPClientTransport | undefined;
  private connecting: Promise<Client> | undefined;
  private closed = false;
  private generation = 0;

  constructor(options: SharedSessionsMcpClientOptions = {}) {
    this.ensureSession = options.ensureSession ?? ((authOptions) => ensureCloudSession(authOptions));
  }

  async listTools(): Promise<Tool[]> {
    try {
      const client = await this.connectedClient();
      const response = await client.listTools(undefined, { timeout: HOSTED_MCP_TIMEOUT_MS });
      return response.tools.filter((tool) => SHARED_SESSION_TOOL_NAMES.has(tool.name));
    } catch (error) {
      throw this.actionableCloudError(error);
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!SHARED_SESSION_TOOL_NAMES.has(name)) {
      throw new Error(`Hosted shared sessions does not expose the tool "${name}".`);
    }

    try {
      const client = await this.connectedClient();
      return (await client.callTool({ name, arguments: args }, undefined, {
        timeout: HOSTED_MCP_TIMEOUT_MS,
      })) as CallToolResult;
    } catch (error) {
      throw this.actionableCloudError(error);
    }
  }

  /**
   * Terminally cancel this proxy client. State flips synchronously so a caller
   * may intentionally fire-and-forget the returned cleanup promise on timeout.
   */
  close(): Promise<void> {
    if (this.closed && !this.client && !this.connectingClient && !this.connectingTransport) {
      return Promise.resolve();
    }

    this.closed = true;
    this.generation += 1;
    const clients = [...new Set([this.client, this.connectingClient].filter(Boolean))] as Client[];
    const orphanedTransport = this.connectingClient ? undefined : this.connectingTransport;
    this.client = undefined;
    this.connectingClient = undefined;
    this.connectingTransport = undefined;
    this.connecting = undefined;

    const cleanup = clients.map((client) => client.close());
    if (orphanedTransport) cleanup.push(orphanedTransport.close());
    return Promise.allSettled(cleanup).then(() => undefined);
  }

  private async connectedClient(): Promise<Client> {
    this.assertOpen();
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    const pending = this.connect(this.generation);
    this.connecting = pending;
    try {
      return await pending;
    } finally {
      // Login can happen after a long-lived MCP process started. Do not cache a
      // failed auth attempt: the next tools/list should retry the local store.
      if (this.connecting === pending) this.connecting = undefined;
    }
  }

  private async connect(generation: number): Promise<Client> {
    let session: CloudSession;
    try {
      session = await this.ensureSession({
        interactive: false,
        validateApiUrl: assertSharedSessionsCloudApiUrl,
      });
    } catch (error) {
      throw this.actionableCloudError(error);
    }
    this.assertActive(generation);
    // Preserve the invariant for injected resolvers that do not apply the hook.
    assertSharedSessionsCloudApiUrl(session.auth.apiUrl);

    const endpoint = buildApiUrl(session.auth.apiUrl, SHARED_SESSIONS_MCP_PATH);
    const transport = new StreamableHTTPClientTransport(endpoint, {
      // The hosted route is a stateless Streamable HTTP server. It returns
      // JSON for POST and deliberately has no GET/SSE session.
      fetch: async (_input, init) =>
        session.client.fetch(SHARED_SESSIONS_MCP_PATH, { ...init, redirect: 'error' }),
      requestInit: { redirect: 'error' },
    });
    const client = new Client({ name: 'agent-relay-shared-sessions', version: '1.0.0' });
    this.connectingClient = client;
    this.connectingTransport = transport;

    try {
      await client.connect(transport, { timeout: HOSTED_MCP_TIMEOUT_MS });
      this.assertActive(generation);
    } catch (error) {
      await client.close().catch(() => undefined);
      if (!this.isActive(generation)) throw new SharedSessionsMcpClientClosedError();
      throw this.actionableCloudError(error);
    } finally {
      if (this.connectingClient === client) this.connectingClient = undefined;
      if (this.connectingTransport === transport) this.connectingTransport = undefined;
    }

    this.client = client;
    return client;
  }

  private actionableCloudError(error: unknown): unknown {
    if (this.closed) return new SharedSessionsMcpClientClosedError();
    if (
      error instanceof SharedSessionsCloudAuthError ||
      error instanceof SharedSessionsCloudPermissionError ||
      error instanceof SharedSessionsInsecureCloudUrlError ||
      error instanceof SharedSessionsMcpClientClosedError
    ) {
      return error;
    }
    const status = error instanceof StreamableHTTPError ? error.code : numericErrorCode(error);
    if (status === 403 || /\bforbidden\b/i.test(errorMessage(error))) {
      return new SharedSessionsCloudPermissionError(error);
    }
    if (
      status === 401 ||
      /\bunauthori[sz]ed\b/i.test(errorMessage(error)) ||
      /\blogin required\b/i.test(errorMessage(error)) ||
      stringErrorCode(error)?.startsWith('AUTH_')
    ) {
      return new SharedSessionsCloudAuthError(error);
    }
    return error;
  }

  private assertOpen(): void {
    if (this.closed) throw new SharedSessionsMcpClientClosedError();
  }

  private isActive(generation: number): boolean {
    return !this.closed && this.generation === generation;
  }

  private assertActive(generation: number): void {
    if (!this.isActive(generation)) throw new SharedSessionsMcpClientClosedError();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numericErrorCode(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
    ? error.code
    : undefined;
}

function stringErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Enforce TLS except for explicit loopback development endpoints. */
export function assertSharedSessionsCloudApiUrl(apiUrl: string): void {
  try {
    const url = new URL(apiUrl);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password
    ) {
      throw new SharedSessionsInsecureCloudUrlError();
    }
  } catch (error) {
    if (error instanceof SharedSessionsInsecureCloudUrlError) throw error;
    throw new SharedSessionsInsecureCloudUrlError(error);
  }
}

/**
 * Register the allowlisted hosted tools on the public MCP server API. Their
 * schemas are fetched from Cloud, converted to Zod for local validation, and
 * converted back by the MCP SDK for tools/list; no tool schema is duplicated
 * in this package.
 */
export function registerSharedSessionTools(
  server: McpServer,
  client: SharedSessionsMcpClientLike,
  tools: Tool[],
  options: { strict: boolean } = { strict: true }
): void {
  const registered = new Set<string>();
  for (const tool of tools) {
    if (!SHARED_SESSION_TOOL_NAMES.has(tool.name) || registered.has(tool.name)) continue;
    registered.add(tool.name);
    try {
      const inputSchema = jsonSchemaToZod(tool.inputSchema);
      const outputSchema = tool.outputSchema ? jsonSchemaToZod(tool.outputSchema) : undefined;
      server.registerTool(
        tool.name,
        {
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        },
        async (args) => client.callTool(tool.name, asArguments(args))
      );
    } catch (error) {
      if (options.strict) {
        throw new Error(`Hosted shared-session tool "${tool.name}" has an invalid definition.`, {
          cause: error,
        });
      }
    }
  }
}

function asArguments(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Convert the hosted MCP JSON Schema through Zod's official converter. */
function jsonSchemaToZod(schema: unknown): z.ZodType {
  return z.fromJSONSchema(inlineLocalJsonSchemaRefs(schema) as Parameters<typeof z.fromJSONSchema>[0]);
}

/**
 * Zod's converter resolves `$defs` references, while MCP SDK schema emission
 * can also deduplicate a reused property as `#/properties/<name>`. Inline
 * those local JSON Pointer references without changing the hosted constraints.
 */
function inlineLocalJsonSchemaRefs(schema: unknown): unknown {
  const root = schema;

  const visit = (value: unknown, resolving: ReadonlySet<string>): unknown => {
    if (Array.isArray(value)) return value.map((item) => visit(item, resolving));
    if (!value || typeof value !== 'object') return value;

    const record = value as Record<string, unknown>;
    const ref = record.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/')) {
      if (resolving.has(ref)) throw new Error(`Cyclic local JSON Schema reference: ${ref}`);
      const target = resolveJsonPointer(root, ref);
      if (target === undefined) throw new Error(`Local JSON Schema reference not found: ${ref}`);
      const nextResolving = new Set(resolving).add(ref);
      const resolved = visit(target, nextResolving);
      const siblings = Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => key !== '$ref')
          .map(([key, child]) => [key, visit(child, resolving)])
      );
      return resolved && typeof resolved === 'object' && !Array.isArray(resolved)
        ? { ...(resolved as Record<string, unknown>), ...siblings }
        : resolved;
    }

    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, visit(child, resolving)]));
  };

  return visit(schema, new Set());
}

function resolveJsonPointer(root: unknown, ref: string): unknown {
  let current = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    if (!current || typeof current !== 'object') return undefined;
    const segment = rawSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
