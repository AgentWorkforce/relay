/**
 * Error Types for Agent Relay
 *
 * Re-exports error classes from @agent-relay/utils, which is the single
 * source of truth. This module exists so SDK consumers can import errors
 * from either '@agent-relay/sdk' or '@agent-relay/sdk/errors'.
 */

export {
  RelayError,
  DaemonNotRunningError,
  AgentNotFoundError,
  TimeoutError,
  ConnectionError,
  ChannelNotFoundError,
  SpawnError,
} from '@agent-relay/utils/errors';

// RelayServerError is defined locally for SDK-specific error handling
import { RelayError } from '@agent-relay/utils/errors';

export class RelayServerError extends RelayError {
  code: string;
  fatal: boolean;
  envelope?: any;

  constructor(message: string, code: string, fatal: boolean, envelope?: any) {
    super(message);
    this.name = 'RelayServerError';
    this.code = code;
    this.fatal = fatal;
    this.envelope = envelope;
  }
}
