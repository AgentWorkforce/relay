import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    expect(packageJson.scripts['diagnose:orchestration:dry-run']).toContain('DRY_RUN=1');
    expect(workflow).toContain("dryRun: process.env.DRY_RUN === '1'");
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

  it('treats confirmed and in-progress critical/high bugs as promotion blockers', () => {
    expect(isPromotionBlockingBug({ severity: 'CRITICAL', status: 'CONFIRMED' })).toBe(true);
    expect(isPromotionBlockingBug({ severity: 'HIGH', status: 'IN_PROGRESS' })).toBe(true);
    expect(isPromotionBlockingBug({ severity: 'HIGH', status: 'VERIFIED' })).toBe(false);
    expect(isPromotionBlockingBug({ severity: 'MEDIUM', status: 'CONFIRMED' })).toBe(false);
  });
});
