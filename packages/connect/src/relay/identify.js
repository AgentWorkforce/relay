import os from 'node:os';
import { claudeCallerSession, findClaudeSession } from './claude.js';
import { codexCallerThread } from './codex.js';

// The CLI runs inside the session that called it, so it names that session
// itself: Codex by CODEX_THREAD_ID; Claude Code by CLAUDE_CODE_SESSION_ID when
// that session has a live record, else by the nearest ancestor with a live
// session record (the desktop probe's `caller_target` rules).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SessionNotFoundError extends Error {
  constructor(checks) {
    super(
      `Run this from a live Claude Code or Codex session (${checks.join('; ')}). In Claude Code, if a permission check blocks the command, run it yourself with the ! prefix.`
    );
    this.name = 'SessionNotFoundError';
    this.code = 'not_a_relay_session';
    this.exitCode = 6;
  }
}

export async function identifyCaller({ home = os.homedir(), env = process.env, pid = process.pid } = {}) {
  const checks = [];
  if (env.CODEX_THREAD_ID) {
    const codex = await codexCallerThread({ env, pid, home });
    if (codex?.threadId) return { kind: 'codex', id: codex.threadId };
    checks.push(`CODEX_THREAD_ID is set but ${codex?.reason || 'its thread was not found'}`);
  } else {
    checks.push('no Codex thread id in the environment');
  }
  const declared = env.CLAUDE_CODE_SESSION_ID;
  if (declared && UUID.test(declared)) {
    const record = await findClaudeSession({ home, env, sessionId: declared }).catch(() => null);
    if (record) return { kind: 'claude', id: record.sessionId || declared };
  }
  const claude = await claudeCallerSession({ home, env, pid });
  if (claude) return { kind: 'claude', id: typeof claude === 'string' ? claude : claude.sessionId };
  checks.push('no Claude Code session record for any parent process');
  throw new SessionNotFoundError(checks);
}
