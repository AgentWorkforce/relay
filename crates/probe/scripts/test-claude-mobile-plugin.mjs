import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from '../src/relay/claude_mobile_plugin/hooks/register.mjs';

async function fixture(options = {}) {
  const hooks = new Map();
  const calls = [];
  const submitted = [];
  const commands = [];
  const spawned = [];
  const timers = [];
  let tick;
  let id = 'session-a';
  const $ = {
    plugin: { root: '/test/plugin' },
    fs: { read: async () => JSON.stringify(options.bridge ?? { socket: '/private/relay.sock' }) },
    process: {
      run: async () => {
        throw new Error('The native bridge must not launch a subprocess');
      },
      // The doorbell helper; by default it cannot start (no curl), which
      // leaves the plugin asking on a timer.
      spawn: (request) => {
        spawned.push(request);
        if (options.doorbell) return options.doorbell(request);
        return (async function* () {
          throw new Error('curl: not found');
        })();
      },
    },
    http: {
      fetch: async (url, init) => {
        const route = new URL(url).pathname.split('/').at(-1);
        const body = JSON.parse(init.body);
        calls.push({ url, init, route, body });
        if (options.reject?.(route)) throw new Error('response lost');
        const data =
          route === 'poll'
            ? (options.action ?? { action: null })
            : route === 'permission'
              ? (options.permissionReplies?.shift() ?? options.permission ?? { handled: false })
              : { accepted: true };
        if (route === 'poll' && options.changeSession) id = 'session-b';
        return { ok: true, status: 200, text: JSON.stringify({ data }), headers: {} };
      },
    },
    session: {
      id: async () => id,
      version: async () => ({ version: '2.1.310', base: '2.1.310', builtAt: '2026-10-23T17:43:32Z' }),
    },
    clock: {
      now: async () => Date.now(),
      every: (_ms, fn) => {
        tick = fn;
        return {
          cancel() {
            if (tick === fn) tick = undefined;
          },
        };
      },
      after: (ms, fn) => {
        const timer = {
          ms,
          fn,
          cancelled: false,
          cancel() {
            this.cancelled = true;
          },
        };
        timers.push(timer);
        return timer;
      },
      sleep: () => new Promise(() => {}),
    },
    command: {
      run: async (value) => {
        commands.push(value);
      },
    },
    prompt: {
      submit: async (value) => {
        submitted.push(value);
        return options.drop ? { drop: 'Policy refused' } : { text: value.text };
      },
    },
  };
  register((name, fn) => {
    hooks.set(name, fn);
    return { catch() {} };
  });
  await hooks.get('session.start')($, {}, async () => ({}));
  await settle();
  return {
    $,
    hooks,
    calls,
    submitted,
    commands,
    spawned,
    timers,
    tick: () => tick(),
    ticking: () => tick !== undefined,
    switchSession: (value) => {
      id = value;
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise(setImmediate);
}

// A doorbell helper the test rings by hand.
function bell() {
  const pending = [];
  let wake;
  let ended = false;
  const stream = (async function* () {
    while (!ended) {
      if (!pending.length)
        await new Promise((resolve) => {
          wake = resolve;
        });
      while (pending.length) yield pending.shift();
    }
    return { code: 0, signal: null };
  })();
  const close = stream.return.bind(stream);
  stream.return = (value) => {
    ended = true;
    wake?.();
    return close(value);
  };
  return {
    stream,
    ring: async (text = '{"ring":"queued"}\n') => {
      pending.push({ stream: 'stdout', text });
      wake?.();
      await settle();
    },
    end: async () => {
      ended = true;
      wake?.();
      await settle();
    },
    get ended() {
      return ended;
    },
  };
}

const turn = {
  action: 'submit',
  delivery_id: 'd1',
  lease_id: 'lease-1',
  control_token: 'control-a',
  text: "Continue the user's task",
};

test('reading the queue without an authenticated action submits nothing', async () => {
  const f = await fixture();
  await f.tick();
  assert.deepEqual(f.submitted, []);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.calls.find((call) => call.route === 'poll').body, { version: '2.1.310' });
});

test('a lost acknowledgment never resubmits a native user turn', async () => {
  const f = await fixture({ action: turn, reject: (route) => route === 'ack' });
  await f.tick();
  await f.tick();
  assert.deepEqual(f.submitted, [{ text: turn.text, asUser: true }]);
});

test('an unsupported background action cannot replace the native session', async () => {
  const f = await fixture({ action: { ...turn, action: 'background' } });
  await f.tick();
  await f.tick();
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.submitted, []);
  assert.equal(
    f.calls.some((call) => call.route === 'ack'),
    false
  );
});

test('a failed poll never falls back to submitting peer-framed text', async () => {
  const f = await fixture({ action: turn, reject: () => true });
  await f.tick();
  assert.deepEqual(f.submitted, []);
  assert.deepEqual(f.commands, []);
});

test('a conversation switch while polling cannot deliver into the new thread', async () => {
  const f = await fixture({ action: turn, changeSession: true });
  await f.tick();
  assert.deepEqual(f.submitted, []);
});

test('native policy refusal is acknowledged as failed', async () => {
  const f = await fixture({ action: turn, drop: true });
  await f.tick();
  const acks = f.calls.filter((call) => call.route === 'ack');
  assert.deepEqual(
    acks.map((call) => call.body),
    [{ lease_id: turn.lease_id, outcome: 'failed' }]
  );
  // Claude stayed idle, so the next queued message is asked for at once.
  assert.equal(f.calls.at(-1).route, 'poll');
  assert.equal(f.submitted.length, 1);
});

test('answers use native HTTP on the private socket without a subprocess', async () => {
  const f = await fixture({ action: turn });
  await f.tick();
  const answer = 'literal $(touch /tmp/no) `echo no` "quotes"\nnext line';
  await f.hooks.get('turn.start')(f.$, { text: 'desktop reply', turnId: 't1' }, async () => ({}));
  await f.hooks.get('turn.complete')(f.$, { answer, turnId: 't1', reason: 'answer' }, async () => ({
    text: answer,
  }));
  await f.tick();
  const result = f.calls.find((call) => call.route === 'result');
  assert.equal(result.body.text, answer);
  assert.equal(result.init.socketPath, '/private/relay.sock');
  assert.equal(result.url, 'http://relay/claude/mobile-handoff/result');
  assert.equal(result.init.method, 'POST');
  assert.equal(result.url.includes(answer), false);
});

test('an answer is sent when its turn completes, without waiting for a tick', async () => {
  const f = await fixture({ action: turn });
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'mobile' }, async () => ({}));
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'Done', turnId: 'mobile', reason: 'answer' },
    async () => ({})
  );
  await new Promise(setImmediate);
  const attempts = f.calls.filter((call) => call.route === 'result');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].body.text, 'Done');
  await f.tick();
  assert.equal(f.calls.filter((call) => call.route === 'result').length, 1, 'a sent answer is not repeated');
});

test('a tick during an in-flight answer does not send it twice', { timeout: 2000 }, async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture({ action: turn });
  await f.tick();
  const fetch = f.$.http.fetch;
  f.$.http.fetch = async (url, init) => {
    if (url.endsWith('/result')) await gate;
    return fetch(url, init);
  };
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'mobile' }, async () => ({}));
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'Done', turnId: 'mobile', reason: 'answer' },
    async () => ({})
  );
  await f.tick();
  release();
  await new Promise(setImmediate);
  await f.tick();
  assert.equal(f.calls.filter((call) => call.route === 'result').length, 1);
});

test('an answer that finishes before its acknowledgment waits for it', { timeout: 2000 }, async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture({ action: turn });
  const fetch = f.$.http.fetch;
  f.$.http.fetch = async (url, init) => {
    if (url.endsWith('/ack')) await gate;
    return fetch(url, init);
  };
  const ticking = f.tick();
  while (!f.submitted.length) await new Promise(setImmediate);
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'mobile' }, async () => ({}));
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'No', turnId: 'mobile', reason: 'answer' },
    async () => ({})
  );
  await new Promise(setImmediate);
  assert.equal(
    f.calls.some((call) => call.route === 'result'),
    false,
    'the core would refuse it before the ack'
  );
  release();
  await ticking;
  const routes = f.calls.map((call) => call.route).filter((route) => route !== 'poll');
  assert.deepEqual(routes, ['ack', 'result']);
});

test(
  "a session switch during an in-flight answer keeps the new session's answer",
  { timeout: 2000 },
  async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture({ action: turn });
    await f.tick();
    const fetch = f.$.http.fetch;
    let gated = true;
    f.$.http.fetch = async (url, init) => {
      if (url.endsWith('/result') && gated) {
        gated = false;
        await gate;
      }
      return fetch(url, init);
    };
    await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'old' }, async () => ({}));
    await f.hooks.get('turn.complete')(
      f.$,
      { answer: 'Old', turnId: 'old', reason: 'answer' },
      async () => ({})
    );
    f.switchSession('session-b');
    await f.tick();
    await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'new' }, async () => ({}));
    await f.hooks.get('turn.complete')(
      f.$,
      { answer: 'New', turnId: 'new', reason: 'answer' },
      async () => ({})
    );
    release();
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.deepEqual(
      f.calls.filter((call) => call.route === 'result').map((call) => call.body.text),
      ['Old', 'New']
    );
  }
);

test("subagent answers are not forwarded as the session's answer", async () => {
  const f = await fixture();
  await f.tick();
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'private subtask', turnId: 't1', agentId: 'child', reason: 'answer' },
    async () => ({})
  );
  await f.tick();
  assert.equal(
    f.calls.some((call) => call.route === 'result'),
    false
  );
});

test('large Unicode answers remain deliverable and do not block later answers', async () => {
  const f = await fixture({ action: turn });
  await f.tick();
  const answer = '漢'.repeat(23999) + '😀'.repeat(30000);
  await f.hooks.get('turn.start')(f.$, { text: 'long reply', turnId: 'long' }, async () => ({}));
  await f.hooks.get('turn.complete')(f.$, { answer, turnId: 'long', reason: 'answer' }, async () => ({
    text: answer,
  }));
  await f.tick();
  const sent = f.calls.find((call) => call.route === 'result').body.text;
  assert.ok(Buffer.byteLength(sent) < 96 * 1024);
  assert.ok(sent.includes('Answer shortened for mobile'));
  assert.equal(sent.includes('\uD83D\n'), false);
  await f.hooks.get('turn.start')(f.$, { text: 'next reply', turnId: 'next' }, async () => ({}));
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'Next answer', turnId: 'next', reason: 'answer' },
    async () => ({})
  );
  await f.tick();
  assert.equal(f.calls.filter((call) => call.route === 'result').at(-1).body.text, 'Next answer');
});

test('relative socket paths are refused instead of using network transport', async () => {
  const f = await fixture({ action: turn, bridge: { socket: 'relay.sock' } });
  assert.deepEqual(f.spawned, [], 'no doorbell helper on a relative path');
  assert.equal(f.ticking(), false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.submitted, []);
});

test('ordinary desktop turns keep their native permission prompt', async () => {
  const f = await fixture();
  const original = {};
  const result = await f.hooks.get('classic.PermissionRequest')(
    f.$,
    { tool_name: 'Write', tool_input: {} },
    async () => original
  );
  assert.equal(result, original);
  assert.equal(
    f.calls.some((call) => call.route === 'permission'),
    false
  );
});

test('a prior permission-hook denial cannot be overridden remotely', async () => {
  const f = await fixture({ action: turn });
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 't-mobile' }, async () => ({}));
  const original = { decision: { behavior: 'deny' } };
  const result = await f.hooks.get('classic.PermissionRequest')(
    f.$,
    { tool_name: 'Write', tool_input: {} },
    async () => original
  );
  assert.equal(result, original);
  assert.equal(
    f.calls.some((call) => call.route === 'permission'),
    false
  );
});

test("a native mobile turn uses the core's one-action approval", async () => {
  const decision = { behavior: 'allow', updatedInput: { file_path: '/test/note' } };
  const f = await fixture({ action: turn, permission: { handled: true, decision } });
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 't-mobile' }, async () => ({}));
  const result = await f.hooks.get('classic.PermissionRequest')(
    f.$,
    { tool_name: 'Write', tool_input: decision.updatedInput },
    async () => ({})
  );
  assert.deepEqual(result.decision, decision);
  const request = f.calls.find((call) => call.route === 'permission');
  assert.deepEqual(request.body, {
    request_id: 't-mobile-1',
    tool_name: 'Write',
    tool_input: decision.updatedInput,
    control_token: turn.control_token,
  });
  assert.equal(request.init.socketPath, '/private/relay.sock');
});

test('unconfirmed remote approval never grants the tool access', async () => {
  const f = await fixture({ action: turn, reject: (route) => route === 'permission' });
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 't-mobile' }, async () => ({}));
  const result = await f.hooks.get('classic.PermissionRequest')(
    f.$,
    { tool_name: 'Bash', tool_input: {} },
    async () => ({})
  );
  assert.equal(result.decision.behavior, 'deny');
});

test("permission polling reuses one request and exact input until the owner's decision", async () => {
  const decision = { behavior: 'allow', updatedInput: { file_path: '/test/note' } };
  const f = await fixture({
    action: turn,
    permissionReplies: [
      { handled: true, pending: true },
      { handled: true, pending: true },
      { handled: true, decision },
    ],
  });
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'mobile' }, async () => ({}));
  const result = await f.hooks.get('classic.PermissionRequest')(
    f.$,
    { tool_name: 'Write', tool_input: decision.updatedInput },
    async () => ({})
  );
  const attempts = f.calls.filter((call) => call.route === 'permission');
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((call) => JSON.stringify(call.body) === JSON.stringify(attempts[0].body)));
  assert.deepEqual(result.decision, decision);
});

test('an indefinitely pending permission fails closed after bounded polls', async () => {
  const f = await fixture({ action: turn, permission: { handled: true, pending: true } });
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'mobile' }, async () => ({}));
  const result = await f.hooks.get('classic.PermissionRequest')(
    f.$,
    { tool_name: 'Write', tool_input: {} },
    async () => ({})
  );
  assert.equal(f.calls.filter((call) => call.route === 'permission').length, 24);
  assert.equal(result.decision.behavior, 'deny');
});

test("a subagent starting cannot clear its parent's mobile approval context", async () => {
  const f = await fixture({ action: turn });
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'parent' }, async () => ({}));
  await f.hooks.get('turn.start')(
    f.$,
    { text: 'Subtask', turnId: 'child-turn', agentId: 'child' },
    async () => ({})
  );
  await f.hooks.get('classic.PermissionRequest')(
    f.$,
    { tool_name: 'Write', tool_input: {} },
    async () => ({})
  );
  assert.equal(f.calls.find((call) => call.route === 'permission').body.control_token, turn.control_token);
});

test('answers keep their original control generation across authority changes', async () => {
  const options = { action: turn, reject: (route) => route === 'result' };
  const f = await fixture(options);
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'old-turn' }, async () => ({}));
  // A new authenticated owner/workspace can engage the same native process.
  options.action = { ...turn, lease_id: 'lease-2', control_token: 'control-b', text: "New owner's task" };
  await f.tick();
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: "Old owner's answer", turnId: 'old-turn', reason: 'answer' },
    async () => ({})
  );
  await f.tick();
  await f.tick();
  const attempts = f.calls.filter((call) => call.route === 'result');
  // One attempt as the turn completes, then one per tick.
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((call) => call.body.control_token === 'control-a'));
});

test('desktop turns before mobile engagement are not forwarded', async () => {
  const f = await fixture();
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { text: 'Local task', turnId: 'local' }, async () => ({}));
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'Local answer', turnId: 'local', reason: 'answer' },
    async () => ({})
  );
  await f.tick();
  assert.equal(
    f.calls.some((call) => call.route === 'result'),
    false
  );
});

test('a temporary owner-verification failure retains the exact answer for retry', async () => {
  let offline = true;
  const f = await fixture({ action: turn, reject: (route) => route === 'result' && offline });
  await f.tick();
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'mobile' }, async () => ({}));
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'Completed while offline', turnId: 'mobile', reason: 'answer' },
    async () => ({})
  );
  await f.tick();
  offline = false;
  await f.tick();
  await f.tick();
  const attempts = f.calls.filter((call) => call.route === 'result');
  // Completion and the first tick fail; the next tick delivers; none repeat.
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((call) => JSON.stringify(call.body) === JSON.stringify(attempts[0].body)));
  assert.equal(attempts[2].body.control_token, turn.control_token);
  assert.equal(f.submitted.length, 1);
});

test("a teammate's turn keeps owner approval but is neither forwarded nor engages the owner", async () => {
  const teammate = {
    ...turn,
    text: '[Agent Relay native input — from @teammate] Please review',
    forward_answer: false,
  };
  const f = await fixture({
    action: teammate,
    permission: { handled: true, decision: { behavior: 'deny', message: 'no' } },
  });
  await f.tick();
  assert.deepEqual(f.submitted, [{ text: teammate.text, asUser: true }]);
  await f.hooks.get('turn.start')(f.$, { text: teammate.text, turnId: 'teammate' }, async () => ({}));
  // Its tool approvals still go through the owner's one-action path.
  const result = await f.hooks.get('classic.PermissionRequest')(
    f.$,
    { tool_name: 'Write', tool_input: { path: 'a' } },
    async () => ({})
  );
  assert.equal(result.decision.behavior, 'deny');
  assert.equal(f.calls.find((call) => call.route === 'permission').body.control_token, turn.control_token);
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'Reviewed', turnId: 'teammate', reason: 'answer' },
    async () => ({})
  );
  await f.tick();
  assert.equal(
    f.calls.some((call) => call.route === 'result'),
    false,
    "a teammate's answer is not sent to the owner"
  );
  // Nor is the owner now subscribed to later desktop turns.
  await f.hooks.get('turn.start')(f.$, { text: 'Local task', turnId: 'local' }, async () => ({}));
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'Local answer', turnId: 'local', reason: 'answer' },
    async () => ({})
  );
  await f.tick();
  assert.equal(
    f.calls.some((call) => call.route === 'result'),
    false
  );
});

test('the doorbell helper only rings; the message comes over native HTTP', async () => {
  const door = bell();
  const f = await fixture({ action: turn, doorbell: () => door.stream });
  assert.deepEqual(f.spawned[0].argv, [
    'curl',
    '-sSfN',
    '--unix-socket',
    '/private/relay.sock',
    'http://relay/claude/mobile-handoff/watch',
  ]);
  assert.equal(f.ticking(), false, 'no timer while the doorbell is open');
  assert.equal(f.calls.length, 0, 'nothing is asked before a ring');
  await door.ring('{"ring":"ready"}\n');
  assert.deepEqual(f.submitted, [{ text: turn.text, asUser: true }]);
  const poll = f.calls.find((call) => call.route === 'poll');
  assert.equal(poll.init.socketPath, '/private/relay.sock');
  assert.equal(f.calls.at(-1).route, 'ack');
});

test('a ring whose text is not a ring line is ignored, and lines may arrive split', async () => {
  const door = bell();
  const f = await fixture({ doorbell: () => door.stream });
  await door.ring('garbage\n');
  assert.equal(f.calls.length, 0);
  await door.ring('{"ri');
  assert.equal(f.calls.length, 0);
  await door.ring('ng":"queued"}\n');
  assert.equal(f.calls.filter((call) => call.route === 'poll').length, 1);
});

test('a message queued while Claude works is collected when the turn completes', async () => {
  const door = bell();
  const options = { action: { action: null, waiting: true }, doorbell: () => door.stream };
  const f = await fixture(options);
  await door.ring();
  assert.deepEqual(f.submitted, []);
  options.action = turn;
  await f.hooks.get('turn.complete')(f.$, { answer: 'ok', turnId: 't9', reason: 'answer' }, async () => ({}));
  await settle();
  assert.deepEqual(f.submitted, [{ text: turn.text, asUser: true }]);
});

test('Claude reporting busy just after its turn is retried briefly, then left to the next ring', async () => {
  const door = bell();
  const f = await fixture({ action: { action: null, waiting: true }, doorbell: () => door.stream });
  await door.ring();
  await f.hooks.get('turn.complete')(f.$, { answer: 'ok', turnId: 't9', reason: 'answer' }, async () => ({}));
  await settle();
  for (let i = 0; i < 10; i++) {
    const timer = f.timers.find((timer) => !timer.cancelled && !timer.fired);
    if (!timer) break;
    timer.fired = true;
    timer.fn();
    await settle();
  }
  assert.equal(f.timers.filter((timer) => timer.fired).length, 6, 'bounded retries');
  assert.equal(f.ticking(), false);
});

test('an ordinary turn completing without a queued message asks nothing', async () => {
  const door = bell();
  const f = await fixture({ doorbell: () => door.stream });
  await f.hooks.get('turn.complete')(f.$, { answer: 'ok', turnId: 't1', reason: 'answer' }, async () => ({}));
  await settle();
  assert.equal(f.calls.length, 0);
});

test('a ring during a collection runs one more collection', { timeout: 2000 }, async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const door = bell();
  const f = await fixture({ doorbell: () => door.stream });
  const fetch = f.$.http.fetch;
  let first = true;
  f.$.http.fetch = async (url, init) => {
    if (first) {
      first = false;
      await gate;
    }
    return fetch(url, init);
  };
  await door.ring();
  await door.ring();
  await door.ring();
  release();
  await settle();
  assert.equal(f.calls.filter((call) => call.route === 'poll').length, 2);
});

test('a new session after /clear gets its own doorbell', async () => {
  const doors = [bell(), bell()];
  let opened = 0;
  const f = await fixture({ doorbell: () => doors[opened++].stream });
  f.switchSession('session-b');
  await f.hooks.get('session.end')(f.$, { reason: 'clear' }, async () => ({}));
  const reconnect = f.timers.find((timer) => timer.ms === 1000);
  reconnect.fn();
  await settle();
  assert.equal(doors[0].ended, true, 'the old helper is stopped');
  assert.equal(f.spawned.length, 2);
});

// Review: several messages queued in one busy turn are all collected.
test("a second message queued in the same busy turn is collected after the first's turn", async () => {
  const door = bell();
  const second = { ...turn, delivery_id: 'd2', lease_id: 'lease-2', text: 'And then this' };
  const options = { action: { action: null, waiting: true }, doorbell: () => door.stream };
  const f = await fixture(options);
  await door.ring();
  await door.ring();
  options.action = turn;
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'busy work done', turnId: 't0', reason: 'answer' },
    async () => ({})
  );
  await settle();
  assert.deepEqual(
    f.submitted.map((s) => s.text),
    [turn.text]
  );
  options.action = second;
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 't1' }, async () => ({}));
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'first done', turnId: 't1', reason: 'answer' },
    async () => ({})
  );
  await settle();
  assert.deepEqual(
    f.submitted.map((s) => s.text),
    [turn.text, second.text]
  );
  options.action = { action: null };
  await f.hooks.get('turn.start')(f.$, { text: second.text, turnId: 't2' }, async () => ({}));
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'second done', turnId: 't2', reason: 'answer' },
    async () => ({})
  );
  await settle();
  const polls = f.calls.filter((call) => call.route === 'poll').length;
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'local', turnId: 't3', reason: 'answer' },
    async () => ({})
  );
  await settle();
  assert.equal(
    f.calls.filter((call) => call.route === 'poll').length,
    polls,
    'an empty queue stops the asking'
  );
});

// Review: a ring whose poll fails is retried, without polling while healthy.
test('a failed poll after a ring is retried on a backoff', async () => {
  const door = bell();
  let down = true;
  const f = await fixture({
    action: turn,
    doorbell: () => door.stream,
    reject: (route) => route === 'poll' && down,
  });
  await door.ring();
  assert.deepEqual(f.submitted, []);
  const retry = f.timers.find((timer) => timer.ms === 1000 && !timer.cancelled);
  assert.ok(retry, 'a retry is scheduled');
  down = false;
  retry.fn();
  await settle();
  assert.deepEqual(f.submitted, [{ text: turn.text, asUser: true }]);
});

// Review: an answer that fails to send is retried while the doorbell is quiet.
test('an answer that failed to send is retried on a timer, with the doorbell open', async () => {
  const door = bell();
  let offline = true;
  const f = await fixture({
    action: turn,
    doorbell: () => door.stream,
    reject: (route) => route === 'result' && offline,
  });
  await door.ring();
  await f.hooks.get('turn.start')(f.$, { text: turn.text, turnId: 'm' }, async () => ({}));
  await f.hooks.get('turn.complete')(
    f.$,
    { answer: 'Done offline', turnId: 'm', reason: 'answer' },
    async () => ({})
  );
  await settle();
  const retry = f.timers.find((timer) => timer.ms === 1000 && !timer.cancelled && !timer.fired);
  assert.ok(retry, 'a retry is scheduled while the answer is unsent');
  offline = false;
  retry.fired = true;
  retry.fn();
  await settle();
  const sent = f.calls.filter((call) => call.route === 'result');
  assert.equal(sent.at(-1).body.text, 'Done offline');
  const timers = f.timers.length;
  await settle();
  assert.equal(f.timers.length, timers, 'nothing more is scheduled once it is sent');
});

// Review: a turn ending while a ring's poll runs still collects afterwards.
test(
  "a turn completing while a ring's poll is in flight collects once it returns",
  { timeout: 2000 },
  async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const door = bell();
    const options = { action: { action: null, waiting: true }, doorbell: () => door.stream };
    const f = await fixture(options);
    const fetch = f.$.http.fetch;
    let first = true;
    f.$.http.fetch = async (url, init) => {
      if (first) {
        first = false;
        await gate;
      }
      return fetch(url, init);
    };
    await door.ring();
    await f.hooks.get('turn.complete')(
      f.$,
      { answer: 'done', turnId: 't', reason: 'answer' },
      async () => ({})
    );
    release();
    await settle();
    options.action = turn;
    for (const timer of f.timers.filter((t) => !t.cancelled)) {
      timer.fn();
      await settle();
    }
    assert.deepEqual(f.submitted, [{ text: turn.text, asUser: true }]);
  }
);
