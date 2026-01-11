import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONNECTION_CONFIG,
  DEFAULT_TMUX_WRAPPER_CONFIG,
  DEFAULT_IDLE_BEFORE_INJECT_MS,
  DEFAULT_IDLE_CONFIDENCE_THRESHOLD,
} from './relay-config.js';

describe('relay-config defaults', () => {
  it('exposes connection defaults', () => {
    expect(DEFAULT_CONNECTION_CONFIG).toEqual({
      maxFrameBytes: 1024 * 1024,
      heartbeatMs: 5000,
      heartbeatTimeoutMultiplier: 6,
      maxWriteQueueSize: 2000,
      writeQueueHighWaterMark: 1500,
      writeQueueLowWaterMark: 500,
    });
  });

  it('exposes tmux wrapper defaults', () => {
    expect(DEFAULT_TMUX_WRAPPER_CONFIG).toEqual({
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
    });
  });

  it('exposes idle detection defaults', () => {
    expect(DEFAULT_IDLE_BEFORE_INJECT_MS).toBe(1500);
    expect(DEFAULT_IDLE_CONFIDENCE_THRESHOLD).toBe(0.7);
  });
});
