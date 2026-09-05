import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isPromotionBlockingBug,
  snapshotRepo,
} from '../../scripts/verify-features/relay-orchestration-diagnostic-gates.mjs';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('diagnosis source provenance', () => {
  it('wires the package dry-run command into the Relayflow runner', async () => {
    const [packageJson, workflow] = await Promise.all([
      readFile('package.json', 'utf8').then(JSON.parse),
      readFile('workflows/diagnose-relay-orchestration-reliability.ts', 'utf8'),
    ]);
    expect(packageJson.scripts['diagnose:orchestration:dry-run']).toMatch(/(?:^|\s)DRY_RUN\s*=\s*1(?:\s|$)/);
    expect(workflow).toMatch(/dryRun\s*:\s*process\.env\.DRY_RUN\s*===\s*["']1["']/);
    expect(workflow).toContain('`${ART}/*`');
    expect(workflow).toContain('extensions.map((extension)');
    expect(workflow).not.toContain("const extensions = '{");
    expect(workflow).toContain("'**/.workflow-artifacts/**/draft-*'");
  });

  it('ignores runtime Trail telemetry but detects real source drift', async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-source-test-'));
    temporaryDirectories.push(repository);
    await mkdir(path.join(repository, 'src'), { recursive: true });
    await mkdir(path.join(repository, '.agentworkforce', 'trajectories', 'active'), {
      recursive: true,
    });
    await writeFile(path.join(repository, 'src', 'value.ts'), 'export const value = 1;\n');
    await writeFile(
      path.join(repository, '.agentworkforce', 'trajectories', 'active', 'run.json'),
      '{"state":"started"}\n'
    );
    await execFileAsync('git', ['init', '-q'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.name', 'diagnosis-test'], { cwd: repository });
    await execFileAsync('git', ['config', 'user.email', 'diagnosis@example.invalid'], {
      cwd: repository,
    });
    await execFileAsync('git', ['add', '.'], { cwd: repository });
    await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repository });

    const before = await snapshotRepo('fixture', repository);
    await writeFile(
      path.join(repository, '.agentworkforce', 'trajectories', 'active', 'run.json'),
      '{"state":"running"}\n'
    );
    const telemetryOnly = await snapshotRepo('fixture', repository);
    expect(telemetryOnly.contentSha256).toBe(before.contentSha256);
    expect(telemetryOnly.dirtyPaths).toEqual([]);

    await writeFile(path.join(repository, 'src', 'value.ts'), 'export const value = 2;\n');
    const sourceChanged = await snapshotRepo('fixture', repository);
    expect(sourceChanged.contentSha256).not.toBe(before.contentSha256);
    expect(sourceChanged.dirtyPaths).toContain('M src/value.ts');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a tracked symlink that escapes the repository',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-source-symlink-'));
      temporaryDirectories.push(root);
      const repository = path.join(root, 'repo');
      await mkdir(repository);
      await writeFile(path.join(root, 'outside.txt'), 'outside\n');
      await symlink('../outside.txt', path.join(repository, 'outside-link'));
      await execFileAsync('git', ['init', '-q'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.name', 'diagnosis-test'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.email', 'diagnosis@example.invalid'], {
        cwd: repository,
      });
      await execFileAsync('git', ['add', '.'], { cwd: repository });
      await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repository });

      await expect(snapshotRepo('fixture', repository)).rejects.toThrow('symlink escapes its repository');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a tracked symlink to ignored internal source',
    async () => {
      const repository = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-source-ignored-link-'));
      temporaryDirectories.push(repository);
      await writeFile(path.join(repository, '.gitignore'), 'ignored.txt\n');
      await writeFile(path.join(repository, 'ignored.txt'), 'untracked input\n');
      await symlink('ignored.txt', path.join(repository, 'ignored-link'));
      await execFileAsync('git', ['init', '-q'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.name', 'diagnosis-test'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.email', 'diagnosis@example.invalid'], {
        cwd: repository,
      });
      await execFileAsync('git', ['add', '.'], { cwd: repository });
      await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repository });

      await expect(snapshotRepo('fixture', repository)).rejects.toThrow(
        'symlink target is absent from the enumerated manifest'
      );
    }
  );

  it.skipIf(process.platform === 'win32')(
    'accepts a tracked directory symlink only when its target contents are enumerated',
    async () => {
      const repository = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-source-directory-link-'));
      temporaryDirectories.push(repository);
      await mkdir(path.join(repository, 'source'));
      await writeFile(path.join(repository, 'source', 'tracked.ts'), 'export const tracked = 1;\n');
      await symlink('source', path.join(repository, 'source-link'));
      await execFileAsync('git', ['init', '-q'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.name', 'diagnosis-test'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.email', 'diagnosis@example.invalid'], {
        cwd: repository,
      });
      await execFileAsync('git', ['add', '.'], { cwd: repository });
      await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repository });

      await expect(snapshotRepo('fixture', repository)).resolves.toMatchObject({ available: true });
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a tracked directory symlink when an ignored target entry is omitted',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-source-directory-link-ignored-'));
      temporaryDirectories.push(root);
      const repository = path.join(root, 'repo');
      await mkdir(path.join(repository, 'source'), { recursive: true });
      await writeFile(path.join(repository, '.gitignore'), 'ignored.txt\n');
      await writeFile(path.join(repository, 'source', 'tracked.ts'), 'export const tracked = 1;\n');
      await writeFile(path.join(repository, 'source', 'ignored.txt'), 'must not be omitted\n');
      await symlink('source', path.join(repository, 'source-link'));
      await execFileAsync('git', ['init', '-q'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.name', 'diagnosis-test'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.email', 'diagnosis@example.invalid'], {
        cwd: repository,
      });
      await execFileAsync('git', ['add', '.'], { cwd: repository });
      await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repository });

      await expect(snapshotRepo('fixture', repository)).rejects.toThrow(
        'symlink target is absent from the enumerated manifest'
      );
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a dangling tracked symlink that lexically escapes the repository',
    async () => {
      const repository = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-source-dangling-link-'));
      temporaryDirectories.push(repository);
      await symlink('../missing.txt', path.join(repository, 'dangling-link'));
      await execFileAsync('git', ['init', '-q'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.name', 'diagnosis-test'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.email', 'diagnosis@example.invalid'], {
        cwd: repository,
      });
      await execFileAsync('git', ['add', '.'], { cwd: repository });
      await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repository });

      await expect(snapshotRepo('fixture', repository)).rejects.toThrow('symlink escapes its repository');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'hashes a dangling internal symlink target so target drift is detected',
    async () => {
      const repository = await mkdtemp(path.join(os.tmpdir(), 'diagnosis-source-dangling-hash-'));
      temporaryDirectories.push(repository);
      const link = path.join(repository, 'dangling-link');
      await symlink('missing-a.txt', link);
      await execFileAsync('git', ['init', '-q'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.name', 'diagnosis-test'], { cwd: repository });
      await execFileAsync('git', ['config', 'user.email', 'diagnosis@example.invalid'], {
        cwd: repository,
      });
      await execFileAsync('git', ['add', '.'], { cwd: repository });
      await execFileAsync('git', ['commit', '-qm', 'fixture'], { cwd: repository });

      const before = await snapshotRepo('fixture', repository);
      await rm(link);
      await symlink('missing-b.txt', link);
      const after = await snapshotRepo('fixture', repository);
      expect(after.contentSha256).not.toBe(before.contentSha256);
    }
  );

  it('treats confirmed and in-progress critical/high bugs as promotion blockers', () => {
    expect(isPromotionBlockingBug({ severity: 'CRITICAL', status: 'CONFIRMED' })).toBe(true);
    expect(isPromotionBlockingBug({ severity: 'HIGH', status: 'IN_PROGRESS' })).toBe(true);
    expect(isPromotionBlockingBug({ severity: 'HIGH', status: 'VERIFIED' })).toBe(false);
    expect(isPromotionBlockingBug({ severity: 'MEDIUM', status: 'CONFIRMED' })).toBe(false);
  });
});
