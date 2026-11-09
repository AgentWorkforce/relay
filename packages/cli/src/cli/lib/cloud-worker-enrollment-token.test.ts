import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_WORKER_ENROLLMENT_TOKEN_BYTES,
  readWorkerEnrollmentToken,
  type WorkerEnrollmentTokenOptions,
} from './cloud-worker-enrollment-token.js';

const directories: string[] = [];
function directory(): string {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-token-input-'));
  directories.push(result);
  return result;
}
function tokenFile(content: string | Buffer): string {
  const file = path.join(directory(), 'enrollment-token');
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('worker enrollment token input', () => {
  it('preserves the legacy token source and trimming', async () => {
    await expect(readWorkerEnrollmentToken({ token: '  fixture-enrollment-token\n' })).resolves.toBe(
      'fixture-enrollment-token'
    );
  });

  it('accepts a regular token file and Kubernetes projected Secret symlinks', async () => {
    const dir = directory();
    fs.mkdirSync(path.join(dir, '..revision'));
    fs.writeFileSync(path.join(dir, '..revision', 'token'), 'fixture-enrollment-token\n');
    fs.symlinkSync('..revision', path.join(dir, '..data'));
    fs.symlinkSync('..data/token', path.join(dir, 'token'));
    await expect(readWorkerEnrollmentToken({ tokenFile: path.join(dir, 'token') })).resolves.toBe(
      'fixture-enrollment-token'
    );
  });

  it('accepts bounded piped stdin, including split UTF-8 chunks', async () => {
    const bytes = Buffer.from('fixture-\u00e9nrollment\n');
    await expect(
      readWorkerEnrollmentToken(
        { tokenStdin: true },
        Readable.from([bytes.subarray(0, 9), bytes.subarray(9)])
      )
    ).resolves.toBe('fixture-\u00e9nrollment');
  });

  it.each<WorkerEnrollmentTokenOptions>([
    {},
    { tokenStdin: false },
    { token: 'fixture', tokenFile: 'missing-file' },
    { token: 'fixture', tokenStdin: true },
    { tokenFile: 'missing-file', tokenStdin: true },
    { token: 'fixture', tokenFile: 'missing-file', tokenStdin: true },
  ])('refuses zero or multiple sources before opening files or reading stdin: %j', async (options) => {
    const read = vi.fn();
    const stdin = new Readable({ read });
    await expect(readWorkerEnrollmentToken(options, stdin)).rejects.toThrow(
      /^worker_enrollment_token_source_required:.*--token, --token-file or --token-stdin$/
    );
    expect(read).not.toHaveBeenCalled();
    stdin.destroy();
  });

  it('refuses interactive stdin without reading or echoing it', async () => {
    const read = vi.fn();
    const stdin = Object.assign(new Readable({ read }), { isTTY: true });
    await expect(readWorkerEnrollmentToken({ tokenStdin: true }, stdin)).rejects.toThrow(
      /^worker_enrollment_token_stdin_tty_refused$/
    );
    expect(read).not.toHaveBeenCalled();
    stdin.destroy();
  });

  it('sanitizes missing-file errors and refuses directories', async () => {
    const dir = directory();
    await expect(readWorkerEnrollmentToken({ tokenFile: path.join(dir, 'private-name') })).rejects.toThrow(
      /^worker_enrollment_token_file_unavailable$/
    );
    await expect(readWorkerEnrollmentToken({ tokenFile: dir })).rejects.toThrow(
      /^worker_enrollment_token_file_not_regular$/
    );
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting for a writer', async () => {
    const fifo = path.join(directory(), 'token-pipe');
    execFileSync('mkfifo', [fifo]);
    await expect(readWorkerEnrollmentToken({ tokenFile: fifo })).rejects.toThrow(
      /^worker_enrollment_token_file_not_regular$/
    );
  });

  it('accepts the byte limit and refuses oversized files or streamed input', async () => {
    const exact = 'a'.repeat(MAX_WORKER_ENROLLMENT_TOKEN_BYTES);
    await expect(readWorkerEnrollmentToken({ tokenFile: tokenFile(exact) })).resolves.toBe(exact);
    await expect(readWorkerEnrollmentToken({ tokenFile: tokenFile(exact + 'a') })).rejects.toThrow(
      /^worker_enrollment_token_too_large$/
    );
    await expect(
      readWorkerEnrollmentToken({ tokenStdin: true }, Readable.from([exact, 'a']))
    ).rejects.toThrow(/^worker_enrollment_token_too_large$/);
  });

  it.each([Buffer.alloc(0), Buffer.from(' \n'), Buffer.from('a\0b'), Buffer.from([0xff])])(
    'refuses empty, NUL and invalid UTF-8 token bytes',
    async (bytes) => {
      await expect(readWorkerEnrollmentToken({ tokenFile: tokenFile(bytes) })).rejects.toThrow(
        /^worker_enrollment_token_invalid$/
      );
      await expect(readWorkerEnrollmentToken({ tokenStdin: true }, Readable.from([bytes]))).rejects.toThrow(
        /^worker_enrollment_token_invalid$/
      );
    }
  );

  it('does not expose a stream error containing a credential-shaped value', async () => {
    const stdin = new Readable({
      read() {
        this.destroy(new Error('fixture-private-token-in-stream-error'));
      },
    });
    await expect(readWorkerEnrollmentToken({ tokenStdin: true }, stdin)).rejects.toThrow(
      /^worker_enrollment_token_stdin_unavailable$/
    );
  });
});
