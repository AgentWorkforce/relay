import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatRelativeTime, formatTableRow, parseSince } from './formatting';

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
    expect(parseSince('-1h')).toBe(now + 3_600_000);
  });

  it('parses absolute time and rejects empty values', () => {
    expect(parseSince('2025-12-31T00:00:00.000Z')).toBe(Date.parse('2025-12-31T00:00:00.000Z'));
    expect(parseSince('  ')).toBeUndefined();
    expect(parseSince('invalid')).toBeUndefined();
  });

  it('formats padded table rows', () => {
    expect(
      formatTableRow([
        { value: 'name', width: 8 },
        { value: 'status', width: 10 },
        { value: 'online' },
      ]),
    ).toBe('name     status     online');
  });
});
