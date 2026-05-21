/**
 * Typed multi-listener registry shared by `AgentRelay` and `AgentRelayClient`.
 *
 * Replaces the previous single-callback `on*: EventHook<T> = null` fields on
 * `AgentRelay` so multiple integrations (burn stamping, Pear UI, third-party
 * observers, …) can subscribe to the same event without stepping on each
 * other.
 *
 * Each `addListener(event, handler)` returns an unsubscribe function;
 * `removeListener(event, handler)` is also available. Handlers fire in
 * registration order; async handlers are awaited sequentially. Handler
 * exceptions are caught and logged to `console.error` so one bad listener
 * never blocks the originating operation or subsequent listeners.
 *
 * The bus is intentionally generic — callers parameterize it with a typed
 * event map (see `AgentRelayEvents` in `./lifecycle-hooks.ts`) so each
 * event's payload is fully checked at the addListener / emit boundary.
 */
export type EventMap = Record<string, readonly unknown[]>;

export type EventHandler<Args extends readonly unknown[]> = (...args: Args) => void | Promise<void>;

export class EventBus<E extends EventMap> {
  private handlers: Map<keyof E, Set<EventHandler<readonly unknown[]>>> = new Map();

  /**
   * Register a handler for `event`. Returns an unsubscribe function that
   * removes the handler when called.
   */
  addListener<K extends keyof E>(event: K, handler: EventHandler<E[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as EventHandler<readonly unknown[]>);
    return () => {
      set!.delete(handler as EventHandler<readonly unknown[]>);
      if (set!.size === 0) {
        this.handlers.delete(event);
      }
    };
  }

  /** Remove a previously-registered handler. Idempotent. */
  removeListener<K extends keyof E>(event: K, handler: EventHandler<E[K]>): void {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler as EventHandler<readonly unknown[]>);
    if (set.size === 0) {
      this.handlers.delete(event);
    }
  }

  /** Number of currently-registered handlers for `event`. Useful for tests. */
  listenerCount<K extends keyof E>(event: K): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  /** Snapshot the handlers for `event` so iteration is safe under concurrent mutation. */
  listeners<K extends keyof E>(event: K): Array<EventHandler<E[K]>> {
    const set = this.handlers.get(event);
    return set ? (Array.from(set) as Array<EventHandler<E[K]>>) : [];
  }

  /**
   * Fire `event` with `args`, awaiting each handler sequentially in
   * registration order. Handler exceptions are caught and logged; they
   * never abort the dispatch chain.
   *
   * Return value is intentionally `void`; consumers that need to collect
   * patches (e.g. `beforeAgentSpawn`'s shallow-merge contract) iterate
   * `listeners()` directly so they can capture each handler's return.
   */
  async emit<K extends keyof E>(event: K, ...args: E[K]): Promise<void> {
    for (const handler of this.listeners(event)) {
      try {
        await handler(...args);
      } catch (err) {
        console.error(`[agent-relay] listener for "${String(event)}" threw:`, err);
      }
    }
  }
}
