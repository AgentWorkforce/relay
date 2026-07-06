import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');
const outfile = join(here, '..', 'dist', 'index.cjs');

await build({
  entryPoints: [entry],
  outfile,
  platform: 'node',
  format: 'cjs',
  bundle: true,
  target: 'node18',
  logLevel: 'info',
  // Exclude native/WASM dependencies from bundle - they're loaded dynamically
  // at runtime. `ai-hist` (Reflex cloud push) pulls in the sql.js WASM runtime,
  // which must resolve its .wasm from node_modules rather than the bundle.
  external: ['better-sqlite3', 'ai-hist', 'sql.js'],
  banner: {
    js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
});
