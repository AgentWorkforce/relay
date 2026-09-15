import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createBrokerTransfer,
  downloadBrokerArtifact,
  PART_BYTES,
  MAX_PAIR_BYTES,
} from './broker-transfer.mjs';

function fixture() {
  const bytes = Buffer.alloc(PART_BYTES + 31, 7);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const input = {
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    handoffNonce: 'c'.repeat(32),
    runtimeArtifacts: { broker: {} },
  };
  for (const arm of ['base', 'head'])
    input.runtimeArtifacts.broker[arm] = {
      path: `.relayflow/pr-proof-binaries/${arm}/agent-relay-broker`,
      sha256: digest,
      sourceSha: input[`${arm}Sha`],
    };
  const objects = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    // Real fetch rejects on an already-aborted signal; the lifetime tests rely on it.
    init.signal?.throwIfAborted();
    const key = new URL(url).pathname;
    calls.push({ key, init });
    assert.equal(init.redirect, 'error');
    if (init.method === 'PUT') {
      assert.ok(['Bearer ci-fixture', 'Bearer sandbox-fixture'].includes(init.headers.authorization));
      if (init.headers['if-none-match'] === '*' && objects.has(key)) return new Response('', { status: 412 });
      objects.set(key, init.body);
      return new Response('{}');
    }
    assert.equal(init.headers.authorization, 'Bearer sandbox-fixture');
    return new Response(objects.get(key) ?? '', { status: objects.has(key) ? 200 : 404 });
  };
  const env = {
    CLOUD_API_URL: 'https://cloud.example',
    CLOUD_API_KEY: 'ci-fixture',
    CLOUD_API_ACCESS_TOKEN: 'sandbox-fixture',
    RUN_ID: 'run-fixture',
  };
  const artifacts = ['base', 'head'].map((arm) => ({ arm, bytes: Buffer.from(bytes) }));
  const options = { env, fetchImpl };
  return {
    input,
    objects,
    calls,
    bytes,
    env,
    options,
    artifacts,
    transfer: createBrokerTransfer(input, artifacts, options),
    read: (arm) => downloadBrokerArtifact(input, arm, options),
  };
}

describe('bounded run-scoped broker transfer', () => {
  for (const origin of ['http://cloud.example', 'http://192.168.1.1', 'http://127.0.0.1.example']) {
    it(`refuses bearer transfer to ${origin} before any request`, async () => {
      const f = fixture();
      const transfer = createBrokerTransfer(f.input, f.artifacts, {
        ...f.options,
        env: { ...f.env, CLOUD_API_URL: origin },
      });
      await assert.rejects(transfer.start('run-fixture'), /require HTTPS/);
      assert.equal(f.calls.length, 0);
    });
  }
  for (const origin of ['http://127.0.0.1:1234', 'http://127.9.8.7:1234', 'http://[::1]:1234']) {
    it(`permits literal loopback fixture ${origin}`, async () => {
      const f = fixture();
      const env = { ...f.env, CLOUD_API_URL: origin };
      const transfer = createBrokerTransfer(f.input, f.artifacts, { ...f.options, env });
      await transfer.start('run-fixture');
      assert.deepEqual(
        (await downloadBrokerArtifact(f.input, 'base', { ...f.options, env })).contents,
        f.bytes
      );
      await transfer.cleanup();
    });
  }

  it('uploads once, publishes readiness last, reconstructs each part once, and tombstones on cleanup', async () => {
    const f = fixture();
    const first = f.transfer.start('run-fixture');
    assert.equal(f.transfer.start('run-fixture'), first);
    await first;
    assert.throws(() => f.transfer.start('different-run'), /run changed/);
    for (const arm of ['base', 'head']) {
      const writes = f.calls.filter((call) => call.key.includes(`/brokers/${arm}/`));
      assert.match(writes.at(-1).key, /manifest.json$/);
      assert.equal(writes.length, 3);
      assert.ok(writes.every((call) => Buffer.byteLength(call.init.body) < 3 * 1024 * 1024));
      const actual = await f.read(arm);
      assert.deepEqual(actual.contents, f.bytes);
      assert.deepEqual(actual.artifact, f.input.runtimeArtifacts.broker[arm]);
      assert.equal(
        f.calls.filter((call) => call.init.method === 'GET' && call.key.includes(`/brokers/${arm}/`)).length,
        3
      );
    }
    assert.ok(
      [...f.objects.values()].every(
        (body) => !body.includes('ci-fixture') && !body.includes('sandbox-fixture')
      )
    );
    await f.transfer.cleanup();
    await f.transfer.cleanup();
    assert.ok([...f.objects.values()].every((body) => body === ''));
    await assert.rejects(f.read('base'), /Invalid broker transfer JSON/);
    assert.throws(() => f.transfer.start('run-fixture'), /already cleaned/);
  });
  for (const [field, value] of [
    ['runId', 'other-run'],
    ['arm', 'head'],
    ['sourceSha', 'd'.repeat(40)],
    ['sha256', 'd'.repeat(64)],
    ['totalBytes', 10],
    ['count', 8],
    ['index', 1],
    ['nonce', 'd'.repeat(32)],
  ]) {
    it(`rejects a chunk with changed ${field}`, async () => {
      const f = fixture();
      await f.transfer.start('run-fixture');
      const key = [...f.objects.keys()].find((key) => key.includes('/base/') && key.endsWith('part-0.json'));
      const part = JSON.parse(f.objects.get(key));
      part[field] = value;
      f.objects.set(key, JSON.stringify(part));
      await assert.rejects(f.read('base'), /binding mismatch/);
    });
  }
  it('rejects missing/duplicate parts, malformed base64, corrupt bytes, and oversized bodies', async () => {
    for (const mutation of ['missing', 'duplicate', 'encoding', 'bytes', 'oversized']) {
      const f = fixture();
      await f.transfer.start('run-fixture');
      const key = [...f.objects.keys()].find((key) => key.includes('/base/') && key.endsWith('part-1.json'));
      const part = JSON.parse(f.objects.get(key));
      if (mutation === 'missing') f.objects.delete(key);
      else if (mutation === 'duplicate') f.objects.set(key, f.objects.get(key.replace('part-1', 'part-0')));
      else if (mutation === 'oversized') f.objects.set(key, ' '.repeat(3 * 1024 * 1024 + 1));
      else {
        part.data = mutation === 'encoding' ? '!!' + part.data : Buffer.alloc(31, 8).toString('base64');
        f.objects.set(key, JSON.stringify(part));
      }
      await assert.rejects(f.read('base'), /unavailable|mismatch|size limit/);
    }
  });
  it('checks final build SHA even if a changed part has a self-consistent checksum', async () => {
    const f = fixture();
    await f.transfer.start('run-fixture');
    const key = [...f.objects.keys()].find((key) => key.includes('/base/') && key.endsWith('part-1.json'));
    const part = JSON.parse(f.objects.get(key));
    const forged = Buffer.alloc(31, 8);
    part.data = forged.toString('base64');
    part.partSha256 = createHash('sha256').update(forged).digest('hex');
    f.objects.set(key, JSON.stringify(part));
    await assert.rejects(f.read('base'), /final build hash mismatch/);
  });
  it('refuses size violations and hash changes before any PUT', () => {
    const f = fixture();
    const tooLarge = [{ arm: 'base', bytes: { length: MAX_PAIR_BYTES } }, f.artifacts[1]];
    assert.throws(() => createBrokerTransfer(f.input, tooLarge, f.options), /bounded artifact/);
    f.artifacts[0].bytes[0] = 9;
    assert.throws(() => createBrokerTransfer(f.input, f.artifacts, f.options), /hash mismatch/);
    assert.equal(f.calls.length, 0);
  });
  it('does not publish a manifest after a partial or ambiguous upload, then cleans attempted keys', async () => {
    for (const ambiguous of [false, true]) {
      const f = fixture();
      let uploads = 0;
      const transfer = createBrokerTransfer(f.input, f.artifacts, {
        env: f.env,
        fetchImpl: async (url, init) => {
          if (init.headers['if-none-match'] === '*' && ++uploads === 2) {
            if (ambiguous) {
              await f.options.fetchImpl(url, init);
              throw new Error('ci-fixture secret');
            }
            return new Response('', { status: 412 });
          }
          return f.options.fetchImpl(url, init);
        },
      });
      await assert.rejects(
        transfer.start('run-fixture'),
        /Broker (chunk upload refused|storage request failed)/
      );
      assert.ok([...f.objects.keys()].every((key) => !key.endsWith('manifest.json')));
      await transfer.cleanup();
      assert.ok([...f.objects.values()].every((body) => body === ''));
    }
  });
  it('starts the upload lifetime at start(), not at preparation, and still bounds the upload', async () => {
    const f = fixture();
    const delayed = createBrokerTransfer(f.input, f.artifacts, { ...f.options, timeoutMs: 30 });
    await delay(80); // a slow prepare must not consume the transfer budget
    await delayed.start('run-fixture');
    assert.ok([...f.objects.keys()].some((key) => key.endsWith('manifest.json')));
    await delayed.cleanup();

    const g = fixture();
    const bounded = createBrokerTransfer(g.input, g.artifacts, {
      ...g.options,
      timeoutMs: 40,
      fetchImpl: async (url, init) => {
        await delay(30);
        return g.options.fetchImpl(url, init);
      },
    });
    await assert.rejects(bounded.start('run-fixture'), /Broker storage request failed/);
    assert.ok([...g.objects.keys()].every((key) => !key.endsWith('manifest.json')));
    await bounded.cleanup();
  });
  it('keeps the download failure when consumption cleanup also fails', async () => {
    const f = fixture();
    await f.transfer.start('run-fixture');
    const key = [...f.objects.keys()].find((key) => key.includes('/base/') && key.endsWith('part-0.json'));
    const part = JSON.parse(f.objects.get(key));
    part.runId = 'other-run';
    f.objects.set(key, JSON.stringify(part));
    let cleanupAttempts = 0;
    await assert.rejects(
      downloadBrokerArtifact(f.input, 'base', {
        env: f.env,
        fetchImpl: async (url, init) => {
          if (init.method === 'PUT') {
            cleanupAttempts++;
            return new Response('', { status: 403 });
          }
          return f.options.fetchImpl(url, init);
        },
      }),
      /Broker part binding mismatch/
    );
    assert.equal(cleanupAttempts, 3); // manifest + both parts were still attempted
  });
  it('does not return executable bytes when consumption cleanup is refused', async () => {
    const f = fixture();
    await f.transfer.start('run-fixture');
    await assert.rejects(
      downloadBrokerArtifact(f.input, 'base', {
        env: f.env,
        fetchImpl: async (url, init) => {
          if (init.method === 'PUT') return new Response('private-error-body', { status: 403 });
          return f.options.fetchImpl(url, init);
        },
      }),
      /consumption cleanup incomplete/
    );
  });
  it('waits for a racing manifest and refuses conflicting sandbox run identities', async () => {
    const f = fixture();
    const reading = f.read('base');
    await f.transfer.start('run-fixture');
    assert.deepEqual((await reading).contents, f.bytes);
    await assert.rejects(
      downloadBrokerArtifact(f.input, 'base', {
        ...f.options,
        env: { ...f.env, AGENT_RELAY_CLOUD_WORKER_RUN_ID: 'other' },
      }),
      /Conflicting/
    );
  });
});

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main as runCloud } from './run-cloud.mjs';

describe('trusted dispatcher transfer integration', () => {
  for (const scenario of [
    'completed',
    'upload-failure',
    'submission-timeout',
    'failed',
    'cancelled',
    'error',
    'failed-revoked',
  ]) {
    const failUpload = scenario === 'upload-failure';
    const hangSubmission = scenario === 'submission-timeout';
    const revoked = scenario === 'failed-revoked';
    const cancels = failUpload || hangSubmission;
    const terminalStatus = revoked ? 'failed' : failUpload || hangSubmission ? 'completed' : scenario;
    it(`preserves cleanup authority for ${scenario}`, async () => {
      const f = fixture();
      const directory = await mkdtemp(path.join(tmpdir(), 'broker-transfer-dispatch-'));
      const originalDirectory = process.cwd();
      const originalEnvironment = { ...process.env };
      const originalFetch = globalThis.fetch;
      const originalWarn = console.warn;
      const warnings = [];
      let cleanupAttempts = 0;
      try {
        console.warn = (...args) => warnings.push(args.join(' '));
        const caseId = 'fixture-broker-transfer';
        const input = {
          ...f.input,
          version: 1,
          repository: 'AgentWorkforce/relay',
          pullRequest: 7,
          caseId,
          kind: 'feature',
          manifest: {
            version: 1,
            id: caseId,
            kind: 'feature',
            title: 'Fixture broker task',
            runner: { command: ['node', `tests/relayflows/cases/${caseId}/run.mjs`] },
            requirements: ['broker-linux-x64'],
            timeoutSeconds: 180,
            expected: {
              base: { outcome: 'absent', signature: 'fixture_absent' },
              head: { outcome: 'fixed', signature: 'fixture_fixed' },
            },
          },
        };
        for (const item of f.artifacts) {
          const root = path.join(directory, '.relayflow/pr-proof-binaries', item.arm);
          await mkdir(root, { recursive: true });
          await writeFile(path.join(root, 'agent-relay-broker'), item.bytes);
          await writeFile(
            path.join(root, 'broker-manifest.json'),
            JSON.stringify({
              version: 1,
              sourceSha: input[`${item.arm}Sha`],
              sha256: input.runtimeArtifacts.broker[item.arm].sha256,
            })
          );
        }
        await writeFile(path.join(directory, '.relayflow/pr-proof-input.json'), JSON.stringify(input));
        const commands = path.join(directory, 'commands.jsonl');
        const cli = path.join(directory, 'fake-cli.mjs');
        await writeFile(
          cli,
          `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nconst command=process.argv[3];appendFileSync(${JSON.stringify(commands)},JSON.stringify(process.argv.slice(2))+'\\n');\nif(command==='run'){console.error('AGENT_RELAY_CLOUD_PREPARED_RUN_ID=run-fixture');if(${hangSubmission})setTimeout(()=>{},60_000);else console.log(JSON.stringify({runId:'run-fixture'}));}\nelse if(command==='status')console.log(JSON.stringify({status:${JSON.stringify(terminalStatus)}}));\nelse if(command==='logs')console.log('fixture log');\nelse if(command==='cancel')console.log('{}');\nelse process.exitCode=2;`,
          { mode: 0o700 }
        );
        process.chdir(directory);
        Object.assign(process.env, f.env, {
          PR_PROOF_AGENT_RELAY_BIN: cli,
          PR_PROOF_POLL_MS: '1000',
          PR_PROOF_CLOUD_COMMAND_TIMEOUT_MS: '1000',
          PR_PROOF_CLOUD_LOG_PATH: path.join(directory, 'cloud.log'),
        });
        for (const key of ['PR_PROOF_INPUT_PATH', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY'])
          delete process.env[key];
        globalThis.fetch = async (url, init) => {
          if (init.method === 'PUT' && init.body === '') {
            cleanupAttempts++;
            if (revoked) return new Response('', { status: 403 });
          }
          if (failUpload && init.headers['if-none-match'] === '*') return new Response('', { status: 503 });
          if (init.method === 'PUT' && init.body === '' && cancels) {
            // Tombstones must land before cancellation revokes the write grant.
            assert.doesNotMatch(await readFile(commands, 'utf8'), /"cancel"/);
          }
          const response = await f.options.fetchImpl(url, init);
          if (
            !failUpload &&
            scenario === 'completed' &&
            init.headers['if-none-match'] === '*' &&
            String(url).includes('/head/') &&
            String(url).endsWith('/manifest.json')
          ) {
            await f.read('base');
            await f.read('head');
          }
          return response;
        };
        if (failUpload) await assert.rejects(runCloud(), /Broker chunk upload refused/);
        else if (hangSubmission)
          await assert.rejects(runCloud(), /submission command timed out and its prepared run was cancelled/);
        else if (scenario !== 'completed')
          await assert.rejects(runCloud(), /Cloud RelayFlow finished with status/);
        else await runCloud();
        // A revoked grant is reported, but never hides the dispatcher's own failure.
        assert.equal(
          warnings.some((line) => /Broker transfer cleanup incomplete/.test(line)),
          revoked
        );
        const invocations = (await readFile(commands, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.equal(invocations.filter((args) => args[1] === 'run').length, 1);
        assert.equal(invocations.filter((args) => args[1] === 'cancel').length, cancels ? 1 : 0);
        assert.ok(cleanupAttempts > 0 || scenario === 'completed');
        if (revoked) assert.ok([...f.objects.values()].some((body) => body !== ''));
        else assert.ok([...f.objects.values()].every((body) => body === ''));
        if (!cancels)
          assert.doesNotMatch(
            await readFile(path.join(directory, 'cloud.log'), 'utf8'),
            /ci-fixture|sandbox-fixture/
          );
      } finally {
        console.warn = originalWarn;
        globalThis.fetch = originalFetch;
        process.chdir(originalDirectory);
        for (const key of Object.keys(process.env))
          if (!(key in originalEnvironment)) delete process.env[key];
        Object.assign(process.env, originalEnvironment);
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
