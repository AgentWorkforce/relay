import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectCliSession } from '../cli-session-collector.js';

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function importCollectorsWithHome(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  const [claudeModule, opencodeModule] = await Promise.all([
    import('../collectors/claude.js'),
    import('../collectors/opencode.js'),
  ]);
  return {
    ClaudeCodeCollector: claudeModule.ClaudeCodeCollector,
    OpenCodeCollector: opencodeModule.OpenCodeCollector,
  };
}

afterEach(() => {
  vi.resetModules();
  process.env.HOME = originalHome;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('cli-session-collector', () => {
  it('returns null for an unknown CLI', async () => {
    const report = await collectCliSession({
      cli: 'gemini',
      cwd: '/tmp/project',
      startedAt: 1000,
      completedAt: 2000,
    });

    expect(report).toBeNull();
  });

  it('reports canCollect=false when configured data stores do not exist', async () => {
    const homeDir = makeTempDir('cli-session-collector-empty-home-');
    const { ClaudeCodeCollector, OpenCodeCollector } = await importCollectorsWithHome(homeDir);
    const { CodexCollector } = await import('../collectors/codex.js');

    expect(new ClaudeCodeCollector().canCollect()).toBe(false);
    expect(new OpenCodeCollector().canCollect()).toBe(false);
    expect(
      new CodexCollector({
        historyPath: path.join(homeDir, 'missing-history.jsonl'),
        statePath: path.join(homeDir, 'missing-state.sqlite'),
      }).canCollect(),
    ).toBe(false);
  });
});
