/**
 * Error Types for Agent Relay MCP Server
 *
 * Re-exports error classes from @agent-relay/utils, which is the single
 * source of truth for error types. Previously this module contained
 * its own implementation.
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
