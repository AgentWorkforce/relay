import {
  extractAnthropicUsage,
  forwardProviderRequest,
  getCapturedUsage,
  normalizePath,
  type ProviderAdapter,
  type TokenUsage,
} from './types.js';

function extractStreamingUsage(eventData: string): TokenUsage | null {
  try {
    return extractAnthropicUsage(JSON.parse(eventData) as unknown);
  } catch {
    return null;
  }
}

export class AnthropicProviderAdapter implements ProviderAdapter {
  readonly name = 'anthropic' as const;
  readonly baseUrl = 'https://api.anthropic.com';

  authHeader(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  matchesPath(path: string): boolean {
    return normalizePath(path) === '/v1/messages';
  }

  forwardRequest(req: Request, apiKey: string): Promise<Response> {
    return forwardProviderRequest({
      request: req,
      baseUrl: this.baseUrl,
      authHeaders: this.authHeader(apiKey),
      usageExtractor: extractAnthropicUsage,
      streamingUsageExtractor: extractStreamingUsage,
    });
  }

  extractUsage(response: Response | object): TokenUsage | null {
    if (response instanceof Response) {
      return getCapturedUsage(response);
    }

    return extractAnthropicUsage(response);
  }
}

export const anthropicProviderAdapter = new AnthropicProviderAdapter();
