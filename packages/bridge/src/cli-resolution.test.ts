/**
 * Unit tests for CLI Resolution Utilities
 *
 * Tests the detection and resolution of CLI commands for different providers,
 * particularly the Cursor CLI which has two names: 'agent' (newer) and 'cursor-agent' (older).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  commandExists,
  detectCursorCli,
  resolveCli,
  resetCursorCliCache,
  CLI_COMMAND_MAP,
} from './cli-resolution.js';

// Mock child_process module
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

describe('CLI Resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCursorCliCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('commandExists', () => {
    it('returns true when command exists', () => {
      mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/agent'));
      expect(commandExists('agent')).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith('which agent', { stdio: 'ignore' });
    });

    it('returns false when command does not exist', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('Command not found');
      });
      expect(commandExists('nonexistent-cmd')).toBe(false);
    });

    it('uses "where" on Windows', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      mockedExecSync.mockReturnValue(Buffer.from('C:\\Path\\agent.exe'));
      commandExists('agent');
      expect(mockedExecSync).toHaveBeenCalledWith('where agent', { stdio: 'ignore' });

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });

  describe('detectCursorCli', () => {
    it('returns "agent" when agent command exists', () => {
      mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/agent'));
      expect(detectCursorCli()).toBe('agent');
    });

    it('returns "cursor-agent" when only cursor-agent exists', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which agent') {
          throw new Error('not found');
        }
        return Buffer.from('/usr/bin/cursor-agent');
      });
      expect(detectCursorCli()).toBe('cursor-agent');
    });

    it('returns null when neither command exists', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(detectCursorCli()).toBeNull();
    });

    it('caches the detected CLI', () => {
      mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/agent'));

      // First call detects
      expect(detectCursorCli()).toBe('agent');
      expect(mockedExecSync).toHaveBeenCalledTimes(1);

      // Second call uses cache
      expect(detectCursorCli()).toBe('agent');
      expect(mockedExecSync).toHaveBeenCalledTimes(1); // Still 1
    });

    it('cache can be reset', () => {
      mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/agent'));

      detectCursorCli();
      expect(mockedExecSync).toHaveBeenCalledTimes(1);

      resetCursorCliCache();

      detectCursorCli();
      expect(mockedExecSync).toHaveBeenCalledTimes(2);
    });
  });

  describe('resolveCli', () => {
    it('resolves "cursor" to detected CLI (agent)', () => {
      mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/agent'));
      expect(resolveCli('cursor')).toBe('agent');
    });

    it('resolves "cursor" to detected CLI (cursor-agent)', () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which agent') {
          throw new Error('not found');
        }
        return Buffer.from('/usr/bin/cursor-agent');
      });
      expect(resolveCli('cursor')).toBe('cursor-agent');
    });

    it('resolves "cursor-agent" input to detected CLI', () => {
      mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/agent'));
      expect(resolveCli('cursor-agent')).toBe('agent');
    });

    it('falls back to "agent" when cursor CLI not detected', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(resolveCli('cursor')).toBe('agent');
    });

    it('is case insensitive for cursor', () => {
      mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/agent'));
      expect(resolveCli('CURSOR')).toBe('agent');
      expect(resolveCli('Cursor')).toBe('agent');
    });

    it('resolves "google" to "gemini"', () => {
      expect(resolveCli('google')).toBe('gemini');
      expect(resolveCli('Google')).toBe('gemini');
    });

    it('returns other commands unchanged', () => {
      expect(resolveCli('claude')).toBe('claude');
      expect(resolveCli('codex')).toBe('codex');
      expect(resolveCli('gemini')).toBe('gemini');
      expect(resolveCli('opencode')).toBe('opencode');
    });

    it('preserves case for unknown commands', () => {
      expect(resolveCli('MyCustomCli')).toBe('MyCustomCli');
    });
  });

  describe('CLI_COMMAND_MAP', () => {
    it('maps cursor to agent', () => {
      expect(CLI_COMMAND_MAP['cursor']).toBe('agent');
    });

    it('maps cursor-agent to agent', () => {
      expect(CLI_COMMAND_MAP['cursor-agent']).toBe('agent');
    });

    it('maps google to gemini', () => {
      expect(CLI_COMMAND_MAP['google']).toBe('gemini');
    });
  });
});

describe('CLI Resolution Integration', () => {
  describe('Cursor CLI scenarios', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      resetCursorCliCache();
    });

    it('handles user with newer Cursor (agent available)', () => {
      // User has Cursor v0.50+ with "agent" CLI
      mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/agent'));

      const resolved = resolveCli('cursor');
      expect(resolved).toBe('agent');
    });

    it('handles user with older Cursor (cursor-agent available)', () => {
      // User has older Cursor with "cursor-agent" CLI
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which agent') {
          throw new Error('not found');
        }
        return Buffer.from('/usr/bin/cursor-agent');
      });

      const resolved = resolveCli('cursor');
      expect(resolved).toBe('cursor-agent');
    });

    it('handles team spawn request with cursor CLI', () => {
      // Lead agent spawns worker with "cursor" - should resolve to available CLI
      mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/agent'));

      // Simulate spawn request parsing
      const cli = 'cursor';
      const cliParts = cli.split(' ');
      const rawCommand = cliParts[0];
      const resolved = resolveCli(rawCommand);

      expect(resolved).toBe('agent');
    });

    it('handles explicit cursor-agent in spawn request', () => {
      // User explicitly requests cursor-agent - should still check availability
      mockedExecSync.mockReturnValue(Buffer.from('/usr/bin/agent'));

      const resolved = resolveCli('cursor-agent');
      // Even when asking for cursor-agent, if agent is available, use agent
      expect(resolved).toBe('agent');
    });
  });
});
