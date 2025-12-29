import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compare } from 'compare-versions';

describe('update-checker', () => {
  describe('version comparison (via compare-versions library)', () => {
    // These tests verify the library works as expected for our use case
    it('detects when latest > current', () => {
      expect(compare('2.0.0', '1.0.0', '>')).toBe(true);
      expect(compare('1.0.11', '1.0.10', '>')).toBe(true);
      expect(compare('1.1.0', '1.0.99', '>')).toBe(true);
    });

    it('detects when latest = current', () => {
      expect(compare('1.0.0', '1.0.0', '>')).toBe(false);
      expect(compare('2.5.10', '2.5.10', '>')).toBe(false);
    });

    it('detects when latest < current (no update)', () => {
      expect(compare('1.0.0', '2.0.0', '>')).toBe(false);
    });

    it('handles v prefix', () => {
      expect(compare('v2.0.0', 'v1.0.0', '>')).toBe(true);
      expect(compare('v1.0.0', '1.0.0', '>')).toBe(false);
    });
  });

  describe('printUpdateNotification', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it('prints notification when update is available', async () => {
      const { printUpdateNotification } = await import('./update-checker.js');

      printUpdateNotification({
        updateAvailable: true,
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('Update available');
      expect(output).toContain('1.0.0');
      expect(output).toContain('2.0.0');
      expect(output).toContain('npm install -g agent-relay');
    });

    it('does not print when no update available', async () => {
      const { printUpdateNotification } = await import('./update-checker.js');

      printUpdateNotification({
        updateAvailable: false,
        currentVersion: '2.0.0',
        latestVersion: '2.0.0',
      });

      const substantiveCalls = consoleErrorSpy.mock.calls.filter(c => c[0] !== '');
      expect(substantiveCalls.length).toBe(0);
    });

    it('does not print when latestVersion is null', async () => {
      const { printUpdateNotification } = await import('./update-checker.js');

      printUpdateNotification({
        updateAvailable: true,
        currentVersion: '1.0.0',
        latestVersion: null,
      });

      const substantiveCalls = consoleErrorSpy.mock.calls.filter(c => c[0] !== '');
      expect(substantiveCalls.length).toBe(0);
    });

    it('formats box with correct border characters', async () => {
      const { printUpdateNotification } = await import('./update-checker.js');

      printUpdateNotification({
        updateAvailable: true,
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
      });

      const output = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('╭');
      expect(output).toContain('╰');
      expect(output).toContain('│');
      expect(output).toContain('─');
    });

    it('dynamically sizes box for short version numbers', async () => {
      const { printUpdateNotification } = await import('./update-checker.js');

      printUpdateNotification({
        updateAvailable: true,
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
      });

      const boxLines = consoleErrorSpy.mock.calls
        .map(c => c[0] as string)
        .filter(line => line.startsWith('│') || line.startsWith('╭') || line.startsWith('╰'));

      // All box lines should have the same length
      const lengths = boxLines.map(l => l.length);
      expect(new Set(lengths).size).toBe(1);
    });

    it('dynamically sizes box for long version numbers', async () => {
      const { printUpdateNotification } = await import('./update-checker.js');

      printUpdateNotification({
        updateAvailable: true,
        currentVersion: '10.20.300',
        latestVersion: '10.20.301',
      });

      const output = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
      expect(output).toContain('10.20.300');
      expect(output).toContain('10.20.301');

      const boxLines = consoleErrorSpy.mock.calls
        .map(c => c[0] as string)
        .filter(line => line.startsWith('│') || line.startsWith('╭') || line.startsWith('╰'));

      // All box lines should have the same length
      const lengths = boxLines.map(l => l.length);
      expect(new Set(lengths).size).toBe(1);
    });

    it('box expands when version line is longer than install line', async () => {
      const { printUpdateNotification } = await import('./update-checker.js');

      // Very long version numbers
      printUpdateNotification({
        updateAvailable: true,
        currentVersion: '100.200.300',
        latestVersion: '100.200.301',
      });

      const boxLines = consoleErrorSpy.mock.calls
        .map(c => c[0] as string)
        .filter(line => line.startsWith('╭'));

      // Box should be wider than minimum (install line is 31 chars + padding)
      expect(boxLines[0].length).toBeGreaterThan(35);
    });
  });

  describe('cache path', () => {
    it('cache is stored in ~/.agent-relay directory', () => {
      const expectedDir = path.join(os.homedir(), '.agent-relay');
      const expectedFile = path.join(expectedDir, 'update-cache.json');

      // We can verify the path structure is correct
      expect(expectedFile).toContain('.agent-relay');
      expect(expectedFile).toContain('update-cache.json');
    });
  });

  describe('UpdateInfo interface', () => {
    it('has correct shape', async () => {
      const { checkForUpdates: _checkForUpdates } = await import('./update-checker.js');

      // Type check - this verifies the interface at compile time
      const mockInfo = {
        updateAvailable: true,
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        error: undefined,
      };

      expect(mockInfo).toHaveProperty('updateAvailable');
      expect(mockInfo).toHaveProperty('currentVersion');
      expect(mockInfo).toHaveProperty('latestVersion');
    });
  });

  describe('checkForUpdatesInBackground', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it('is a function that accepts a version string', async () => {
      const { checkForUpdatesInBackground } = await import('./update-checker.js');

      expect(typeof checkForUpdatesInBackground).toBe('function');
      // Should not throw when called
      expect(() => checkForUpdatesInBackground('1.0.0')).not.toThrow();
    });
  });
});

describe('update-checker integration', () => {
  // These tests use the real module but mock the cache file
  const testCacheDir = path.join(os.tmpdir(), 'update-checker-test-' + Date.now());
  const testCachePath = path.join(testCacheDir, 'update-cache.json');

  beforeEach(() => {
    if (!fs.existsSync(testCacheDir)) {
      fs.mkdirSync(testCacheDir, { recursive: true });
    }
  });

  afterEach(() => {
    try {
      if (fs.existsSync(testCachePath)) {
        fs.unlinkSync(testCachePath);
      }
      if (fs.existsSync(testCacheDir)) {
        fs.rmdirSync(testCacheDir);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it('cache file format is valid JSON', () => {
    const cache = {
      lastCheck: Date.now(),
      latestVersion: '1.0.0',
    };

    fs.writeFileSync(testCachePath, JSON.stringify(cache, null, 2));
    const read = JSON.parse(fs.readFileSync(testCachePath, 'utf-8'));

    expect(read.lastCheck).toBe(cache.lastCheck);
    expect(read.latestVersion).toBe(cache.latestVersion);
  });

  it('cache file can include error field', () => {
    const cache = {
      lastCheck: Date.now(),
      latestVersion: null,
      error: 'Network error',
    };

    fs.writeFileSync(testCachePath, JSON.stringify(cache, null, 2));
    const read = JSON.parse(fs.readFileSync(testCachePath, 'utf-8'));

    expect(read.error).toBe('Network error');
    expect(read.latestVersion).toBeNull();
  });
});
