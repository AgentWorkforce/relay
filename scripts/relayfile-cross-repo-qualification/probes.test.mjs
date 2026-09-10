import assert from 'node:assert/strict';
import test from 'node:test';
import { PROBES, PROBE_KILL_SIGNAL, PROBE_TIMEOUT_MS, hasExactProbeToken, runProbe } from './probes.mjs';

test('probe definitions use the proven model/auth argument arrays and bounded options', async () => {
  const calls = [];
  const result = await runProbe(PROBES[0], {
    execFileAsync: async (...args) => {
      calls.push(args);
      return {
        stdout:
          '{"type":"item.completed","item":{"type":"agent_message","text":"RELAYFILE_CODEX_PROBE_OK"}}\n',
      };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0][0], 'codex');
  assert.deepEqual(calls[0][1], PROBES[0].args);
  assert.equal(calls[0][2].timeout, PROBE_TIMEOUT_MS);
  assert.equal(calls[0][2].killSignal, PROBE_KILL_SIGNAL);
  assert.deepEqual(calls[0][2].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(PROBES[1].args[0], '-p');
  assert.deepEqual(PROBES[1].args.slice(0, 8), [
    '-p',
    '--model',
    'sonnet',
    '--permission-mode',
    'plan',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--setting-sources',
  ]);
});

test('probe token detection rejects false-green extra output', () => {
  assert.equal(hasExactProbeToken('RELAYFILE_CLAUDE_PROBE_OK\nextra', 'RELAYFILE_CLAUDE_PROBE_OK'), false);
  assert.equal(
    hasExactProbeToken(
      '{"type":"item.completed","item":{"type":"agent_message","text":"RELAYFILE_CODEX_PROBE_OK extra"}}\n',
      'RELAYFILE_CODEX_PROBE_OK',
      true
    ),
    false
  );
  assert.equal(hasExactProbeToken('RELAYFILE_CLAUDE_PROBE_OK', 'RELAYFILE_CLAUDE_PROBE_OK'), true);
});

test('probe failures are bounded and redacted', async () => {
  const result = await runProbe(PROBES[1], {
    execFileAsync: async () => {
      const error = new Error('authorization=super-secret');
      error.code = 1;
      error.stderr = 'token=super-secret';
      throw error;
    },
    timeoutMs: 1234,
  });
  assert.equal(result.ok, false);
  assert.match(result.failure, /REDACTED/);
  assert.doesNotMatch(result.failure, /super-secret/);
});
