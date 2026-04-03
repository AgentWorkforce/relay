import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createOpenCodeFixture(homeDir: string, cwd: string, sessionCreatedAt: number): string {
  const dbDir = path.join(homeDir, '.local', 'share', 'opencode');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'opencode.db');
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);

  const insertSession = db.prepare('INSERT INTO session (id, directory, time_created) VALUES (?, ?, ?)');
  const insertMessage = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
  const insertPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)');

  insertSession.run('session-1', cwd, sessionCreatedAt);
  insertSession.run('session-2', '/other/project', sessionCreatedAt + 1000);

  insertMessage.run(
    'msg-1',
    'session-1',
    sessionCreatedAt + 10,
    JSON.stringify({ role: 'user', tokens: { input: 10, output: 0, cache: { read: 1 } } }),
  );
  insertMessage.run(
    'msg-2',
    'session-1',
    sessionCreatedAt + 20,
    JSON.stringify({
      role: 'assistant',
      modelID: 'gpt-5',
      providerID: 'openai',
      finish: 'error',
      cost: 1.25,
      tokens: { input: 15, output: 20, cache: { read: 4 } },
    }),
  );
  insertMessage.run(
    'msg-other',
    'session-2',
    sessionCreatedAt + 30,
    JSON.stringify({ role: 'assistant', modelID: 'ignore-me', providerID: 'other', finish: 'completed' }),
  );

  insertPart.run(
    'part-1',
    'msg-1',
    'session-1',
    sessionCreatedAt + 11,
    JSON.stringify({ type: 'text', text: 'Planning work' }),
  );
  insertPart.run(
    'part-2',
    'msg-2',
    'session-1',
    sessionCreatedAt + 21,
    JSON.stringify({ type: 'tool_call', name: 'write_file' }),
  );
  insertPart.run(
    'part-3',
    'msg-2',
    'session-1',
    sessionCreatedAt + 22,
    JSON.stringify({ type: 'text', text: 'Error: database locked\nCleanup afterwards' }),
  );
  insertPart.run(
    'part-4',
    'msg-2',
    'session-1',
    sessionCreatedAt + 23,
    JSON.stringify({ type: 'text', text: 'Completed summary output' }),
  );

  db.close();
  return dbPath;
}

async function importCollectorWithHome(homeDir: string) {
  process.env.HOME = homeDir;
  vi.restoreAllMocks();
  vi.doMock('node:module', () => ({
    createRequire: () => (id: string) => {
      if (id !== 'better-sqlite3') {
        throw new Error(`Unexpected module request: ${id}`);
      }

      return class BetterSqliteCompat {
        private readonly db: DatabaseSync;

        constructor(filename: string) {
          this.db = new DatabaseSync(filename, { open: true, readOnly: true });
        }

        prepare(sql: string) {
          const statement = this.db.prepare(sql);
          return {
            get<T>(params?: unknown): T | undefined {
              return statement.get(params as never) as T | undefined;
            },
            all<T>(params?: unknown): T[] {
              return statement.all(params as never) as T[];
            },
          };
        }

        pragma(_source: string) {
          return undefined;
        }

        close() {
          this.db.close();
        }
      };
    },
  }));
  const module = await import('../../collectors/opencode.js');
  return module.OpenCodeCollector;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('OpenCodeCollector', () => {
  it('matches by directory and time window, aggregates tokens, and extracts errors', async () => {
    const homeDir = makeTempDir('opencode-home-');
    const cwd = path.join(homeDir, 'workspace');
    const sessionCreatedAt = 10_000;
    createOpenCodeFixture(homeDir, cwd, sessionCreatedAt);
    const OpenCodeCollector = await importCollectorWithHome(homeDir);

    const collector = new OpenCodeCollector();
    const report = await collector.collect({
      cli: 'opencode',
      cwd,
      startedAt: sessionCreatedAt + 100,
      completedAt: sessionCreatedAt + 500,
    });

    expect(report).not.toBeNull();
    expect(report?.sessionId).toBe('session-1');
    expect(report?.model).toBe('gpt-5');
    expect(report?.provider).toBe('openai');
    expect(report?.tokens).toEqual({ input: 25, output: 20, cacheRead: 5 });
    expect(report?.cost).toBe(1.25);
    expect(report?.toolCalls).toEqual([{ name: 'write_file', count: 1 }]);
    expect(report?.errors).toEqual([{ turn: 3, text: 'Error: database locked' }]);
    expect(report?.finalStatus).toBe('failed');
    expect(report?.summary).toBe('Completed summary output');
  });

  it('returns false from canCollect when the database is missing', async () => {
    const homeDir = makeTempDir('opencode-missing-home-');
    const OpenCodeCollector = await importCollectorWithHome(homeDir);

    expect(new OpenCodeCollector().canCollect()).toBe(false);
  });
});
