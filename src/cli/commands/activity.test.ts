import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  formatActivityEvent,
  registerActivityCommands,
  runActivitySession,
  type ActivityDependencies,
  type ActivityWebSocket,
} from './activity.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

type WsListener = (...args: unknown[]) => void;

class FakeWebSocket implements ActivityWebSocket {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly listeners = new Map<string, WsListener[]>();
  closed = false;
  closeCode?: number;
  closeReason?: string;

  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const bucket = this.listeners.get(event) ?? [];
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
}

function createHarness(options?: { connectionFile?: unknown; env?: NodeJS.ProcessEnv; nowIso?: string }): {
  deps: ActivityDependencies;
  sockets: FakeWebSocket[];
  lines: string[];
  logs: unknown[][];
  errors: unknown[][];
  signals: Map<NodeJS.Signals, () => void | Promise<void>>;
} {
  const sockets: FakeWebSocket[] = [];
  const lines: string[] = [];
  const logs: unknown[][] = [];
  const errors: unknown[][] = [];
  const signals = new Map<NodeJS.Signals, () => void | Promise<void>>();

  const deps: ActivityDependencies = {
    readConnectionFile: vi.fn(() => options?.connectionFile ?? null),
    getDefaultStateDir: vi.fn(() => '/tmp/project/.agent-relay'),
    env: options?.env ?? {},
    createWebSocket: vi.fn((url: string, headers: Record<string, string>) => {
      const socket = new FakeWebSocket(url, headers);
      sockets.push(socket);
      return socket;
    }),
    writeLine: vi.fn((line: string) => {
      lines.push(line);
    }),
    log: vi.fn((...args: unknown[]) => {
      logs.push(args);
    }),
    error: vi.fn((...args: unknown[]) => {
      errors.push(args);
    }),
    onSignal: vi.fn((signal, handler) => {
      signals.set(signal, handler);
    }),
    nowIso: vi.fn(() => options?.nowIso ?? '2026-02-20T12:34:56.000Z'),
    exit: vi.fn((code: number) => {
      throw new ExitSignal(code);
    }) as unknown as ActivityDependencies['exit'],
  };

  return { deps, sockets, lines, logs, errors, signals };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

describe('formatActivityEvent', () => {
  it('formats inbound messages as received activity', () => {
    expect(
      formatActivityEvent(
        {
          kind: 'relay_inbound',
          from: 'Alice',
          target: 'Bob',
          body: 'hello\nthere',
          event_id: 'evt_1',
          seq: 4,
        },
        '2026-02-20T12:34:56.000Z'
      )
    ).toBe('12:34:56 RECEIVED   Alice -> Bob evt_1 "hello there" #4');
  });

  it('formats outbound relaycast publish activity', () => {
    expect(
      formatActivityEvent(
        {
          kind: 'relaycast_published',
          to: '#general',
          target_type: 'channel',
          event_id: 'evt_2',
        },
        '2026-02-20T12:34:56.000Z'
      )
    ).toBe('12:34:56 SENT       broker -> #general (channel) event evt_2');
  });

  it('sanitizes worker output previews and drops empty control chunks', () => {
    expect(
      formatActivityEvent(
        {
          kind: 'worker_stream',
          name: 'WorkerA',
          stream: 'stdout',
          chunk: '\x1b[31mresult\x1b[0m\r\n',
        },
        '2026-02-20T12:34:56.000Z'
      )
    ).toBe('12:34:56 OUTPUT     WorkerA stdout: "result"');

    expect(
      formatActivityEvent(
        {
          kind: 'worker_stream',
          name: 'WorkerA',
          stream: 'stdout',
          chunk: '\x1b[2J\x1b[H',
        },
        '2026-02-20T12:34:56.000Z'
      )
    ).toBeNull();
  });
});

describe('runActivitySession', () => {
  it('streams pretty broker events from the resolved connection', async () => {
    const { deps, sockets, lines, logs } = createHarness({
      connectionFile: { url: 'http://localhost:3889', api_key: 'secret' },
    });

    const sessionPromise = runActivitySession({ sinceSeq: '7' }, deps);
    await tick();

    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    expect(socket.url).toBe('ws://localhost:3889/ws?sinceSeq=7');
    expect(socket.headers['X-API-Key']).toBe('secret');

    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          kind: 'relay_inbound',
          from: 'Alice',
          target: 'Bob',
          body: 'ship it',
          event_id: 'evt_1',
          seq: 8,
        })
      )
    );
    socket.emit('message', Buffer.from('not-json'));
    socket.emit('close', 1000, Buffer.from(''));

    const code = await sessionPromise;
    expect(code).toBe(0);
    expect(logs[0]?.[0]).toContain('[activity] streaming broker activity');
    expect(lines).toEqual(['12:34:56 RECEIVED   Alice -> Bob evt_1 "ship it" #8']);
  });

  it('supports JSON Lines output and event filters', async () => {
    const { deps, sockets, lines } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });

    const sessionPromise = runActivitySession({ json: true, kind: 'delivery_queued', name: 'WorkerA' }, deps);
    await tick();
    const socket = sockets[0];

    socket.emit(
      'message',
      JSON.stringify({ kind: 'delivery_queued', name: 'WorkerB', event_id: 'evt_skip' })
    );
    socket.emit('message', JSON.stringify({ kind: 'delivery_ack', name: 'WorkerA', event_id: 'evt_skip' }));
    socket.emit(
      'message',
      JSON.stringify({ kind: 'delivery_queued', name: 'WorkerA', event_id: 'evt_keep' })
    );
    socket.emit('close', 1000, Buffer.from(''));

    await sessionPromise;
    expect(lines).toEqual([
      JSON.stringify({ kind: 'delivery_queued', name: 'WorkerA', event_id: 'evt_keep' }),
    ]);
  });

  it('can hide worker stream output', async () => {
    const { deps, sockets, lines } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });

    const sessionPromise = runActivitySession({ streams: false }, deps);
    await tick();
    const socket = sockets[0];

    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'WorkerA', stream: 'stdout', chunk: 'noise' })
    );
    socket.emit('message', JSON.stringify({ kind: 'agent_idle', name: 'WorkerA', idle_secs: 30 }));
    socket.emit('close', 1000, Buffer.from(''));

    await sessionPromise;
    expect(lines).toEqual(['12:34:56 IDLE       WorkerA idle 30s']);
  });

  it('returns 1 when no broker connection can be resolved', async () => {
    const { deps, errors } = createHarness();
    const code = await runActivitySession({}, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toMatch(/could not locate broker connection/);
  });

  it('returns 1 for an invalid since sequence', async () => {
    const { deps, errors } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });
    const code = await runActivitySession({ sinceSeq: 'abc' }, deps);
    expect(code).toBe(1);
    expect(errors[0]?.[0]).toBe('Invalid --since-seq value: abc');
  });

  it('exits cleanly on SIGINT', async () => {
    const { deps, sockets, signals } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });

    const sessionPromise = runActivitySession({}, deps);
    await tick();
    const socket = sockets[0];

    await signals.get('SIGINT')?.();

    const code = await sessionPromise;
    expect(code).toBe(0);
    expect(socket.closed).toBe(true);
  });
});

describe('registerActivityCommands', () => {
  it('registers the activity command and wires --no-streams', async () => {
    const { deps, sockets, lines } = createHarness({
      connectionFile: { url: 'http://localhost:3889' },
    });
    const program = new Command();
    registerActivityCommands(program, deps);

    expect(program.commands.map((command) => command.name())).toContain('activity');

    const commandPromise = runCommand(program, ['activity', '--no-streams']);
    await tick();
    const socket = sockets[0];
    socket.emit(
      'message',
      JSON.stringify({ kind: 'worker_stream', name: 'WorkerA', stream: 'stdout', chunk: 'hidden' })
    );
    socket.emit('message', JSON.stringify({ kind: 'agent_released', name: 'WorkerA' }));
    socket.emit('close', 1000, Buffer.from(''));

    await commandPromise;
    expect(lines).toEqual(['12:34:56 RELEASED   WorkerA']);
  });
});
