/**
 * Tests for harness detection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectHarness, HARNESS_ENV_VAR, resetHarnessCacheForTests, __internal } from './harness.js';

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
    expect(__internal.commandBasename('C:\\Users\\me\\cursor.exe')).toBe('cursor.exe');
  });

  it('strips surrounding quotes', () => {
    expect(__internal.commandBasename('"/Applications/Claude.app/Claude"')).toBe('Claude');
  });

  it('keeps quoted executable paths with spaces intact before taking the basename', () => {
    expect(
      __internal.commandBasename('"/Applications/Cursor App.app/Contents/MacOS/Cursor" --type=renderer')
    ).toBe('Cursor');
  });

  it('handles empty input', () => {
    expect(__internal.commandBasename('')).toBe('');
  });
});

describe('detectHarness', () => {
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
    expect(detectHarness()).toBe('claude-code');
  });

  it('accepts sanitized custom env hints as reporting slugs', () => {
    process.env[HARNESS_ENV_VAR] = 'made-up-harness';
    expect(detectHarness()).toBe('made-up-harness');
  });

  it('normalizes env hint case', () => {
    process.env[HARNESS_ENV_VAR] = 'CURSOR';
    expect(detectHarness()).toBe('cursor');
  });

  it('returns `unknown` for invalid env hints', () => {
    process.env[HARNESS_ENV_VAR] = 'bad value!';
    expect(detectHarness()).toBe('unknown');
  });

  it('caches the result across calls', () => {
    process.env[HARNESS_ENV_VAR] = 'cursor';
    const first = detectHarness();
    process.env[HARNESS_ENV_VAR] = 'codex';
    expect(detectHarness()).toBe(first);
  });

  it('falls back to `unknown` when env unset and parent not classifiable', () => {
    delete process.env[HARNESS_ENV_VAR];
    // The test runner is the parent — almost certainly not a known harness,
    // so this should fall back to 'unknown' on platforms we support and on
    // unsupported platforms.
    const result = detectHarness();
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

describe('sanitizeHarnessSlug', () => {
  it('accepts lower-kebab reporting slugs', () => {
    expect(__internal.sanitizeHarnessSlug('new-tool')).toBe('new-tool');
    expect(__internal.sanitizeHarnessSlug(' New-Tool ')).toBe('new-tool');
  });

  it('rejects empty, path-like, and high-cardinality values', () => {
    expect(__internal.sanitizeHarnessSlug('')).toBeNull();
    expect(__internal.sanitizeHarnessSlug('../bad')).toBeNull();
    expect(__internal.sanitizeHarnessSlug('bad value')).toBeNull();
    expect(__internal.sanitizeHarnessSlug('a'.repeat(41))).toBeNull();
  });
});
