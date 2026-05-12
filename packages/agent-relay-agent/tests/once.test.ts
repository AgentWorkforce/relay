import assert from 'node:assert/strict';
import test from 'node:test';

import { createContextFactory } from '../src/context.js';

test('ctx.once coalesces concurrent work for the same key', async () => {
  const { base } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    trackSchedule() {},
  });

  let calls = 0;
  const shared = { ok: true };

  const [first, second, third] = await Promise.all([
    base.once('ticket:123', async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return shared;
    }),
    base.once('ticket:123', async () => {
      calls += 1;
      return { ok: false };
    }),
    base.once('ticket:123', async () => {
      calls += 1;
      return { ok: false };
    }),
  ]);

  assert.equal(calls, 1);
  assert.strictEqual(first, shared);
  assert.strictEqual(second, shared);
  assert.strictEqual(third, shared);
});

test('ctx.once evicts a failed key so the caller can retry', async () => {
  const { base } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    trackSchedule() {},
  });

  let calls = 0;

  await assert.rejects(
    base.once('ticket:retry', async () => {
      calls += 1;
      throw new Error('first failure');
    }),
    /first failure/
  );

  const result = await base.once('ticket:retry', async () => {
    calls += 1;
    return 'recovered';
  });

  assert.equal(calls, 2);
  assert.equal(result, 'recovered');
});

test('schedule helpers proxy to relaycron and track registered schedule ids', async () => {
  const registered: Array<unknown> = [];
  const tracked: string[] = [];
  const cancelled: string[] = [];
  let nextId = 0;
  const relaycron = {
    available: true,
    register: async (definition: unknown) => {
      registered.push(definition);
      nextId += 1;
      return { id: `sched-${nextId}` };
    },
    cancel: async (id: string) => {
      cancelled.push(id);
    },
  };
  const { base, withSignal } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    getRelaycronClient: () => relaycron,
    trackSchedule(id) {
      tracked.push(id);
    },
  });

  const overlay = withSignal(AbortSignal.abort());
  assert.equal(base.raw.relaycron.available, true);
  assert.equal(overlay.signal.aborted, true);
  assert.equal(base.signal.aborted, false);

  const oneShot = await base.schedule.at('2026-05-11T12:00:00.000Z', { ticket: 1 });
  const recurring = await base.schedule.every('*/5 * * * *', { ticket: 2 }, { tz: 'America/New_York' });
  await base.schedule.cancel('sched-2');

  assert.deepEqual(registered, [
    { at: '2026-05-11T12:00:00.000Z', payload: { ticket: 1 } },
    { cron: '*/5 * * * *', payload: { ticket: 2 }, tz: 'America/New_York' },
  ]);
  assert.deepEqual(tracked, ['sched-1', 'sched-2']);
  assert.deepEqual(cancelled, ['sched-2']);
  assert.deepEqual(oneShot, { id: 'sched-1' });
  assert.deepEqual(recurring, { id: 'sched-2' });
});

test('schedule helpers fail cleanly before the relaycron control plane is ready', async () => {
  const { base } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    trackSchedule() {},
  });

  assert.equal(base.raw.relaycron.available, false);
  await assert.rejects(
    base.schedule.at('2026-05-11T12:00:00.000Z'),
    /relaycron control plane is not ready yet/
  );
  await assert.rejects(base.schedule.cancel('sched-missing'), /relaycron control plane is not ready yet/);
});

test('file helpers proxy to relayfile when the control plane is ready', async () => {
  const calls: string[] = [];
  const relayfile = {
    available: true,
    read: async (path: string) => {
      calls.push(`read:${path}`);
      return { path, body: { ok: true }, revision: 'rev-1' };
    },
    write: async (path: string, body: unknown) => {
      calls.push(`write:${path}:${JSON.stringify(body)}`);
    },
    delete: async (path: string) => {
      calls.push(`delete:${path}`);
    },
    list: async (glob: string) => {
      calls.push(`list:${glob}`);
      return [{ path: '/tickets/123.json', revision: 'rev-1' }];
    },
  };
  const { base } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    getRelayfileClient: () => relayfile,
    trackSchedule() {},
  });

  assert.equal(base.raw.relayfile.available, true);
  assert.deepEqual(await base.files.read('/tickets/123.json'), {
    path: '/tickets/123.json',
    body: { ok: true },
    revision: 'rev-1',
  });
  await base.files.write('/tickets/123.json', { ok: false });
  await base.files.delete('/tickets/123.json');
  assert.deepEqual(await base.files.list('/tickets/*.json'), [
    { path: '/tickets/123.json', revision: 'rev-1' },
  ]);
  assert.deepEqual(calls, [
    'read:/tickets/123.json',
    'write:/tickets/123.json:{"ok":false}',
    'delete:/tickets/123.json',
    'list:/tickets/*.json',
  ]);
});

test('file helpers fail cleanly before the relayfile control plane is ready', async () => {
  const { base } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    trackSchedule() {},
  });

  await assert.rejects(base.files.read('/tickets/123.json'), (error: unknown) => {
    assert.equal(
      error instanceof Error ? error.message : String(error),
      'relayfile control plane is not ready yet'
    );
    return true;
  });
  await assert.rejects(base.files.list('/tickets/*.json'), /relayfile control plane is not ready yet/);
});

test('message helpers proxy to relaycast when the control plane is ready', async () => {
  const calls: string[] = [];
  const relayfile = {
    available: true,
    read: async () => null,
    write: async (path: string, body: unknown) => {
      calls.push(`audit:${path}:${JSON.stringify(body)}`);
    },
    delete: async () => {},
    list: async () => [],
  };
  const relaycast = {
    available: true,
    post: async (channel: string, text: string) => {
      calls.push(`post:${channel}:${text}`);
      return { id: 'msg-1' };
    },
    reply: async (threadId: string, text: string) => {
      calls.push(`reply:${threadId}:${text}`);
      return { id: 'msg-2' };
    },
    dm: async (agentOrUser: string, text: string) => {
      calls.push(`dm:${agentOrUser}:${text}`);
      return { id: 'msg-3' };
    },
  };
  const { base } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    getRelayfileClient: () => relayfile,
    getRelaycastClient: () => relaycast,
    trackSchedule() {},
  });

  assert.deepEqual(await base.messages.post('#support', 'hello'), { id: 'msg-1' });
  assert.deepEqual(await base.messages.reply('thread-1', 'ack'), { id: 'msg-2' });
  assert.deepEqual(await base.messages.dm('teammate', 'ping'), { id: 'msg-3' });
  assert.equal(calls.filter((entry) => entry.startsWith('audit:')).length, 0);
  assert.ok(calls.includes('post:#support:hello'));
  assert.ok(calls.includes('reply:thread-1:ack'));
  assert.ok(calls.includes('dm:teammate:ping'));
});

test('message helpers fail cleanly before the relaycast control plane is ready', async () => {
  const { base } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    trackSchedule() {},
  });

  await assert.rejects(base.messages.post('#support', 'hello'), (error: unknown) => {
    assert.equal(
      error instanceof Error ? error.message : String(error),
      'relaycast control plane is not ready yet'
    );
    return true;
  });
});

test('policy suggest mode returns suggestions without executing side effects', async () => {
  const calls: string[] = [];
  const relayfile = {
    available: true,
    read: async () => null,
    write: async (path: string, body: unknown) => {
      calls.push(`write:${path}:${JSON.stringify(body)}`);
    },
    delete: async (path: string) => {
      calls.push(`delete:${path}`);
    },
    list: async () => [],
  };
  const relaycast = {
    available: true,
    post: async () => {
      calls.push('post');
      return { id: 'msg-1' };
    },
    reply: async () => {
      calls.push('reply');
      return { id: 'msg-2' };
    },
    dm: async () => {
      calls.push('dm');
      return { id: 'msg-3' };
    },
  };
  const relaycron = {
    available: true,
    register: async () => {
      calls.push('schedule');
      return { id: 'sched-1' };
    },
    cancel: async () => {
      calls.push('schedule-cancel');
    },
  };
  const { base } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    getRelayfileClient: () => relayfile,
    getRelaycastClient: () => relaycast,
    getRelaycronClient: () => relaycron,
    policy: {
      mode: 'suggest',
    },
    trackSchedule() {},
  });

  const fileSuggestion = await base.files.write('/tickets/123.json', { ok: true });
  const messageSuggestion = await base.messages.post('#support', 'hello');
  const scheduleSuggestion = await base.schedule.at('2026-05-12T00:00:00.000Z', { kind: 'follow-up' });

  assert.equal(fileSuggestion?.decision, 'suggested');
  assert.equal(messageSuggestion?.decision, 'suggested');
  assert.equal(scheduleSuggestion?.decision, 'suggested');
  assert.equal(
    calls.some((entry) => entry === 'post'),
    false
  );
  assert.equal(
    calls.some((entry) => entry === 'schedule'),
    false
  );
  assert.equal(
    calls.some((entry) => entry.startsWith('delete:')),
    false
  );
  assert.equal(calls.filter((entry) => entry.startsWith('write:/_policy-log/support/')).length, 3);
});

test('policy approval mode and per-action overrides compose with file and message helpers', async () => {
  const calls: string[] = [];
  const approvals: string[] = [];
  const relayfile = {
    available: true,
    read: async () => null,
    write: async (path: string, body: unknown) => {
      calls.push(`write:${path}:${JSON.stringify(body)}`);
    },
    delete: async (path: string) => {
      calls.push(`delete:${path}`);
    },
    list: async () => [],
  };
  const relaycast = {
    available: true,
    post: async (channel: string, text: string) => {
      calls.push(`post:${channel}:${text}`);
      return { id: 'msg-1' };
    },
    reply: async () => ({ id: 'msg-2' }),
    dm: async () => ({ id: 'msg-3' }),
  };
  const relaycron = {
    available: true,
    register: async () => {
      calls.push('schedule');
      return { id: 'sched-1' };
    },
    cancel: async () => {
      calls.push('schedule-cancel');
    },
  };
  const { base } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    getRelayfileClient: () => relayfile,
    getRelaycastClient: () => relaycast,
    getRelaycronClient: () => relaycron,
    awaitApproval: async (approvalId) => {
      approvals.push(approvalId);
      return {
        verdict: approvals.length === 1 ? 'approved' : 'rejected',
        reason: 'human review',
      };
    },
    policy: {
      mode: 'auto',
      approvals: ['external-message', 'delete', 'schedule'],
    },
    trackSchedule() {},
  });

  await base.files.write('/tickets/123.json', { ok: true });
  await base.messages.post('#support', 'hello');
  await assert.rejects(base.schedule.at('2026-05-12T00:00:00.000Z'), /human review/);
  await assert.rejects(base.files.delete('/tickets/123.json'), /human review/);

  assert.ok(calls.some((entry) => entry.startsWith('write:/tickets/123.json:')));
  assert.ok(calls.some((entry) => entry.startsWith('write:/pending-approvals/')));
  assert.ok(calls.some((entry) => entry.startsWith('delete:/pending-approvals/')));
  assert.ok(calls.some((entry) => entry.startsWith('write:/_policy-log/support/')));
  assert.ok(calls.includes('post:#support:hello'));
  assert.equal(calls.includes('schedule'), false);
  assert.equal(calls.includes('delete:/tickets/123.json'), false);
  assert.equal(approvals.length, 3);
});

test('policy approvals override suggest mode on a per-action basis', async () => {
  const calls: string[] = [];
  const relayfile = {
    available: true,
    read: async () => null,
    write: async (path: string, body: unknown) => {
      calls.push(`write:${path}:${JSON.stringify(body)}`);
    },
    delete: async () => {},
    list: async () => [],
  };
  const relaycast = {
    available: true,
    post: async () => {
      calls.push('post');
      return { id: 'msg-1' };
    },
    reply: async () => ({ id: 'msg-2' }),
    dm: async () => ({ id: 'msg-3' }),
  };
  const { base } = createContextFactory({
    workspace: 'support',
    agentId: 'support-agent',
    getRelayfileClient: () => relayfile,
    getRelaycastClient: () => relaycast,
    awaitApproval: async () => ({ verdict: 'approved' }),
    policy: {
      mode: 'suggest',
      approvals: ['external-message'],
    },
    trackSchedule() {},
  });

  const fileResult = await base.files.write('/tickets/123.json', { ok: true });
  const messageResult = await base.messages.post('#support', 'hello');

  assert.equal('decision' in (fileResult ?? {}), true);
  assert.deepEqual(messageResult, { id: 'msg-1' });
  assert.ok(calls.some((entry) => entry.startsWith('write:/tickets/123.json:')) === false);
  assert.ok(calls.some((entry) => entry.startsWith('write:/pending-approvals/')));
  assert.ok(calls.includes('post'));
});

test('logger emits structured JSON with workspace and agent metadata', () => {
  const originalDebug = console.debug;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  const calls: Array<{ level: string; payload: string }> = [];

  console.debug = ((payload: string) => {
    calls.push({ level: 'debug', payload });
  }) as typeof console.debug;
  console.info = ((payload: string) => {
    calls.push({ level: 'info', payload });
  }) as typeof console.info;
  console.warn = ((payload: string) => {
    calls.push({ level: 'warn', payload });
  }) as typeof console.warn;
  console.error = ((payload: string) => {
    calls.push({ level: 'error', payload });
  }) as typeof console.error;

  try {
    const { base } = createContextFactory({
      workspace: 'support',
      agentId: 'support-agent',
      trackSchedule() {},
    });

    base.logger.debug('debug message', { traceId: 'trace-1' });
    base.logger.info('info message');
    base.logger.warn('warn message');
    base.logger.error('error message', { eventId: 'evt-1' });
  } finally {
    console.debug = originalDebug;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.equal(calls.length, 4);
  for (const { level, payload } of calls) {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    assert.equal(parsed.level, level);
    assert.equal(parsed.workspace, 'support');
    assert.equal(parsed.agentId, 'support-agent');
    assert.equal(typeof parsed.ts, 'string');
  }
  assert.equal(JSON.parse(calls[0]!.payload).traceId, 'trace-1');
  assert.equal(JSON.parse(calls[3]!.payload).eventId, 'evt-1');
});
