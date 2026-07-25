#!/usr/bin/env node
/**
 * Bake the PostHog write key into the compiled CLI before it is published.
 *
 * Why this exists: the npm package is plain `tsc` output, so there is no
 * bundler step that could inline an env var, and the release workflow publishes
 * with `--ignore-scripts`, which rules out a `prepublishOnly` hook. Without this
 * step the published CLI resolves no key and every event it emits is silently
 * dropped — which is exactly what shipped until now.
 *
 * The key is a PostHog *project ingest* key: write-only and public by design,
 * the same category as a Sentry DSN. The Rust broker already embeds one via
 * `option_env!`.
 *
 * Usage:
 *   AGENT_RELAY_POSTHOG_KEY=phc_xxx node scripts/inject-posthog-key.mjs
 *   node scripts/inject-posthog-key.mjs --check     # verify a key is present
 *
 * With no key in the environment this is a no-op and exits 0, so local and fork
 * builds keep shipping with telemetry disabled.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(
  REPO_ROOT,
  'packages/cli/dist/cli/telemetry/posthog-key.js'
);

const EXPORT_PATTERN = /export const BUILD_TIME_POSTHOG_KEY = (['"])(.*?)\1;/;

/** PostHog project keys are `phc_` + base62. Reject anything else loudly. */
const KEY_PATTERN = /^phc_[A-Za-z0-9]{16,}$/;

function fail(message) {
  console.error(`[inject-posthog-key] ${message}`);
  process.exit(1);
}

async function readTarget() {
  try {
    return await readFile(TARGET, 'utf8');
  } catch {
    fail(`${path.relative(REPO_ROOT, TARGET)} not found — run \`npm run build\` first.`);
  }
}

async function main() {
  const check = process.argv.includes('--check');
  const source = await readTarget();
  const match = source.match(EXPORT_PATTERN);

  if (!match) {
    fail(
      'could not find the BUILD_TIME_POSTHOG_KEY export. ' +
        'posthog-key.ts must keep the form `export const BUILD_TIME_POSTHOG_KEY = "";`.'
    );
  }

  if (check) {
    if (!match[2]) {
      fail('no key is baked into the built CLI — telemetry would ship disabled.');
    }
    console.log('[inject-posthog-key] key present in built CLI');
    return;
  }

  const key = process.env.AGENT_RELAY_POSTHOG_KEY?.trim();
  if (!key) {
    console.log(
      '[inject-posthog-key] AGENT_RELAY_POSTHOG_KEY not set — leaving telemetry disabled.'
    );
    return;
  }

  if (!KEY_PATTERN.test(key)) {
    // A malformed key is worse than none: the CLI would try to ship events to
    // an endpoint that rejects them, on every command, forever.
    fail(`AGENT_RELAY_POSTHOG_KEY does not look like a PostHog project key (expected phc_...).`);
  }

  await writeFile(
    TARGET,
    source.replace(EXPORT_PATTERN, `export const BUILD_TIME_POSTHOG_KEY = '${key}';`),
    'utf8'
  );

  console.log(
    `[inject-posthog-key] baked key (${key.slice(0, 8)}…) into ${path.relative(REPO_ROOT, TARGET)}`
  );
}

await main();
