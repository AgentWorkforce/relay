import type { AgentEvent } from '@agent-relay/events';

import { withBurnTags } from './burn.js';
import type { Context } from './types.js';

interface DispatcherOptions {
  concurrency: number;
  handlerTimeoutMs: number;
  createContext(signal: AbortSignal, event: AgentEvent): Context;
  onEvent(ctx: Context, event: AgentEvent): Promise<void> | void;
}

interface QueueItem {
  event: AgentEvent;
  resolve(): void;
  reject(error: unknown): void;
}

interface Dispatcher {
  dispatch(event: AgentEvent): Promise<void>;
  close(): void;
  abortActive(reason: Error): void;
  drain(timeoutMs: number): Promise<boolean>;
}

/**
 * Creates the single-handler dispatcher that enforces local concurrency limits.
 */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const concurrency = Math.max(1, options.concurrency);
  const queue: QueueItem[] = [];
  const active = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let closed = false;

  const pump = () => {
    if (closed && queue.length > 0) {
      while (queue.length > 0) {
        const queued = queue.shift();
        queued?.reject(new Error('Dispatcher closed'));
      }
      return;
    }

    while (active.size < concurrency && queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        break;
      }

      const task = runItem(next);
      active.add(task);
      void task.finally(() => {
        active.delete(task);
        pump();
      });
    }
  };

  const runItem = async (item: QueueItem): Promise<void> => {
    const controller = new AbortController();
    controllers.add(controller);

    const timeout = setTimeout(() => {
      controller.abort(new Error('Handler timed out'));
    }, options.handlerTimeoutMs);

    try {
      const ctx = options.createContext(controller.signal, item.event);
      await dispatchToHandler(ctx, item.event, options.onEvent, controller.signal);
      item.resolve();
    } catch (error) {
      item.reject(error);
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  };

  return {
    dispatch(event) {
      if (closed) {
        return Promise.reject(new Error('Dispatcher closed'));
      }

      return new Promise<void>((resolve, reject) => {
        queue.push({ event, resolve, reject });
        pump();
      });
    },
    close() {
      closed = true;
      pump();
    },
    abortActive(reason) {
      for (const controller of controllers) {
        controller.abort(reason);
      }
    },
    async drain(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while ((queue.length > 0 || active.size > 0) && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }

      return queue.length === 0 && active.size === 0;
    },
  };
}

async function dispatchToHandler(
  ctx: Context,
  event: AgentEvent,
  handler: (ctx: Context, event: AgentEvent) => Promise<void> | void,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Handler aborted');
  }

  const abortPromise = new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Handler aborted'));
      },
      { once: true }
    );
  });

  await withBurnTags(
    {
      workspace: ctx.workspace,
      agentId: ctx.agentId,
      eventType: event.type,
      eventId: event.id,
      occurredAt: event.occurredAt,
    },
    async () => {
      const handlerPromise = Promise.resolve(handler(ctx, event));
      await Promise.race([handlerPromise, abortPromise]);
    }
  );
}
