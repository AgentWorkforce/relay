import assert from 'node:assert/strict';
import test from 'node:test';

import type { LinearIssue } from '@relayfile/adapter-linear';

import { createAgentEvent, FeatureNotImplementedError, relayfileTools } from '../src/index.ts';

test('expand caches full payloads per event id', async () => {
  const expansionCache = new Map();
  let firstLoads = 0;
  let secondLoads = 0;

  const firstEvent = createAgentEvent(
    {
      id: 'evt_linear_1',
      workspace: 'ws_acme',
      type: 'relayfile.changed',
      path: '/linear/issues/ENG-412.json',
      resource: {
        path: '/linear/issues/ENG-412.json',
        kind: 'linear.issue',
        id: 'ENG-412',
        provider: 'linear',
      },
      summary: {
        title: 'ENG-412',
        status: 'In Progress',
      },
    },
    {
      expansionCache,
      loadFull: async () => {
        firstLoads += 1;
        return {
          level: 'full',
          path: '/linear/issues/ENG-412.json',
          data: {
            id: 'ENG-412',
            title: 'ENG-412',
          },
        };
      },
    }
  );

  const secondEvent = createAgentEvent(
    {
      id: 'evt_linear_2',
      workspace: 'ws_acme',
      type: 'relayfile.changed',
      path: '/linear/issues/ENG-413.json',
      resource: {
        path: '/linear/issues/ENG-413.json',
        kind: 'linear.issue',
        id: 'ENG-413',
        provider: 'linear',
      },
      summary: {
        title: 'ENG-413',
        status: 'Todo',
      },
    },
    {
      expansionCache,
      loadFull: async () => {
        secondLoads += 1;
        return {
          level: 'full',
          path: '/linear/issues/ENG-413.json',
          data: {
            id: 'ENG-413',
            title: 'ENG-413',
          },
        };
      },
    }
  );

  const firstExpandA = firstEvent.expand('full');
  const firstExpandB = firstEvent.expand('full');
  const secondExpand = secondEvent.expand('full');

  const [firstFullA, firstFullB, secondFull] = await Promise.all([firstExpandA, firstExpandB, secondExpand]);

  assert.strictEqual(firstLoads, 1);
  assert.strictEqual(secondLoads, 1);
  assert.strictEqual(firstFullA, firstFullB);
  assert.notStrictEqual(firstFullA, secondFull);
  assert.deepEqual(firstFullA, {
    level: 'full',
    path: '/linear/issues/ENG-412.json',
    data: {
      id: 'ENG-412',
      title: 'ENG-412',
    },
  });
  assert.deepEqual(secondFull, {
    level: 'full',
    path: '/linear/issues/ENG-413.json',
    data: {
      id: 'ENG-413',
      title: 'ENG-413',
    },
  });
});

test('full expansion data narrows from the resource kind for provider events', async () => {
  const event = createAgentEvent(
    {
      id: 'evt_linear_typed',
      workspace: 'ws_acme',
      type: 'linear.issue.updated',
      path: '/linear/issues/ENG-900.json',
      resource: {
        path: '/linear/issues/ENG-900.json',
        kind: 'linear.issue',
        id: 'ENG-900',
        provider: 'linear',
      },
    },
    {
      loadFull: async () => ({
        level: 'full',
        path: '/linear/issues/ENG-900.json',
        data: {
          id: 'ENG-900',
          title: 'Typed payload',
        },
      }),
    }
  );

  const full = await event.expand('full');
  const issue: LinearIssue = full.data;

  assert.equal(issue.id, 'ENG-900');
});

test('expand defaults to full expansion when no level is provided', async () => {
  const event = createAgentEvent(
    {
      id: 'evt_linear_default_full',
      workspace: 'ws_acme',
      type: 'relayfile.changed',
      resource: {
        path: '/linear/issues/ENG-901A.json',
        kind: 'linear.issue',
        id: 'ENG-901A',
        provider: 'linear',
      },
    },
    {
      loadFull: async () => ({
        level: 'full',
        path: '/linear/issues/ENG-901A.json',
        data: {
          id: 'ENG-901A',
          title: 'Default full',
        },
      }),
    }
  );

  assert.deepEqual(await event.expand(), {
    level: 'full',
    path: '/linear/issues/ENG-901A.json',
    data: {
      id: 'ENG-901A',
      title: 'Default full',
    },
  });
});

test('diff expansion uses the configured loader and does not fabricate payloads', async () => {
  let loads = 0;
  const event = createAgentEvent(
    {
      id: 'evt_linear_diff',
      workspace: 'ws_acme',
      type: 'relayfile.changed',
      resource: {
        path: '/linear/issues/ENG-901.json',
        kind: 'linear.issue',
        id: 'ENG-901',
        provider: 'linear',
      },
    },
    {
      loadDiff: async () => {
        loads += 1;
        return {
          level: 'diff',
          path: '/linear/issues/ENG-901.json',
          diff: {
            fieldsChanged: ['status'],
          },
        };
      },
    }
  );

  const [first, second] = await Promise.all([event.expand('diff'), event.expand('diff')]);

  assert.equal(loads, 1);
  assert.strictEqual(first, second);
  assert.deepEqual(first, {
    level: 'diff',
    path: '/linear/issues/ENG-901.json',
    diff: {
      fieldsChanged: ['status'],
    },
  });
});

test('thread expansion uses the configured loader and caches by cursor and limit', async () => {
  let loads = 0;
  const event = createAgentEvent(
    {
      id: 'evt_linear_thread',
      workspace: 'ws_acme',
      type: 'relayfile.changed',
      resource: {
        path: '/linear/issues/ENG-902.json',
        kind: 'linear.issue',
        id: 'ENG-902',
        provider: 'linear',
      },
    },
    {
      loadThread: async (options) => {
        loads += 1;
        return {
          level: 'thread',
          items: [
            {
              id: `c_${options?.cursor ?? 'first'}`,
              author: { id: 'usr_1', displayName: 'Ada' },
              createdAt: '2026-05-12T00:00:00.000Z',
              body: 'Customer replied',
              kind: 'comment',
            },
          ],
          hasMore: !options?.cursor,
          ...(options?.cursor ? {} : { cursor: 'cursor-2' }),
        };
      },
    }
  );

  const [first, second, third] = await Promise.all([
    event.expand('thread'),
    event.expand('thread'),
    event.expand('thread', { cursor: 'cursor-2', limit: 10 }),
  ]);

  assert.equal(loads, 2);
  assert.strictEqual(first, second);
  assert.notStrictEqual(first, third);
  assert.deepEqual(first, {
    level: 'thread',
    items: [
      {
        id: 'c_first',
        author: { id: 'usr_1', displayName: 'Ada' },
        createdAt: '2026-05-12T00:00:00.000Z',
        body: 'Customer replied',
        kind: 'comment',
      },
    ],
    hasMore: true,
    cursor: 'cursor-2',
  });
  assert.deepEqual(third, {
    level: 'thread',
    items: [
      {
        id: 'c_cursor-2',
        author: { id: 'usr_1', displayName: 'Ada' },
        createdAt: '2026-05-12T00:00:00.000Z',
        body: 'Customer replied',
        kind: 'comment',
      },
    ],
    hasMore: false,
  });
});

test('full expansion fails when no gateway-backed loader is configured', async () => {
  const event = createAgentEvent({
    id: 'evt_linear_missing_full',
    workspace: 'ws_acme',
    type: 'relayfile.changed',
    resource: {
      path: '/linear/issues/ENG-999.json',
      kind: 'linear.issue',
      id: 'ENG-999',
      provider: 'linear',
    },
  });

  await assert.rejects(event.expand('full'), /expand\("full"\) is unavailable/);
});

test('diff and thread expansions surface milestone-specific not-implemented errors', async () => {
  const event = createAgentEvent({
    id: 'evt_linear_missing_loader',
    workspace: 'ws_acme',
    type: 'relayfile.changed',
    resource: {
      path: '/linear/issues/ENG-1000.json',
      kind: 'linear.issue',
      id: 'ENG-1000',
      provider: 'linear',
    },
  });

  await assert.rejects(event.expand('diff'), (error: unknown) => {
    assert.ok(error instanceof FeatureNotImplementedError);
    assert.equal(error.code, 'M2_NOT_IMPLEMENTED');
    return true;
  });
  await assert.rejects(event.expand('thread'), (error: unknown) => {
    assert.ok(error instanceof FeatureNotImplementedError);
    assert.equal(error.code, 'M3_NOT_IMPLEMENTED');
    return true;
  });
});

test('relayfileTools exposes a live relayfile client when one is provided', async () => {
  const calls: string[] = [];
  const tools = relayfileTools({
    workspace: 'ws_acme',
    client: {
      available: true,
      async read(path) {
        calls.push(`read:${path}`);
        return { path };
      },
      async write(path, body) {
        calls.push(`write:${path}:${String(body)}`);
      },
      async list(glob) {
        calls.push(`list:${glob}`);
        return [{ path: glob }];
      },
    },
  });

  assert.equal(tools.available, true);
  assert.deepEqual(await tools.read('/docs/readme.md'), { path: '/docs/readme.md' });
  await tools.write('/docs/readme.md', 'body');
  assert.deepEqual(await tools.list('/docs/**'), [{ path: '/docs/**' }]);
  assert.deepEqual(calls, ['read:/docs/readme.md', 'write:/docs/readme.md:body', 'list:/docs/**']);
});
