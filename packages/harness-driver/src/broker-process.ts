/**
 * Managed-broker child-process lifecycle helpers: waiting for the broker to
 * announce its API URL, draining stdio so the broker never blocks on a full
 * pipe, capturing recent output for diagnostics, and shutting the process down.
 *
 * Extracted from {@link HarnessDriverClient} so the client retains the
 * connection/API surface while the OS-process plumbing lives on its own.
 */
import type { ChildProcess } from 'node:child_process';

export interface BrokerExitInfo {
  /** Exit code, or null when the process was killed by signal. */
  code: number | null;
  /** Terminating signal, or null when the process exited normally. */
  signal: NodeJS.Signals | null;
  /** PID of the managed broker process that exited. */
  pid: number | undefined;
  /** Recent stderr lines captured from the managed broker process. */
  recentStderr: string[];
}

export interface BrokerStartupDebugContext {
  binaryPath: string;
  args: string[];
  cwd: string;
  stdoutLines: string[];
  stderrLines: string[];
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function waitForApiUrl(
  child: ChildProcess,
  timeoutMs: number,
  debug: BrokerStartupDebugContext
): Promise<string> {
  const { createInterface } = await import('node:readline');

  return new Promise<string>((resolve, reject) => {
    if (!child.stdout) {
      reject(new Error('Broker stdout not available'));
      return;
    }

    let resolved = false;
    const rl = createInterface({ input: child.stdout });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        rl.close();
        child.kill('SIGTERM');
        reject(
          new Error(
            formatBrokerStartupError(`Broker did not report API port within ${timeoutMs}ms`, child, debug)
          )
        );
      }
    }, timeoutMs);

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        rl.close();
        reject(
          new Error(
            formatBrokerStartupError(
              `Broker process exited with code ${code} before becoming ready`,
              child,
              debug
            )
          )
        );
      }
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        rl.close();
        reject(new Error(formatBrokerStartupError(`Failed to start broker: ${err.message}`, child, debug)));
      }
    });

    rl.on('line', (line) => {
      if (resolved) return;
      pushBufferedLine(debug.stdoutLines, line);

      const match = line.match(/API listening on (https?:\/\/[^\s]+)/);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        rl.close();
        resolve(match[1]);
      }
    });
  });
}

export function drainBrokerStdioAfterStartup(child: ChildProcess): void {
  // Drain both stdout AND stderr after startup so high-volume broker
  // diagnostics/events cannot fill either pipe and block the broker process.
  // Stderr also has a readline consumer above for line buffering/onStderr; this
  // raw drain is intentionally no-op and exists only to keep the stream flowing
  // if that consumer is changed or removed later.
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.on('data', () => {});
    stream.resume();
  }
}

export function pushBufferedLine(lines: string[], line: string): void {
  lines.push(line);
  if (lines.length > 40) {
    lines.splice(0, lines.length - 40);
  }
}

export function cloneBrokerExitInfo(info: BrokerExitInfo): BrokerExitInfo {
  return {
    ...info,
    recentStderr: [...info.recentStderr],
  };
}

export function formatBrokerStartupError(
  message: string,
  child: ChildProcess,
  debug: BrokerStartupDebugContext
): string {
  const details = [
    `pid=${child.pid ?? 'unknown'}`,
    `cwd=${debug.cwd}`,
    `command=${formatCommand(debug.binaryPath, debug.args)}`,
    `stdout_tail=${formatBufferedLines(debug.stdoutLines)}`,
    `stderr_tail=${formatBufferedLines(debug.stderrLines)}`,
  ];
  return `${message} (${details.join('; ')})`;
}

function formatBufferedLines(lines: string[]): string {
  if (lines.length === 0) {
    return '<empty>';
  }
  return lines
    .slice(-8)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' | ');
}

function formatCommand(binaryPath: string, args: string[]): string {
  const render = [binaryPath, ...args].map((value) => {
    if (/^[A-Za-z0-9_./:@=-]+$/u.test(value)) {
      return value;
    }
    return JSON.stringify(value);
  });
  return render.join(' ');
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    // A process that already exited via signal has exitCode === null but
    // signalCode !== null; check both so we don't wait the full timeout and
    // then issue a redundant SIGKILL.
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
