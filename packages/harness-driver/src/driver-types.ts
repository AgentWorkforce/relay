export type DriverRuntimeKind = 'managed' | 'external' | 'none';

export type DriverRuntimeStatus = 'idle' | 'busy' | 'offline' | 'unknown';

export interface DriverAgentRef {
  name: string;
  id?: string;
}

export interface DriverDeliveryRef {
  mode: DriverRuntimeKind;
  adapterId?: string;
}

export interface SpawnRuntimeInput {
  name: string;
  cli: string;
  args?: string[];
  channels?: string[];
  task?: string;
  model?: string;
  cwd?: string;
  transport?: 'pty' | 'headless';
  /** Resolved harness launch contract, including broker-owned native harness sidecars. */
  harnessConfig?: import('./harness.js').ResolvedHarnessConfig;
}

export interface AttachRuntimeInput {
  name: string;
  kind: string;
  cwd?: string;
  endpoint?: string;
  metadata?: Record<string, unknown>;
}

export interface SpawnedAgentRuntime {
  agent: DriverAgentRef;
  delivery: DriverDeliveryRef;
  status(): Promise<DriverRuntimeStatus>;
  release(reason?: string): Promise<void>;
  /** Reconciles agent-event history with live events and returns an async disposer. */
  observeAgentEvents?(
    listener: (event: import('./protocol.js').AgentEventEnvelope) => void | Promise<void>,
    onError?: (error: unknown) => void | Promise<void>
  ): Promise<() => Promise<void>>;
  /** Observe broker-owned lifecycle/output events for this runtime. */
  observeBrokerEvents?(
    listener: (event: import('./protocol.js').BrokerEvent) => void | Promise<void>,
    onError?: (error: unknown) => void | Promise<void>
  ): Promise<() => Promise<void>>;
}

export interface AgentSpawner {
  readonly kind: string;
  spawn(input: SpawnRuntimeInput): Promise<SpawnedAgentRuntime>;
  attach?(input: AttachRuntimeInput): Promise<SpawnedAgentRuntime>;
}

export interface AgentDriver extends AgentSpawner {
  release?(name: string, reason?: string): Promise<void>;
  status?(name: string): Promise<DriverRuntimeStatus>;
}
