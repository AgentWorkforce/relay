/**
 * `agent-relay cloud sync` applies patches through `@relayflows/sdk`.
 *
 * This drives the real command against a real git repository with a real
 * patch — no mocked `git`, no mocked apply — so the delegation is proven by
 * what lands on disk. The exclusion list is the reason it matters: the sandbox
 * commits its own bookkeeping into the synced tree, and applying that verbatim
 * would drag trajectory records and agent binaries into the user's checkout.
 *
 * Only the download is stubbed, because it rides Relay's Cloud session.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cloudMocks = vi.hoisted(() => ({ syncWorkflowPatch: vi.fn() }));

vi.mock('@agent-relay/cloud', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncWorkflowPatch: (...args: unknown[]) => cloudMocks.syncWorkflowPatch(...args),
}));

const { registerCloudCommands } = await import('./cloud.js');
type CloudDependencies = Parameters<typeof registerCloudCommands>[1] extends
  | Partial<infer D>
  | undefined
  ? D
  : never;

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
}

/** A unified diff adding one file, in the shape the Cloud patch endpoint returns. */
function addFilePatch(relPath: string, body: string): string {
  const lines = body.split('\n');
  return (
    `diff --git a/${relPath} b/${relPath}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${relPath}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((line) => `+${line}`).join('\n') +
    '\n'
  );
}

function harness() {
  const exit = vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as unknown as CloudDependencies['exit'];
  const logs: string[] = [];
  const errors: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerCloudCommands(program, {
    log: ((...args: unknown[]) => logs.push(args.join(' '))) as CloudDependencies['log'],
    warn: (() => undefined) as CloudDependencies['warn'],
    error: ((...args: unknown[]) => errors.push(args.join(' '))) as CloudDependencies['error'],
    exit,
  } as Partial<CloudDependencies>);
  return { program, logs, errors };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-sync-apply-'));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  cloudMocks.syncWorkflowPatch.mockReset();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('cloud sync applies through @relayflows/sdk', () => {
  it('writes the run changes into the target tree', async () => {
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({
      hasChanges: true,
      patch: addFilePatch('src/feature.ts', "export const feature = 'added';"),
    });
    const { program, logs } = harness();

    await program.parseAsync(['cloud', 'sync', 'run_1', '--dir', repo], { from: 'user' });

    expect(fs.readFileSync(path.join(repo, 'src/feature.ts'), 'utf8')).toContain('added');
    expect(logs.join('\n')).toContain('Patch applied successfully.');
    expect(logs.join('\n')).toContain('src/feature.ts');
  });

  it.each([
    '.agent-bin/relay',
    '.relayfile.acl',
    '.relayfile-mount-state.json',
    '.trajectories/index.json',
    '.workflow-context/notes.md',
  ])('refuses to write the agent bookkeeping path %s', async (excluded) => {
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({
      hasChanges: true,
      patch: addFilePatch(excluded, 'should never land'),
    });
    const { program } = harness();

    await program.parseAsync(['cloud', 'sync', 'run_1', '--dir', repo], { from: 'user' });

    expect(fs.existsSync(path.join(repo, excluded))).toBe(false);
  });

  it('applies the real changes while dropping the bookkeeping in the same patch', async () => {
    // The realistic case: one diff carrying both. Excluding must not cost the
    // user the changes they actually wanted.
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({
      hasChanges: true,
      patch:
        addFilePatch('src/kept.ts', 'export const kept = true;') +
        addFilePatch('.trajectories/index.json', '{"dropped":true}'),
    });
    const { program, logs } = harness();

    await program.parseAsync(['cloud', 'sync', 'run_1', '--dir', repo], { from: 'user' });

    expect(fs.existsSync(path.join(repo, 'src/kept.ts'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.trajectories/index.json'))).toBe(false);
    const output = logs.join('\n');
    expect(output).toContain('src/kept.ts');
    expect(output).toContain('Skipped 1 agent bookkeeping path');
    expect(output).toContain('.trajectories/index.json');
  });

  it('reports no changes without touching the tree', async () => {
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({ hasChanges: false, patch: '' });
    const { program, logs } = harness();
    const before = fs.readdirSync(repo).sort();

    await program.parseAsync(['cloud', 'sync', 'run_1', '--dir', repo], { from: 'user' });

    expect(logs.join('\n')).toContain('No changes to sync');
    expect(fs.readdirSync(repo).sort()).toEqual(before);
  });

  it('--dry-run prints the patch and writes nothing', async () => {
    const patch = addFilePatch('src/feature.ts', 'export const feature = 1;');
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({ hasChanges: true, patch });
    const { program } = harness();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await program.parseAsync(['cloud', 'sync', 'run_1', '--dir', repo, '--dry-run'], {
        from: 'user',
      });
    } finally {
      stdout.mockRestore();
    }

    expect(fs.existsSync(path.join(repo, 'src/feature.ts'))).toBe(false);
  });

  it('keeps the patch on disk when it conflicts, and exits non-zero', async () => {
    // A conflict is usually resolved by hand, and re-downloading needs the run
    // to still exist — so the saved path is the recovery route, not a detail.
    fs.writeFileSync(path.join(repo, 'src.ts'), 'occupied\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'occupy');
    cloudMocks.syncWorkflowPatch.mockResolvedValueOnce({
      hasChanges: true,
      patch: addFilePatch('src.ts', 'conflicting'),
    });
    const { program, errors } = harness();

    await expect(
      program.parseAsync(['cloud', 'sync', 'run_1', '--dir', repo], { from: 'user' })
    ).rejects.toThrow('exit:1');

    const saved = errors.find((line) => line.includes('Patch saved to:'));
    expect(saved).toBeDefined();
    const savedPath = saved!.split('Patch saved to:')[1]!.trim();
    expect(fs.readFileSync(savedPath, 'utf8')).toContain('conflicting');
  });
});
