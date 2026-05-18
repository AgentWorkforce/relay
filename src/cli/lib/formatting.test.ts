import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatRelativeTime,
  formatTableRow,
  formatUptimeSecs,
  parseSince,
  sanitizeForTerminal,
} from './formatting';

describe('formatting helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats relative time for invalid input', () => {
    expect(formatRelativeTime()).toBe('unknown');
    expect(formatRelativeTime('not-a-date')).toBe('unknown');
  });

  it('formats relative time across units', () => {
    expect(formatRelativeTime('2025-12-31T23:59:50.000Z')).toBe('10s ago');
    expect(formatRelativeTime('2025-12-31T23:58:00.000Z')).toBe('2m ago');
    expect(formatRelativeTime('2025-12-31T21:00:00.000Z')).toBe('3h ago');
    expect(formatRelativeTime('2025-12-30T00:00:00.000Z')).toBe('2d ago');
  });

  it('parses --since duration shorthand', () => {
    const now = Date.now();

    expect(parseSince('10s')).toBe(now - 10_000);
    expect(parseSince('5m')).toBe(now - 300_000);
    expect(parseSince('2h')).toBe(now - 7_200_000);
    expect(parseSince('1d')).toBe(now - 86_400_000);
    expect(parseSince('-1h')).toBeUndefined();
  });

  it('parses absolute time and rejects empty values', () => {
    expect(parseSince('2025-12-31T00:00:00.000Z')).toBe(Date.parse('2025-12-31T00:00:00.000Z'));
    expect(parseSince('  ')).toBeUndefined();
    expect(parseSince('invalid')).toBeUndefined();
  });

  it('formats padded table rows', () => {
    expect(
      formatTableRow([{ value: 'name', width: 8 }, { value: 'status', width: 10 }, { value: 'online' }])
    ).toBe('name     status     online');
  });

  it('formats uptime seconds compactly', () => {
    expect(formatUptimeSecs(0)).toBe('0s');
    expect(formatUptimeSecs(45)).toBe('45s');
    expect(formatUptimeSecs(60)).toBe('1m 00s');
    expect(formatUptimeSecs(125)).toBe('2m 05s');
    expect(formatUptimeSecs(3600)).toBe('1h 00m 00s');
    expect(formatUptimeSecs(3661)).toBe('1h 01m 01s');
    expect(formatUptimeSecs(1_000_000_000)).toBe('277777h 46m 40s');
    expect(formatUptimeSecs(421)).toBe('7m 01s');
    expect(formatUptimeSecs(7.9)).toBe('7s'); // floors fractional seconds
  });

  it('formats invalid uptime as a dash', () => {
    expect(formatUptimeSecs(-0)).toBe('0s');
    expect(formatUptimeSecs(-1)).toBe('-');
    expect(formatUptimeSecs(Number.NaN)).toBe('-');
    expect(formatUptimeSecs(Number.POSITIVE_INFINITY)).toBe('-');
    expect(formatUptimeSecs(Number.NEGATIVE_INFINITY)).toBe('-');
  });
});

describe('sanitizeForTerminal', () => {
  it('removes ANSI, OSC, and carriage-return controls from text output', () => {
    expect(sanitizeForTerminal('safe\x1b[2Jclear')).toBe('safeclear');
    expect(sanitizeForTerminal('link\x1b]52;c;YWJj\x07tail')).toBe('linktail');
    expect(sanitizeForTerminal('old\rnew')).toBe('oldnew');
    expect(sanitizeForTerminal('a\x1bMb')).toBe('ab');
    expect(sanitizeForTerminal('x\x9bDy')).toBe('xy');
    expect(sanitizeForTerminal('p\x1b]0;t\x1b\\q')).toBe('pq');
  });
});
