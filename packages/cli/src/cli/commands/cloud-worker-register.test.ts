import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerCloudWorkerCommands } from './cloud-worker.js';
import { MAX_WORKER_ENROLLMENT_TOKEN_BYTES } from '../lib/cloud-worker-enrollment-token.js';

const directories: string[] = [];
function file(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-register-'));
  directories.push(dir);
  const result = path.join(dir, 'token');
  fs.writeFileSync(result, content, { mode: 0o600 });
  return result;
}
function harness(stdin: Readable & { isTTY?: boolean } = Readable.from([])) {
  const program = new Command().exitOverride();
  const cloud = program.command('cloud');
  const log = vi.fn();
  const error = vi.fn();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-register-home-'));
  directories.push(home);
  const fetchImpl = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          workerId: 'fixture-worker',
          workerToken: 'fixture-private-worker-token',
          heartbeatIntervalMs: 30_000,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
  );
  const exit = vi.fn((code: number): never => {
    throw new Error(`exit:${code}`);
  });
  registerCloudWorkerCommands(cloud, { stdin, log, error, fetchImpl, exit, env: { AGENT_RELAY_HOME: home } });
  return { program, log, error, fetchImpl, home, exit };
}
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('cloud worker register token sources', () => {
  it.each(['legacy', 'file', 'stdin'])(
    'passes %s input only through the official registration API',
    async (source) => {
      const token = 'fixture-private-enrollment-token';
      const { program, log, error, fetchImpl, home } = harness(Readable.from([token + '\n']));
      const args =
        source === 'legacy'
          ? ['--token', token]
          : source === 'file'
            ? ['--token-file', file(token)]
            : ['--token-stdin'];
      await program.parseAsync([
        'node',
        'relay',
        'cloud',
        'worker',
        'register',
        '--name',
        'fixture',
        '--base-url',
        'https://control.example.com',
        '--json',
        ...args,
      ]);
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, request] = fetchImpl.mock.calls[0];
      expect(String(url)).toBe('https://control.example.com/api/v1/workers/register');
      expect(request?.method).toBe('POST');
      expect(JSON.parse(String(request?.body))).toMatchObject({ enrollmentToken: token, name: 'fixture' });
      const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      expect(output).not.toContain(token);
      expect(output).not.toContain('fixture-private-worker-token');
      const stored = fs.readFileSync(path.join(home, 'cloud-workers.json'), 'utf8');
      expect(stored).toContain('fixture-private-worker-token');
      expect(stored).not.toContain(token);
    }
  );

  it.each(
    [
      [],
      ['--token', 'fixture', '--token-stdin'],
      ['--token-file', 'not-present', '--token-stdin'],
      ['--token', 'fixture', '--token-file', 'not-present'],
      ['--token-file', 'not-present'],
      ['--token', ''],
    ].map((args) => ({ args }))
  )('refuses invalid selection/input before registration: $args', async ({ args }) => {
    const { program, log, error, fetchImpl } = harness();
    const attempt = program.parseAsync([
      'node',
      'relay',
      'cloud',
      'worker',
      'register',
      '--name',
      'fixture',
      ...args,
    ]);
    await expect(attempt).rejects.toThrow(/^worker_enrollment_token_/);
    if (args.length === 0) {
      await expect(attempt).rejects.toThrow('choose exactly one of --token, --token-file or --token-stdin');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('refuses an oversized file before registration', async () => {
    const { program, fetchImpl } = harness();
    await expect(
      program.parseAsync([
        'node',
        'relay',
        'cloud',
        'worker',
        'register',
        '--name',
        'fixture',
        '--token-file',
        file('x'.repeat(MAX_WORKER_ENROLLMENT_TOKEN_BYTES + 1)),
      ])
    ).rejects.toThrow(/^worker_enrollment_token_too_large$/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses interactive stdin before registration', async () => {
    const { program, fetchImpl } = harness(Object.assign(Readable.from(['fixture']), { isTTY: true }));
    await expect(
      program.parseAsync([
        'node',
        'relay',
        'cloud',
        'worker',
        'register',
        '--name',
        'fixture',
        '--token-stdin',
      ])
    ).rejects.toThrow(/^worker_enrollment_token_stdin_tty_refused$/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
