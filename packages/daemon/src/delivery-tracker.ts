import type { DeliverEnvelope, AckPayload, Envelope } from '@agent-relay/protocol/types';
import type { StorageAdapter } from '@agent-relay/storage/adapter';
import { routerLog } from '@agent-relay/utils/logger';

export interface DeliveryReliabilityOptions {
  /** How long to wait for an ACK before retrying (ms) */
  ackTimeoutMs: number;
  /** Maximum attempts (initial send counts as attempt 1) */
  maxAttempts: number;
  /** How long to keep retrying before dropping (ms) */
  deliveryTtlMs: number;
}

export const DEFAULT_DELIVERY_OPTIONS: DeliveryReliabilityOptions = {
  ackTimeoutMs: 5000,
  maxAttempts: 5,
  deliveryTtlMs: 60_000,
};

export interface DeliveryTrackerConnection {
  id: string;
  send(envelope: DeliverEnvelope): boolean;
}

interface PendingDelivery {
  envelope: DeliverEnvelope;
  connectionId: string;
  attempts: number;
  firstSentAt: number;
  timer?: NodeJS.Timeout;
}

export class DeliveryTracker {
  private pendingDeliveries: Map<string, PendingDelivery> = new Map();
  private deliveryOptions: DeliveryReliabilityOptions;
  private storage?: StorageAdapter;
  private getConnection: (id: string) => DeliveryTrackerConnection | undefined;

  constructor(options: {
    storage?: StorageAdapter;
    delivery?: Partial<DeliveryReliabilityOptions>;
    getConnection: (id: string) => DeliveryTrackerConnection | undefined;
  }) {
    this.storage = options.storage;
    this.deliveryOptions = { ...DEFAULT_DELIVERY_OPTIONS, ...options.delivery };
    this.getConnection = options.getConnection;
  }

  get pendingCount(): number {
    return this.pendingDeliveries.size;
  }

  track(target: DeliveryTrackerConnection, deliver: DeliverEnvelope): void {
    const pending: PendingDelivery = {
      envelope: deliver,
      connectionId: target.id,
      attempts: 1,
      firstSentAt: Date.now(),
    };

    pending.timer = this.scheduleRetry(deliver.id);
    this.pendingDeliveries.set(deliver.id, pending);
  }

  handleAck(connectionId: string, ackId: string): void {
    const pending = this.pendingDeliveries.get(ackId);
    if (!pending) return;

    // Only accept ACKs from the same connection that received the deliver
    if (pending.connectionId !== connectionId) return;

    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingDeliveries.delete(ackId);
    const statusUpdate = this.storage?.updateMessageStatus?.(ackId, 'acked');
    if (statusUpdate instanceof Promise) {
      statusUpdate.catch(err => {
        routerLog.error('Failed to record ACK status', { error: String(err) });
      });
    }
    routerLog.debug(`ACK received for ${ackId}`);
  }

  clearPendingForConnection(connectionId: string): void {
    for (const [id, pending] of this.pendingDeliveries.entries()) {
      if (pending.connectionId === connectionId) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingDeliveries.delete(id);
      }
    }
  }

  private scheduleRetry(deliverId: string): NodeJS.Timeout | undefined {
    return setTimeout(() => {
      const pending = this.pendingDeliveries.get(deliverId);
      if (!pending) return;

      const now = Date.now();
      const elapsed = now - pending.firstSentAt;
      if (elapsed > this.deliveryOptions.deliveryTtlMs) {
        routerLog.warn(`Dropping ${deliverId} after TTL`, { ttlMs: this.deliveryOptions.deliveryTtlMs });
        this.pendingDeliveries.delete(deliverId);
        this.markFailed(deliverId);
        return;
      }

      if (pending.attempts >= this.deliveryOptions.maxAttempts) {
        routerLog.warn(`Dropping ${deliverId} after max attempts`, { maxAttempts: this.deliveryOptions.maxAttempts });
        this.pendingDeliveries.delete(deliverId);
        this.markFailed(deliverId);
        return;
      }

      const target = this.getConnection(pending.connectionId);
      if (!target) {
        routerLog.warn(`Dropping ${deliverId} - connection unavailable`);
        this.pendingDeliveries.delete(deliverId);
        this.markFailed(deliverId);
        return;
      }

      pending.attempts++;
      const sent = target.send(pending.envelope);
      if (!sent) {
        routerLog.warn(`Retry failed for ${deliverId}`, { attempt: pending.attempts });
      } else {
        routerLog.debug(`Retried ${deliverId}`, { attempt: pending.attempts });
      }

      pending.timer = this.scheduleRetry(deliverId);
    }, this.deliveryOptions.ackTimeoutMs);
  }

  private markFailed(deliverId: string): void {
    const statusUpdate = this.storage?.updateMessageStatus?.(deliverId, 'failed');
    if (statusUpdate instanceof Promise) {
      statusUpdate.catch(err => {
        routerLog.error(`Failed to update status for ${deliverId}`, { error: String(err) });
      });
    }
  }
}

export type AckEnvelope = Envelope<AckPayload>;
