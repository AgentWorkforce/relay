export const DEFAULT_CONNECTION_CONFIG = {
  maxFrameBytes: 1024 * 1024,
  heartbeatMs: 5000,
  heartbeatTimeoutMultiplier: 6,
  maxWriteQueueSize: 2000,
  writeQueueHighWaterMark: 1500,
  writeQueueLowWaterMark: 500,
} as const;

export const DEFAULT_TMUX_WRAPPER_CONFIG = {
  pollInterval: 150,
  idleBeforeInjectMs: 800,
  injectRetryMs: 300,
  debug: false,
  debugLogIntervalMs: 0,
  mouseMode: true,
  activityIdleThresholdMs: 30_000,
  outputStabilityTimeoutMs: 800,
  outputStabilityPollMs: 150,
  streamLogs: true,
} as const;

export const DEFAULT_IDLE_BEFORE_INJECT_MS = 800;
export const DEFAULT_IDLE_CONFIDENCE_THRESHOLD = 0.7;

/** Low-latency mode constants for time-critical messaging */
export const LOW_LATENCY_CONFIG = {
  pollInterval: 100,
  idleBeforeInjectMs: 300,
  injectRetryMs: 200,
  outputStabilityTimeoutMs: 300,
  outputStabilityPollMs: 100,
} as const;

/** Default Unix socket path for daemon communication */
export const DEFAULT_SOCKET_PATH = '/tmp/agent-relay.sock';
