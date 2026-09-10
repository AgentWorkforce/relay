import { spawn } from 'node:child_process';

export function classifyProbeOutput(value, { spawnError = false } = {}) {
  if (spawnError) return 'spawn_error';
  const text = String(value).toLowerCase();
  if (text.includes('context deadline exceeded') || text.includes('timed out')) return 'deadline_exceeded';
  if (text.includes('initial bootstrap incomplete')) return 'bootstrap_incomplete';
  if (text.includes('mount sync cycle failed')) return 'cycle_failed';
  if (text.includes('mount sync cycle completed')) return 'cycle_completed';
  return text.trim() === '' ? 'no_output' : 'other_output';
}

export function runCapturedProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const limit = 8192;
    let output = '';
    let outputBytes = 0;
    let outputTruncated = false;
    let spawnError = false;
    let settled = false;
    const capture = (chunk) => {
      outputBytes += chunk.length;
      output = `${output}${chunk}`;
      if (output.length > limit) {
        output = output.slice(-limit);
        outputTruncated = true;
      }
    };
    const finish = (exitCode, signal = null) => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode,
        signal,
        diagnostic: classifyProbeOutput(output, { spawnError }),
        outputBytes,
        outputTruncated,
      });
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', () => {
      spawnError = true;
      setImmediate(() => finish(1));
    });
    // `close`, unlike `exit`, fires after stdout/stderr have drained.
    child.once('close', (code, signal) => finish(code ?? 1, signal));
  });
}
