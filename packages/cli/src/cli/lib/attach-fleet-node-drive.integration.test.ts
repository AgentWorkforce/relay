/**
 * End-to-end integration for `agent-relay node agent attach <name> --node
 * <node> --mode drive` across a terminal-transport reconnect.
 *
 * Unlike the unit suites, this wires the REAL pieces together: the real
 * `attachDrive` session (real `fetch`, real event WebSocket, real SDK PTY
 * input stream, real snapshot decoder) talking to the real
 * `startFleetNodeAttachProxy` loopback, which in turn talks to a stand-in
 * Relaycast terminal endpoint. Only stdin, stdout and signal registration are
 * faked, because those are the operator's terminal.
 *
 * It exists because relay#1829 lived exactly in the seam these suites each
 * mocked away: the adapter re-emitted the base64 `terminal.ready.screen` as a
 * `worker_stream` chunk, and `worker_stream` chunks are written to the
 * operator's terminal verbatim. Asserting on stdout is the only place that
 * defect is visible as what it actually is.
 */
import type { AddressInfo } from 'node:net';
import { Buffer } from 'node:buffer';

import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachDrive, fetchWorkerIdentity, type DriveStdin, type DriveTerminal } from './attach-drive.js';
import { startFleetNodeAttachProxy, type FleetNodeAttachProxy } from './attach-fleet-node.js';

const SESSION_ID = 'integration-session';
const AGENT = 'Alice';

class FakeStdin implements DriveStdin {
  isTTY = true;
  isRaw = false;
  private listener: ((chunk: Buffer) => void) | null = null;
  setRawMode = vi.fn((mode: boolean) => {
    this.isRaw = mode;
    return undefined;
  });
  resume = vi.fn(() => undefined);
  pause = vi.fn(() => undefined);

  on(event: 'data', listener: (chunk: Buffer) => void): unknown {
    if (event === 'data') this.listener = listener;
    return this;
  }
  off(event: 'data', listener: (chunk: Buffer) => void): unknown {
    if (event === 'data' && this.listener === listener) this.listener = null;
    return this;
  }
  removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown {
    return this.off(event, listener);
  }
  type(text: string): void {
    this.listener?.(Buffer.from(text, 'utf8'));
  }
}

const fakeTerminal: DriveTerminal = {
  getSize: () => ({ rows: 24, cols: 80 }),
  onResize: () => () => undefined,
};

/**
 * Stand-in for the node's Relaycast terminal endpoint. Answers the frames the
 * loopback needs to reach readiness, and records the `terminal.input` payloads
 * it receives so input replay can be asserted on the far side of the bridge.
 */
type FakeNode = {
  url: string;
  nextConnection: () => Promise<WsSocket>;
  /** Decoded bytes of every `terminal.input` frame, in arrival order. */
  inputBytes: string[];
  close: () => Promise<void>;
};

async function startFakeNode(): Promise<FakeNode> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  const pending: WsSocket[] = [];
  const waiters: Array<(socket: WsSocket) => void> = [];
  const inputBytes: string[] = [];
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame.type === 'terminal.input' && typeof frame.data_base64 === 'string') {
        inputBytes.push(Buffer.from(frame.data_base64, 'base64').toString('utf8'));
        socket.send(
          JSON.stringify({
            type: 'terminal.input_ack',
            session_id: SESSION_ID,
            bytes_written: Buffer.from(frame.data_base64, 'base64').byteLength,
          })
        );
      }
      if (frame.type === 'terminal.set_delivery_mode') {
        socket.send(
          JSON.stringify({
            type: 'terminal.delivery_mode',
            session_id: SESSION_ID,
            request_id: frame.request_id,
            mode: frame.mode,
            flushed: 0,
            matched: true,
            revision: '2',
          })
        );
      }
    });
    const waiter = waiters.shift();
    if (waiter) waiter(socket);
    else pending.push(socket);
  });
  return {
    url: `ws://127.0.0.1:${port}/terminal`,
    inputBytes,
    nextConnection: () =>
      new Promise<WsSocket>((resolve) => {
        const existing = pending.shift();
        if (existing) return resolve(existing);
        waiters.push(resolve);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of pending) socket.terminate();
        wss.close(() => resolve());
      }),
  };
}

function ticketFetch(remoteUrl: string): typeof globalThis.fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { session_id: SESSION_ID, terminal_url: remoteUrl, resume_token: 'resume' },
      }),
    }) as unknown as Response) as unknown as typeof globalThis.fetch;
}

function sendReady(socket: WsSocket, screenBase64: string): void {
  socket.send(
    JSON.stringify({
      type: 'terminal.ready',
      session_id: SESSION_ID,
      screen: screenBase64,
      rows: 24,
      cols: 80,
      offset: 0,
      delivery_mode: 'auto_inject',
    })
  );
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('node attach --mode drive across a terminal-transport reconnect', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()!().catch(() => undefined);
    }
  });

  // MUST FIRE: before the fix, `stdout` picked up the base64 text of the
  // post-reconnect screen — the reported flood. The decoded-screen assertion
  // additionally guards against "fixing" it by dropping the repaint entirely,
  // which would leave the operator staring at a stale pre-outage image.
  it('repaints with real screen bytes and never writes an encoded payload to stdout', async () => {
    const node = await startFakeNode();
    cleanup.push(node.close);

    const proxy: FleetNodeAttachProxy = await startFleetNodeAttachProxy({
      agent: AGENT,
      node: 'node-int',
      mode: 'drive',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: ticketFetch(node.url),
      reconnectDelay: { initialMs: 1, maxMs: 1 },
    });
    cleanup.push(proxy.close);

    const beforeScreen = '\u001b[2J\u001b[Hbefore outage';
    const afterScreen = '\u001b[2J\u001b[Hrestored after reconnect';
    const beforeB64 = Buffer.from(beforeScreen, 'utf8').toString('base64');
    const afterB64 = Buffer.from(afterScreen, 'utf8').toString('base64');

    const initial = await node.nextConnection();
    sendReady(initial, beforeB64);

    const stdout: string[] = [];
    const stdin = new FakeStdin();
    const logs: string[] = [];
    const sessionPromise = attachDrive(
      AGENT,
      { brokerUrl: proxy.brokerUrl, apiKey: proxy.apiKey, requestTimeoutMs: 15_000 },
      {
        stdin,
        terminal: fakeTerminal,
        writeChunk: (chunk) => stdout.push(chunk),
        disposeWriter: () => undefined,
        log: (...args) => logs.push(String(args[0])),
        error: (...args) => logs.push(String(args[0])),
        onSignal: () => () => undefined,
        statusRepaintCoalesceMs: 0,
        ownershipReassertMs: 0,
        inputReopenBaseDelayMs: 5,
        fleetHint: async () => null,
        createPredictiveEcho: () => null,
      }
    );

    // The initial paint comes from the HTTP snapshot, which the client
    // decodes. Its presence proves the session is live before the outage.
    await waitFor(() => stdout.join('').includes('before outage'), 'initial snapshot paint');
    expect(stdout.join('')).not.toContain(beforeB64);

    // Drop the node transport. The loopback reconnects underneath a session
    // that never learns the transport changed.
    initial.terminate();
    const replacement = await node.nextConnection();
    sendReady(replacement, afterB64);

    await waitFor(() => stdout.join('').includes('restored after reconnect'), 'post-reconnect repaint');

    const rendered = stdout.join('');
    // THE ASSERTION. A base64 screen payload reaching the terminal is the bug.
    expect(rendered).not.toContain(afterB64);
    expect(rendered).not.toContain(beforeB64);
    // Live output still flows on the replacement transport.
    replacement.send(
      JSON.stringify({ type: 'terminal.output', session_id: SESSION_ID, chunk: 'post-reconnect output' })
    );
    await waitFor(() => stdout.join('').includes('post-reconnect output'), 'live output after reconnect');

    stdin.type('\u0003'); // Ctrl+C detach
    expect(await sessionPromise).toBe(0);
  }, 30_000);

  // MUST FIRE: covers the other half of the reported session — the input
  // stream dying with the transport and replaying what was typed during the
  // outage — and pins that the replay reaches the node as real bytes.
  it('replays input typed during the outage to the node after the transport returns', async () => {
    const node = await startFakeNode();
    cleanup.push(node.close);

    const proxy: FleetNodeAttachProxy = await startFleetNodeAttachProxy({
      agent: AGENT,
      node: 'node-int-input',
      mode: 'drive',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: ticketFetch(node.url),
      reconnectDelay: { initialMs: 1, maxMs: 1 },
    });
    cleanup.push(proxy.close);

    const screenB64 = Buffer.from('\u001b[2J\u001b[Hready', 'utf8').toString('base64');
    const initial = await node.nextConnection();
    sendReady(initial, screenB64);

    const stdout: string[] = [];
    const stdin = new FakeStdin();
    const logs: string[] = [];
    let identityCalls = 0;
    let releaseIdentity = (): void => undefined;
    const identityGate = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    const sessionPromise = attachDrive(
      AGENT,
      { brokerUrl: proxy.brokerUrl, apiKey: proxy.apiKey, requestTimeoutMs: 15_000 },
      {
        stdin,
        terminal: fakeTerminal,
        writeChunk: (chunk) => stdout.push(chunk),
        disposeWriter: () => undefined,
        log: (...args) => logs.push(String(args[0])),
        error: (...args) => logs.push(String(args[0])),
        onSignal: () => () => undefined,
        statusRepaintCoalesceMs: 0,
        ownershipReassertMs: 0,
        inputReopenBaseDelayMs: 5,
        fleetHint: async () => null,
        createPredictiveEcho: () => null,
        // Hold the recovery-time identity check open so the outage window is
        // deterministic: without a barrier, reopen can complete between the
        // loss being logged and the test typing into the outage, and the
        // replay path under test is never exercised.
        getWorkerIdentity: async (connection, agentName) => {
          const identity = await fetchWorkerIdentity(connection, agentName, fetch);
          if (identityCalls++ > 0) await identityGate;
          return identity;
        },
      }
    );

    await waitFor(() => stdout.join('').includes('ready'), 'initial snapshot paint');

    stdin.type('before');
    await waitFor(() => node.inputBytes.join('').includes('before'), 'pre-outage keystroke');

    initial.terminate();
    // The first keystroke after the drop is DELIVERY-AMBIGUOUS: it may have
    // crossed the socket before the failure arrived, so `createInputStreamRecovery`
    // deliberately does not replay it (re-executing a command is worse than
    // losing a character). It is what trips recovery.
    stdin.type('x');
    await waitFor(
      () => logs.some((line) => line.includes('input stream lost')),
      'input-stream loss to be reported'
    );

    // Everything typed once recovery is in flight IS buffered, and must be
    // replayed in order after the same worker is verified.
    stdin.type('during');
    const replacement = await node.nextConnection();
    sendReady(replacement, screenB64);
    // Only now may the reopened stream prove it reached the same worker, so
    // 'during' is guaranteed to have been buffered rather than sent live.
    releaseIdentity();

    await waitFor(() => node.inputBytes.join('').includes('during'), 'buffered input replay');
    // Byte order across the outage is the contract, not just delivery.
    expect(node.inputBytes.join('').indexOf('before')).toBeLessThan(
      node.inputBytes.join('').indexOf('during')
    );
    // The operator is told what happened, with the replayed byte count.
    expect(logs.some((line) => line.includes('reconnected'))).toBe(true);
    expect(logs.some((line) => line.includes('Replayed 6 buffered bytes'))).toBe(true);
    // And recovery never leaks its own framing onto the screen.
    expect(stdout.join('')).not.toContain('pty_input');

    stdin.type('\u0003');
    expect(await sessionPromise).toBe(0);
  }, 30_000);
});
