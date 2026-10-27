import fs from 'node:fs';

/**
 * Env var naming a broker-rotated agent token file. In run-token mode the
 * broker gives workers this instead of a static `RELAY_AGENT_TOKEN`: Relaycast
 * agent tokens expire after 15 minutes, and the broker atomically replaces the
 * file (`{"token":"at_live_...","expiresAt":"<ISO8601>"}`) before each expiry.
 */
export const AGENT_TOKEN_FILE_ENV = 'RELAY_AGENT_TOKEN_FILE';

type CachedToken = { mtimeMs: number; size: number; ino: number; token: string };

function parseAgentToken(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { token?: unknown };
    const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
    // Agent tokens only; never accept a workspace key or run token here.
    return token.startsWith('at_') ? token : null;
  } catch {
    return null;
  }
}

/**
 * Per-request reader for a broker-rotated agent token file. Each `read()`
 * stats the file and reparses it only when its inode, size, or mtime changed,
 * so a rotation (atomic rename) is picked up by the very next request while
 * unchanged files cost one `stat`. Token values are never logged.
 */
export class AgentTokenFile {
  private cached: CachedToken | null = null;

  constructor(readonly path: string) {}

  /** The current token, or null when the file is missing (identity released) or invalid. */
  read(): string | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.path);
    } catch {
      this.cached = null;
      return null;
    }
    const cached = this.cached;
    if (cached && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.token;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(this.path, 'utf8');
    } catch {
      return cached?.token ?? null;
    }
    const token = parseAgentToken(raw);
    if (!token) return null;
    this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, token };
    return token;
  }
}

/** One-shot read for short-lived CLI processes. */
export function readAgentTokenFile(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  return new AgentTokenFile(trimmed).read() ?? undefined;
}
