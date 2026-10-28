// AGENT_RELAY_PI_EXTENSION=2
// No Pi package imports: works with both package names and older extension APIs.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const runtime = __RUNTIME__;
const limit = 1024 * 1024;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const contentText = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n')
      : '';

function privateDir(path) {
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error('Pi relay directory must be private');
}

function read(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit)
      throw new Error('Invalid Pi relay record');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function write(path, value) {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path);
  const dir = fs.openSync(join(path, '..'), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

// Older Pi releases defer creating the JSONL until the first assistant reply.
// A branch entry alone is therefore not evidence of a durable user message.
function persisted(ctx, entry, prompt) {
  let fd;
  try {
    if (typeof entry.id !== 'string') return false;
    fd = fs.openSync(ctx.sessionManager.getSessionFile(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid()) return false;
    const start = Math.max(0, stat.size - 8 * 1024 * 1024);
    const bytes = Buffer.alloc(stat.size - start);
    const count = fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.subarray(0, count).toString('utf8').split('\n');
    if (start) lines.shift();
    const found = lines.some((line) => {
      try {
        const saved = JSON.parse(line);
        return (
          saved.id === entry.id &&
          saved.type === 'message' &&
          saved.message.role === 'user' &&
          contentText(saved.message.content) === prompt
        );
      } catch {
        return false;
      }
    });
    if (found) fs.fsyncSync(fd);
    return found;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function inbox(state) {
  const records = [];
  for (const name of fs.readdirSync(state.dir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    if (state.finished.has(name)) continue;
    const path = join(state.dir, name);
    let record;
    try {
      record = read(path);
    } catch {
      continue;
    }
    if (
      ![1, 2].includes(record?.version) ||
      record.sessionId !== state.id ||
      typeof record.messageId !== 'string' ||
      typeof record.text !== 'string' ||
      !['pending', 'claimed', 'recorded'].includes(record.state) ||
      `${digest(record.messageId)}.json` !== name ||
      record.text.length > limit / 2 ||
      (record.sequence !== undefined && (!Number.isSafeInteger(record.sequence) || record.sequence < 1))
    )
      continue;
    records.push({ name, path, record, modified: fs.lstatSync(path).mtimeMs });
  }
  return records.sort((a, b) => {
    const aSequenced = a.record.sequence !== undefined;
    const bSequenced = b.record.sequence !== undefined;
    // Pre-upgrade records precede new ones; only their original file times
    // remain available. Every newly queued message has a durable sequence.
    if (aSequenced !== bSequenced) return aSequenced ? 1 : -1;
    return (
      (aSequenced ? a.record.sequence - b.record.sequence : a.modified - b.modified) ||
      a.name.localeCompare(b.name)
    );
  });
}

export default function (pi) {
  let active;

  function stop() {
    if (!active) return;
    clearInterval(active.timer);
    fs.closeSync(active.fd);
    // Keep receipts for reconciliation; closing this descriptor removes liveness.
    active = undefined;
  }

  // Metadata commands are separate from delivery: a rename never starts a turn.
  function titles(state) {
    if (typeof pi.setSessionName !== 'function' || typeof pi.getSessionName !== 'function') return;
    for (const name of fs.readdirSync(state.dir)) {
      if (!/^title-[a-f0-9]{32}\.json$/.test(name)) continue;
      const path = join(state.dir, name);
      let record;
      try {
        record = read(path);
      } catch {
        continue;
      }
      if (
        record?.version !== 1 ||
        record.sessionId !== state.id ||
        record.state !== 'pending' ||
        record.requestId !== name.slice(6, -5) ||
        !Number.isSafeInteger(record.expiresAt) ||
        record.expiresAt < Date.now() ||
        typeof record.title !== 'string' ||
        !record.title.trim() ||
        [...record.title].length > 200 ||
        /[\x00-\x1f\x7f]/.test(record.title)
      )
        continue;
      try {
        pi.setSessionName(record.title);
        record.title = pi.getSessionName();
        if (typeof record.title !== 'string' || !record.title.trim()) throw new Error('No title saved');
        record.state = 'done';
      } catch {
        record.state = 'failed';
      }
      write(path, record);
    }
    const title = pi.getSessionName();
    if (typeof title === 'string' && title !== state.title) {
      write(join(state.dir, 'title-state.json'), { sessionId: state.id, title });
      state.title = title;
    }
  }

  function pump() {
    const state = active;
    if (!state || state.pumping) return;
    state.pumping = true;
    try {
      const ctx = state.ctx;
      if (ctx.sessionManager.getSessionId() !== state.id) return;
      titles(state);
      const branch = ctx.sessionManager.getBranch();
      let submitted = false;
      for (const { name, path, record } of inbox(state)) {
        if (record.state === 'recorded' && record.answer) {
          state.finished.add(name);
          continue;
        }
        // Version 2 contains the verified owner's unframed text. Both modes
        // retain this neutral marker because Pi cannot accept a client message
        // ID. It is receipt metadata, not a claim of peer or owner authority.
        const prompt = `${record.text}\n\n[Agent Relay delivery ${digest(record.messageId)}]`;
        const index = branch.findIndex(
          (entry) =>
            entry.type === 'message' &&
            entry.message.role === 'user' &&
            contentText(entry.message.content) === prompt
        );
        if (index >= 0) {
          if (record.state !== 'recorded') {
            if (!persisted(ctx, branch[index], prompt)) continue;
            record.state = 'recorded';
            write(path, record);
          }
          // Only an assistant's completed final message, before the next user turn.
          const following = branch.slice(index + 1);
          const nextUser = following.findIndex((e) => e.type === 'message' && e.message.role === 'user');
          const turn = nextUser < 0 ? following : following.slice(0, nextUser);
          const last = turn.filter((e) => e.type === 'message').at(-1)?.message;
          if (
            !record.answer &&
            (nextUser >= 0 || ctx.isIdle()) &&
            last?.role === 'assistant' &&
            last.stopReason === 'stop'
          ) {
            const answer = contentText(last.content);
            if (answer) {
              record.answer = answer;
              write(path, record);
            }
          }
        } else if (record.state === 'pending' && !submitted && ctx.isIdle()) {
          // Sync the claim before calling Pi. A crash here is uncertain, never resent.
          record.state = 'claimed';
          write(path, record);
          submitted = true;
          pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
        }
      }
    } catch {
      // An unreadable record fails closed; never disrupt the person's Pi session.
    } finally {
      state.pumping = false;
    }
  }

  pi.on('session_start', (_event, ctx) => {
    stop();
    // Persistent sessions only. A print/subagent invocation is not an open terminal.
    if (
      !ctx.hasUI ||
      !ctx.sessionManager.getSessionFile() ||
      typeof pi.sendUserMessage !== 'function' ||
      typeof ctx.isIdle !== 'function'
    )
      return;
    const id = ctx.sessionManager.getSessionId();
    if (!/^[a-f0-9-]{36}$/i.test(id)) return;
    try {
      privateDir(runtime);
      const instance = randomBytes(16).toString('hex');
      const dir = join(runtime, instance);
      privateDir(dir);
      const path = join(dir, 'session.json');
      write(path, {
        version: 1,
        pid: process.pid,
        sessionId: id,
        instance,
        cwd: ctx.cwd,
        title: pi.getSessionName?.() || 'Pi session',
        titleEditing: typeof pi.setSessionName === 'function' && typeof pi.getSessionName === 'function',
        nativeContinuation: 1,
      });
      const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      // Relay proves this exact process still holds this file open, on both OSes.
      active = { id, dir, fd, ctx, finished: new Set(), pumping: false, timer: undefined };
      active.timer = setInterval(pump, 250);
      active.timer.unref?.();
      ctx.ui?.notify?.(
        'Agent Relay extension loaded. Enable Receives messages for this session in Agent Relay.',
        'info'
      );
    } catch {
      stop();
    }
  });
  pi.on('message_end', () => pump());
  pi.on('agent_end', () => pump());
  pi.on('session_shutdown', stop);
}
