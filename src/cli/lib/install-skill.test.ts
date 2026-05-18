import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installSkill } from './install-skill.js';

const SOURCE_BODY_V1 = '---\nname: test-skill\n---\nbody v1\n';
const SOURCE_BODY_V2 = '---\nname: test-skill\n---\nbody v2\n';

describe('installSkill', () => {
  let tmpRoot: string;
  let srcPath: string;
  let destRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'install-skill-'));
    srcPath = path.join(tmpRoot, 'source-SKILL.md');
    destRoot = path.join(tmpRoot, 'dest', '.claude', 'skills');
    await fs.writeFile(srcPath, SOURCE_BODY_V1);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('creates parent dir and writes the file with mode 0644', async () => {
    const originalUmask = process.umask(0o077);
    try {
      const result = await installSkill({ src: srcPath, destRoot, skillName: 'spawn-cloud-swarm' });

      expect(result.installed).toBe(true);
      expect(result.destPath).toBe(path.join(destRoot, 'spawn-cloud-swarm', 'SKILL.md'));

      const dirStat = await fs.stat(path.join(destRoot, 'spawn-cloud-swarm'));
      expect(dirStat.isDirectory()).toBe(true);
      expect(dirStat.mode & 0o777).toBe(0o755);

      const fileStat = await fs.stat(result.destPath);
      expect(fileStat.mode & 0o777).toBe(0o644);

      const written = await fs.readFile(result.destPath, 'utf-8');
      expect(written).toBe(SOURCE_BODY_V1);
    } finally {
      process.umask(originalUmask);
    }
  });

  it('is a no-op when destination hash matches source hash', async () => {
    const first = await installSkill({ src: srcPath, destRoot, skillName: 'spawn-cloud-swarm' });
    expect(first.installed).toBe(true);

    const second = await installSkill({ src: srcPath, destRoot, skillName: 'spawn-cloud-swarm' });
    expect(second.installed).toBe(false);
    expect(second.destPath).toBe(first.destPath);
  });

  it('overwrites when source hash differs', async () => {
    await installSkill({ src: srcPath, destRoot, skillName: 'spawn-cloud-swarm' });

    await fs.writeFile(srcPath, SOURCE_BODY_V2);
    const result = await installSkill({ src: srcPath, destRoot, skillName: 'spawn-cloud-swarm' });

    expect(result.installed).toBe(true);
    const written = await fs.readFile(result.destPath, 'utf-8');
    expect(written).toBe(SOURCE_BODY_V2);
  });

  it('is idempotent across repeated calls', async () => {
    const a = await installSkill({ src: srcPath, destRoot, skillName: 'spawn-cloud-swarm' });
    const b = await installSkill({ src: srcPath, destRoot, skillName: 'spawn-cloud-swarm' });
    const c = await installSkill({ src: srcPath, destRoot, skillName: 'spawn-cloud-swarm' });

    expect(a.installed).toBe(true);
    expect(b.installed).toBe(false);
    expect(c.installed).toBe(false);
  });
});
