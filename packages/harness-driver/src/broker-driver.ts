import { HarnessDriverClient, type RuntimeSpawnOptions } from './client.js';
import type { BrokerEvent, SemanticEventEnvelope } from './protocol.js';
import type { ListAgent, SpawnAgentResult } from './types.js';
import type {
  AgentDriver,
  DriverRuntimeStatus,
  SpawnRuntimeInput,
  SpawnedAgentRuntime,
} from './driver-types.js';

function statusFromManagedAgent(agent: ListAgent | SpawnAgentResult | undefined): DriverRuntimeStatus {
  if (!agent) {
    return 'offline';
  }

  const currentState =
    'current_state' in agent && typeof agent.current_state === 'string' ? agent.current_state : undefined;
  if (currentState === 'working' || currentState === 'blocked_on_send') {
    return 'busy';
  }
  if (currentState === 'idle') {
    return 'idle';
  }
  return 'unknown';
}

export interface BrokerDriverOptions extends RuntimeSpawnOptions {
  client?: HarnessDriverClient;
}

interface BufferedBrokerEvents {
  attach(listener: (event: BrokerEvent) => void): () => void;
  dispose(): void;
}

export class BrokerDriver implements AgentDriver {
  readonly kind = 'broker';

  private client?: HarnessDriverClient;

  constructor(private readonly options: BrokerDriverOptions = {}) {
    this.client = options.client;
  }

  async spawn(input: SpawnRuntimeInput): Promise<SpawnedAgentRuntime> {
    const client = await this.ensureClient();
    const transport = input.harnessConfig?.runtime === 'semantic' ? 'headless' : (input.transport ?? 'pty');
    const { transport: _transport, ...spawnInput } = input;
    const buffered = transport === 'pty' ? this.bufferBrokerEvents(client, input.name) : undefined;
    let result: SpawnAgentResult;
    try {
      result = transport === 'headless' ? await client.spawnHeadless(spawnInput) : await client.spawnPty(spawnInput);
    } catch (error) {
      buffered?.dispose();
      throw error;
    }

    return this.runtimeHandle(client, result, transport === 'headless', buffered);
  }

  private bufferBrokerEvents(client: HarnessDriverClient, name: string): BufferedBrokerEvents {
    client.connectEvents();
    const pending: BrokerEvent[] = [];
    let live: ((event: BrokerEvent) => void) | undefined;
    const unsubscribe = client.onEvent((event) => {
      if (!('name' in event) || event.name !== name) return;
      if (live) live(event);
      else pending.push(event);
    });
    return {
      attach(listener) {
        for (const event of pending.splice(0)) listener(event);
        live = listener;
        return unsubscribe;
      },
      dispose: unsubscribe,
    };
  }

  private async ensureClient(): Promise<HarnessDriverClient> {
    if (!this.client) {
      this.client = await HarnessDriverClient.spawn(this.options);
    }
    return this.client;
  }

  private runtimeHandle(
    client: HarnessDriverClient,
    result: SpawnAgentResult,
    semantic = false,
    buffered?: BufferedBrokerEvents
  ): SpawnedAgentRuntime {
    const observers = new Set<() => Promise<void>>();
    const disposeBuffered = async () => buffered?.dispose();
    if (buffered) observers.add(disposeBuffered);
    const runtime: SpawnedAgentRuntime = {
      agent: { name: result.name, id: result.sessionId },
      delivery: { mode: 'managed' },
      status: async () => this.status(result.name),
      release: async (reason?: string) => {
        await Promise.allSettled([...observers].map((dispose) => dispose()));
        observers.clear();
        await client.release(result.name, reason);
      },
    };
    runtime.observeBrokerEvents = async (listener, onError) => {
      if (!buffered) client.connectEvents();
      let delivery = Promise.resolve();
      let trackedDispose: () => Promise<void>;
      const receive = (event: BrokerEvent) => {
        if (!('name' in event) || event.name !== result.name) return;
        const terminal =
          event.kind === 'agent_exit' || event.kind === 'agent_exited' || event.kind === 'worker_error';
        delivery = delivery
          .then(() => listener(event))
          .catch(async (error) => onError?.(error))
          .finally(() => {
            if (terminal) {
              dispose();
              observers.delete(trackedDispose);
            }
          });
      };
      const dispose = buffered ? buffered.attach(receive) : client.onEvent(receive);
      if (buffered) observers.delete(disposeBuffered);
      trackedDispose = async () => {
        dispose();
        await delivery;
      };
      observers.add(trackedDispose);
      return async () => {
        observers.delete(trackedDispose);
        await trackedDispose();
      };
    };
    if (semantic) {
      runtime.observeSemanticEvents = async (listener, onError) => {
        let closed = false;
        let trackedDispose: (() => Promise<void>) | undefined;
        const dispose = await this.observeSemanticEvents(client, result.name, listener, onError, () => {
          closed = true;
          if (trackedDispose) observers.delete(trackedDispose);
        });
        trackedDispose = async () => {
          observers.delete(trackedDispose!);
          await dispose();
        };
        if (!closed) observers.add(trackedDispose);
        return trackedDispose;
      };
    }
    return runtime;
  }

  private async observeSemanticEvents(
    client: HarnessDriverClient,
    name: string,
    listener: (event: SemanticEventEnvelope) => void | Promise<void>,
    onError?: (error: unknown) => void | Promise<void>,
    onClose?: () => void
  ): Promise<() => Promise<void>> {
    let iterator: AsyncIterator<SemanticEventEnvelope> | undefined;
    let stopped = false;
    const stopOnRuntimeExit = client.onEvent((event: BrokerEvent) => {
      if (
        'name' in event &&
        event.name === name &&
        (event.kind === 'agent_exit' || event.kind === 'agent_exited' || event.kind === 'worker_error')
      ) {
        stopped = true;
        void iterator?.return?.();
      }
    });
    let brokerCursor: number;
    try {
      brokerCursor = await client.currentEventSeq();
    } catch (error) {
      stopOnRuntimeExit();
      throw error;
    }
    const stream = client.subscribeSemanticEvents(name, {
      sinceSequence: 0,
      sinceBrokerSeq: brokerCursor,
    });
    iterator = stream[Symbol.asyncIterator]();
    let highWater = 0;
    let terminalSeen = false;
    let delivery = Promise.resolve();
    const publish = (event: SemanticEventEnvelope) => {
      if (event.sequence <= highWater) return;
      highWater = event.sequence;
      delivery = delivery.then(() => listener(event));
      terminalSeen = ['session.destroyed', 'session.released', 'session.failed'].includes(
        String(event.event.kind)
      );
    };
    const history = await client.getSemanticHistory(name, 0);
    for (const event of history.events) publish(event);
    const pump = (async () => {
      try {
        while (!stopped && !terminalSeen) {
          const next = await iterator!.next();
          if (next.done) break;
          publish(next.value);
        }
      } finally {
        stopOnRuntimeExit();
        await iterator?.return?.();
        try {
          await delivery;
        } finally {
          onClose?.();
        }
      }
    })().catch(async (error) => {
      await onError?.(error);
    });
    return async () => {
      if (stopped) return;
      stopped = true;
      stopOnRuntimeExit();
      await iterator?.return?.();
      await pump;
    };
  }

  async release(name: string, reason?: string): Promise<void> {
    const client = await this.ensureClient();
    await client.release(name, reason);
  }

  async status(name: string): Promise<DriverRuntimeStatus> {
    const client = await this.ensureClient();
    const agents = await client.listAgents();
    return statusFromManagedAgent(agents.find((agent) => agent.name === name));
  }
}
