import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_CAPTURE_BYTES = 128 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;

function appendBounded(current, chunk, maximum) {
  const next = current + chunk;
  return next.length <= maximum ? next : next.slice(next.length - maximum);
}

function signalProcessTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

/**
 * Run a subprocess with bounded output and a process-tree timeout. The child
 * owns a process group on POSIX so descendants that inherit stdout/stderr are
 * terminated with it. After the grace period, the parent-side pipes are also
 * closed so an escaped descendant cannot keep this promise pending forever.
 */
export function runBoundedProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const maximum = options.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let hardKill = null;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          signalProcessTree(child, 'SIGTERM');
          hardKill = setTimeout(() => {
            signalProcessTree(child, 'SIGKILL');
            child.stdout.destroy();
            child.stderr.destroy();
          }, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
          hardKill.unref();
        }, options.timeoutMs)
      : null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
    };

    child.stdout.on('data', (chunk) => {
      const text = stdoutDecoder.write(chunk);
      if (!text) return;
      stdout = appendBounded(stdout, text, maximum);
      if (options.echo !== false) process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = stderrDecoder.write(chunk);
      if (!text) return;
      stderr = appendBounded(stderr, text, maximum);
      if (options.echo !== false) process.stderr.write(text);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      stdout = appendBounded(stdout, stdoutTail, maximum);
      stderr = appendBounded(stderr, stderrTail, maximum);
      if (options.echo !== false && stdoutTail) process.stdout.write(stdoutTail);
      if (options.echo !== false && stderrTail) process.stderr.write(stderrTail);
      resolve({ exitCode: code ?? 1, signal, stdout, stderr, timedOut });
    });
  });
}
