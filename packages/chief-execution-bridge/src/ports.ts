/** A Relay refusal or transport failure. Carries a code only, never a response body. */
export class RelayError extends Error {
  constructor(
    readonly code: string,
    /** True when the outcome is unknown or the call may succeed if repeated. */
    readonly retryable: boolean
  ) {
    super(code);
    this.name = 'RelayError';
  }
}

/**
 * @param error Whatever ended the process.
 * @returns The error's own machine-readable code, or `bridge_failed` for anything that could quote a response.
 */
export function exitCode(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_:]+$/.test(error.message) ? error.message : 'bridge_failed';
}

export interface RelayIdentity {
  agentId: string;
  workspaceId: string;
  /** The address Relay holds for this agent, when it reports one. */
  address?: string;
}

export interface RelayConversation {
  id: string;
  type: '1:1' | 'group';
  participants: string[];
  /** The newest message's ID, when Relay reports it. */
  lastMessageId?: string;
}

/** One stored message. `agentId` and `agentName` are recorded by Relay from the sender's token. */
export interface RelayMessage {
  id: string;
  agentId: string;
  agentName: string;
  text: string;
  metadata?: Record<string, unknown>;
  /** When Relay recorded the message, in milliseconds. Set by Relay, not the sender. */
  sentAt?: number;
}

export interface SpawnRequest {
  name: string;
  harness: string;
  task: string;
  targetNodeName: string;
  directory: string;
  idempotencyKey: string;
}

export interface SpawnReceipt {
  id: string;
  status: 'pending' | 'dispatched' | 'invoked' | 'running' | 'completed' | 'failed';
  nodeId?: string;
  name?: string;
  spawned: boolean;
  ready: boolean;
  taskUnconfirmed: boolean;
}

export interface SendReport {
  address: string;
  text: string;
  data: Record<string, unknown>;
  idempotencyKey: string;
}

/** Everything the bridge does on Relay, using only the worker's own agent token. */
export interface RelayPort {
  identity(): Promise<RelayIdentity>;
  conversations(): Promise<RelayConversation[]>;
  messages(
    conversationId: string,
    page: { after?: string; before?: string; limit: number }
  ): Promise<RelayMessage[]>;
  sendReport(report: SendReport): Promise<void>;
  invokeSpawn(request: SpawnRequest): Promise<SpawnReceipt>;
  invocation(id: string): Promise<SpawnReceipt>;
}

/** The dedicated node on this computer, through the core's local bridge. */
export interface NodePort {
  /** `undefined` when the node may take work now, otherwise a refusal code. */
  preflight(harness: string, node: { id: string; name: string }): Promise<string | undefined>;
  endAgent(name: string): Promise<'ended' | 'not_found' | 'refused'>;
}

export type BridgeLog = (event: string, fields?: Record<string, string | number>) => void;
