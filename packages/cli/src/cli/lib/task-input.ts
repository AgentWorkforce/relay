import { readFile } from 'node:fs/promises';

/** Broker-wide PTY ceiling for the formatted envelope; a harness may reject a lower effective wire limit. */
export const MAX_INJECTION_BODY_BYTES = 16 * 1024;
/** Room the broker keeps for attribution and its MCP reminder around a body. */
export const ENVELOPE_RESERVE_BYTES = 2 * 1024;
/** Largest body that still fits {@link MAX_INJECTION_BODY_BYTES} once formatted. */
export const MAX_TASK_BODY_BYTES = MAX_INJECTION_BODY_BYTES - ENVELOPE_RESERVE_BYTES;
export async function readTaskInput(
  task: unknown,
  taskFile: unknown,
  required = false
): Promise<string | undefined> {
  if (task !== undefined && taskFile !== undefined)
    throw new Error('Specify exactly one of --task or --task-file');
  if (task === undefined && taskFile === undefined) {
    if (required) throw new Error('Specify exactly one of --task or --task-file');
    return undefined;
  }
  const text = taskFile === undefined ? task : await readFile(String(taskFile), 'utf8');
  if (typeof text !== 'string' || !text.trim()) throw new Error('Task must not be empty');
  validateInjectionSize(text);
  return text;
}

export function validateInjectionSize(text: string): void {
  if (Buffer.byteLength(text, 'utf8') > MAX_TASK_BODY_BYTES) {
    throw new Error(
      `Task exceeds ${MAX_TASK_BODY_BYTES} UTF-8 bytes (the ${MAX_INJECTION_BODY_BYTES}-byte PTY limit less room for the message envelope); use a brief file on the node and send a short pointer`
    );
  }
}
