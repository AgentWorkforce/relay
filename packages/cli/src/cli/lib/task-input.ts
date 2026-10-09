import { open } from 'node:fs/promises';

/** Broker-wide PTY ceiling for the formatted envelope; a harness may reject a lower effective wire limit. */
export const MAX_INJECTION_BODY_BYTES = 16 * 1024;
/** Room the broker keeps for attribution and its MCP reminder around a body. */
export const ENVELOPE_RESERVE_BYTES = 2 * 1024;
/** Largest body that still fits {@link MAX_INJECTION_BODY_BYTES} once formatted. */
export const MAX_TASK_BODY_BYTES = MAX_INJECTION_BODY_BYTES - ENVELOPE_RESERVE_BYTES;
/**
 * The broker's portable ceiling for a prompt passed as one process argument
 * (Muse's startup task, a headless provider's message).
 */
export const MAX_ARGV_TASK_BYTES = 16 * 1024;

/**
 * A native runtime receives its task as a delivery frame, so no wire limit
 * applies; this only bounds how much of a `--task-file` the CLI will read.
 */
export const MAX_NATIVE_TASK_BYTES = 1024 * 1024;

/** Who receives a task: the CLI, and the runtime once it is resolved. */
export interface TaskTarget {
  cli: string;
  /** `native` delivers the task as a frame, without the PTY envelope; omitted means PTY. */
  runtime?: 'native' | 'pty';
}

/** Mirrors the broker's `is_muse_executable`: the basename, case-insensitive, minus a Windows launcher suffix. */
function isMuseExecutable(cli: string): boolean {
  const basename = cli.split(/[\\/]/).pop() || cli;
  return basename.toLowerCase().replace(/\.(exe|cmd|bat)$/, '') === 'muse';
}

type TaskLimit = 'pty' | 'argv' | 'native';

/** Muse takes its task as one argument; a native runtime as a frame; everything else through the PTY envelope. */
function taskLimitKind(target: TaskTarget | undefined): TaskLimit {
  if (target?.runtime === 'native') return 'native';
  if (target && isMuseExecutable(target.cli)) return 'argv';
  return 'pty';
}

export async function readTaskInput(
  task: unknown,
  taskFile: unknown,
  required = false,
  target?: TaskTarget
): Promise<string | undefined> {
  if (task !== undefined && taskFile !== undefined)
    throw new Error('Specify exactly one of --task or --task-file');
  if (task === undefined && taskFile === undefined) {
    if (required) throw new Error('Specify exactly one of --task or --task-file');
    return undefined;
  }
  const text =
    taskFile === undefined ? task : await readTaskFile(String(taskFile), taskByteLimit(target), target);
  if (typeof text !== 'string' || !text.trim()) throw new Error('Task must not be empty');
  validateTaskSize(text, target);
  return text;
}

function taskByteLimit(target: TaskTarget | undefined): number {
  const kind = taskLimitKind(target);
  return kind === 'pty' ? MAX_TASK_BODY_BYTES : kind === 'argv' ? MAX_ARGV_TASK_BYTES : MAX_NATIVE_TASK_BYTES;
}

/** Validate a task as its target receives it; recheck after anything is appended to it. */
export function validateTaskSize(text: string, target?: TaskTarget): void {
  validateTaskBytes(Buffer.byteLength(text, 'utf8'), target);
}

function validateTaskBytes(bytes: number, target: TaskTarget | undefined): void {
  const kind = taskLimitKind(target);
  if (kind === 'pty' && bytes > MAX_TASK_BODY_BYTES) throwInjectionTooLarge();
  if (kind === 'argv') validateArgvTaskSize(bytes);
  if (kind === 'native' && bytes > MAX_NATIVE_TASK_BYTES) {
    throw new Error(
      `Task exceeds ${MAX_NATIVE_TASK_BYTES} UTF-8 bytes; use a brief file on the node and send a short pointer`
    );
  }
}

/**
 * Read a UTF-8 task file, never more than one byte past `limit`: that is enough
 * to reject an oversized file without materializing all of it. Size is checked
 * before decoding, since the cut can split a character, and malformed UTF-8 is
 * rejected rather than replaced, so the agent never gets different text.
 */
async function readTaskFile(path: string, limit: number, target: TaskTarget | undefined): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const maxBytes = limit + 1;
    const buffer = Buffer.alloc(maxBytes);
    let length = 0;
    while (length < maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, maxBytes - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) validateTaskBytes(length, target);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error(`Task file ${path} is not valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

function validateArgvTaskSize(bytes: number): void {
  if (bytes > MAX_ARGV_TASK_BYTES) {
    throw new Error(
      `Task exceeds the ${MAX_ARGV_TASK_BYTES}-byte portable argv limit for a single process argument; use a brief file on the node and send a short pointer`
    );
  }
}

function throwInjectionTooLarge(): never {
  throw new Error(
    `Task exceeds ${MAX_TASK_BODY_BYTES} UTF-8 bytes (the ${MAX_INJECTION_BODY_BYTES}-byte PTY limit less room for the message envelope); use a brief file on the node and send a short pointer`
  );
}
