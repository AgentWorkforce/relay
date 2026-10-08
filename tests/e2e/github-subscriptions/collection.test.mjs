import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

const source = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
const collectSource = source
  .slice(source.indexOf('async function collect() {'), source.indexOf('\nfunction emit() {'))
  .replace("await import(path.join(root, 'packages/harness-driver/dist/index.js'))", 'testHarness');

for (const signalName of ['SIGTERM', 'SIGINT']) {
  test(`collector cancels a pending history read on ${signalName} and disconnects`, async () => {
    const lifecycle = new EventEmitter();
    let disconnected = false,
      requested = false;
    const context = {
      process: lifecycle,
      AbortController,
      path,
      root: '/owned',
      out: '/evidence',
      configFile: '/config',
      config: { receiver: 'owned', actors: { owned: 'owned-channel' }, collectionSeconds: 60 },
      manifest: { createdAt: new Date().toISOString() },
      testHarness: {
        HarnessDriverClient: {
          connect: () => ({
            onEvent() {},
            connectEvents() {},
            disconnect() {
              disconnected = true;
            },
          }),
        },
      },
      readLines: () => [],
      readFileSync: () => '{"actors":{"owned":"owned-channel"}}',
      appendFileSync() {
        throw new Error('cancelled reads must not claim coverage');
      },
      console: { log() {} },
      pause: async () => {},
      collectUnseenMessages: async (fetchPage) => fetchPage(),
      cast: async (_route, signal) => {
        requested = true;
        assert(signal, 'history request needs a cancellation signal');
        queueMicrotask(() => lifecycle.emit(signalName));
        return new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        );
      },
    };
    await runInNewContext(collectSource + '\ncollect();', context);
    assert(requested);
    assert(disconnected);
    assert.equal(lifecycle.listenerCount('SIGINT'), 0);
    assert.equal(lifecycle.listenerCount('SIGTERM'), 0);
  });
}

test('collector propagates an ordinary history failure', async () => {
  const lifecycle = new EventEmitter();
  let disconnected = false;
  const context = {
    process: lifecycle,
    AbortController,
    path,
    root: '/owned',
    out: '/evidence',
    configFile: '/config',
    config: { receiver: 'owned', actors: { owned: 'owned-channel' } },
    manifest: { createdAt: new Date().toISOString() },
    testHarness: {
      HarnessDriverClient: {
        connect: () => ({
          onEvent() {},
          connectEvents() {},
          disconnect() {
            disconnected = true;
          },
        }),
      },
    },
    readLines: () => [],
    readFileSync: () => '{"actors":{"owned":"owned-channel"}}',
    appendFileSync() {},
    console: { log() {} },
    pause: async () => {},
    collectUnseenMessages: async (fetchPage) => fetchPage(),
    cast: async () => {
      throw new Error('history HTTP503');
    },
  };
  await assert.rejects(runInNewContext(collectSource + '\ncollect();', context), /history HTTP503/);
  assert(disconnected);
  assert.equal(lifecycle.listenerCount('SIGTERM'), 0);
});
