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

    // Transforms run before capture, live output, and callbacks. A transform
    // may retain a small streaming boundary and is called once more with
    // `final=true` after the decoder has been flushed.
    const transformOutput = (stream, text, final = false) => {
      if (typeof options.transformChunk !== 'function') return text;
      return options.transformChunk(text, stream, final) ?? '';
    };

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

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      forceKill();
      reject(error);
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

    const consumeOutput = (stream, text, final = false) => {
      const transformed = transformOutput(stream, text, final);
      if (!transformed) return;
      if (stream === 'stdout') {
        stdout = appendBounded(stdout, transformed, maximum);
        options.onStdout?.(transformed);
        writeLiveOutput(process.stdout, transformed);
      } else {
        stderr = appendBounded(stderr, transformed, maximum);
        options.onStderr?.(transformed);
        writeLiveOutput(process.stderr, transformed);
      }
    };

    child.stdout.on('data', (chunk) => {
      try {
        consumeOutput('stdout', stdoutDecoder.write(chunk));
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        consumeOutput('stderr', stderrDecoder.write(chunk));
      } catch (error) {
        fail(error);
      }
    });
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      // The process-group leader can exit after SIGTERM while a descendant
      // with detached stdio remains alive. Force-kill the group before
      // clearing the grace timer so that descendant cannot escape cleanup.
      if (timedOut || aborted) forceKill();
      cleanup();
      try {
        const stdoutTail = stdoutDecoder.end();
        const stderrTail = stderrDecoder.end();
        consumeOutput('stdout', stdoutTail);
        consumeOutput('stderr', stderrTail);
        consumeOutput('stdout', '', true);
        consumeOutput('stderr', '', true);
      } catch (error) {
        settled = true;
        reject(error);
        return;
      }
      settled = true;
      resolve({ exitCode: code ?? 1, signal, stdout, stderr, timedOut, aborted });
    });
  });
}
