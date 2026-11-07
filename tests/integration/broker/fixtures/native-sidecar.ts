import { createInterface } from 'node:readline';

let sequence = 0;

function write(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function event(kind: string, payload: Record<string, unknown> = {}): void {
  const timestamp = new Date().toISOString();
  write({
    v: 2,
    type: 'agent_event',
    payload: {
      protocol_version: 1,
      sequence: ++sequence,
      timestamp,
      event: { kind, ...payload },
    },
  });
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (!line.trim()) continue;
  const frame = JSON.parse(line) as {
    type?: string;
    request_id?: string;
    payload?: Record<string, unknown>;
  };

  if (frame.type === 'init_worker') {
    write({
      v: 2,
      type: 'worker_ready',
      payload: { name: 'native-e2e', runtime: 'headless', sessionId: 'native-e2e-session' },
    });
    event('session.starting');
    event('activity.changed', {
      activity: 'starting',
      previousActivity: 'idle',
      reason: 'fixture_start',
    });
    event('session.started');
    event('warning', {
      message: JSON.stringify({
        relayAgentName: process.env.RELAY_AGENT_NAME ?? null,
        relayAgentTokenPresent: Boolean(process.env.RELAY_AGENT_TOKEN),
        relayAgentType: process.env.RELAY_AGENT_TYPE ?? null,
        relayStrictAgentName: process.env.RELAY_STRICT_AGENT_NAME ?? null,
      }),
    });
    event('activity.changed', {
      activity: 'idle',
      previousActivity: 'starting',
      reason: 'fixture_ready',
    });
    continue;
  }

  if (frame.type === 'deliver_relay') {
    write({
      v: 2,
      type: 'delivery_ack',
      payload: {
        delivery_id: frame.payload?.delivery_id,
        event_id: frame.payload?.event_id,
      },
    });
    continue;
  }

  if (frame.type === 'native_harness_command') {
    const payload = frame.payload ?? {};
    write({
      v: 2,
      type: 'native_harness_command_response',
      request_id: frame.request_id,
      payload: {
        protocol_version: 1,
        request_id: frame.request_id,
        idempotency_key: payload.idempotency_key,
        accepted: true,
        active_turn: false,
      },
    });
    event('turn.started', { turnId: 'fixture-turn' });
    event('activity.changed', {
      activity: 'thinking',
      previousActivity: 'idle',
      reason: 'turn_started',
    });
    event('text.started', { messageId: 'fixture-message' });
    event('text.delta', { messageId: 'fixture-message', delta: `echo:${String(payload.text ?? '')}` });
    event('text.finished', { messageId: 'fixture-message' });
    event('turn.finished', { turnId: 'fixture-turn' });
    event('activity.changed', {
      activity: 'idle',
      previousActivity: 'thinking',
      reason: 'turn_finished',
    });
    continue;
  }

  if (frame.type === 'shutdown_worker') {
    event('session.released');
    write({ v: 2, type: 'worker_exited', payload: { code: 0 } });
    break;
  }

  if (frame.type === 'ping') {
    write({ v: 2, type: 'pong', payload: frame.payload });
  }
}
