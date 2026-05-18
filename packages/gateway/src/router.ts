/**
 * Gateway Router
 *
 * Routes incoming webhooks through the configurable pipeline:
 * 1. Find adapter by source type
 * 2. Verify signature
 * 3. Parse payload into NormalizedMessage[]
 * 4. Match messages against rules
 * 5. Return ProcessResult
 */

import type {
  SurfaceType,
  SurfaceAdapter,
  HeaderMap,
  NormalizedMessage,
  OutboundMessage,
  DeliveryResult,
  GatewayMetadata,
  WebhookRule,
  ProcessResult,
  ProcessResultEntry,
  GatewayOptions,
} from './types.js';
import { findMatchingRules } from './rules-engine.js';

function normalizeHeaders(headers: HeaderMap): HeaderMap {
  const normalized: Record<string, HeaderMap[string]> = {};

  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }

  return normalized;
}

export class Gateway {
  private readonly adapters = new Map<SurfaceType, SurfaceAdapter>();
  private rules: WebhookRule[];

  constructor(options?: GatewayOptions) {
    this.rules = options?.rules ?? [];

    if (options?.adapters) {
      for (const adapter of options.adapters) {
        this.registerAdapter(adapter);
      }
    }
  }

  /**
   * Register a surface adapter
   */
  registerAdapter(adapter: SurfaceAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  /**
   * Get a registered adapter by type
   */
  getAdapter(type: SurfaceType): SurfaceAdapter | undefined {
    return this.adapters.get(type);
  }

  /**
   * Process an incoming webhook
   */
  processWebhook(source: SurfaceType, payload: string, headers: HeaderMap): ProcessResult {
    const normalizedHeaders = normalizeHeaders(headers);
    const adapter = this.adapters.get(source);

    if (!adapter) {
      return {
        source,
        verified: false,
        entries: [],
        error: `No adapter registered for source: ${source}`,
      };
    }

    // Verify signature
    const verified = adapter.verify(payload, normalizedHeaders);
    if (!verified) {
      return {
        source,
        verified: false,
        entries: [],
        error: 'Signature verification failed',
      };
    }

    // Parse payload
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return {
        source,
        verified: true,
        entries: [],
        error: 'Invalid JSON payload',
      };
    }

    // Receive normalized messages
    let messages: NormalizedMessage[];
    try {
      messages = adapter.receive(parsed, normalizedHeaders);
      if (!Array.isArray(messages)) {
        throw new Error('Adapter receive() must return an array of normalized messages');
      }
    } catch (error) {
      return {
        source,
        verified: true,
        entries: [],
        error: `Parse error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }

    // Match rules for each message
    const entries: ProcessResultEntry[] = messages.map((message) => {
      const matchedRules = findMatchingRules(this.rules, message);
      const actions = matchedRules.map((rule) => rule.action);

      return {
        message,
        matchedRules,
        actions,
      };
    });

    return {
      source,
      verified: true,
      entries,
    };
  }

  /**
   * Deliver an outbound message via the appropriate adapter
   */
  async deliver(
    event: NormalizedMessage,
    message: OutboundMessage,
    config?: GatewayMetadata
  ): Promise<DeliveryResult> {
    const adapter = this.adapters.get(event.source);

    if (!adapter) {
      return {
        success: false,
        error: `No adapter registered for source: ${event.source}`,
      };
    }

    return adapter.deliver(event, message, config);
  }
}
