import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_CAPTURE_BYTES = 128 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const MAX_TIMER_MS = 2_147_483_647;

function appendBounded(current, chunk, maximum) {
  const bytes = Buffer.from(current + chunk, 'utf8');
  if (bytes.length <= maximum) return bytes.toString('utf8');

  let start = bytes.length - maximum;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

function takeUtf8Prefix(value, maximum) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maximum) return value;
  let end = maximum;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function boundedInteger(value, { fallback, minimum, label }) {
  const candidate = value ?? fallback;
  if (
    !Number.isFinite(candidate) ||
    !Number.isInteger(candidate) ||
    candidate < minimum ||
    candidate > MAX_TIMER_MS
  ) {
    throw new Error(`${label} must be an integer between ${minimum} and ${MAX_TIMER_MS}`);
  }
  return candidate;
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
  const maximum = boundedInteger(options.maxCaptureBytes, {
    fallback: DEFAULT_CAPTURE_BYTES,
    minimum: 1,
    label: 'maxCaptureBytes',
  });
  const maximumLiveOutput = boundedInteger(options.maxLiveOutputBytes, {
    fallback: maximum,
    minimum: 0,
    label: 'maxLiveOutputBytes',
  });
  const timeoutMs =
    options.timeoutMs === undefined || options.timeoutMs === null
      ? null
      : boundedInteger(options.timeoutMs, {
          fallback: null,
          minimum: 1,
          label: 'timeoutMs',
        });
  const terminationGraceMs = boundedInteger(options.terminationGraceMs, {
    fallback: DEFAULT_TERMINATION_GRACE_MS,
    minimum: 0,
    label: 'terminationGraceMs',
  });
  if (options.signal?.aborted) {
    return Promise.reject(new Error('Subprocess aborted before launch'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let hardKill = null;
    let forced = false;
    let liveOutputBytes = 0;
    let liveOutputTruncated = false;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const forceKill = () => {
      if (forced) return;
      forced = true;
      signalProcessTree(child, 'SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    };

    const beginTermination = (reason) => {
      if (timedOut || aborted || settled) return;
      timedOut = reason === 'timeout';
      aborted = reason === 'abort';
      signalProcessTree(child, 'SIGTERM');
      hardKill = setTimeout(forceKill, terminationGraceMs);
    };

    const timeout = timeoutMs ? setTimeout(() => beginTermination('timeout'), timeoutMs) : null;
    const abortHandler = () => beginTermination('abort');
    options.signal?.addEventListener('abort', abortHandler, { once: true });

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      options.signal?.removeEventListener('abort', abortHandler);
    };

    const writeLiveOutput = (stream, text) => {
      if (options.echo === false || !text) return;
      if (liveOutputBytes >= maximumLiveOutput) {
        if (!liveOutputTruncated) {
          liveOutputTruncated = true;
          stream.write('\n[... subprocess live output truncated ...]\n');
        }
        return;
      }

      const remaining = maximumLiveOutput - liveOutputBytes;
      const prefix = takeUtf8Prefix(text, remaining);
      const prefixBytes = Buffer.byteLength(prefix, 'utf8');
      if (prefix) stream.write(prefix);
      liveOutputBytes += prefixBytes;
      if (prefixBytes < Buffer.byteLength(text, 'utf8')) {
        liveOutputBytes = maximumLiveOutput;
        liveOutputTruncated = true;
        stream.write('\n[... subprocess live output truncated ...]\n');
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = stdoutDecoder.write(chunk);
      if (!text) return;
      stdout = appendBounded(stdout, text, maximum);
      options.onStdout?.(text);
      writeLiveOutput(process.stdout, text);
    });
    child.stderr.on('data', (chunk) => {
      const text = stderrDecoder.write(chunk);
      if (!text) return;
      stderr = appendBounded(stderr, text, maximum);
      options.onStderr?.(text);
      writeLiveOutput(process.stderr, text);
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
      // The process-group leader can exit after SIGTERM while a descendant
      // with detached stdio remains alive. Force-kill the group before
      // clearing the grace timer so that descendant cannot escape cleanup.
      if (timedOut || aborted) forceKill();
      cleanup();
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      stdout = appendBounded(stdout, stdoutTail, maximum);
      stderr = appendBounded(stderr, stderrTail, maximum);
      if (stdoutTail) {
        options.onStdout?.(stdoutTail);
        writeLiveOutput(process.stdout, stdoutTail);
      }
      if (stderrTail) {
        options.onStderr?.(stderrTail);
        writeLiveOutput(process.stderr, stderrTail);
      }
      resolve({ exitCode: code ?? 1, signal, stdout, stderr, timedOut, aborted });
    });
  });
}
