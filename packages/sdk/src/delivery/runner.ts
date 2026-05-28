import { RelayCapabilityError } from '../capabilities.js';
import type { InboxItem, RelayMessaging } from '../messaging/index.js';
import type {
  AgentDeliveryAdapter,
  InjectionContext,
  InjectionResult,
  MessageDeliveryTarget,
} from './types.js';
import type { MessageContext, MessageReceipt } from '../session/index.js';

export type DeliveryRunnerContext = Partial<
  Omit<InjectionContext, 'reason' | 'mode'> & Omit<MessageContext, 'reason' | 'mode'>
> & {
  reason?: InjectionContext['reason'] | MessageContext['reason'];
  mode?: InjectionContext['mode'] | MessageContext['mode'];
};

export interface DeliveryRunnerOptions {
  messaging: RelayMessaging;
  delivery: MessageDeliveryTarget;
  agentName?: string;
  context?: DeliveryRunnerContext;
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
    await deliveryAdapter(this.options.delivery).connect?.();
    try {
      for await (const item of this.options.messaging.inbox.subscribe({
        agentName: this.options.agentName,
      })) {
        if (this.stopped) return;
        await this.deliver(item);
      }
    } finally {
      await deliveryAdapter(this.options.delivery).disconnect?.();
    }
  }

  private async deliver(item: InboxItem): Promise<void> {
    try {
      const result = await deliverToTarget(this.options.delivery, item, this.options.context);
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

async function deliverToTarget(
  target: MessageDeliveryTarget,
  item: InboxItem,
  context: DeliveryRunnerContext | undefined
): Promise<InjectionResult> {
  if (typeof target.receiveMessage === 'function') {
    return receiptToInjectionResult(
      await target.receiveMessage(item.message, {
        id: context?.id ?? item.id,
        mode: toMessageMode(context?.mode),
        reason: toMessageReason(context?.reason),
        priority: context?.priority,
        deadline: context?.deadline,
        idempotencyKey: context?.idempotencyKey,
        metadata: context?.metadata,
      })
    );
  }

  const adapter = deliveryAdapter(target);
  if (typeof adapter.inject !== 'function') {
    throw new Error('Delivery target must implement receiveMessage(...) or inject(...).');
  }

  return adapter.inject(item.message, {
    reason: toInjectionReason(context?.reason),
    priority: context?.priority,
    mode: toInjectionMode(context?.mode),
  });
}

function deliveryAdapter(target: MessageDeliveryTarget): AgentDeliveryAdapter {
  return target as AgentDeliveryAdapter;
}

function receiptToInjectionResult(receipt: MessageReceipt): InjectionResult {
  return {
    status: receipt.status,
    ...('deliveryId' in receipt && receipt.deliveryId ? { injectionId: receipt.deliveryId } : {}),
    ...('availableAt' in receipt ? { availableAt: dateToString(receipt.availableAt) } : {}),
    ...('reason' in receipt && receipt.reason ? { reason: receipt.reason } : {}),
    ...('metadata' in receipt && receipt.metadata ? { metadata: receipt.metadata } : {}),
  };
}

function toMessageMode(mode: DeliveryRunnerContext['mode']): MessageContext['mode'] {
  switch (mode) {
    case 'append':
      return 'next-message';
    case 'interrupt':
      return 'immediate';
    case 'wait_until_idle':
      return 'on-idle';
    case 'next-message':
    case 'next-tool-call':
    case 'on-idle':
    case 'manual':
    case 'immediate':
      return mode;
    default:
      return 'immediate';
  }
}

function toMessageReason(reason: DeliveryRunnerContext['reason']): MessageContext['reason'] {
  switch (reason) {
    case 'thread_reply':
      return 'thread-reply';
    case 'action_result':
      return 'action-result';
    case 'dm':
    case 'mention':
    case 'message':
      return reason;
    default:
      return 'message';
  }
}

function toInjectionReason(reason: DeliveryRunnerContext['reason']): InjectionContext['reason'] {
  switch (reason) {
    case 'thread-reply':
      return 'thread_reply';
    case 'action-result':
      return 'action_result';
    case 'notification':
      return 'message';
    case 'dm':
    case 'mention':
    case 'message':
    case 'channel':
    case 'thread_reply':
    case 'action_result':
      return reason;
    default:
      return 'message';
  }
}

function toInjectionMode(mode: DeliveryRunnerContext['mode']): InjectionContext['mode'] | undefined {
  switch (mode) {
    case 'immediate':
      return 'interrupt';
    case 'next-message':
    case 'manual':
      return 'append';
    case 'on-idle':
      return 'wait_until_idle';
    case 'append':
    case 'interrupt':
    case 'wait_until_idle':
      return mode;
    default:
      return undefined;
  }
}

function dateToString(input: Date | string): string {
  return input instanceof Date ? input.toISOString() : input;
}
