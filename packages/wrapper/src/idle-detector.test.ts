/**
 * Tests for UniversalIdleDetector
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { UniversalIdleDetector, createIdleDetector } from './idle-detector.js';
import fs from 'node:fs';

// Mock fs for Linux process state tests
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
    },
    readFileSync: vi.fn(),
  };
});

describe('UniversalIdleDetector', () => {
  let detector: UniversalIdleDetector;

  beforeEach(() => {
    detector = new UniversalIdleDetector();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic functionality', () => {
    it('initializes with default config', () => {
      expect(detector.getPid()).toBeNull();
    });

    it('sets and gets PID', () => {
      detector.setPid(12345);
      expect(detector.getPid()).toBe(12345);
    });

    it('tracks output and updates lastOutputTime', () => {
      const before = Date.now();
      detector.onOutput('some output');
      const after = Date.now();

      const silence = detector.getTimeSinceLastOutput();
      expect(silence).toBeLessThanOrEqual(after - before + 10);
    });

    it('bounds output buffer to prevent memory issues', () => {
      // Fill buffer beyond limit
      const chunk = 'x'.repeat(6000);
      detector.onOutput(chunk);
      detector.onOutput(chunk); // Now at 12000, should trim

      // Internal buffer should be trimmed (we can only verify via behavior)
      // Just verify it doesn't throw
      const result = detector.checkIdle();
      expect(result).toBeDefined();
    });

    it('resets state correctly', () => {
      detector.onOutput('some output');
      detector.setPid(12345);
      detector.reset();

      // PID should be preserved, buffer cleared
      expect(detector.getPid()).toBe(12345);
      // Silence time should be near zero after reset
      expect(detector.getTimeSinceLastOutput()).toBeLessThan(50);
    });
  });

  describe('checkIdle - output silence', () => {
    it('returns not idle when output is recent', () => {
      detector.onOutput('recent output');

      const result = detector.checkIdle({ minSilenceMs: 500 });

      expect(result.isIdle).toBe(false);
      expect(result.signals).toHaveLength(0);
    });

    it('returns idle signal after silence period', async () => {
      detector.onOutput('output');

      // Wait for silence
      await new Promise(r => setTimeout(r, 600));

      const result = detector.checkIdle({ minSilenceMs: 500 });

      expect(result.signals.length).toBeGreaterThan(0);
      const silenceSignal = result.signals.find(s => s.source === 'output_silence');
      expect(silenceSignal).toBeDefined();
      expect(silenceSignal!.confidence).toBeGreaterThan(0);
    });

    it('confidence scales with silence duration', async () => {
      detector.onOutput('output');

      // Short silence
      await new Promise(r => setTimeout(r, 600));
      const shortResult = detector.checkIdle({ minSilenceMs: 500 });

      // Reset and wait longer
      detector.onOutput('output');
      await new Promise(r => setTimeout(r, 1500));
      const longResult = detector.checkIdle({ minSilenceMs: 500 });

      const shortConfidence = shortResult.signals.find(s => s.source === 'output_silence')?.confidence ?? 0;
      const longConfidence = longResult.signals.find(s => s.source === 'output_silence')?.confidence ?? 0;

      expect(longConfidence).toBeGreaterThan(shortConfidence);
    });
  });

  describe('checkIdle - natural ending detection', () => {
    it('detects sentence-ending punctuation', async () => {
      detector.onOutput('This is complete.');
      await new Promise(r => setTimeout(r, 300));

      const result = detector.checkIdle({ minSilenceMs: 200 });

      const endingSignal = result.signals.find(s => s.source === 'natural_ending');
      expect(endingSignal).toBeDefined();
    });

    it('detects shell prompt', async () => {
      detector.onOutput('command output\n$ ');
      await new Promise(r => setTimeout(r, 300));

      const result = detector.checkIdle({ minSilenceMs: 200 });

      const endingSignal = result.signals.find(s => s.source === 'natural_ending');
      expect(endingSignal).toBeDefined();
    });

    it('detects code block closure', async () => {
      detector.onOutput('function foo() {}\n```');
      await new Promise(r => setTimeout(r, 300));

      const result = detector.checkIdle({ minSilenceMs: 200 });

      const endingSignal = result.signals.find(s => s.source === 'natural_ending');
      expect(endingSignal).toBeDefined();
    });

    it('does not detect mid-sentence comma as natural ending', async () => {
      detector.onOutput('First item,');
      await new Promise(r => setTimeout(r, 300));

      const result = detector.checkIdle({ minSilenceMs: 200 });

      const endingSignal = result.signals.find(s => s.source === 'natural_ending');
      expect(endingSignal).toBeUndefined();
    });

    it('does not detect open bracket as natural ending', async () => {
      detector.onOutput('function foo(');
      await new Promise(r => setTimeout(r, 300));

      const result = detector.checkIdle({ minSilenceMs: 200 });

      const endingSignal = result.signals.find(s => s.source === 'natural_ending');
      expect(endingSignal).toBeUndefined();
    });
  });

  describe('checkIdle - process state (Linux)', () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      // Mock Linux platform
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    });

    it('detects process waiting for input via wchan', () => {
      detector.setPid(12345);

      // Mock /proc/12345/stat - S state (sleeping)
      // Format: pid (comm) state ...
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (path === '/proc/12345/stat') {
          return '12345 (node) S 1 12345 12345 0 -1 4194304 ...';
        }
        if (path === '/proc/12345/wchan') {
          return 'n_tty_read';
        }
        throw new Error('File not found');
      });

      const result = detector.checkIdle();

      const processSignal = result.signals.find(s => s.source === 'process_state');
      expect(processSignal).toBeDefined();
      expect(processSignal!.confidence).toBe(0.95);
      expect(processSignal!.details).toBe('n_tty_read');
    });

    it('detects running process as not idle', () => {
      detector.setPid(12345);

      // Mock running process (R state)
      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
        if (path === '/proc/12345/stat') {
          return '12345 (node) R 1 12345 12345 0 -1 4194304 ...';
        }
        throw new Error('File not found');
      });

      const result = detector.checkIdle();

      expect(result.isIdle).toBe(false);
      expect(result.confidence).toBe(0.95);
    });

    it('handles permission denied gracefully', () => {
      detector.setPid(12345);

      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      // Should not throw, just skip process state signal
      const result = detector.checkIdle();
      expect(result).toBeDefined();
      const processSignal = result.signals.find(s => s.source === 'process_state');
      expect(processSignal).toBeUndefined();
    });

    it('handles process not found gracefully', () => {
      detector.setPid(99999);

      (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      const result = detector.checkIdle();
      expect(result).toBeDefined();
    });
  });

  describe('checkIdle - confidence combination', () => {
    it('boosts confidence when multiple signals agree', async () => {
      detector.onOutput('Complete output.');
      await new Promise(r => setTimeout(r, 600));

      const result = detector.checkIdle({ minSilenceMs: 500 });

      // Should have both output_silence and natural_ending signals
      expect(result.signals.length).toBeGreaterThanOrEqual(2);

      // Combined confidence should include boost
      const maxIndividual = Math.max(...result.signals.map(s => s.confidence));
      expect(result.confidence).toBeGreaterThanOrEqual(maxIndividual);
    });

    it('respects confidence threshold for isIdle', () => {
      const strictDetector = new UniversalIdleDetector({
        confidenceThreshold: 0.9,
      });

      strictDetector.onOutput('output');

      // With high threshold, short silence shouldn't trigger idle
      const result = strictDetector.checkIdle({ minSilenceMs: 100 });
      expect(result.isIdle).toBe(false);
    });
  });

  describe('waitForIdle', () => {
    it('returns immediately if already idle', async () => {
      detector.onOutput('complete.');
      await new Promise(r => setTimeout(r, 600));

      const start = Date.now();
      const result = await detector.waitForIdle(5000, 100);
      const elapsed = Date.now() - start;

      expect(result.isIdle).toBe(true);
      expect(elapsed).toBeLessThan(200); // Should return quickly
    });

    it('waits until idle', async () => {
      // Start with recent output
      detector.onOutput('working...');

      // Simulate becoming idle after 500ms
      setTimeout(() => {
        // No more output = will become idle
      }, 100);

      const result = await detector.waitForIdle(2000, 100);

      // After waiting, should detect idle based on silence
      expect(result.signals.length).toBeGreaterThan(0);
    });

    it('respects timeout', async () => {
      // Keep generating output to prevent idle
      const interval = setInterval(() => {
        detector.onOutput('busy');
      }, 50);

      const start = Date.now();
      const _result = await detector.waitForIdle(300, 50);
      const elapsed = Date.now() - start;

      clearInterval(interval);

      expect(elapsed).toBeGreaterThanOrEqual(280);
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('createIdleDetector', () => {
    it('creates detector with custom config', () => {
      const detector = createIdleDetector({
        minSilenceMs: 1000,
        confidenceThreshold: 0.8,
      }, { quiet: true });

      expect(detector).toBeInstanceOf(UniversalIdleDetector);
    });

    it('warns on non-Linux platforms', () => {
      const originalPlatform = process.platform;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        Object.defineProperty(process, 'platform', {
          value: 'darwin',
          configurable: true,
        });

        createIdleDetector({}, { quiet: false });

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('macOS')
        );
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
        warnSpy.mockRestore();
      }
    });

    it('suppresses warning in quiet mode', () => {
      const originalPlatform = process.platform;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        Object.defineProperty(process, 'platform', {
          value: 'darwin',
          configurable: true,
        });

        createIdleDetector({}, { quiet: true });

        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', {
          value: originalPlatform,
          configurable: true,
        });
        warnSpy.mockRestore();
      }
    });
  });
});
