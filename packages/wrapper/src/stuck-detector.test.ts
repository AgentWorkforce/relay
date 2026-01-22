import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { StuckDetector, type StuckEvent } from './stuck-detector';

describe('StuckDetector', () => {
  let detector: StuckDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new StuckDetector({
      checkIntervalMs: 1000, // 1 second for faster tests
      extendedIdleMs: 5000, // 5 seconds for faster tests
      toolLoopThreshold: 5, // Lower threshold for testing
      toolLoopWindowMs: 10000, // 10 second window
      outputFloodLinesPerMinute: 100, // Lower threshold for testing
      outputFloodMinDurationMs: 2000, // 2 seconds
    });
  });

  afterEach(() => {
    detector.stop();
    vi.useRealTimers();
  });

  describe('extended_idle detection', () => {
    it('should detect extended idle after configured duration', () => {
      const stuckEvents: StuckEvent[] = [];
      detector.on('stuck', (event) => stuckEvents.push(event));

      detector.start();

      // Advance time past idle threshold
      vi.advanceTimersByTime(6000);

      expect(stuckEvents).toHaveLength(1);
      expect(stuckEvents[0].reason).toBe('extended_idle');
    });

    it('should not trigger if output is received', () => {
      const stuckEvents: StuckEvent[] = [];
      detector.on('stuck', (event) => stuckEvents.push(event));

      detector.start();

      // Send output before idle threshold
      vi.advanceTimersByTime(3000);
      detector.onOutput('some output');

      // Advance more time
      vi.advanceTimersByTime(3000);

      expect(stuckEvents).toHaveLength(0);
    });
  });

  describe('tool_loop detection', () => {
    it('should detect when same file is operated on repeatedly', () => {
      // Use higher loop threshold to avoid output_loop triggering first
      const toolLoopDetector = new StuckDetector({
        checkIntervalMs: 1000,
        extendedIdleMs: 60000,
        loopThreshold: 100, // Very high to prevent output_loop
        toolLoopThreshold: 5,
        toolLoopWindowMs: 30000,
      });
      const stuckEvents: StuckEvent[] = [];
      toolLoopDetector.on('stuck', (event) => stuckEvents.push(event));

      toolLoopDetector.start();

      // Simulate repeated Write operations to the same file
      // Each with unique content to avoid output_loop
      for (let i = 0; i < 6; i++) {
        toolLoopDetector.onOutput(`⏺ Write(~/Projects/test/file.ts) - change ${i}\nSome different content ${i}`);
        vi.advanceTimersByTime(500);
      }

      // Trigger check
      vi.advanceTimersByTime(1000);

      expect(stuckEvents).toHaveLength(1);
      expect(stuckEvents[0].reason).toBe('tool_loop');
      expect(stuckEvents[0].targetFile).toContain('file.ts');
      expect(stuckEvents[0].toolName).toBe('Write');

      toolLoopDetector.stop();
    });

    it('should detect mixed tool operations on same file', () => {
      // Use higher loop threshold to avoid output_loop triggering first
      const mixedToolDetector = new StuckDetector({
        checkIntervalMs: 1000,
        extendedIdleMs: 60000,
        loopThreshold: 100, // Very high to prevent output_loop
        toolLoopThreshold: 5,
        toolLoopWindowMs: 30000,
      });
      const stuckEvents: StuckEvent[] = [];
      mixedToolDetector.on('stuck', (event) => stuckEvents.push(event));

      mixedToolDetector.start();

      // Simulate Read and Write to the same file with different surrounding content
      mixedToolDetector.onOutput('Processing step 1\n⏺ Read(~/Projects/test/file.ts)\nContent A');
      mixedToolDetector.onOutput('Processing step 2\n⏺ Write(~/Projects/test/file.ts)\nContent B');
      mixedToolDetector.onOutput('Processing step 3\n⏺ Read(~/Projects/test/file.ts)\nContent C');
      mixedToolDetector.onOutput('Processing step 4\n⏺ Write(~/Projects/test/file.ts)\nContent D');
      mixedToolDetector.onOutput('Processing step 5\n⏺ Read(~/Projects/test/file.ts)\nContent E');

      vi.advanceTimersByTime(1000);

      expect(stuckEvents).toHaveLength(1);
      expect(stuckEvents[0].reason).toBe('tool_loop');

      mixedToolDetector.stop();
    });

    it('should not trigger for different files', () => {
      const stuckEvents: StuckEvent[] = [];
      detector.on('stuck', (event) => stuckEvents.push(event));

      detector.start();

      // Simulate operations on different files
      detector.onOutput('⏺ Write(~/Projects/test/file1.ts)');
      detector.onOutput('⏺ Write(~/Projects/test/file2.ts)');
      detector.onOutput('⏺ Write(~/Projects/test/file3.ts)');
      detector.onOutput('⏺ Write(~/Projects/test/file4.ts)');
      detector.onOutput('⏺ Write(~/Projects/test/file5.ts)');

      vi.advanceTimersByTime(1000);

      expect(stuckEvents).toHaveLength(0);
    });

    it('should prune old invocations outside window', () => {
      // Directly test the pruning behavior via getToolInvocations
      const testDetector = new StuckDetector({
        checkIntervalMs: 100000, // Very long - don't auto-check
        extendedIdleMs: 100000,
        toolLoopThreshold: 10,
        toolLoopWindowMs: 5000, // 5 second window
      });

      testDetector.start();

      // Add operations
      testDetector.onOutput('⏺ Write(~/test/file.ts)\n');
      testDetector.onOutput('⏺ Write(~/test/file.ts)\n');
      testDetector.onOutput('⏺ Write(~/test/file.ts)\n');

      expect(testDetector.getToolInvocations()).toHaveLength(3);

      // Move past the window
      vi.advanceTimersByTime(6000);

      // Add new output to trigger pruning
      testDetector.onOutput('⏺ Read(~/test/other.ts)\n');

      // Old invocations should be pruned, only new one remains
      const invocations = testDetector.getToolInvocations();
      expect(invocations).toHaveLength(1);
      expect(invocations[0].tool).toBe('Read');

      testDetector.stop();
    });
  });

  describe('output_flood detection', () => {
    it('should detect abnormally high output rate', () => {
      // Create detector with specific flood settings
      const floodDetector = new StuckDetector({
        checkIntervalMs: 1000,
        extendedIdleMs: 100000, // Very long idle to not trigger
        outputFloodLinesPerMinute: 100,
        outputFloodMinDurationMs: 2000, // 2 seconds min
        toolLoopThreshold: 1000, // Very high to not trigger
      });
      const stuckEvents: StuckEvent[] = [];
      floodDetector.on('stuck', (event) => stuckEvents.push(event));

      floodDetector.start();

      // Generate lots of output lines immediately
      // 1000 lines in 3 seconds = 20000 lines/minute
      const manyLines = Array(1000).fill('output line').join('\n');
      floodDetector.onOutput(manyLines);

      // Wait past minimum duration and trigger check
      vi.advanceTimersByTime(3000);

      expect(stuckEvents).toHaveLength(1);
      expect(stuckEvents[0].reason).toBe('output_flood');
      expect(stuckEvents[0].linesPerMinute).toBeGreaterThan(100);

      floodDetector.stop();
    });

    it('should not trigger before minimum duration', () => {
      const stuckEvents: StuckEvent[] = [];
      detector.on('stuck', (event) => stuckEvents.push(event));

      detector.start();

      // Generate lots of output before minimum duration
      const manyLines = Array(300).fill('output line').join('\n');
      detector.onOutput(manyLines);

      vi.advanceTimersByTime(1000);

      // Should not trigger yet
      expect(stuckEvents).toHaveLength(0);
    });

    it('should not trigger for normal output rates', () => {
      const stuckEvents: StuckEvent[] = [];
      detector.on('stuck', (event) => stuckEvents.push(event));

      detector.start();

      // Wait past minimum duration
      vi.advanceTimersByTime(2500);

      // Generate moderate output
      detector.onOutput('line 1\nline 2\nline 3\n');

      vi.advanceTimersByTime(1000);

      expect(stuckEvents).toHaveLength(0);
    });
  });

  describe('unstuck emission', () => {
    it('should emit unstuck when output resumes after being stuck', () => {
      const stuckEvents: StuckEvent[] = [];
      const unstuckEvents: { timestamp: number }[] = [];

      detector.on('stuck', (event) => stuckEvents.push(event));
      detector.on('unstuck', (event) => unstuckEvents.push(event));

      detector.start();

      // Become stuck (extended idle)
      vi.advanceTimersByTime(6000);
      expect(stuckEvents).toHaveLength(1);

      // Resume output
      detector.onOutput('back to work');

      expect(unstuckEvents).toHaveLength(1);
      expect(detector.getIsStuck()).toBe(false);
    });
  });

  describe('getOutputStats', () => {
    it('should return accurate output statistics', () => {
      detector.start();

      detector.onOutput('line 1\nline 2\nline 3\n');
      vi.advanceTimersByTime(30000); // 30 seconds

      const stats = detector.getOutputStats();

      expect(stats.lineCount).toBe(3);
      expect(stats.durationMs).toBeGreaterThanOrEqual(30000);
      expect(stats.linesPerMinute).toBeLessThan(10); // 3 lines in 30 seconds = 6 lines/min
    });
  });

  describe('getToolInvocations', () => {
    it('should return tracked tool invocations', () => {
      detector.start();

      detector.onOutput('⏺ Write(~/test/file.ts)');
      detector.onOutput('⏺ Read(~/test/other.ts)');

      const invocations = detector.getToolInvocations();

      expect(invocations).toHaveLength(2);
      expect(invocations[0].tool).toBe('Write');
      expect(invocations[0].target).toContain('file.ts');
      expect(invocations[1].tool).toBe('Read');
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      detector.start();

      // Generate some activity
      detector.onOutput('⏺ Write(~/test/file.ts)');
      detector.onOutput('line 1\nline 2\n');

      expect(detector.getToolInvocations()).toHaveLength(1);
      expect(detector.getOutputStats().lineCount).toBe(2);

      detector.reset();

      expect(detector.getToolInvocations()).toHaveLength(0);
      expect(detector.getOutputStats().lineCount).toBe(0);
      expect(detector.getIsStuck()).toBe(false);
    });
  });
});
