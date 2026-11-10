import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultAssignmentRunner, type CloudWorkerDependencies } from './cloud-worker.js';
import { prepareWorkerAuthoredRuntime } from '../lib/cloud-worker-authored-runtime.js';

const DIRECTORIES: string[] = [];
const SDK_ENTRY = fileURLToPath(import.meta.resolve('@relayflows/sdk/relay-cli'));
const SDK_DIST = path.dirname(SDK_ENTRY);
const SURFACE_ROOT = path.dirname(
  path.dirname(createRequire(pathToFileURL(SDK_ENTRY)).resolve('@relayflows/surface/runtime'))
);
const LOADER_URL = pathToFileURL(path.join(SDK_DIST, 'authored-flow-loader.js')).href;

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-authored-runtime-'));
  DIRECTORIES.push(home);
  const runDir = path.join(home, 'cloud-workers', 'runs', 'authored-fixture');
  fs.mkdirSync(runDir, { recursive: true });
  return { home, runDir, workflow: path.join(runDir, 'example.flow.ts') };
}

afterEach(() => {
  for (const directory of DIRECTORIES.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('isolated worker authored runtime', () => {
  it.each([false, true])(
    'loads and executes the actual pinned SDK flow body (assignment Surface=%s)',
    async (supplied) => {
      const f = fixture();
      const target = path.join(f.runDir, 'node_modules', '@relayflows', 'surface');
      if (supplied) {
        // A physically separate, compatible assignment dependency, not our link.
        fs.cpSync(SURFACE_ROOT, target, { recursive: true });
        fs.symlinkSync(
          path.join(path.dirname(SURFACE_ROOT), '..'),
          path.join(target, 'node_modules'),
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      }
      const originalManifest = supplied
        ? fs.readFileSync(path.join(target, 'package.json'), 'utf8')
        : undefined;
      // This child really imports the installed SDK loader, the isolated .flow.ts
      // and its own Surface instance, then executes the authored body. Journal,
      // daemon and model execution are deliberately outside this regression.
      const entry = path.join(f.home, 'run-authored.mjs');
      fs.writeFileSync(
        entry,
        `
      import assert from 'node:assert/strict';
      import { writeFile } from 'node:fs/promises';
      import { loadAuthoredFlow } from ${JSON.stringify(LOADER_URL)};
      import { createRelayCliSurface } from ${JSON.stringify(pathToFileURL(SDK_ENTRY).href)};
      const [group, command, file, flag, input] = process.argv.slice(2);
      assert.equal(group, 'flows'); assert.equal(command, 'run');
      assert.equal(flag, '--input'); assert.equal(input, '{}');
      let diagnostics = '';
      const checked = await createRelayCliSurface().run(['check', file], {
        stdout() {}, stderr(chunk) { diagnostics += chunk; }
      });
      assert.equal(checked, 0, diagnostics);
      const loaded = await loadAuthoredFlow(file);
      const definition = loaded.getDefinition(loaded.handle);
      let reason;
      await definition.body({ done(value) { reason = value; } }, JSON.parse(input));
      assert.equal(reason, 'success');
      await writeFile('body-completed.json', JSON.stringify({ name: definition.name, reason, version: loaded.surfaceAuthority.version }));
    `
      );
      const spawnProcess = vi.fn(spawn);
      const deps: CloudWorkerDependencies = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
        env: {
          ...process.env,
          NODE_OPTIONS: '--no-warnings',
          AGENT_RELAY_HOME: f.home,
          AGENT_RELAY_WORKER_KEEP_RUN_DIR: '1',
        },
        spawnProcess,
        now: () => new Date(),
        cwd: () => f.home,
        fetchImpl: vi.fn(),
        resolveAgentRelayCliEntrypoint: () => entry,
      };
      const runner = createDefaultAssignmentRunner(deps, { localAgent: true });
      const result = await runner({
        worker: {
          baseUrl: 'https://control.example.test',
          workerId: 'fixture',
          workerToken: 'fixture',
          name: 'fixture',
          heartbeatIntervalMs: 1,
          registeredAt: '',
          updatedAt: '',
        },
        payload: {
          runId: 'authored-fixture',
          workspaceId: 'fixture',
          relayWorkspaceId: 'fixture',
          relaycastApiKey: 'fixture',
          fileType: 'ts',
          sourceFileType: 'ts',
          workflowFileName: 'example.ts',
          workflow:
            "import { flow } from '@relayflows/surface';\nexport default flow('isolated-worker', async (f) => { f.done('success'); });\n",
        },
        // Bound the real child independently of the test runner, including
        // slow SDK imports while other integration work uses the host.
        signal: AbortSignal.timeout(20_000),
      });
      expect(result.exitCode).toBe(0);
      const childEnv = spawnProcess.mock.calls[0]![2]!.env;
      expect(childEnv!.NODE_OPTIONS).toBe('--no-warnings --experimental-strip-types');
      expect(JSON.parse(fs.readFileSync(path.join(f.runDir, 'body-completed.json'), 'utf8'))).toEqual({
        name: 'isolated-worker',
        reason: 'success',
        version: '2.0.66',
      });
      if (supplied) {
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).toBe(originalManifest);
      } else {
        expect(fs.realpathSync(target)).toBe(fs.realpathSync(SURFACE_ROOT));
        // Causal negative: exactly the materialized flow fails with the former
        // missing-dependency layout; do not substitute a classifier-only test.
        fs.rmSync(target);
        const refused = spawnSync(process.execPath, [entry, 'flows', 'run', f.workflow, '--input', '{}'], {
          cwd: f.runDir,
          env: childEnv,
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(refused.error).toBeUndefined();
        expect(refused.signal).toBeNull();
        expect(typeof refused.status).toBe('number');
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain('@relayflows/surface');
      }
    },
    40_000
  );

  it('preserves an incompatible assignment package and refuses instead of replacing it', async () => {
    const f = fixture();
    const target = path.join(f.runDir, 'node_modules', '@relayflows', 'surface');
    fs.mkdirSync(target, { recursive: true });
    const manifest = '{"name":"@relayflows/surface","version":"0.0.0","exports":{}}';
    fs.writeFileSync(path.join(target, 'package.json'), manifest);
    await expect(prepareWorkerAuthoredRuntime(f.workflow)).rejects.toThrow();
    expect(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).toBe(manifest);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
  });

  it('refuses to add a fallback through an assignment node_modules link', async () => {
    const f = fixture();
    const outside = path.join(f.home, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(f.runDir, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(prepareWorkerAuthoredRuntime(f.workflow)).rejects.toThrow('not a link');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
