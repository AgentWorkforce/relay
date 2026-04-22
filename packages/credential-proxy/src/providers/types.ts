export type ProviderType = 'openai' | 'anthropic' | 'openrouter';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model?: string;
}

export interface ProviderAdapter {
  readonly name: ProviderType;
  authHeader(apiKey: string): Record<string, string>;
  readonly baseUrl: string;
  matchesPath(path: string): boolean;
  forwardRequest(req: Request, apiKey: string): Promise<Response>;
  extractUsage(response: Response | object): TokenUsage | null;
}

/** Maximum SSE buffer size (1 MB) before discarding incomplete data to prevent OOM. */
const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

/** Headers stripped from incoming agent requests before forwarding upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'connection',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'transfer-encoding',
]);

type UsageState = {
  usage: TokenUsage | null;
};

type JsonTransform = (body: unknown) => unknown;
type StreamingUsageExtractor = (eventData: string) => TokenUsage | null;

const usageStateByResponse = new WeakMap<Response, UsageState>();
const usagePromiseByResponse = new WeakMap<Response, Promise<TokenUsage | null>>();

export function getCapturedUsage(response: Response): TokenUsage | null {
  return usageStateByResponse.get(response)?.usage ?? null;
}

export function waitForCapturedUsage(response: Response): Promise<TokenUsage | null> {
  return usagePromiseByResponse.get(response) ?? Promise.resolve(getCapturedUsage(response));
}

export function normalizePath(path: string): string {
  const pathname = new URL(path, 'http://localhost').pathname;
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createTokenUsage(inputTokens: number, outputTokens: number, model?: string): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(model ? { model } : {}),
  };
}

export function extractOpenAIUsage(payload: unknown): TokenUsage | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    return null;
  }

  const inputTokens = getNumber(payload.usage.prompt_tokens) ?? 0;
  const outputTokens = getNumber(payload.usage.completion_tokens) ?? 0;

  if (inputTokens === 0 && outputTokens === 0) {
    return null;
  }

  const model = typeof payload.model === 'string' ? payload.model : undefined;
  return createTokenUsage(inputTokens, outputTokens, model);
}

export function extractAnthropicUsage(payload: unknown): TokenUsage | null {
  if (!isRecord(payload)) {
    return null;
  }

  const usage =
    (isRecord(payload.usage) && payload.usage)
    || (isRecord(payload.message) && isRecord(payload.message.usage) && payload.message.usage)
    || (isRecord(payload.delta) && isRecord(payload.delta.usage) && payload.delta.usage);

  if (!usage) {
    return null;
  }

  const inputTokens = getNumber(usage.input_tokens) ?? 0;
  const outputTokens = getNumber(usage.output_tokens) ?? 0;

  if (inputTokens === 0 && outputTokens === 0) {
    return null;
  }

  const model = typeof payload.model === 'string' ? payload.model : undefined;
  return createTokenUsage(inputTokens, outputTokens, model);
}

export async function forwardProviderRequest(options: {
  request: Request;
  baseUrl: string;
  authHeaders: Record<string, string>;
  usageExtractor: (payload: unknown) => TokenUsage | null;
  streamingUsageExtractor?: StreamingUsageExtractor;
  transformJsonBody?: JsonTransform;
  extraHeaders?: Record<string, string>;
}): Promise<Response> {
  const requestUrl = new URL(options.request.url);
  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, options.baseUrl);
  const headers = createUpstreamRequestHeaders(
    options.request.headers,
    options.authHeaders,
    options.extraHeaders
  );
  const body = await createUpstreamRequestBody(options.request, options.transformJsonBody);

  const upstreamResponse = await fetch(upstreamUrl, {
    method: options.request.method,
    headers,
    body,
    redirect: 'manual',
  });

  return captureProviderResponse(
    upstreamResponse,
    options.usageExtractor,
    options.streamingUsageExtractor
  );
}

function createUpstreamRequestHeaders(
  incomingHeaders: Headers,
  authHeaders: Record<string, string>,
  extraHeaders?: Record<string, string>
): Headers {
  const headers = new Headers();

  incomingHeaders.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lowerKey)) {
      return;
    }

    headers.set(key, value);
  });

  for (const [key, value] of Object.entries(authHeaders)) {
    headers.set(key, value);
  }

  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers.set(key, value);
    }
  }

  return headers;
}

async function createUpstreamRequestBody(
  request: Request,
  transformJsonBody?: JsonTransform
): Promise<RequestInit['body'] | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }

  const rawBody = await request.clone().text();
  if (rawBody.length === 0) {
    return undefined;
  }

  if (!transformJsonBody || !isJsonContentType(request.headers.get('content-type'))) {
    return rawBody;
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return JSON.stringify(transformJsonBody(parsed));
  } catch {
    return rawBody;
  }
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().includes('application/json') ?? false;
}

function captureProviderResponse(
  upstreamResponse: Response,
  usageExtractor: (payload: unknown) => TokenUsage | null,
  streamingUsageExtractor?: StreamingUsageExtractor
): Promise<Response> | Response {
  const contentType = upstreamResponse.headers.get('content-type')?.toLowerCase() ?? '';

  if (
    upstreamResponse.body &&
    contentType.includes('text/event-stream') &&
    streamingUsageExtractor
  ) {
    return captureStreamingResponse(upstreamResponse, streamingUsageExtractor);
  }

  return captureNonStreamingResponse(upstreamResponse, usageExtractor);
}

async function captureNonStreamingResponse(
  upstreamResponse: Response,
  usageExtractor: (payload: unknown) => TokenUsage | null
): Promise<Response> {
  if (!upstreamResponse.body) {
    const response = new Response(null, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: cloneResponseHeaders(upstreamResponse.headers),
    });

    const state: UsageState = { usage: null };
    usageStateByResponse.set(response, state);
    usagePromiseByResponse.set(response, Promise.resolve(null));
    return response;
  }

  const rawBody = await upstreamResponse.text();
  let usage: TokenUsage | null = null;

  try {
    usage = usageExtractor(JSON.parse(rawBody) as unknown);
  } catch {
    usage = null;
  }

  const response = new Response(rawBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: cloneResponseHeaders(upstreamResponse.headers),
  });

  const state: UsageState = { usage };
  usageStateByResponse.set(response, state);
  usagePromiseByResponse.set(response, Promise.resolve(usage));
  return response;
}

function captureStreamingResponse(
  upstreamResponse: Response,
  streamingUsageExtractor: StreamingUsageExtractor
): Response {
  const state: UsageState = { usage: null };
  let resolveUsage: ((value: TokenUsage | null) => void) | undefined;
  const usagePromise = new Promise<TokenUsage | null>((resolve) => {
    resolveUsage = resolve;
  });

  const decoder = new TextDecoder();
  let buffer = '';

  const transformedBody = upstreamResponse.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        buffer += decoder.decode(chunk, { stream: true });

        // Prevent unbounded buffer growth from malformed SSE streams.
        if (buffer.length > MAX_SSE_BUFFER_BYTES) {
          buffer = '';
          return;
        }

        const consumed = consumeCompleteSseEvents(buffer);
        buffer = consumed.remainder;

        for (const eventText of consumed.events) {
          const usage = extractUsageFromSseEvent(eventText, streamingUsageExtractor);
          if (usage) {
            state.usage = usage;
          }
        }
      },
      flush() {
        buffer += decoder.decode();
        const consumed = consumeCompleteSseEvents(`${buffer}\n\n`);

        for (const eventText of consumed.events) {
          const usage = extractUsageFromSseEvent(eventText, streamingUsageExtractor);
          if (usage) {
            state.usage = usage;
          }
        }

        resolveUsage?.(state.usage);
      },
    })
  );

  const response = new Response(transformedBody, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: cloneResponseHeaders(upstreamResponse.headers),
  });

  usageStateByResponse.set(response, state);
  usagePromiseByResponse.set(response, usagePromise);

  return response;
}

function consumeCompleteSseEvents(buffer: string): { events: string[]; remainder: string } {
  const events: string[] = [];
  const separator = /\r?\n\r?\n/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = separator.exec(buffer)) !== null) {
    events.push(buffer.slice(lastIndex, match.index));
    lastIndex = separator.lastIndex;
  }

  return {
    events,
    remainder: buffer.slice(lastIndex),
  };
}

function extractUsageFromSseEvent(
  eventText: string,
  streamingUsageExtractor: StreamingUsageExtractor
): TokenUsage | null {
  if (eventText.trim().length === 0) {
    return null;
  }

  const dataLines: string[] = [];
  for (const line of eventText.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return streamingUsageExtractor(dataLines.join('\n'));
}

function cloneResponseHeaders(headers: Headers): Headers {
  const cloned = new Headers(headers);
  cloned.delete('content-length');
  return cloned;
}
