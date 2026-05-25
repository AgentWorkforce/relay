import type { MessageInjectionMode } from './protocol.js';

export type MaybePromise<T> = T | Promise<T>;

export interface HarnessInitContext {
  name: string;
  cli: string;
  task?: string;
  args: string[];
  channels: string[];
  model?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface HarnessInitResult {
  /** Provider/native session id, when the harness supports resume. */
  sessionId?: string;
  /** OS process id for the broker-controlled harness process, when applicable. */
  pid?: number;
  /** Alias for consumers that prefer the expanded spelling. */
  processId?: number;
  metadata?: Record<string, unknown>;
}

export interface HarnessRegistrationContext {
  name: string;
  cli: string;
  channels: string[];
  relayAgentToken?: string;
  relayApiKey?: string;
  relayBaseUrl?: string;
}

export interface HarnessRegistrationResult {
  name?: string;
  sessionId?: string;
  token?: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessRelayMessage {
  from: string;
  to: string;
  text: string;
  threadId?: string;
  workspaceId?: string;
  workspaceAlias?: string;
  priority?: number;
  mode?: MessageInjectionMode;
  data?: Record<string, unknown>;
}

export interface HarnessMessageContext {
  name: string;
  sessionId?: string;
  pid?: number;
  processId?: number;
}

export interface HarnessReleaseContext extends HarnessMessageContext {
  reason?: string;
}

/**
 * Runtime-facing harness lifecycle contract.
 *
 * The Rust broker cannot call in-memory TypeScript functions directly; a
 * concrete implementation still needs to be exposed through a serializable
 * boundary such as a CLI/stdio worker or HTTP service. These method names are
 * the control surface that such adapters should implement.
 */
export interface HarnessRuntimeAdapter {
  readonly kind: string;
  initHarness(context: HarnessInitContext): MaybePromise<HarnessInitResult>;
  register?(context: HarnessRegistrationContext): MaybePromise<HarnessRegistrationResult | void>;
  /** Deliver a Relay message from the broker to the harness. */
  receiveMessage?(message: HarnessRelayMessage, context: HarnessMessageContext): MaybePromise<void>;
  /** Emit a harness-originated message back through Relay. */
  sendMessage?(message: HarnessRelayMessage, context: HarnessMessageContext): MaybePromise<void>;
  releaseHarness?(context: HarnessReleaseContext): MaybePromise<void>;
}
