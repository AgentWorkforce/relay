import assert from 'node:assert/strict';
import test from 'node:test';
import { pollUntilAbsent } from './absence.mjs';

test('pollUntilAbsent tolerates delayed info and inventory deletion visibility', async () => {
  let clock = 0;
  let infoCalls = 0;
  let listCalls = 0;
  const run = async (_command, args) => {
    if (args[0] === 'info') {
      infoCalls += 1;
      return infoCalls < 3
        ? { exitCode: 0, stdout: '{"id":"sandbox-delayed"}', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: '404 not found' };
    }
    listCalls += 1;
    return {
      exitCode: 0,
      stdout: JSON.stringify({ items: listCalls < 2 ? [{ id: 'sandbox-delayed' }] : [] }),
      stderr: '',
    };
  };
  const absent = await pollUntilAbsent('sandbox-delayed', {
    run,
    timeoutMs: 10_000,
    initialDelayMs: 1,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(absent, true);
  assert.equal(infoCalls, 4);
  assert.equal(listCalls, 2);
});

test('pollUntilAbsent fails closed at its bounded deadline', async () => {
  let clock = 0;
  const absent = await pollUntilAbsent('sandbox-stuck', {
    run: async () => ({ exitCode: 0, stdout: '{"id":"sandbox-stuck"}', stderr: '' }),
    timeoutMs: 5,
    initialDelayMs: 2,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(absent, false);
  assert.equal(clock, 5);
});

test('pollUntilAbsent caps stalled multi-page inventory traversal to the deadline', async () => {
  let clock = 0;
  let listCalls = 0;
  const observedTimeouts = [];
  const absent = await pollUntilAbsent('sandbox-stalled', {
    timeoutMs: 25,
    initialDelayMs: 1,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    run: async (_command, args, options) => {
      observedTimeouts.push(options.timeoutMs);
      if (args[0] === 'info') return { exitCode: 1, stdout: '', stderr: '404 not found' };
      listCalls += 1;
      // Simulate a command that consumes its entire bounded timeout while the
      // API keeps returning another page, never allowing 100 pages to run.
      clock += options.timeoutMs;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ items: [], nextCursor: `page-${listCalls + 1}` }),
        stderr: '',
      };
    },
  });
  assert.equal(absent, false);
  assert.equal(listCalls, 1);
  assert.ok(observedTimeouts.every((value) => value <= 25));
  assert.equal(clock, 25);
});
