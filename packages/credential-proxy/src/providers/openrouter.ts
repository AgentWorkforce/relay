import {
  extractOpenAIUsage,
  forwardProviderRequest,
  getCapturedUsage,
  isRecord,
  normalizePath,
  type ProviderAdapter,
  type TokenUsage,
} from './types.js';

const OPENROUTER_TITLE = 'Relay Credential Proxy';

function injectStreamingUsage(body: unknown): unknown {
  if (!isRecord(body) || body.stream !== true) {
    return body;
  }

  const streamOptions = isRecord(body.stream_options) ? body.stream_options : {};
  return {
    ...body,
    stream_options: {
      ...streamOptions,
      include_usage: true,
    },
  };
}

function extractStreamingUsage(eventData: string): TokenUsage | null {
  if (eventData === '[DONE]') {
    return null;
  }

  try {
    return extractOpenAIUsage(JSON.parse(eventData) as unknown);
  } catch {
    return null;
  }
}

export class OpenRouterProviderAdapter implements ProviderAdapter {
  readonly name = 'openrouter' as const;
  readonly baseUrl = 'https://openrouter.ai/api';

  authHeader(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
    };
  }

  matchesPath(path: string): boolean {
    const normalizedPath = normalizePath(path);
    return normalizedPath === '/v1/chat/completions' || normalizedPath === '/v1/embeddings';
  }

  forwardRequest(req: Request, apiKey: string): Promise<Response> {
    return forwardProviderRequest({
      request: req,
      baseUrl: this.baseUrl,
      authHeaders: this.authHeader(apiKey),
      extraHeaders: {
        'X-Title': OPENROUTER_TITLE,
      },
      usageExtractor: extractOpenAIUsage,
      streamingUsageExtractor: extractStreamingUsage,
      transformJsonBody: injectStreamingUsage,
    });
  }

  extractUsage(response: Response | object): TokenUsage | null {
    if (response instanceof Response) {
      return getCapturedUsage(response);
    }

    return extractOpenAIUsage(response);
  }
}

export const openRouterProviderAdapter = new OpenRouterProviderAdapter();
