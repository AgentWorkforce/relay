import { readFile } from 'node:fs/promises';

/** Broker-wide ceiling; a harness may reject a lower effective wire limit. */
export const MAX_INJECTION_BODY_BYTES = 16 * 1024;
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
  if (Buffer.byteLength(text, 'utf8') > MAX_INJECTION_BODY_BYTES) {
    throw new Error(
      `Injection exceeds ${MAX_INJECTION_BODY_BYTES} UTF-8 bytes; use a brief file on the node and send a short pointer`
    );
  }
}
