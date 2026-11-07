/**
 * Bring up a REAL Relaycast engine, not a stand-in.
 *
 * `@relaycast/engine` publishes `dist/bin/serve.js`, which runs standalone
 * against a local sqlite file. That gives the case authentic registration,
 * identity, node-control and delivery semantics — the things an in-case fake
 * would otherwise get to decide for itself.
 *
 * The engine's `better-sqlite3` dependency ships no prebuilt binary in its
 * tarball, so installation may need to fetch one or compile it. That is why
 * `ensureEngine` reports its own failure precisely: an engine that cannot be
 * installed is an infrastructure fault, and the case must say so rather than
 * silently degrade into proving nothing.
 */
import { execFile as execFileCb, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
export const ENGINE_VERSION = '8.2.2';
const SERVE_BIN = 'node_modules/@relaycast/engine/dist/bin/serve.js';

/** Install the engine into `dir` and return the path to its serve binary. */
export async function ensureEngine(dir, log = () => {}) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'relayflow-engine-host', private: true, version: '0.0.0' }, null, 2)}\n`,
    'utf8'
  );
  log(`installing @relaycast/engine@${ENGINE_VERSION}`);
  await execFile('npm', ['install', `@relaycast/engine@${ENGINE_VERSION}`, '--no-audit', '--no-fund'], {
    cwd: dir,
    maxBuffer: 32 * 1024 * 1024,
  });

  // `bindings` resolves the native addon from build/Release. Newer
  // better-sqlite3 ships prebuilds/ instead, and the engine pins a version that
  // ships neither, so normalise whichever layout we ended up with and fall back
  // to compiling. Doing this here keeps the failure legible instead of
  // surfacing as "Could not locate the bindings file" from deep inside startup.
  const nested = path.join(dir, 'node_modules/@relaycast/engine/node_modules/better-sqlite3');
  const top = path.join(dir, 'node_modules/better-sqlite3');
  for (const root of [nested, top]) {
    await normaliseSqliteBindings(root, log);
  }
  return path.join(dir, SERVE_BIN);
}

async function normaliseSqliteBindings(root, log) {
  const { existsSync } = await import('node:fs');
  if (!existsSync(root)) return;
  const target = path.join(root, 'build', 'Release', 'better_sqlite3.node');
  if (existsSync(target)) return;
  const prebuilt = path.join(root, 'prebuilds', `${process.platform}-${process.arch}.node`);
  if (existsSync(prebuilt)) {
    await mkdir(path.dirname(target), { recursive: true });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(prebuilt, target);
    log(`used prebuilt sqlite binding for ${process.platform}-${process.arch}`);
    return;
  }
  log('compiling better-sqlite3 from source');
  await execFile('npx', ['--yes', 'node-gyp', 'rebuild'], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
}

/** Start the engine on `port` against a fresh sqlite db under `dir`. */
export async function startEngine(serveBin, dir, port, onLog = () => {}) {
  const child = spawn(
    process.execPath,
    [serveBin, '--port', String(port), '--db', path.join(dir, 'relaycast.db'), '--env', 'test'],
    {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.on('data', (d) => onLog(`[engine] ${d}`));
  child.stderr.on('data', (d) => onLog(`[engine] ${d}`));
  return child;
}
