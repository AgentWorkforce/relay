/**
 * Error Types for Agent Relay
 *
 * Single source of truth for typed error classes.
 * Previously duplicated in @agent-relay/mcp (errors.ts).
 * Now consolidated here in the SDK for shared use.
 */

export class RelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayError';
  }
}

export class DaemonNotRunningError extends RelayError {
  constructor(message?: string) {
    super(message || 'Relay daemon is not running. Start with: agent-relay up');
    this.name = 'DaemonNotRunningError';
  }
}

export class AgentNotFoundError extends RelayError {
  constructor(agentName: string) {
    super(`Agent not found: ${agentName}`);
    this.name = 'AgentNotFoundError';
  }
}

export class TimeoutError extends RelayError {
  constructor(operation: string, timeoutMs: number) {
    super(`Timeout after ${timeoutMs}ms: ${operation}`);
    this.name = 'TimeoutError';
  }
}

export class ConnectionError extends RelayError {
  constructor(message: string) {
    super(`Connection error: ${message}`);
    this.name = 'ConnectionError';
  }
}

export class ChannelNotFoundError extends RelayError {
  constructor(channel: string) {
    super(`Channel not found: ${channel}`);
    this.name = 'ChannelNotFoundError';
  }
}

export class SpawnError extends RelayError {
  constructor(workerName: string, reason: string) {
    super(`Failed to spawn worker "${workerName}": ${reason}`);
    this.name = 'SpawnError';
  }
}
