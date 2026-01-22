export const DEFAULT_CONNECTION_CONFIG = {
  maxFrameBytes: 1024 * 1024,
  heartbeatMs: 5000,
  heartbeatTimeoutMultiplier: 6,
  maxWriteQueueSize: 2000,
  writeQueueHighWaterMark: 1500,
  writeQueueLowWaterMark: 500,
} as const;

export const DEFAULT_TMUX_WRAPPER_CONFIG = {
  pollInterval: 200,
  idleBeforeInjectMs: 1500,
  injectRetryMs: 500,
  debug: false,
  debugLogIntervalMs: 0,
  mouseMode: true,
  activityIdleThresholdMs: 30_000,
  outputStabilityTimeoutMs: 2000,
  outputStabilityPollMs: 200,
  streamLogs: true,
} as const;

export const DEFAULT_IDLE_BEFORE_INJECT_MS = 1500;
export const DEFAULT_IDLE_CONFIDENCE_THRESHOLD = 0.7;
