import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

import { formatShellInvocation, runInteractiveSession } from './ssh-interactive.js';

function createFakeStream() {
  const stream: any = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = vi.fn();
  stream.close = vi.fn();
  stream.setWindow = vi.fn();
  return stream;
}

function createFakeClient(
  options: {
    emitEarlyData?: boolean;
    onWrite?: (stream: any, payload: string) => void;
  } = {}
) {
  const client: any = new EventEmitter();
  const stream = createFakeStream();

  client.stream = stream;
  client.connect = vi.fn(() => {
    setImmediate(() => client.emit('ready'));
  });
  client.shell = vi.fn((_opts: any, cb: any) => {
    cb(null, stream);
    if (options.emitEarlyData) {
      stream.emit('data', Buffer.from('READY\n'));
    }
  });
  client.forwardOut = vi.fn((_src: any, _p1: any, _dst: any, _p2: any, cb: any) => {
    cb(null, new EventEmitter());
  });
  client.end = vi.fn();

  if (options.onWrite) {
    stream.write.mockImplementation((payload: string) => {
      options.onWrite?.(stream, payload);
    });
  }

  return client;
}

function createFakeSSH2(
  options: {
    emitEarlyData?: boolean;
    onWrite?: (stream: any, payload: string) => void;
  } = {}
) {
  let client: any;

  const fakeSSH2 = {
    Client: class FakeClientWrap {
      constructor() {
        client = createFakeClient(options);
        return client;
      }
    },
  };

  return {
    fakeSSH2,
    getClient: () => client,
  };
}

function createOptions(fakeSSH2: { Client: new () => any }, successPatterns: RegExp[]) {
  return {
    ssh: { host: 'test', port: 22, user: 'test', password: 'test' },
    remoteCommand: 'claude',
    successPatterns,
    errorPatterns: [],
    timeoutMs: 5000,
    io: { log: vi.fn(), error: vi.fn() },
    runtime: {
      loadSSH2: async () => fakeSSH2,
      createServer: () => ({
        listen: (_port: any, _host: any, cb: any) => cb(),
        close: vi.fn(),
        on: vi.fn(),
      }),
      setTimeout: (fn: any, ms: any) => setTimeout(fn, ms),
    },
  };
}

async function withMockedStdio<T>(work: () => Promise<T>) {
  const setRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');

  if (!setRawModeDescriptor) {
    Object.defineProperty(process.stdin, 'setRawMode', {
      configurable: true,
      value: () => process.stdin,
    });
  }

  const setRawModeSpy = vi.spyOn(process.stdin, 'setRawMode').mockImplementation(() => process.stdin);
  const resumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
  const pauseSpy = vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);
  const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  try {
    return await work();
  } finally {
    stderrWriteSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
    pauseSpy.mockRestore();
    resumeSpy.mockRestore();
    setRawModeSpy.mockRestore();

    if (setRawModeDescriptor) {
      Object.defineProperty(process.stdin, 'setRawMode', setRawModeDescriptor);
    } else {
      delete (process.stdin as { setRawMode?: unknown }).setRawMode;
    }
  }
}

describe('formatShellInvocation', () => {
  it("wraps the command in `exec sh -c '…'`", () => {
    expect(formatShellInvocation('claude')).toBe("exec sh -c 'claude'\n");
  });

  it('keeps leading env-var prefixes intact so sh can parse them', () => {
    expect(formatShellInvocation('PATH=/foo/bin claude')).toBe("exec sh -c 'PATH=/foo/bin claude'\n");
  });

  it('escapes single quotes in the command body', () => {
    expect(formatShellInvocation("echo 'hi'")).toBe("exec sh -c 'echo '\\''hi'\\'''\n");
  });

  it('never includes shell teardown suffixes', () => {
    expect(formatShellInvocation('claude').includes('; exit $?')).toBe(false);
  });

  it('ends with a single trailing newline', () => {
    expect(formatShellInvocation('claude').endsWith('\n')).toBe(true);
    expect(formatShellInvocation('claude').split('\n').length).toBe(2);
  });
});

describe('runInteractiveSession - handler-order regression (H1)', () => {
  it("attaches stream.on('data') before the first stream.write", async () => {
    const listenerCountsAtWrite: number[] = [];
    const { fakeSSH2, getClient } = createFakeSSH2({
      onWrite: (stream) => {
        listenerCountsAtWrite.push(stream.listenerCount('data'));
        queueMicrotask(() => stream.emit('close'));
      },
    });

    await withMockedStdio(async () => {
      await runInteractiveSession(createOptions(fakeSSH2, []));
    });

    const stream = getClient().stream;
    expect(stream.write).toHaveBeenCalled();
    expect(listenerCountsAtWrite[0]).toBeGreaterThanOrEqual(1);
  });

  it("writes an `exec sh -c` payload without '; exit $?'", async () => {
    const { fakeSSH2, getClient } = createFakeSSH2({
      onWrite: (stream) => {
        queueMicrotask(() => stream.emit('close'));
      },
    });

    await withMockedStdio(async () => {
      await runInteractiveSession(createOptions(fakeSSH2, []));
    });

    const payload = String(getClient().stream.write.mock.calls[0][0]);
    expect(payload.startsWith("exec sh -c '")).toBe(true);
    expect(payload.includes('; exit $?')).toBe(false);
  });

  it('does not mark auth as successful when the command is never matched', async () => {
    // Reproduces the cloud-connect regression where the outer `authDetected`
    // result used to fall back to `exitCode === 0`, incorrectly treating a
    // clean shell exit (e.g. user Ctrl+D after a failed `exec` in zsh) as a
    // successful authentication.
    const { fakeSSH2 } = createFakeSSH2({
      onWrite: (stream) => {
        queueMicrotask(() => {
          stream.emit('exit', 0, undefined);
          stream.emit('close');
        });
      },
    });

    const result = await withMockedStdio(async () =>
      runInteractiveSession(createOptions(fakeSSH2, [/authenticated/i]))
    );

    expect(result.authDetected).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('matches success patterns only against output produced after the command is written', async () => {
    const { fakeSSH2 } = createFakeSSH2({
      onWrite: (stream) => {
        queueMicrotask(() => {
          stream.emit('data', Buffer.from('READY\n'));
          queueMicrotask(() => stream.emit('close'));
        });
      },
    });

    const result = await withMockedStdio(async () =>
      runInteractiveSession(createOptions(fakeSSH2, [/READY/]))
    );

    expect(result.authDetected).toBe(true);
  });
});
