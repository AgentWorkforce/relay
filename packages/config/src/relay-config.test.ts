import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONNECTION_CONFIG,
  DEFAULT_TMUX_WRAPPER_CONFIG,
  DEFAULT_IDLE_BEFORE_INJECT_MS,
  DEFAULT_IDLE_CONFIDENCE_THRESHOLD,
  LOW_LATENCY_CONFIG,
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

  it('exposes tmux wrapper defaults with reduced latency', () => {
    expect(DEFAULT_TMUX_WRAPPER_CONFIG).toEqual({
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
    });
  });

  it('exposes idle detection defaults', () => {
    expect(DEFAULT_IDLE_BEFORE_INJECT_MS).toBe(800);
    expect(DEFAULT_IDLE_CONFIDENCE_THRESHOLD).toBe(0.7);
  });

  it('exposes low-latency config for time-critical messaging', () => {
    expect(LOW_LATENCY_CONFIG).toEqual({
      pollInterval: 100,
      idleBeforeInjectMs: 300,
      injectRetryMs: 200,
      outputStabilityTimeoutMs: 300,
      outputStabilityPollMs: 100,
    });
  });
});
