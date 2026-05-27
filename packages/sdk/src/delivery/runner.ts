import { RelayCapabilityError } from '../capabilities.js';
import type { InboxItem, RelayMessaging } from '../messaging/index.js';
import type { AgentDeliveryAdapter, InjectionContext, InjectionResult } from './types.js';

export interface DeliveryRunnerOptions {
  messaging: RelayMessaging;
  delivery: AgentDeliveryAdapter;
  agentName?: string;
  context?: Partial<InjectionContext>;
  onResult?: (item: InboxItem, result: InjectionResult) => void | Promise<void>;
  onError?: (item: InboxItem, error: unknown) => void | Promise<void>;
}

export class DeliveryRunner {
  private stopped = false;
  private running?: Promise<void>;

  constructor(private readonly options: DeliveryRunnerOptions) {}

  start(): Promise<void> {
    if (!this.options.messaging.capabilities.serverDeliveryState) {
      throw new RelayCapabilityError(
        'messaging.capabilities.serverDeliveryState',
        'DeliveryRunner requires server-backed delivery state for ack/fail/defer.'
      );
    }
    this.running ??= this.run();
    return this.running;
  }

  stop(): void {
    this.stopped = true;
  }

  private async run(): Promise<void> {
    await this.options.delivery.connect?.();
    try {
      for await (const item of this.options.messaging.inbox.subscribe({
        agentName: this.options.agentName,
      })) {
        if (this.stopped) return;
        await this.deliver(item);
      }
    } finally {
      await this.options.delivery.disconnect?.();
    }
  }

  private async deliver(item: InboxItem): Promise<void> {
    try {
      const result = await this.options.delivery.inject(item.message, {
        reason: this.options.context?.reason ?? 'message',
        priority: this.options.context?.priority,
        mode: this.options.context?.mode,
      });
      await Promise.resolve(this.options.onResult?.(item, result));
      if (result.status === 'deferred') {
        await this.options.messaging.inbox.defer({
          inboxItemId: item.id,
          availableAt: result.availableAt ?? new Date(Date.now() + 30_000).toISOString(),
          reason: result.reason,
          metadata: result.metadata,
        });
        return;
      }
      if (result.status === 'failed') {
        await this.options.messaging.inbox.fail({
          inboxItemId: item.id,
          error: result.reason ?? 'delivery adapter reported failure',
          retry: false,
          metadata: result.metadata,
        });
        return;
      }
      await this.options.messaging.inbox.ack({
        inboxItemId: item.id,
        state: result.status === 'delivered' ? 'delivered' : undefined,
        metadata: result.metadata,
      });
    } catch (error) {
      await Promise.resolve(this.options.onError?.(item, error));
      await this.options.messaging.inbox.fail({
        inboxItemId: item.id,
        error: error instanceof Error ? error.message : String(error),
        retry: true,
      });
    }
  }
}
