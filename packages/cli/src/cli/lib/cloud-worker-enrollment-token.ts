import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';

export const MAX_WORKER_ENROLLMENT_TOKEN_BYTES = 16 * 1024;

export type WorkerEnrollmentTokenOptions = {
  token?: string;
  tokenFile?: string;
  tokenStdin?: boolean;
};

export type WorkerEnrollmentTokenStream = Readable & { isTTY?: boolean };

class EnrollmentTokenInputError extends Error {}

function refuse(code: string): never {
  const guidance =
    code === 'token_source_required' ? ': choose exactly one of --token, --token-file or --token-stdin' : '';
  throw new EnrollmentTokenInputError(`worker_enrollment_${code}${guidance}`);
}

function decodeToken(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_WORKER_ENROLLMENT_TOKEN_BYTES) refuse('token_too_large');
  let value: string;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch {
    return refuse('token_invalid');
  }
  if (!value || value.includes('\0')) refuse('token_invalid');
  return value;
}

async function readTokenFile(filePath: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Follow projected Secret symlinks, then bind the read and regular-file
    // check to the opened descriptor. Nonblocking open avoids waiting on FIFOs.
    file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) refuse('token_file_not_regular');
    if (stat.size > MAX_WORKER_ENROLLMENT_TOKEN_BYTES) refuse('token_too_large');
    const bytes = Buffer.alloc(MAX_WORKER_ENROLLMENT_TOKEN_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    return decodeToken(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof EnrollmentTokenInputError) throw error;
    return refuse('token_file_unavailable');
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function readTokenStdin(stdin: WorkerEnrollmentTokenStream): Promise<string> {
  if (stdin.isTTY) refuse('token_stdin_tty_refused');
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stdin) {
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) refuse('token_invalid');
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_WORKER_ENROLLMENT_TOKEN_BYTES) refuse('token_too_large');
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof EnrollmentTokenInputError) throw error;
    return refuse('token_stdin_unavailable');
  }
  return decodeToken(Buffer.concat(chunks, length));
}

/** Read exactly one enrollment source without logging its value or file path. */
export async function readWorkerEnrollmentToken(
  options: WorkerEnrollmentTokenOptions,
  stdin: WorkerEnrollmentTokenStream = process.stdin
): Promise<string> {
  const sources = [options.token !== undefined, options.tokenFile !== undefined, options.tokenStdin === true];
  if (sources.filter(Boolean).length !== 1) refuse('token_source_required');
  if (options.token !== undefined) return decodeToken(Buffer.from(options.token, 'utf8'));
  if (options.tokenFile !== undefined) return readTokenFile(options.tokenFile);
  return readTokenStdin(stdin);
}
