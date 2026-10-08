import { open } from 'node:fs/promises';

/** Broker-wide PTY ceiling for the formatted envelope; a harness may reject a lower effective wire limit. */
export const MAX_INJECTION_BODY_BYTES = 16 * 1024;
/** Room the broker keeps for attribution and its MCP reminder around a body. */
export const ENVELOPE_RESERVE_BYTES = 2 * 1024;
/** Largest body that still fits {@link MAX_INJECTION_BODY_BYTES} once formatted. */
export const MAX_TASK_BODY_BYTES = MAX_INJECTION_BODY_BYTES - ENVELOPE_RESERVE_BYTES;
/** The broker's portable argv ceiling for Muse's single-argument startup prompt. */
export const MUSE_STARTUP_PROMPT_MAX_BYTES = 16 * 1024;

/** Mirrors the broker's `is_muse_executable`: the basename, case-insensitive, minus a Windows launcher suffix. */
function isMuseExecutable(cli: string): boolean {
  const basename = cli.split(/[\\/]/).pop() || cli;
  return basename.toLowerCase().replace(/\.(exe|cmd|bat)$/, '') === 'muse';
}

export async function readTaskInput(
  task: unknown,
  taskFile: unknown,
  required = false,
  cli?: string
): Promise<string | undefined> {
  if (task !== undefined && taskFile !== undefined)
    throw new Error('Specify exactly one of --task or --task-file');
  if (task === undefined && taskFile === undefined) {
    if (required) throw new Error('Specify exactly one of --task or --task-file');
    return undefined;
  }
  // Muse receives its startup task through argv, not the PTY envelope.
  const muse = cli !== undefined && isMuseExecutable(cli);
  const limit = muse ? MUSE_STARTUP_PROMPT_MAX_BYTES : MAX_TASK_BODY_BYTES;
  const text = taskFile === undefined ? task : await readFilePrefix(String(taskFile), limit + 1);
  if (typeof text !== 'string' || !text.trim()) throw new Error('Task must not be empty');
  validateTaskSize(text, cli);
  return text;
}

/** Validate a task as the given CLI receives it; recheck after anything is appended to it. */
export function validateTaskSize(text: string, cli?: string): void {
  if (cli !== undefined && isMuseExecutable(cli)) validateMuseStartupPromptSize(text);
  else validateInjectionSize(text);
}

/**
 * Read at most `maxBytes` of a UTF-8 file. Reading one byte past a size limit
 * is enough to reject an oversized file without materializing all of it.
 */
async function readFilePrefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    let length = 0;
    while (length < maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, maxBytes - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await handle.close();
  }
}

function validateMuseStartupPromptSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MUSE_STARTUP_PROMPT_MAX_BYTES) {
    throw new Error(
      `Muse startup task exceeds the ${MUSE_STARTUP_PROMPT_MAX_BYTES}-byte portable argv limit; use a brief file on the node and send a short pointer`
    );
  }
}

export function validateInjectionSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_TASK_BODY_BYTES) {
    throw new Error(
      `Task exceeds ${MAX_TASK_BODY_BYTES} UTF-8 bytes (the ${MAX_INJECTION_BODY_BYTES}-byte PTY limit less room for the message envelope); use a brief file on the node and send a short pointer`
    );
  }
}
