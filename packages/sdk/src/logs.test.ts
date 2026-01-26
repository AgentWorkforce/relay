import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLogs, listLoggedAgents } from './logs.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

describe('getLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return log content when file exists', async () => {
    const mockContent = 'line 1\nline 2\nline 3\nline 4\nline 5';
    vi.mocked(fs.stat).mockResolvedValue({} as any);
    vi.mocked(fs.readFile).mockResolvedValue(mockContent);

    const result = await getLogs('Worker1', { logsDir: '/test/logs', lines: 3 });

    expect(result.found).toBe(true);
    expect(result.agent).toBe('Worker1');
    expect(result.content).toBe('line 3\nline 4\nline 5');
    expect(result.lineCount).toBe(3);
  });

  it('should return found=false when file does not exist', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

    const result = await getLogs('NonExistent', { logsDir: '/test/logs' });

    expect(result.found).toBe(false);
    expect(result.agent).toBe('NonExistent');
    expect(result.content).toBe('');
    expect(result.lineCount).toBe(0);
  });

  it('should use default lines value of 50', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    vi.mocked(fs.stat).mockResolvedValue({} as any);
    vi.mocked(fs.readFile).mockResolvedValue(lines);

    const result = await getLogs('Worker1', { logsDir: '/test/logs' });

    expect(result.found).toBe(true);
    expect(result.lineCount).toBe(50);
  });

  it('should handle empty files', async () => {
    vi.mocked(fs.stat).mockResolvedValue({} as any);
    vi.mocked(fs.readFile).mockResolvedValue('');

    const result = await getLogs('Worker1', { logsDir: '/test/logs' });

    expect(result.found).toBe(true);
    expect(result.content).toBe('');
    expect(result.lineCount).toBe(0);
  });
});

describe('listLoggedAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return agent names from log files', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      'Alice.log',
      'Bob.log',
      'Worker1.log',
      'some-other-file.txt',
    ] as any);

    const result = await listLoggedAgents('/test/logs');

    expect(result).toEqual(['Alice', 'Bob', 'Worker1']);
  });

  it('should return empty array when directory does not exist', async () => {
    vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'));

    const result = await listLoggedAgents('/nonexistent');

    expect(result).toEqual([]);
  });

  it('should return empty array when no log files exist', async () => {
    vi.mocked(fs.readdir).mockResolvedValue(['file.txt', 'README.md'] as any);

    const result = await listLoggedAgents('/test/logs');

    expect(result).toEqual([]);
  });
});
