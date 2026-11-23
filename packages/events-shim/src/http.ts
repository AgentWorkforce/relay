import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { advertiseEventsExtension, handleEventsRequest, isEventsRequest } from './events.js';
import { EVENTS_SHIM_LIMITS } from './limits.js';
import { buildEventsShimMcpServer } from './mcp.js';
import {
  createShim,
  EventsShimInputError,
  feedFor,
  findShimByManageToken,
  findShimByMcpToken,
  receivePost,
  rotateHook,
  setModeSecret,
  type EventsShimDeps,
} from './service.js';
import type { SecretMode, ShimRecord, ShimUrls, VerificationMode } from './types.js';
import { VERIFICATION_MODES } from './types.js';

export interface EventsShimHttpOptions {
  deps: EventsShimDeps;
  urls: ShimUrls;
  relayOrigins?: readonly string[];
  /** Host check run before a shim is created (per-IP rate limit). Return a Response to refuse. */
  beforeCreate?: (request: Request) => Promise<Response | undefined>;
  pollIntervalMs?: number;
  version?: string;
  /** Tunes `events/stream` (MCP Events push): store re-read interval and longest open stream. */
  eventsStream?: { pollMs?: number; maxStreamMs?: number };
  /**
   * Path prefixes (under the host's origin) to list in
   * `/.well-known/mcp-webhook-receiver.json`, e.g. `['/api/v1/events-shim/h/']`.
   * Publishing it lets an MCP Events server deliver to this host's `/h/<token>/mcp`
   * URLs without a challenge round trip. The route answers only when this is set
   * and the host routes `/.well-known/mcp-webhook-receiver.json` here.
   */
  mcpWebhookReceivers?: readonly string[];
}

/**
 * Routes, relative to wherever the host mounts them:
 *
 * - `POST /shims` creates an inbox (returns the MCP URL, webhook URL and a manage token)
 * - `GET /shims/current` reads the feed (`Authorization: Bearer <manage token>`)
 * - `POST /shims/current/rotate` replaces the webhook URL
 * - `PUT /shims/current/secrets/<mode>` sets a verification secret
 * - `POST /h/<hook token>[/<mode>]` receives a webhook post
 * - `POST /t/<mcp token>/mcp` is the MCP endpoint (Streamable HTTP, stateless), which
 *   also answers the MCP Events extension (`events/list`, `events/poll`, `events/stream`)
 * - `GET /.well-known/mcp-webhook-receiver.json`, when `mcpWebhookReceivers` is set
 *
 * @param request - The incoming request.
 * @param path - The request path after the host's mount point, e.g. `/h/<token>`.
 * @param options - The store, URL shapes, allowed relay origins and host hooks.
 * @returns The response, or `null` when `path` is not one of these routes.
 */
export async function handleEventsShimRequest(
  request: Request,
  path: string,
  options: EventsShimHttpOptions
): Promise<Response | null> {
  const method = request.method.toUpperCase();

  if (path === '/.well-known/mcp-webhook-receiver.json' && options.mcpWebhookReceivers?.length) {
    if (method !== 'GET')
      return json(405, { error: 'method_not_allowed', message: 'GET this document.' }, { allow: 'GET' });
    return json(
      200,
      { receivers: [...options.mcpWebhookReceivers] },
      { 'cache-control': 'public, max-age=3600' }
    );
  }

  const hook = /^\/h\/([A-Za-z0-9_-]{1,100})(?:\/([a-z]+))?\/?$/.exec(path);
  if (hook) {
    if (method !== 'POST')
      return json(405, { error: 'method_not_allowed', message: 'POST JSON to this URL.' }, { allow: 'POST' });
    const mode = (hook[2] ?? 'open') as VerificationMode;
    if (!VERIFICATION_MODES.includes(mode))
      return json(404, { error: 'not_found', message: 'Unknown verification mode.' });
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > EVENTS_SHIM_LIMITS.maxBodyBytes) {
      return json(413, {
        error: 'payload_too_large',
        message: `Bodies are limited to ${EVENTS_SHIM_LIMITS.maxBodyBytes / 1024} KB.`,
      });
    }
    const rawBody = await readBounded(request, EVENTS_SHIM_LIMITS.maxBodyBytes);
    if (rawBody === null) {
      return json(413, {
        error: 'payload_too_large',
        message: `Bodies are limited to ${EVENTS_SHIM_LIMITS.maxBodyBytes / 1024} KB.`,
      });
    }
    const outcome = await receivePost(options.deps, {
      hookToken: hook[1]!,
      mode,
      headers: request.headers,
      rawBody,
    });
    return json(outcome.status, outcome.body, outcome.headers);
  }

  const mcp = /^\/t\/([A-Za-z0-9_-]{1,100})\/mcp\/?$/.exec(path);
  if (mcp) return handleMcp(request, mcp[1]!, options);

  if (path === '/shims' || path === '/shims/') {
    if (method !== 'POST')
      return json(
        405,
        { error: 'method_not_allowed', message: 'POST to create a webhook inbox.' },
        { allow: 'POST' }
      );
    const refused = await options.beforeCreate?.(request);
    if (refused) return refused;
    const minted = await createShim(options.deps);
    return json(201, {
      shim_id: minted.shim.id,
      mcp_url: options.urls.mcpUrl(minted.mcpToken),
      webhook_url: options.urls.hookUrl(minted.hookToken, 'open'),
      webhook_urls: Object.fromEntries(
        VERIFICATION_MODES.map((mode) => [mode, options.urls.hookUrl(minted.hookToken, mode)])
      ),
      manage_token: minted.manageToken,
      limits: EVENTS_SHIM_LIMITS,
    });
  }

  const manage = /^\/shims\/current(\/rotate|\/secrets\/([a-z]+))?\/?$/.exec(path);
  if (manage) {
    const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
    const shim = token ? await findShimByManageToken(options.deps, token) : null;
    if (!shim)
      return json(404, {
        error: 'not_found',
        message: 'This webhook inbox expired or the link is wrong. Create a new one.',
      });
    if (!manage[1]) {
      if (method !== 'GET')
        return json(405, { error: 'method_not_allowed', message: 'GET the feed.' }, { allow: 'GET' });
      return json(200, await feedFor(options.deps, shim, options.urls));
    }
    if (manage[1] === '/rotate') {
      if (method !== 'POST')
        return json(405, { error: 'method_not_allowed', message: 'POST to rotate.' }, { allow: 'POST' });
      const hookToken = await rotateHook(options.deps, shim);
      return json(200, await feedFor(options.deps, { ...shim, hookToken }, options.urls));
    }
    const mode = manage[2] as SecretMode;
    if (!VERIFICATION_MODES.includes(mode) || (mode as VerificationMode) === 'open') {
      return json(404, {
        error: 'not_found',
        message: 'Secrets exist for github, stripe, linear, bearer and mcp.',
      });
    }
    if (method !== 'PUT')
      return json(405, { error: 'method_not_allowed', message: 'PUT {"secret": "…"}.' }, { allow: 'PUT' });
    const body = await readJsonObject(request);
    if (!body) return json(400, { error: 'invalid_request', message: 'Send a JSON object.' });
    const secret = body.secret;
    if (secret !== undefined && secret !== null && typeof secret !== 'string') {
      return json(400, { error: 'invalid_request', message: 'secret must be a string or null.' });
    }
    try {
      const saved = await setModeSecret(options.deps, shim, mode, secret as string | null | undefined);
      return json(200, {
        mode,
        set: secret !== null,
        ...(saved.secret ? { secret: saved.secret } : {}),
        webhook_url: options.urls.hookUrl(shim.hookToken, mode),
      });
    } catch (error) {
      if (error instanceof EventsShimInputError)
        return json(400, { error: 'invalid_request', message: error.message });
      throw error;
    }
  }

  return null;
}

async function handleMcp(request: Request, token: string, options: EventsShimHttpOptions): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') {
    return rpcError(405, 'This MCP server speaks Streamable HTTP over POST.', { allow: 'POST' });
  }
  const shim: ShimRecord | null = await findShimByMcpToken(options.deps, token);
  if (!shim)
    return rpcError(
      404,
      'This MCP URL expired or was never valid. Create a new one at the page that gave it to you.'
    );
  const raw = await readBounded(request, 64 * 1024);
  if (raw === null) return rpcError(413, 'Request too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return rpcError(400, 'Body must be JSON-RPC.');
  }
  if (isEventsRequest(parsed)) {
    return handleEventsRequest(parsed, {
      deps: options.deps,
      shim,
      mcpToken: token,
      headers: request.headers,
      signal: request.signal,
      streamPollMs: options.eventsStream?.pollMs,
      maxStreamMs: options.eventsStream?.maxStreamMs,
    });
  }
  const initializing =
    Boolean(parsed) && typeof parsed === 'object' && (parsed as { method?: unknown }).method === 'initialize';
  const server = buildEventsShimMcpServer({
    deps: options.deps,
    shim,
    urls: options.urls,
    // A long wait must see a wake link made, removed or broken by another request meanwhile.
    reloadShim: () => findShimByMcpToken(options.deps, token),
    relayOrigins: options.relayOrigins,
    pollIntervalMs: options.pollIntervalMs,
    signal: request.signal,
    version: options.version,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const headers = new Headers(request.headers);
    // Clients send both; the transport requires it even in JSON mode.
    headers.set('accept', 'application/json, text/event-stream');
    const response = await transport.handleRequest(
      new Request(request.url, { method: 'POST', headers, body: raw }),
      { parsedBody: parsed }
    );
    const out = new Headers(response.headers);
    out.set('cache-control', 'no-store');
    const text = await response.text();
    return new Response(initializing && response.ok ? advertiseEventsExtension(text) : text, {
      status: response.status,
      headers: out,
    });
  } finally {
    await server.close().catch(() => undefined);
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function rpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { jsonrpc: '2.0', id: null, error: { code: -32000, message } }, headers);
}

/** Reads the body as text, or `null` once it passes `limit` bytes. */
async function readBounded(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await readBounded(request, 8 * 1024);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
