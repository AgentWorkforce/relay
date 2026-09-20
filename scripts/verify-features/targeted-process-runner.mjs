import { runBoundedProcess } from '../pr-proof/process-runner.mjs';

const DEFAULT_TERMINATION_GRACE_MS = 2_000;

function appendWithinLimit(current, chunk, maximum) {
  const combined = Buffer.from(current + chunk, 'utf8');
  if (combined.length <= maximum) return { value: combined.toString('utf8'), exceeded: false };
  let end = maximum;
  while (end > 0 && (combined[end] & 0xc0) === 0x80) end -= 1;
  return { value: combined.subarray(0, end).toString('utf8'), exceeded: true };
}

/**
 * Run one targeted verification command under a POSIX process group. The
 * underlying runner sends SIGTERM at the deadline and SIGKILL after a bounded
 * grace period. Output overflow aborts the same process group and fails closed.
 */
export async function runTargetedProcess(
  argv,
  { cwd, env, timeoutMs, maxOutputBytes, terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS }
) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('argv must be non-empty');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error('maxOutputBytes must be a positive integer');
  }
  const controller = new AbortController();
  let stdout = '';
  let stderr = '';
  let outputLimitExceeded = false;
  const capture = (stream, chunk) => {
    const captured = appendWithinLimit(stream === 'stdout' ? stdout : stderr, chunk, maxOutputBytes);
    if (stream === 'stdout') stdout = captured.value;
    else stderr = captured.value;
    if (captured.exceeded && !outputLimitExceeded) {
      outputLimitExceeded = true;
      controller.abort();
    }
  };

  const result = await runBoundedProcess(argv[0], argv.slice(1), {
    cwd,
    env,
    timeoutMs,
    terminationGraceMs,
    maxCaptureBytes: maxOutputBytes,
    maxLiveOutputBytes: 0,
    echo: false,
    signal: controller.signal,
    onStdout: (chunk) => capture('stdout', chunk),
    onStderr: (chunk) => capture('stderr', chunk),
  });
  return { ...result, stdout, stderr, outputLimitExceeded };
}
