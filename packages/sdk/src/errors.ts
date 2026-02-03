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
