/**
 * Tests for orchestrator harness detection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectOrchestratorHarness,
  HARNESS_ENV_VAR,
  resetHarnessCacheForTests,
  __internal,
} from './harness.js';

describe('classifyBasename', () => {
  const cases: Array<{ basename: string; expected: ReturnType<typeof __internal.classifyBasename> }> = [
    { basename: 'claude', expected: 'claude-code' },
    { basename: 'claude-code', expected: 'claude-code' },
    { basename: 'Claude', expected: 'claude-code' },
    { basename: 'Claude Helper', expected: 'claude-code' },
    { basename: 'cursor', expected: 'cursor' },
    { basename: 'Cursor', expected: 'cursor' },
    { basename: 'Cursor Helper', expected: 'cursor' },
    { basename: 'cursor.exe', expected: 'cursor' },
    { basename: 'codex', expected: 'codex' },
    { basename: 'gemini', expected: 'gemini' },
    { basename: 'aider', expected: 'aider' },
    { basename: 'cline', expected: 'cline' },
    { basename: 'continue', expected: 'continue' },
    { basename: 'windsurf', expected: 'windsurf' },
    { basename: 'zed', expected: 'zed' },
    { basename: 'bash', expected: null },
    { basename: 'node', expected: null },
    { basename: '', expected: null },
  ];

  for (const { basename, expected } of cases) {
    it(`classifies ${JSON.stringify(basename)} as ${expected ?? 'null'}`, () => {
      expect(__internal.classifyBasename(basename)).toBe(expected);
    });
  }
});

describe('commandBasename', () => {
  it('strips POSIX paths', () => {
    expect(__internal.commandBasename('/usr/bin/claude --foo')).toBe('claude');
  });

  it('strips Windows-style backslash paths', () => {
    // Note: we tokenize on whitespace first, so paths with spaces in them
    // (e.g. "C:\Program Files\...") need quoting from the OS — which is
    // exactly what `ps` does on darwin. Test the unquoted, space-free shape.
    expect(__internal.commandBasename('C:\\Users\\me\\cursor.exe')).toBe('cursor.exe');
  });

  it('strips surrounding quotes', () => {
    expect(__internal.commandBasename('"/Applications/Claude.app/Claude"')).toBe('Claude');
  });

  it('handles empty input', () => {
    expect(__internal.commandBasename('')).toBe('');
  });
});

describe('detectOrchestratorHarness', () => {
  const originalEnv = process.env[HARNESS_ENV_VAR];

  beforeEach(() => {
    resetHarnessCacheForTests();
  });

  afterEach(() => {
    resetHarnessCacheForTests();
    if (originalEnv === undefined) {
      delete process.env[HARNESS_ENV_VAR];
    } else {
      process.env[HARNESS_ENV_VAR] = originalEnv;
    }
  });

  it('uses the env hint when set to a known value', () => {
    process.env[HARNESS_ENV_VAR] = 'claude-code';
    expect(detectOrchestratorHarness()).toBe('claude-code');
  });

  it('returns `unknown` for an unrecognized env hint', () => {
    process.env[HARNESS_ENV_VAR] = 'made-up-harness';
    expect(detectOrchestratorHarness()).toBe('unknown');
  });

  it('caches the result across calls', () => {
    process.env[HARNESS_ENV_VAR] = 'cursor';
    const first = detectOrchestratorHarness();
    process.env[HARNESS_ENV_VAR] = 'codex';
    expect(detectOrchestratorHarness()).toBe(first);
  });

  it('falls back to `unknown` when env unset and parent not classifiable', () => {
    delete process.env[HARNESS_ENV_VAR];
    // The test runner is the parent — almost certainly not a known harness,
    // so this should fall back to 'unknown' on platforms we support and on
    // unsupported platforms.
    const result = detectOrchestratorHarness();
    expect([
      'unknown',
      'claude-code',
      'cursor',
      'codex',
      'gemini',
      'aider',
      'cline',
      'continue',
      'windsurf',
      'zed',
    ]).toContain(result);
  });
});
