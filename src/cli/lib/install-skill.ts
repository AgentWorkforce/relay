import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import url from 'node:url';

export interface InstallSkillArgs {
  src: string;
  destRoot: string;
  skillName: string;
}

export interface InstallSkillResult {
  installed: boolean;
  destPath: string;
}

const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

function hashContent(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function readIfExists(p: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function installSkill(args: InstallSkillArgs): Promise<InstallSkillResult> {
  const { src, destRoot, skillName } = args;
  if (!skillName) {
    throw new Error('installSkill: skillName is required');
  }
  const destDir = path.join(destRoot, skillName);
  const destPath = path.join(destDir, 'SKILL.md');

  const srcBuf = await fs.readFile(src);
  const existing = await readIfExists(destPath);

  if (existing && hashContent(existing) === hashContent(srcBuf)) {
    return { installed: false, destPath };
  }

  await fs.mkdir(destDir, { recursive: true, mode: DIR_MODE });
  await fs.writeFile(destPath, srcBuf, { mode: FILE_MODE });
  await fs.chmod(destPath, FILE_MODE);

  return { installed: true, destPath };
}

// The compiled JS lives at `dist/src/cli/lib/install-skill.js`; the source TS
// lives at `src/cli/lib/install-skill.ts`. From either, the package root that
// contains `skills/<skillName>/SKILL.md` is some number of `..` segments up.
// Probe both candidate depths so the helper works under tsx / vitest (source)
// and the published npm package (compiled).
export function resolveBundledSkillPath(skillName: string): string {
  const candidates = resolveBundledSkillPathCandidates(skillName);
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

export function resolveBundledSkillPathCandidates(skillName: string): string[] {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  return [
    path.resolve(here, '..', '..', '..', 'skills', skillName, 'SKILL.md'),
    path.resolve(here, '..', '..', '..', '..', 'skills', skillName, 'SKILL.md'),
  ];
}
