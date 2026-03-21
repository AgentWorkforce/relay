import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { CodexCollector } from '../../collectors/codex.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCodexFixture(tempDir: string, cwd: string, createdAtSeconds: number) {
  const statePath = path.join(tempDir, 'state_5.sqlite');
  const historyPath = path.join(tempDir, 'history.jsonl');
  const db = new DatabaseSync(statePath);

  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      model_provider TEXT,
      tokens_used INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE logs (
      thread_id TEXT,
      ts INTEGER,
      level TEXT,
      message TEXT,
      line INTEGER
    );
  `);

  db.prepare(
    'INSERT INTO threads (id, cwd, model_provider, tokens_used, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run('thread-1', cwd, 'openai/gpt-5', 321, createdAtSeconds, createdAtSeconds + 3);
  db.prepare(
    'INSERT INTO logs (thread_id, ts, level, message, line) VALUES (?, ?, ?, ?, ?)',
  ).run('thread-1', createdAtSeconds + 1, 'error', 'Command failed: bad exit code', 12);
  db.close();

  writeFileSync(historyPath, `${JSON.stringify({ session_id: 'thread-1', ts: createdAtSeconds, text: 'history' })}\n`);

  return { statePath, historyPath };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('CodexCollector', () => {
  it('matches by cwd and time window and extracts errors from logs', async () => {
    const tempDir = makeTempDir('codex-fixture-');
    const cwd = '/repo/codex-project';
    const createdAtSeconds = 100;
    const { statePath, historyPath } = createCodexFixture(tempDir, cwd, createdAtSeconds);
    const collector = new CodexCollector({ statePath, historyPath });

    const report = await collector.collect({
      cli: 'codex',
      cwd,
      startedAt: 100_000,
      completedAt: 105_000,
    });

    expect(report).not.toBeNull();
    expect(report?.sessionId).toBe('thread-1');
    expect(report?.provider).toBe('openai');
    expect(report?.model).toBe('gpt-5');
    expect(report?.tokens).toEqual({ input: 321, output: 0, cacheRead: 0 });
    expect(report?.errors).toEqual([{ turn: 1, text: 'Command failed: bad exit code' }]);
    expect(report?.finalStatus).toBe('failed');
  });
});
