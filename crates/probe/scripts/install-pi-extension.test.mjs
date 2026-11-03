// The manual Pi installer: what it refuses, and what it writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./install-pi-extension.mjs', import.meta.url));

function run(home) {
  const agent = join(home, 'agent');
  try {
    const out = execFileSync(process.execPath, [script], {
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: String(error.stderr) };
  }
}

function home(t, name) {
  // Short: a Unix socket path must fit in about a hundred bytes.
  const root = fs.mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'rpi-'));
  const dir = join(root, name);
  fs.mkdirSync(join(dir, 'agent', 'extensions'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, file: join(dir, 'agent', 'extensions', 'agent-relay.js') };
}

const unix = process.platform !== 'win32';

test('a home path naming a placeholder is written as it is', { skip: !unix }, (t) => {
  const h = home(t, '__HARNESS__');
  assert.equal(run(h.dir).ok, true);
  const installed = fs.readFileSync(h.file, 'utf8');
  assert.match(installed, /const harness = "pi";/);
  assert.ok(installed.includes(`${h.dir}/.agentworkforce/desktop/pi`));
  execFileSync(process.execPath, ['--check', h.file]);
});

test('an Oh My Pi copy is refused, not overwritten', { skip: !unix }, (t) => {
  const h = home(t, 'omp');
  assert.equal(run(h.dir).ok, true);
  const omp = fs.readFileSync(h.file, 'utf8').replace('const harness = "pi";', 'const harness = "omp";');
  fs.writeFileSync(h.file, omp);
  const result = run(h.dir);
  assert.equal(result.ok, false);
  assert.match(result.out, /Preserving the Oh My Pi extension/);
  assert.equal(fs.readFileSync(h.file, 'utf8'), omp);
});

for (const [name, make] of [
  ['a symlink', (file) => fs.symlinkSync('/etc/hosts', file)],
  ['a FIFO', (file) => execFileSync('mkfifo', [file])],
]) {
  test(`${name} at the extension path is refused`, { skip: !unix }, (t) => {
    const h = home(t, 'special');
    make(h.file);
    const result = run(h.dir);
    assert.equal(result.ok, false);
    assert.match(result.out, /Preserving another extension/);
    fs.rmSync(h.root, { recursive: true, force: true });
  });
}

test('a socket at the extension path is refused', { skip: !unix }, async (t) => {
  const h = home(t, 'socket');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(h.file, resolve));
  const result = run(h.dir);
  server.close();
  assert.equal(result.ok, false);
  assert.match(result.out, /Preserving another extension/);
});
