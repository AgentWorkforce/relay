import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const id = '12345678-1234-4234-8234-123456789abc';
const hash = text => createHash('sha256').update(text).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'relay-pi-test-'));
  const runtime = join(root, 'runtime');
  const source = fs.readFileSync(new URL('./agent-relay.mjs', import.meta.url), 'utf8')
    .replace('__RUNTIME__', JSON.stringify(runtime));
  const path = join(root, 'extension.mjs');
  fs.writeFileSync(path, source);
  const handlers = new Map();
  const branch = [];
  const sent = [];
  let idle = true;
  const ctx = { hasUI: true, cwd: root, ui: {}, isIdle: () => idle,
    sessionManager: { getSessionFile: () => join(root, 'session.jsonl'),
      getSessionId: () => id, getBranch: () => branch } };
  let title = 'Old title';
  const pi = { getSessionName: () => title, setSessionName: value => { title = value; }, on: (name, fn) => handlers.set(name, fn), sendUserMessage: (text, options) => {
    sent.push({ text, options }); idle = false;
  } };
  (await import(path)).default(pi);
  t.after(() => { handlers.get('session_shutdown')(); fs.rmSync(root, { recursive: true, force: true }); });
  handlers.get('session_start')({}, ctx);
  const dir = join(runtime, fs.readdirSync(runtime)[0]);
  const file = join(dir, `${hash('m-1')}.json`);
  function enqueue(messageId = 'm-1', sequence, version = 1, text = '[via Agent Relay · ref test]\nHello') {
    const path = join(dir, `${hash(messageId)}.json`);
    fs.writeFileSync(path, JSON.stringify({ version, sessionId: id, messageId, sequence,
      text, state: 'pending' }), { mode: 0o600 });
  }
  return { root, dir, file, ctx, branch, sent, handlers, enqueue, pi,
    setIdle: value => { idle = value; }, record: () => JSON.parse(fs.readFileSync(file)) };
}

test('busy sessions wait; history confirms delivery; final answers exclude tool progress', async t => {
  const f = await fixture(t);
  f.setIdle(false); f.enqueue();
  await sleep(300);
  assert.equal(f.sent.length, 0);
  assert.equal(f.record().state, 'pending');
  f.setIdle(true);
  await sleep(300);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].options.deliverAs, 'followUp');
  assert.equal(f.record().state, 'claimed');
  f.branch.push({ id: 'user-1', type: 'message', message: { role: 'user', content: f.sent[0].text } });
  f.handlers.get('message_end')();
  assert.equal(f.record().state, 'claimed', 'in-memory history must not acknowledge an unsaved message');
  fs.writeFileSync(join(f.root, 'session.jsonl'), f.branch.map(e => JSON.stringify(e)).join('\n') + '\n');
  f.handlers.get('message_end')();
  assert.equal(f.record().state, 'recorded');
  f.branch.push({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse',
    content: [{ type: 'text', text: 'Checking...' }] } });
  f.setIdle(true); f.handlers.get('agent_end')();
  assert.equal(f.record().answer, undefined);
  f.branch.push({ type: 'message', message: { role: 'assistant', stopReason: 'stop',
    content: [{ type: 'text', text: 'Done.' }] } });
  f.handlers.get('agent_end')();
  assert.equal(f.record().answer, 'Done.');
  await sleep(300);
  assert.equal(f.sent.length, 1);
});

test('an uncertain claim is never sent again, even while idle', async t => {
  const f = await fixture(t); f.enqueue();
  await sleep(300);
  assert.equal(f.sent.length, 1);
  f.setIdle(true);
  await sleep(550);
  assert.equal(f.record().state, 'claimed');
  assert.equal(f.sent.length, 1);
});

test('wrong-session records and symlinks never become prompts', async t => {
  const f = await fixture(t); f.enqueue();
  const record = f.record(); record.sessionId = 'another-session';
  fs.writeFileSync(f.file, JSON.stringify(record));
  await sleep(300);
  assert.equal(f.sent.length, 0);
  fs.renameSync(f.file, join(f.root, 'outside.json'));
  fs.symlinkSync(join(f.root, 'outside.json'), f.file);
  await sleep(300);
  assert.equal(f.sent.length, 0);
});

test('one corrupt record does not prevent a valid delivery', async t => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.dir, `${'0'.repeat(64)}.json`), 'broken', { mode: 0o600 });
  f.enqueue();
  await sleep(300);
  assert.equal(f.sent.length, 1);
  assert.equal(f.record().state, 'claimed');
});

test('reload closes the old runtime and publishes a new binding in the same session', async t => {
  const f = await fixture(t);
  f.enqueue();
  f.handlers.get('session_shutdown')();
  f.handlers.get('session_start')({ reason: 'reload' }, f.ctx);
  await sleep(300);
  assert.equal(f.sent.length, 0);
  assert.equal(fs.readdirSync(join(f.root, 'runtime')).length, 2);
});


test('several messages queued while busy run by persisted arrival sequence, not digest', async t => {
  const f = await fixture(t);
  f.setIdle(false);
  const arrivals = ['m-1', 'm-2', 'm-3'].sort((a, b) => hash(b).localeCompare(hash(a)));
  arrivals.forEach((messageId, index) => f.enqueue(messageId, index + 1));
  await sleep(300);
  assert.equal(f.sent.length, 0);
  for (const messageId of arrivals) {
    f.setIdle(true);
    f.handlers.get('agent_end')();
    assert.ok(f.sent.at(-1).text.includes(hash(messageId)), `expected ${messageId} next`);
  }
  assert.equal(f.sent.length, arrivals.length);
});


test('legacy queue records precede sequenced records and keep file-time order', async t => {
  const f = await fixture(t);
  f.setIdle(false);
  for (const [index, messageId] of ['m-1', 'm-2'].entries()) {
    f.enqueue(messageId);
    fs.utimesSync(join(f.dir, `${hash(messageId)}.json`), 1000 + index, 1000 + index);
  }
  f.enqueue('m-3', 1);
  for (const messageId of ['m-1', 'm-2', 'm-3']) {
    f.setIdle(true); f.handlers.get('agent_end')();
    assert.ok(f.sent.at(-1).text.includes(hash(messageId)), `expected ${messageId} next`);
  }
});

test('invalid sequence values cannot become prompts', async t => {
  const f = await fixture(t);
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    f.enqueue('m-1', sequence);
    f.setIdle(true); f.handlers.get('agent_end')();
  }
  assert.equal(f.sent.length, 0);
});


test('title commands use native metadata without sending a prompt, even while busy', async t => {
  const f = await fixture(t);
  f.setIdle(false);
  const requestId = 'a'.repeat(32);
  const path = join(f.dir, `title-${requestId}.json`);
  fs.writeFileSync(path, JSON.stringify({ version: 1, sessionId: id, requestId,
    title: 'A better title', state: 'pending', expiresAt: Date.now() + 4000 }), { mode: 0o600 });
  f.handlers.get('message_end')();
  assert.equal(f.pi.getSessionName(), 'A better title');
  assert.equal(JSON.parse(fs.readFileSync(path)).state, 'done');
  assert.equal(f.sent.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(join(f.dir, 'title-state.json'))).title, 'A better title');
});

test('expired, wrong-session and malformed title commands do not rename', async t => {
  const f = await fixture(t);
  for (const [i, patch] of [{ expiresAt: 1 }, { sessionId: 'other' }, { title: '\n' }].entries()) {
    const requestId = String(i).repeat(32);
    fs.writeFileSync(join(f.dir, `title-${requestId}.json`), JSON.stringify({ version: 1,
      sessionId: id, requestId, title: 'Changed', state: 'pending', expiresAt: Date.now() + 4000, ...patch }), { mode: 0o600 });
  }
  f.handlers.get('message_end')();
  assert.equal(f.pi.getSessionName(), 'Old title');
  assert.equal(f.sent.length, 0);
});


test('a null title command cannot block message delivery', async t => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.dir, `title-${'f'.repeat(32)}.json`), 'null', { mode: 0o600 });
  f.enqueue();
  f.handlers.get('message_end')();
  assert.equal(f.sent.length, 1);
  assert.equal(f.pi.getSessionName(), 'Old title');
});

test('native capability submits a user turn without peer attribution and retains exact answer correlation', async t => {
  const f = await fixture(t);
  assert.equal(JSON.parse(fs.readFileSync(join(f.dir, 'session.json'))).nativeContinuation, 1);
  const ownerText = 'Continue the work I started on desktop.';
  f.enqueue('m-1', 1, 2, ownerText);
  f.handlers.get('agent_end')();
  assert.deepEqual(f.sent, [{ text: `${ownerText}\n\n[Agent Relay delivery ${hash('m-1')}]`,
    options: { deliverAs: 'followUp' } }]);
  assert.ok(!f.sent[0].text.includes('[via Agent Relay'));
  const user = { id: 'native-user-1', type: 'message', message: { role: 'user', content: f.sent[0].text } };
  f.branch.push(user);
  fs.writeFileSync(join(f.root, 'session.jsonl'), JSON.stringify(user) + '\n');
  f.handlers.get('message_end')();
  assert.equal(f.record().state, 'recorded');
  f.branch.push({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: 'Owner answer' } });
  f.setIdle(true); f.handlers.get('agent_end')();
  assert.equal(f.record().answer, 'Owner answer');
  f.handlers.get('agent_end')();
  assert.equal(f.sent.length, 1, 'an observed native receipt is never submitted twice');
});

test('peer records keep their attribution; unknown native protocol versions stay unsubmitted', async t => {
  const f = await fixture(t);
  f.enqueue('unknown', 1, 3, 'Unsupported native record');
  f.handlers.get('agent_end')();
  assert.equal(f.sent.length, 0);
  f.enqueue('m-1', 2);
  f.handlers.get('agent_end')();
  assert.ok(f.sent[0].text.startsWith('[via Agent Relay · ref test]\nHello'));
});

test('native uncertain submission is not replayed or matched to another delivery, including reload', async t => {
  const f = await fixture(t);
  f.enqueue('m-1', 1, 2, 'Same text');
  f.handlers.get('agent_end')();
  assert.equal(f.record().state, 'claimed');
  f.setIdle(true);
  f.branch.push({ id: 'other', type: 'message', message: { role: 'user',
    content: `Same text\n\n[Agent Relay delivery ${hash('other')}]` } });
  fs.writeFileSync(join(f.root, 'session.jsonl'), f.branch.map(e => JSON.stringify(e)).join('\n') + '\n');
  f.handlers.get('agent_end')();
  assert.equal(f.record().state, 'claimed');
  assert.equal(f.sent.length, 1);
  f.handlers.get('session_start')({ reason: 'reload' }, f.ctx);
  f.handlers.get('agent_end')();
  assert.equal(f.sent.length, 1, 'new runtime never migrates an old uncertain claim');
  assert.equal(f.record().state, 'claimed');
});
