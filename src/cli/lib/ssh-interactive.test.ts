import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

import { formatShellInvocation, runInteractiveSession, wrapWithLaunchCheckpoint } from './ssh-interactive.js';

interface FakeStream extends EventEmitter {
  stderr: EventEmitter;
  write: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setWindow: ReturnType<typeof vi.fn>;
}

function createFakeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.stderr = new EventEmitter();
  stream.write = vi.fn();
  stream.close = vi.fn();
  stream.setWindow = vi.fn();
  return stream;
}

interface FakeClientOptions {
  onWrite?: (stream: FakeStream, payload: string) => void;
  emitEarlyData?: boolean;
}

interface FakeClient extends EventEmitter {
  stream: FakeStream;
  connect: ReturnType<typeof vi.fn>;
  shell: ReturnType<typeof vi.fn>;
  forwardOut: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function createFakeClient(options: FakeClientOptions = {}): FakeClient {
  const client = new EventEmitter() as FakeClient;
  const stream = createFakeStream();

  client.stream = stream;
  client.connect = vi.fn(() => {
    setImmediate(() => client.emit('ready'));
  });
  // biome-ignore lint/suspicious/noExplicitAny: ssh2 shell signature
  client.shell = vi.fn((_opts: any, cb: any) => {
    cb(null, stream);
    if (options.emitEarlyData) {
      stream.emit('data', Buffer.from('READY\n'));
    }
  });
  client.forwardOut = vi.fn((_src, _p1, _dst, _p2, cb) => {
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

function createFakeSSH2(options: FakeClientOptions = {}) {
  let client: FakeClient | undefined;

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
    getClient: () => {
      if (!client) throw new Error('Client not yet constructed');
      return client;
    },
  };
}

function createOptions(fakeSSH2: { Client: new () => FakeClient }, successPatterns: RegExp[]) {
  return {
    ssh: { host: 'test', port: 22, user: 'test', password: 'test' },
    remoteCommand: 'claude',
    successPatterns,
    errorPatterns: [],
    timeoutMs: 5000,
    io: { log: vi.fn(), error: vi.fn() },
    runtime: {
      loadSSH2: async () => fakeSSH2,
      // biome-ignore lint/suspicious/noExplicitAny: test runtime shim
      createServer: (): any => ({
        listen: (_port: number, _host: string, cb: () => void) => cb(),
        close: vi.fn(),
        on: vi.fn(),
      }),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    },
  };
}

async function withMockedStdio<T>(work: () => Promise<T>): Promise<T> {
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

describe('wrapWithLaunchCheckpoint', () => {
  it('prefixes the command with a visible stderr printf before it runs', () => {
    const wrapped = wrapWithLaunchCheckpoint('exec claude');
    expect(wrapped.startsWith("printf '")).toBe(true);
    expect(wrapped).toContain('launching provider CLI');
    expect(wrapped).toContain('>&2;');
    expect(wrapped.endsWith('exec claude')).toBe(true);
  });

  it('keeps the checkpoint on stderr so it does not pollute command output piping', () => {
    const wrapped = wrapWithLaunchCheckpoint('true');
    expect(wrapped).toMatch(/>&2\s*;/);
  });

  it('preserves env-var prefixes in the wrapped command', () => {
    const wrapped = wrapWithLaunchCheckpoint('PATH=/foo/bin exec claude');
    expect(wrapped.endsWith('PATH=/foo/bin exec claude')).toBe(true);
  });
});

describe('runInteractiveSession — handler-order and pattern gating', () => {
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
    // The launch-checkpoint wrap is applied before formatShellInvocation,
    // so the inner sh -c body starts with the visible printf breadcrumb.
    expect(payload).toContain('launching provider CLI');
  });

  it('matches success patterns against output produced after the command is written', async () => {
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

  it('reports a clear error when the remote closes without producing any output', async () => {
    // This is the diagnostic path for the "zero output received" hang: if
    // the remote CLI crashes or the sandbox image is missing the binary, we
    // surface a useful error instead of silent failure.
    const { fakeSSH2 } = createFakeSSH2({
      onWrite: (stream) => {
        queueMicrotask(() => stream.emit('close'));
      },
    });

    const opts = createOptions(fakeSSH2, []);
    const result = await withMockedStdio(async () => runInteractiveSession(opts));

    expect(result.authDetected).toBe(false);
    const errorCalls = (opts.io.error as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ');
    expect(errorCalls).toContain('No output received');
  });
});
