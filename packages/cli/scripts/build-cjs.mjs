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
  // Exclude native dependencies from bundle - they're loaded dynamically at runtime.
  // @slack/web-api lives in the @agent-relay/slack-primitive workspace (whose
  // source is bundled here); keep it external + declared as a runtime dep so the
  // CJS build doesn't have to resolve/bundle the Slack SDK (it isn't installed in
  // every publish context) and consumers load it from node_modules at runtime.
  external: ['better-sqlite3', 'ssh2', '@slack/web-api'],
  banner: {
    js: "const import_meta_url = require('node:url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': 'import_meta_url',
  },
});
