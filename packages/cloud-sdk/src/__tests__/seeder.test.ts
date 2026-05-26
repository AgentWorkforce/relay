import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { afterEach, mock } from 'node:test';

import { RelayFileClient } from '@relayfile/sdk';

import { seedAclRules, seedWorkflowAcls, seedWorkspace } from '../seeder.js';

interface FetchResponseShape {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

const originalFetch = globalThis.fetch;

async function createWorkspace(
  files: Record<string, string | Buffer>
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'relay-seeder-'));

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(dir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function createFetchResponse(body: string, status = 200): FetchResponseShape {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text(): Promise<string> {
      return body;
    },
  };
}

function parseFetchBody(fetchMock: ReturnType<typeof mock.method>): { files: unknown[] } {
  assert.equal(fetchMock.mock.calls.length, 1);
  const [, options] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit];
  assert.equal(typeof options.body, 'string');
  return JSON.parse(options.body as string) as { files: unknown[] };
}

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
});

test('seedWorkspace posts the expected HTTP payload after SDK fallback', async () => {
  const workspace = await createWorkspace({
    'alpha.txt': 'alpha payload',
    'binary.bin': Buffer.from([0xff, 0x00, 0x61]),
    '.relay/ignored.txt': 'skip',
    '.git/config': 'skip',
    'node_modules/pkg/index.js': 'skip',
    'custom-skip/ignored.txt': 'skip',
    '.relayfile-mount-state.json': '{"skip":true}',
  });

  try {
    mock.method(RelayFileClient.prototype, 'bulkWrite', async () => {
      throw new Error('fall back to HTTP');
    });

    const fetchMock = mock.method(globalThis, 'fetch', async () =>
      createFetchResponse(JSON.stringify({ written: 2, errorCount: 0, errors: [] }))
    );

    const seededCount = await seedWorkspace(
      'https://relay.example///',
      'admin-token',
      ' workspace-123 ',
      workspace.dir,
      ['custom-skip']
    );

    assert.equal(seededCount, 2);
    assert.equal(fetchMock.mock.calls.length, 1);

    const [url, options] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit];
    assert.equal(url, 'https://relay.example/v1/workspaces/workspace-123/fs/bulk');
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, {
      Authorization: 'Bearer admin-token',
      'Content-Type': 'application/json',
      'X-Correlation-Id': options.headers && (options.headers as Record<string, string>)['X-Correlation-Id'],
    });
    assert.match(
      (options.headers as Record<string, string>)['X-Correlation-Id'],
      /^seed-workspace-workspace-123-\d+-0$/u
    );

    const body = parseFetchBody(fetchMock);
    assert.deepEqual(body.files, [
      {
        path: '/alpha.txt',
        content: 'alpha payload',
        encoding: 'utf-8',
      },
      {
        path: '/binary.bin',
        content: Buffer.from([0xff, 0x00, 0x61]).toString('base64'),
        encoding: 'base64',
      },
    ]);
  } finally {
    await workspace.cleanup();
  }
});

test('seedAclRules formats ACL files for root and nested directories', async () => {
  mock.method(RelayFileClient.prototype, 'bulkWrite', async () => {
    throw new Error('fall back to HTTP');
  });

  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    createFetchResponse(JSON.stringify({ written: 2, errorCount: 0, errors: [] }))
  );

  await seedAclRules('https://relay.example/', 'acl-token', 'workspace-acl', {
    '/': ['allow:agent:lead:read'],
    '/docs/': ['allow:agent:writer:write', 'deny:agent:reader'],
  });

  const body = parseFetchBody(fetchMock);
  assert.deepEqual(body.files, [
    {
      path: '/.relayfile.acl',
      content: JSON.stringify({
        semantics: { permissions: ['allow:agent:lead:read'] },
      }),
      encoding: 'utf-8',
    },
    {
      path: '/docs/.relayfile.acl',
      content: JSON.stringify({
        semantics: {
          permissions: ['allow:agent:writer:write', 'deny:agent:reader'],
        },
      }),
      encoding: 'utf-8',
    },
  ]);
});

test('seedWorkflowAcls merges multiple agents onto shared directories', async () => {
  mock.method(RelayFileClient.prototype, 'bulkWrite', async () => {
    throw new Error('fall back to HTTP');
  });

  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    createFetchResponse(JSON.stringify({ written: 2, errorCount: 0, errors: [] }))
  );

  await seedWorkflowAcls({
    relayfileUrl: 'https://relay.example',
    adminToken: 'workflow-token',
    workspace: 'workflow-merge',
    agents: [
      { name: 'qa-reviewer', acl: { src: ['read'] } },
      { name: 'builder', acl: { 'src\\': ['write'], '/docs/': ['read'] } },
      { name: 'analyst', acl: { docs: ['read'] } },
    ],
  });

  const body = parseFetchBody(fetchMock);
  assert.deepEqual(body.files, [
    {
      path: '/docs/.relayfile.acl',
      content: JSON.stringify({
        semantics: {
          permissions: [
            'allow:agent:analyst:read',
            'allow:agent:builder:read',
            'allow:agent:qa-reviewer:read',
          ],
        },
      }),
      encoding: 'utf-8',
    },
    {
      path: '/src/.relayfile.acl',
      content: JSON.stringify({
        semantics: {
          permissions: [
            'allow:agent:builder:read',
            'allow:agent:builder:write',
            'allow:agent:qa-reviewer:read',
            'deny:agent:analyst',
          ],
        },
      }),
      encoding: 'utf-8',
    },
  ]);
});

test('seedWorkflowAcls unions deny rules for agents missing directory access', async () => {
  mock.method(RelayFileClient.prototype, 'bulkWrite', async () => {
    throw new Error('fall back to HTTP');
  });

  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    createFetchResponse(JSON.stringify({ written: 2, errorCount: 0, errors: [] }))
  );

  await seedWorkflowAcls({
    relayfileUrl: 'https://relay.example',
    adminToken: 'workflow-token',
    workspace: 'workflow-deny',
    agents: [
      { name: 'alpha', acl: { src: ['read'] } },
      { name: 'beta', acl: { docs: ['write'] } },
    ],
  });

  const body = parseFetchBody(fetchMock);
  assert.deepEqual(body.files, [
    {
      path: '/docs/.relayfile.acl',
      content: JSON.stringify({
        semantics: {
          permissions: ['allow:agent:beta:read', 'allow:agent:beta:write', 'deny:agent:alpha'],
        },
      }),
      encoding: 'utf-8',
    },
    {
      path: '/src/.relayfile.acl',
      content: JSON.stringify({
        semantics: {
          permissions: ['allow:agent:alpha:read', 'deny:agent:beta'],
        },
      }),
      encoding: 'utf-8',
    },
  ]);
});

test('seedWorkflowAcls is a no-op when there are no ACL directories to seed', async () => {
  const bulkWriteMock = mock.method(RelayFileClient.prototype, 'bulkWrite', async () => {
    throw new Error('bulkWrite should not be called');
  });
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not be called');
  });

  await seedWorkflowAcls({
    relayfileUrl: 'https://relay.example',
    adminToken: 'workflow-token',
    workspace: 'workflow-empty',
    agents: [
      { name: 'builder', acl: {} },
      { name: 'qa-reviewer', acl: {} },
    ],
  });

  assert.equal(bulkWriteMock.mock.calls.length, 0);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('seedAclRules surfaces HTTP failures from the fallback API', async () => {
  mock.method(RelayFileClient.prototype, 'bulkWrite', async () => {
    throw new Error('fall back to HTTP');
  });

  mock.method(globalThis, 'fetch', async () => createFetchResponse('relay unavailable', 503));

  await assert.rejects(
    seedAclRules('https://relay.example', 'acl-token', 'workspace-http', {
      '/': ['allow:agent:builder:read'],
    }),
    new Error('failed to seed workspace workspace-http: HTTP 503 relay unavailable')
  );
});
