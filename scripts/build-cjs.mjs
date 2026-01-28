import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'src', 'index.js');
const outfile = join(here, '..', 'dist', 'index.cjs');

await build({
  entryPoints: [entry],
  outfile,
  platform: 'node',
  format: 'cjs',
  bundle: true,
  target: 'node18',
  logLevel: 'info',
  banner: {
    js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
});
