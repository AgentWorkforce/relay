import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const template = fs.readFileSync(path.join(root, 'src/relay/opencode/agent-relay.js'), 'utf8');
const rust = fs.readFileSync(path.join(root, 'src/relay/opencode.rs'), 'utf8');
const version = Number(rust.match(/PLUGIN_VERSION: u32 = (\d+)/)[1]);

test('managed V1 and V2 keep exact shell tags without a duplicate delivery socket', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-opencode-tags-'));
  const runtime = path.join(folder, 'runtime');
  const modulePath = path.join(folder, 'plugin.mjs');
  fs.writeFileSync(
    modulePath,
    template.replaceAll('__RUNTIME__', JSON.stringify(runtime)).replaceAll('__VERSION__', String(version))
  );
  const plugin = (await import(pathToFileURL(modulePath).href)).default;
  const previous = process.env.AGENT_RELAY_MANAGED_SESSION_MARKER;
  const marker = 'synthetic-test-marker';
  process.env.AGENT_RELAY_MANAGED_SESSION_MARKER = marker;
  try {
    const v1 = await plugin.server({});
    const output = { env: {} };
    await v1['shell.env']({ sessionID: 'ses_exact' }, output);
    assert.equal(output.env.AGENT_RELAY_OPENCODE_SESSION, 'ses_exact');
    const recordPath = path.join(runtime, `${process.pid}.managed.json`);
    const record = JSON.parse(fs.readFileSync(recordPath));
    assert.equal(record.pid, process.pid);
    assert.equal(record.version, version);
    assert.equal(record.marker_sha256, createHash('sha256').update(marker).digest('hex'));
    assert.equal(
      fs.readdirSync(runtime).some((name) => name.endsWith('.sock')),
      false
    );
    await v1.dispose();
    assert.equal(fs.existsSync(recordPath), false);
    let hook;
    let disposed = false;
    const dispose = await plugin.setup({
      shell: {
        hook: async (name, fn) => {
          assert.equal(name, 'create.before');
          hook = fn;
          return {
            dispose: async () => {
              disposed = true;
            },
          };
        },
      },
    });
    const event = { env: { OPENCODE_SESSION_ID: 'ses_second' } };
    hook(event);
    assert.equal(event.env.AGENT_RELAY_OPENCODE_SESSION, 'ses_second');
    assert.equal(fs.existsSync(recordPath), true);
    assert.equal(
      fs.readdirSync(runtime).some((name) => name.endsWith('.sock')),
      false
    );
    await dispose();
    assert.equal(disposed, true);
    assert.equal(fs.existsSync(recordPath), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_RELAY_MANAGED_SESSION_MARKER;
    else process.env.AGENT_RELAY_MANAGED_SESSION_MARKER = previous;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('native title route updates V1 and V2 metadata without prompting and rejects other mutations', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-opencode-titles-'));
  const runtime = path.join(folder, 'runtime');
  const modulePath = path.join(folder, 'plugin.mjs');
  fs.writeFileSync(
    modulePath,
    template.replaceAll('__RUNTIME__', JSON.stringify(runtime)).replaceAll('__VERSION__', String(version)) +
      '\nexport {v1Adapter, v2Adapter, serve};\n'
  );
  const { v1Adapter, v2Adapter, serve } = await import(pathToFileURL(modulePath).href);
  const previousBun = globalThis.Bun;
  let fetchRequest;
  globalThis.Bun = {
    serve: ({ unix, fetch }) => {
      fs.writeFileSync(unix, 'fake socket');
      fetchRequest = fetch;
      return { stop() {} };
    },
  };
  try {
    for (const generation of [1, 2]) {
      let current = {
        id: 'ses_title',
        title: 'Original',
        projectID: 'project',
        directory: '/synthetic',
        time: { updated: 1 },
      };
      const writes = [];
      const client = {
        _client: {
          getConfig: () => ({
            baseUrl: 'http://synthetic',
            fetch: async (request) => {
              const url = new URL(request.url);
              assert.equal(url.pathname, '/session/ses_title');
              if (request.method === 'PATCH') {
                const update = await request.json();
                writes.push(update);
                current = { ...current, ...update };
              } else assert.equal(request.method, 'GET');
              return Response.json(current);
            },
          }),
        },
      };
      const context = {
        location: { directory: '/synthetic' },
        session: {
          get: async ({ sessionID }) => {
            assert.equal(sessionID, current.id);
            return current;
          },
          update: async ({ sessionID, title }) => {
            assert.equal(sessionID, current.id);
            writes.push({ title });
            current = { ...current, title };
          },
          prompt: async () => {
            throw new Error('rename must never prompt');
          },
        },
      };
      const api = generation === 1 ? v1Adapter(client) : v2Adapter(context, new Map(), new Map());
      const running = await serve({ api, directory: '/synthetic', release() {} });
      running.remember(current);
      try {
        const request = (suffix, method = 'GET', body) =>
          fetchRequest(
            new Request(`http://local/session/${suffix}`, {
              method,
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
          );
        assert.deepEqual(await (await request('ses_title/title-capability')).json(), { supported: true });
        assert.equal((await request('ses_unknown', 'PATCH', { title: 'Wrong' })).status, 404);
        for (const bad of [
          { title: '' },
          { title: 'line\nbreak' },
          { title: 'OK', permissions: [] },
          { title: 'a'.repeat(201) },
        ]) {
          assert.equal((await request('ses_title', 'PATCH', bad)).status, 400);
        }
        assert.equal(writes.length, 0);
        const result = await request('ses_title', 'PATCH', { title: 'Fix login' });
        assert.equal(result.status, 200);
        assert.equal((await result.json()).title, 'Fix login');
        assert.deepEqual(writes, [{ title: 'Fix login' }]);
        assert.equal(running.sessions.get('ses_title').title, 'Fix login');
        current = { ...current, time: { archived: 123 } };
        assert.equal((await request('ses_title', 'PATCH', { title: 'Archived' })).status, 409);
        assert.equal(writes.length, 1);
      } finally {
        await running.dispose();
      }
    }
  } finally {
    globalThis.Bun = previousBun;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('native V1 and V2 capabilities keep raw user IDs and leave permissions and peer text unchanged', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-opencode-native-'));
  const modulePath = path.join(folder, 'plugin.mjs');
  fs.writeFileSync(
    modulePath,
    template
      .replaceAll('__RUNTIME__', JSON.stringify(path.join(folder, 'runtime')))
      .replaceAll('__VERSION__', String(version)) + '\nexport {v1Adapter, v2Adapter, serve};\n'
  );
  const { v1Adapter, v2Adapter, serve } = await import(pathToFileURL(modulePath).href);
  const previousBun = globalThis.Bun;
  let handle;
  globalThis.Bun = {
    serve: ({ unix, fetch }) => {
      fs.writeFileSync(unix, 'fake socket');
      handle = fetch;
      return { stop() {} };
    },
  };
  try {
    for (const generation of [1, 2]) {
      const id = 'ses_native';
      const userID = `msg_relay_${'a'.repeat(32)}`;
      const calls = [];
      let serverVersion = '1.18.35';
      const current = { id, projectID: 'project', directory: '/synthetic', time: { updated: 1 } };
      const client = {
        _client: {
          getConfig: () => ({
            baseUrl: 'http://synthetic',
            fetch: async (request) => {
              const pathname = new URL(request.url).pathname;
              if (pathname === '/global/health')
                return Response.json({ healthy: true, version: serverVersion });
              if (pathname === `/session/${id}`) return Response.json(current);
              assert.equal(pathname, `/session/${id}/prompt_async`);
              assert.equal(request.method, 'POST');
              calls.push(await request.json());
              return new Response(null, { status: 204 });
            },
          }),
        },
      };
      const context = {
        location: { directory: '/synthetic' },
        session: {
          get: async ({ sessionID }) => {
            assert.equal(sessionID, id);
            return current;
          },
          context: async () => [],
          prompt: async (args) => calls.push(args),
        },
      };
      const api = generation === 1 ? v1Adapter(client) : v2Adapter(context, new Map(), new Map());
      const running = await serve({ api, directory: '/synthetic', release() {} });
      running.remember(current);
      const request = (session, route, body) =>
        handle(
          new Request(
            `http://local/session/${session}/${route}`,
            body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }
          )
        );
      try {
        assert.deepEqual(await (await request(id, 'native-continuation')).json(), {
          protocol: 1,
          version,
          sessionID: id,
          messageID: true,
        });
        assert.equal((await request('ses_unknown', 'native-continuation')).status, 404);
        assert.equal(calls.length, 0, 'capability cannot prompt or change policy');
        for (const text of ['Please continue my work', 'Relay peer message\nMessageRef: abcdef012345']) {
          assert.equal(
            (await request(id, 'prompt_async', { messageID: userID, parts: [{ type: 'text', text }] }))
              .status,
            204
          );
          assert.deepEqual(
            calls.at(-1),
            generation === 1
              ? { messageID: userID, parts: [{ type: 'text', text }] }
              : { sessionID: id, id: userID, text, delivery: 'steer' }
          );
        }
        assert.equal(
          (
            await request(id, 'prompt_async', {
              messageID: userID,
              parts: [{ type: 'text', text: 'x' }],
              tools: { bash: true },
            })
          ).status,
          400
        );
        assert.equal(calls.length, 2);
        if (generation === 1) serverVersion = '1.18.34';
        else delete context.session.prompt;
        assert.equal((await request(id, 'native-continuation')).status, 501);
      } finally {
        await running.dispose();
      }
    }
  } finally {
    globalThis.Bun = previousBun;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
