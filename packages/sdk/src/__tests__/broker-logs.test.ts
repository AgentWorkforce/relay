/**
 * Tests for the broker-logs SDK helpers.
 *
 * The helpers are filesystem-only, so we stage a fake log directory in tmp
 * and pass it explicitly via the `dir` option.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';

import {
  clearBrokerLogs,
  getBrokerLogDir,
  listBrokerLogs,
  pruneBrokerLogs,
  tailBrokerLog,
} from '../broker-logs.js';

function stageLog(dir: string, name: string, content: string, ageDays = 0): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  if (ageDays > 0) {
    const past = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path, past, past);
  }
  return path;
}

describe('broker-logs SDK helpers', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'broker-logs-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('getBrokerLogDir returns a platform-appropriate path', () => {
    const path = getBrokerLogDir();
    if (process.platform === 'darwin') {
      assert.match(path, /Library\/Logs\/agent-relay$/);
    } else if (process.platform === 'win32') {
      assert.match(path.toLowerCase(), /agent-relay[\\/]logs$/);
    } else {
      assert.match(path, /agent-relay\/logs$/);
    }
  });

  test('listBrokerLogs returns empty array when directory missing', async () => {
    const missing = join(dir, 'does-not-exist');
    const files = await listBrokerLogs(missing);
    assert.deepEqual(files, []);
  });

  test('listBrokerLogs parses current and rotated filenames', async () => {
    stageLog(dir, 'alpha.log', 'current\n');
    stageLog(dir, 'alpha.log.2026-05-20', 'old\n');
    stageLog(dir, 'beta.log.2026-05-21', 'beta\n');
    stageLog(dir, 'unrelated.txt', 'skip\n');

    const files = await listBrokerLogs(dir);
    const byName = Object.fromEntries(files.map((f) => [f.name, f]));

    assert.equal(files.length, 3);
    assert.equal(byName['alpha.log'].brokerId, 'alpha');
    assert.equal(byName['alpha.log'].date, null);
    assert.equal(byName['alpha.log.2026-05-20'].brokerId, 'alpha');
    assert.equal(byName['alpha.log.2026-05-20'].date, '2026-05-20');
    assert.equal(byName['beta.log.2026-05-21'].brokerId, 'beta');
  });

  test('tailBrokerLog returns the newest matching file', async () => {
    stageLog(dir, 'proj.log.2026-05-19', 'old-1\nold-2\nold-3\n', 5);
    stageLog(dir, 'proj.log', 'new-1\nnew-2\nnew-3\nnew-4\n');

    const result = await tailBrokerLog('proj', { dir, lines: 2 });
    assert.ok(result);
    assert.match(result.path, /proj\.log$/);
    assert.equal(result.content, 'new-3\nnew-4');
  });

  test('tailBrokerLog returns null when no log file exists', async () => {
    const result = await tailBrokerLog('missing', { dir });
    assert.equal(result, null);
  });

  test('pruneBrokerLogs deletes rotated files older than keepDays', async () => {
    const fresh = stageLog(dir, 'proj.log.2026-05-20', 'fresh\n', 1);
    const stale = stageLog(dir, 'proj.log.2026-05-01', 'stale\n', 20);
    const current = stageLog(dir, 'proj.log', 'current\n');

    const { removed, kept } = await pruneBrokerLogs({ dir, keepDays: 7 });

    const removedPaths = removed.map((f) => f.path);
    const keptPaths = kept.map((f) => f.path);

    assert.deepEqual(removedPaths, [stale]);
    assert.ok(keptPaths.includes(fresh));
    assert.ok(keptPaths.includes(current));
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(current), true);
  });

  test('pruneBrokerLogs never deletes the current un-suffixed file', async () => {
    const current = stageLog(dir, 'proj.log', 'still-active\n', 365);
    const { removed, kept } = await pruneBrokerLogs({ dir, keepDays: 7 });
    assert.equal(removed.length, 0);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].path, current);
  });

  test('pruneBrokerLogs respects brokerId filter', async () => {
    const aOld = stageLog(dir, 'a.log.2026-04-01', 'a\n', 30);
    const bOld = stageLog(dir, 'b.log.2026-04-01', 'b\n', 30);

    const { removed } = await pruneBrokerLogs({ dir, keepDays: 7, brokerId: 'a' });

    assert.deepEqual(
      removed.map((f) => f.path),
      [aOld]
    );
    assert.equal(existsSync(bOld), true);
  });

  test('pruneBrokerLogs dryRun reports without deleting', async () => {
    const stale = stageLog(dir, 'proj.log.2026-01-01', 'stale\n', 200);
    const { removed } = await pruneBrokerLogs({ dir, keepDays: 7, dryRun: true });
    assert.equal(removed.length, 1);
    assert.equal(existsSync(stale), true);
  });

  test('clearBrokerLogs removes every file in scope', async () => {
    const a = stageLog(dir, 'a.log', 'a\n');
    const b = stageLog(dir, 'b.log.2026-05-20', 'b\n');
    const c = stageLog(dir, 'c.log', 'c\n');

    const removed = await clearBrokerLogs({ dir });

    assert.equal(removed.length, 3);
    for (const path of [a, b, c]) assert.equal(existsSync(path), false);
  });

  test('clearBrokerLogs honors brokerId filter', async () => {
    const a = stageLog(dir, 'a.log', 'a\n');
    const b = stageLog(dir, 'b.log', 'b\n');
    const removed = await clearBrokerLogs({ dir, brokerId: 'a' });
    assert.equal(removed.length, 1);
    assert.equal(existsSync(a), false);
    assert.equal(existsSync(b), true);
  });
});
