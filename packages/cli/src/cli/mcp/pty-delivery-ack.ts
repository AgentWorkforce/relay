import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Publish a local receipt only for a successful read by this worker's own identity. */
export async function acknowledgePtyMessageRead(messageId: string, as?: string): Promise<boolean> {
  const directory = process.env.RELAY_PTY_ACK_DIR;
  if (!directory || (as && as !== process.env.RELAY_AGENT_NAME)) return false;
  const key = createHash('sha256').update(messageId).digest('hex');
  const temporary = path.join(directory, `${key}.${randomUUID()}.tmp`);
  try {
    const pending = JSON.parse(await readFile(path.join(directory, `${key}.pending`), 'utf8'));
    if (
      pending.messageId !== messageId ||
      pending.agentName !== process.env.RELAY_AGENT_NAME ||
      !/^[a-f0-9-]{36}$/.test(pending.nonce)
    )
      return false;
    await writeFile(temporary, pending.nonce, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(directory, `${key}.${pending.nonce}.read`));
    return true;
  } catch {
    // A completed/expired PTY delivery must not turn a successful remote read into an MCP error.
    return false;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
