import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** The bridge version this client speaks (`crates/relay-node/src/relay/protocol.rs`). */
export const BRIDGE_VERSION = 2;
/** Moves the core's bridge socket, for the core and its clients alike. */
export const CORE_SOCKET_ENV = 'AGENT_RELAY_CORE_SOCKET';
/** The longest request line the core reads (`protocol.rs` `MAX_FRAME_BYTES`), without its newline. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
/** The longest reply or event line this client buffers (`protocol.rs` `MAX_REPLY_BYTES`), without its newline. */
export const MAX_REPLY_BYTES = 16 * 1024 * 1024;

/**
 * The core's bridge socket, resolved as the core resolves it: an absolute
 * `AGENT_RELAY_CORE_SOCKET`, a relative one beside the default, else
 * `<home>/.agentworkforce/desktop/core.sock`.
 * @param env - Environment to read the override from (default `process.env`)
 * @param home - The user's home directory (default `os.homedir()`)
 * @returns Absolute socket path
 */
export function coreSocketPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const fallback = path.join(home, '.agentworkforce', 'desktop', 'core.sock');
  const configured = env[CORE_SOCKET_ENV]?.trim();
  if (!configured) return fallback;
  return path.isAbsolute(configured) ? configured : path.join(path.dirname(fallback), configured);
}

/**
 * The Windows named pipe the core serves for a socket path
 * (`relay::transport::pipe_name`).
 * @param socket - The socket path
 * @returns `\\.\pipe\agent-relay-<16 hex>`
 */
export function pipeName(socket: string): string {
  let key = socket.replace(/\//g, '\\').toLowerCase();
  if (key.startsWith('\\\\?\\')) key = key.slice(4);
  while (key.length > 1 && key.endsWith('\\')) key = key.slice(0, -1);
  const hex = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\agent-relay-${hex}`;
}
