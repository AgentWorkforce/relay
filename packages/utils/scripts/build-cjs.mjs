import { build } from 'esbuild';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const outdir = join(here, '..', 'dist', 'cjs');

const entryPoints = readdirSync(srcDir)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .map((file) => join(srcDir, file));

await build({
  entryPoints,
  outdir,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: false,
  logLevel: 'info',
});

writeFileSync(join(outdir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));
