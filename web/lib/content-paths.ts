import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleFilename = fileURLToPath(import.meta.url);
const moduleDirname = path.dirname(moduleFilename);

export function resolveContentDir(section: 'docs' | 'blog'): string {
  const candidates = [
    path.resolve(process.cwd(), 'content', section),
    path.resolve(process.cwd(), 'web/content', section),
    path.resolve(process.cwd(), '../content', section),
    path.resolve(process.cwd(), '../web/content', section),
    path.resolve(moduleDirname, '../content', section),
    path.resolve(moduleDirname, '../../content', section),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate ${section} content directory. Checked: ${candidates.join(', ')}`);
}
