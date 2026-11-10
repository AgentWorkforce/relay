import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultAssignmentRunner, type CloudWorkerDependencies } from './cloud-worker.js';
import { prepareWorkerAuthoredRuntime } from '../lib/cloud-worker-authored-runtime.js';

const directories: string[] = [];
const sdkEntry = fileURLToPath(import.meta.resolve('@relayflows/sdk/relay-cli'));
const sdkDist = path.dirname(sdkEntry);
const surfaceRoot = path.dirname(
  path.dirname(createRequire(pathToFileURL(sdkEntry)).resolve('@relayflows/surface/runtime'))
);
const loaderUrl = pathToFileURL(path.join(sdkDist, 'authored-flow-loader.js')).href;

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-authored-runtime-'));
  directories.push(home);
  const runDir = path.join(home, 'cloud-workers', 'runs', 'authored-fixture');
  fs.mkdirSync(runDir, { recursive: true });
  return { home, runDir, workflow: path.join(runDir, 'example.flow.ts') };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('isolated worker authored runtime', () => {
  it.each([false, true])(
    'loads and executes the actual pinned SDK flow body (assignment Surface=%s)',
    async (supplied) => {
      const f = fixture();
      const target = path.join(f.runDir, 'node_modules', '@relayflows', 'surface');
      if (supplied) {
        // A physically separate, compatible assignment dependency, not our link.
        fs.cpSync(surfaceRoot, target, { recursive: true });
        fs.symlinkSync(
          path.join(path.dirname(surfaceRoot), '..'),
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
      import { loadAuthoredFlow } from ${JSON.stringify(loaderUrl)};
      import { createRelayCliSurface } from ${JSON.stringify(pathToFileURL(sdkEntry).href)};
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
      const deps: CloudWorkerDependencies = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
        env: { ...process.env, AGENT_RELAY_HOME: f.home, AGENT_RELAY_WORKER_KEEP_RUN_DIR: '1' },
        spawnProcess: spawn,
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
        signal: new AbortController().signal,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(f.runDir, 'body-completed.json'), 'utf8'))).toEqual({
        name: 'isolated-worker',
        reason: 'success',
        version: '2.0.66',
      });
      if (supplied) {
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).toBe(originalManifest);
      } else {
        expect(fs.realpathSync(target)).toBe(fs.realpathSync(surfaceRoot));
        // Causal negative: exactly the materialized flow fails with the former
        // missing-dependency layout; do not substitute a classifier-only test.
        fs.rmSync(target);
        const refused = spawnSync(process.execPath, [entry, 'flows', 'run', f.workflow, '--input', '{}'], {
          cwd: f.runDir,
          encoding: 'utf8',
        });
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain('@relayflows/surface');
      }
    }
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
