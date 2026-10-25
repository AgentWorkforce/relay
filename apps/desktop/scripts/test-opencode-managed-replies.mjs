import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const template = fs.readFileSync(path.join(root, 'probe/src/relay/opencode/agent-relay.js'), 'utf8');
const rust = fs.readFileSync(path.join(root, 'probe/src/relay/opencode.rs'), 'utf8');
const version = Number(rust.match(/PLUGIN_VERSION: u32 = (\d+)/)[1]);

test('managed V1 and V2 keep exact shell tags without a duplicate delivery socket', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-opencode-tags-'));
  const runtime = path.join(folder, 'runtime');
  const modulePath = path.join(folder, 'plugin.mjs');
  fs.writeFileSync(modulePath, template.replaceAll('__RUNTIME__', JSON.stringify(runtime)).replaceAll('__VERSION__', String(version)));
  const plugin = (await import(pathToFileURL(modulePath).href)).default;
  const previous = process.env.AGENT_RELAY_MANAGED_SESSION_MARKER;
  const marker = 'synthetic-test-marker';
  process.env.AGENT_RELAY_MANAGED_SESSION_MARKER = marker;
  try {
    const v1 = await plugin.server({});
    const output = {env: {}};
    await v1['shell.env']({sessionID: 'ses_exact'}, output);
    assert.equal(output.env.AGENT_RELAY_OPENCODE_SESSION, 'ses_exact');
    const recordPath = path.join(runtime, `${process.pid}.managed.json`);
    const record = JSON.parse(fs.readFileSync(recordPath));
    assert.equal(record.pid, process.pid);
    assert.equal(record.version, version);
    assert.equal(record.marker_sha256, createHash('sha256').update(marker).digest('hex'));
    assert.equal(fs.readdirSync(runtime).some(name => name.endsWith('.sock')), false);
    await v1.dispose();
    assert.equal(fs.existsSync(recordPath), false);
    let hook;
    let disposed = false;
    const dispose = await plugin.setup({shell: {hook: async (name, fn) => {
      assert.equal(name, 'create.before'); hook = fn;
      return {dispose: async () => {disposed = true;}};
    }}});
    const event = {env: {OPENCODE_SESSION_ID: 'ses_second'}};
    hook(event);
    assert.equal(event.env.AGENT_RELAY_OPENCODE_SESSION, 'ses_second');
    assert.equal(fs.existsSync(recordPath), true);
    assert.equal(fs.readdirSync(runtime).some(name => name.endsWith('.sock')), false);
    await dispose();
    assert.equal(disposed, true);
    assert.equal(fs.existsSync(recordPath), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_RELAY_MANAGED_SESSION_MARKER;
    else process.env.AGENT_RELAY_MANAGED_SESSION_MARKER = previous;
    fs.rmSync(folder, {recursive: true, force: true});
  }
});

test('native title route updates V1 and V2 metadata without prompting and rejects other mutations', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-opencode-titles-'));
  const runtime = path.join(folder, 'runtime');
  const modulePath = path.join(folder, 'plugin.mjs');
  fs.writeFileSync(modulePath, template.replaceAll('__RUNTIME__', JSON.stringify(runtime)).replaceAll('__VERSION__', String(version)) + '\nexport {v1Adapter, v2Adapter, serve};\n');
  const {v1Adapter, v2Adapter, serve} = await import(pathToFileURL(modulePath).href);
  const previousBun = globalThis.Bun;
  let fetchRequest;
  globalThis.Bun = {serve: ({unix, fetch}) => {
    fs.writeFileSync(unix, 'fake socket'); fetchRequest = fetch; return {stop() {}};
  }};
  try {
    for (const generation of [1, 2]) {
      let current = {id: 'ses_title', title: 'Original', projectID: 'project', directory: '/synthetic', time: {updated: 1}};
      const writes = [];
      const client = {_client: {getConfig: () => ({baseUrl: 'http://synthetic', fetch: async (request) => {
        const url = new URL(request.url);
        assert.equal(url.pathname, '/session/ses_title');
        if (request.method === 'PATCH') { const update = await request.json(); writes.push(update); current = {...current, ...update}; }
        else assert.equal(request.method, 'GET');
        return Response.json(current);
      }})}};
      const context = {location: {directory: '/synthetic'}, session: {
        get: async ({sessionID}) => { assert.equal(sessionID, current.id); return current; },
        update: async ({sessionID, title}) => { assert.equal(sessionID, current.id); writes.push({title}); current = {...current, title}; },
        prompt: async () => { throw new Error('rename must never prompt'); },
      }};
      const api = generation === 1 ? v1Adapter(client) : v2Adapter(context, new Map(), new Map());
      const running = await serve({api, directory: '/synthetic', release() {}});
      running.remember(current);
      try {
        const request = (suffix, method = 'GET', body) => fetchRequest(new Request(`http://local/session/${suffix}`, {method, ...(body === undefined ? {} : {body: JSON.stringify(body)})}));
        assert.deepEqual(await (await request('ses_title/title-capability')).json(), {supported: true});
        assert.equal((await request('ses_unknown', 'PATCH', {title: 'Wrong'})).status, 404);
        for (const bad of [{title: ''}, {title: 'line\nbreak'}, {title: 'OK', permissions: []}, {title: 'a'.repeat(201)}]) {
          assert.equal((await request('ses_title', 'PATCH', bad)).status, 400);
        }
        assert.equal(writes.length, 0);
        const result = await request('ses_title', 'PATCH', {title: 'Fix login'});
        assert.equal(result.status, 200);
        assert.equal((await result.json()).title, 'Fix login');
        assert.deepEqual(writes, [{title: 'Fix login'}]);
        assert.equal(running.sessions.get('ses_title').title, 'Fix login');
        current = {...current, time: {archived: 123}};
        assert.equal((await request('ses_title', 'PATCH', {title: 'Archived'})).status, 409);
        assert.equal(writes.length, 1);
      } finally { await running.dispose(); }
    }
  } finally { globalThis.Bun = previousBun; fs.rmSync(folder, {recursive: true, force: true}); }
});
