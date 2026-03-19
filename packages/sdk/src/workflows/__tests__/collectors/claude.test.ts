import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '--').replace(/^-+/, '');
}

function createClaudeFixture(homeDir: string, cwd: string, timestamp: number): string {
  const claudeHome = path.join(homeDir, '.claude');
  const projectsRoot = path.join(claudeHome, 'projects', encodeProjectPath(cwd));
  mkdirSync(projectsRoot, { recursive: true });

  const sessionId = 'session-claude-1';
  writeFileSync(
    path.join(claudeHome, 'history.jsonl'),
    [
      JSON.stringify({ timestamp: timestamp - 1000, project: '/other/project', sessionId: 'ignored-session' }),
      JSON.stringify({ timestamp, project: cwd, sessionId }),
    ].join('\n'),
  );

  writeFileSync(
    path.join(projectsRoot, `${sessionId}.jsonl`),
    [
      JSON.stringify({ type: 'user', text: 'Investigate the failing command' }),
      JSON.stringify({ type: 'tool_use', name: 'bash' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4',
          provider: 'anthropic',
          usage: {
            input_tokens: 42,
            output_tokens: 24,
            cache_read_input_tokens: 7,
          },
          content: [{ text: 'Final concise summary' }],
        },
      }),
    ].join('\n'),
  );

  return sessionId;
}

async function importCollectorWithHome(homeDir: string) {
  process.env.HOME = homeDir;
  vi.resetModules();
  const module = await import('../../collectors/claude.js');
  return module.ClaudeCodeCollector;
}

afterEach(() => {
  vi.resetModules();
  process.env.HOME = originalHome;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('ClaudeCodeCollector', () => {
  it('matches by project path and timestamp and reads the session jsonl', async () => {
    const homeDir = makeTempDir('claude-home-');
    const cwd = '/repo/project';
    const timestamp = 50_000;
    const sessionId = createClaudeFixture(homeDir, cwd, timestamp);
    const ClaudeCodeCollector = await importCollectorWithHome(homeDir);

    const report = await new ClaudeCodeCollector().collect({
      cli: 'claude',
      cwd,
      startedAt: timestamp - 100,
      completedAt: timestamp + 2_000,
    });

    expect(report).not.toBeNull();
    expect(report?.sessionId).toBe(sessionId);
    expect(report?.model).toBe('claude-sonnet-4');
    expect(report?.provider).toBe('anthropic');
    expect(report?.tokens).toEqual({ input: 42, output: 24, cacheRead: 7 });
    expect(report?.turns).toBe(1);
    expect(report?.toolCalls).toEqual([{ name: 'bash', count: 1 }]);
    expect(report?.summary).toBe('Final concise summary');
    expect(report?.finalStatus).toBe('completed');
  });

  it('returns false from canCollect when history and project files are missing', async () => {
    const homeDir = makeTempDir('claude-empty-home-');
    const ClaudeCodeCollector = await importCollectorWithHome(homeDir);

    expect(new ClaudeCodeCollector().canCollect()).toBe(false);
  });
});
