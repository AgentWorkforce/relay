import {
  extractOpenAIUsage,
  forwardProviderRequest,
  getCapturedUsage,
  isRecord,
  normalizePath,
  type ProviderAdapter,
  type TokenUsage,
} from './types.js';

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

export class OpenAIProviderAdapter implements ProviderAdapter {
  readonly name = 'openai' as const;
  readonly baseUrl = 'https://api.openai.com';

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

export const openAIProviderAdapter = new OpenAIProviderAdapter();
