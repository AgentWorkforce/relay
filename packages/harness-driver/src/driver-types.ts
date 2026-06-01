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
