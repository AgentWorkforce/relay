import { describe, expect, it } from 'vitest';

import {
  detectOrchestratorHarness,
  inferHarnessFromCommand,
  sanitizeOrchestratorHarness,
} from './orchestrator-harness.js';

describe('orchestrator harness detection', () => {
  it('sanitizes explicit harness values for headers and telemetry', () => {
    expect(sanitizeOrchestratorHarness(' Claude-Code/1.2 (model=opus) ')).toBe(
      'claude-code/1.2 (model=opus)'
    );
    expect(sanitizeOrchestratorHarness('bad\r\nvalue')).toBeUndefined();
    expect(sanitizeOrchestratorHarness(' '.repeat(3))).toBeUndefined();
  });

  it('maps common process command names to harness identifiers', () => {
    expect(inferHarnessFromCommand('/usr/local/bin/claude')).toBe('claude-code');
    expect(inferHarnessFromCommand('/opt/homebrew/bin/codex')).toBe('codex');
    expect(inferHarnessFromCommand('/Applications/Cursor.app/Contents/MacOS/Cursor')).toBe('cursor');
    expect(inferHarnessFromCommand('/usr/local/bin/gemini-cli')).toBe('gemini-cli');
    expect(inferHarnessFromCommand(String.raw`C:\Users\will\AppData\Roaming\npm\gemini.cmd`)).toBe(
      'gemini-cli'
    );
  });

  it('prefers an explicit environment override', () => {
    expect(
      detectOrchestratorHarness({
        env: { AGENT_RELAY_ORCHESTRATOR_HARNESS: 'Codex' },
        processLookup: () => ({ pid: 10, command: 'claude' }),
      })
    ).toBe('codex');
  });

  it('walks parent processes until it finds a known harness', () => {
    expect(
      detectOrchestratorHarness({
        env: {},
        startPid: 10,
        processLookup: (pid) => {
          if (pid === 10) return { pid, ppid: 9, command: 'zsh' };
          if (pid === 9) return { pid, ppid: 8, command: '/usr/bin/codex' };
          return undefined;
        },
      })
    ).toBe('codex');
  });

  it('returns unknown when no process matches', () => {
    expect(
      detectOrchestratorHarness({
        env: {},
        startPid: 10,
        processLookup: () => undefined,
      })
    ).toBe('unknown');
  });
});
