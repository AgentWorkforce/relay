/**
 * Every error kind the core can return in `error.data.kind`
 * (`crates/relay-node/src/relay/protocol.rs` `ErrorKind`). A kind may be
 * added without a bridge version bump, so {@link ErrorKind} also admits any
 * other string.
 */
export const ERROR_KINDS = [
  'parse_error',
  'invalid_request',
  'method_not_found',
  'invalid_params',
  'handshake_required',
  'bridge_version_mismatch',
  'not_signed_in',
  'refused',
  'relaycast_unreachable',
  'relaycast_refused',
  'unauthorized',
  'plan_limit_exceeded',
  'rate_limited',
  'not_found',
  'conflict',
  'shutting_down',
  'busy',
  'store_failed',
  'cloud_failed',
  'cloud_refused',
  'fleet_unavailable',
  'internal',
] as const;

/** A machine-readable error kind from the core; branch on this, not on the message. */
export type ErrorKind = (typeof ERROR_KINDS)[number] | (string & {});

/** With `plan_limit_exceeded`: which cap was reached and how full it is (`contract/plan.rs`). */
export interface PlanLimit {
  limit: 'devices' | 'agents' | 'humans' | 'other' | (string & {});
  max: number;
  current: number;
  plan: string;
}

/**
 * Every typed reason the core gives with a `refused` error in
 * `error.data.reason` (`protocol.rs` `RefusalReason`). None is retryable.
 */
export const REFUSAL_REASONS = [
  'service_unknown',
  'service_disabled',
  'service_expired',
  'workspace_mismatch',
  'not_owner',
  'outside_scope',
  'management_peer',
] as const;

/**
 * Why the core refused a call. A reason may be added without a bridge version
 * bump, so this also admits any other string.
 */
export type RefusalReason = (typeof REFUSAL_REASONS)[number] | (string & {});

/** The base of every error this package throws; `code` names the class of failure. */
export class CoreBridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Nothing answers at the socket: the file is missing, the connection failed, or connecting timed out. */
export class CoreNotRunningError extends CoreBridgeError {
  readonly socket: string;
  constructor(socket: string, message: string, options?: { cause?: unknown }) {
    super('core_not_running', message, options);
    this.socket = socket;
  }
}

/** The socket or its directory could have been planted by someone else; the client refused to connect. */
export class CoreUntrustedError extends CoreBridgeError {
  readonly reason: 'directory' | 'socket';
  constructor(reason: 'directory' | 'socket', message: string) {
    super('core_untrusted', message);
    this.reason = reason;
  }
}

/** What answered at the socket did not greet like the Agent Relay core. */
export class NotACoreError extends CoreBridgeError {
  constructor(message: string) {
    super('not_a_core', message);
  }
}

/** The core speaks a different bridge version and refused this client. */
export class BridgeVersionMismatchError extends CoreBridgeError {
  /** The bridge version this client sent. */
  readonly clientVersion: number;
  /** The core's own message, safe to show a person. */
  readonly coreMessage: string;
  constructor(clientVersion: number, coreMessage: string, message: string, options?: { cause?: unknown }) {
    super('bridge_version_mismatch', message, options);
    this.clientVersion = clientVersion;
    this.coreMessage = coreMessage;
  }
}

/** The core answered a call with a JSON-RPC error. */
export class CoreRpcError extends CoreBridgeError {
  /** The JSON-RPC numeric code. */
  readonly rpcCode: number | undefined;
  /** The stable machine-readable kind from `error.data.kind`. */
  readonly kind: ErrorKind | undefined;
  /** Whether repeating the same request later can succeed. */
  readonly retryable: boolean;
  /** With `plan_limit_exceeded`, the counters when the core had them. */
  readonly planLimit: PlanLimit | undefined;
  /** With `refused`, the typed reason from `error.data.reason` when the core gave one. */
  readonly reason: RefusalReason | undefined;
  constructor(
    message: string,
    details: {
      rpcCode?: number;
      kind?: ErrorKind;
      retryable?: boolean;
      planLimit?: PlanLimit;
      reason?: RefusalReason;
    } = {}
  ) {
    super('rpc_error', message);
    this.rpcCode = details.rpcCode;
    this.kind = details.kind;
    this.retryable = details.retryable ?? false;
    this.planLimit = details.planLimit;
    this.reason = details.reason;
  }
}

/**
 * @deprecated Use {@link CoreRpcError}; this alias is removed in the next release.
 */
export const CoreCallError = CoreRpcError;
/** @deprecated Use {@link CoreRpcError}. */
export type CoreCallError = CoreRpcError;

/** The core did not answer a call in time. */
export class CoreTimeoutError extends CoreBridgeError {
  readonly method: string;
  constructor(method: string) {
    super('timeout', `The Agent Relay core did not answer ${method} in time.`);
    this.method = method;
  }
}

/** The core sent a line longer than `MAX_REPLY_BYTES`; the connection was closed. */
export class CoreReplyTooLargeError extends CoreBridgeError {
  constructor() {
    super('reply_too_large', 'The Agent Relay core sent an oversized reply.');
  }
}

/** A request line would exceed `MAX_REQUEST_BYTES`; it was not sent and the connection stays open. */
export class CoreRequestTooLargeError extends CoreBridgeError {
  readonly method: string;
  readonly bytes: number;
  constructor(method: string, bytes: number, limit: number) {
    super(
      'request_too_large',
      `The ${method} request is ${bytes} bytes; the Agent Relay core reads at most ${limit}.`
    );
    this.method = method;
    this.bytes = bytes;
  }
}

/** The connection is closed: a call after close, or the connection ended while calls were pending. */
export class CoreClosedError extends CoreBridgeError {
  constructor(message = 'The Agent Relay core closed the connection.', options?: { cause?: unknown }) {
    super('closed', message, options);
  }
}
