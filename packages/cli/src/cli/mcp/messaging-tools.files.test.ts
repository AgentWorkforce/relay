import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerMessagingTools } from './messaging-tools.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UPLOAD_URL = 'https://files.example.test/_relayfiles?token=upload-signature';
const DOWNLOAD_URL = 'https://files.example.test/_relayfiles?token=download-signature';

function createAgentClient() {
  return {
    dm: vi.fn(async () => ({ id: 'dm1', conversationId: 'conv-dm' })),
    send: vi.fn(async () => ({ id: 'm1' })),
    dms: {
      createGroup: vi.fn(async () => ({ id: 'conv1' })),
      sendMessage: vi.fn(async () => ({ id: 'gdm1' })),
    },
    files: {
      // @relaycast/sdk camelizes response keys.
      upload: vi.fn(async () => ({ id: 'f1', uploadUrl: UPLOAD_URL, expiresAt: '2026-10-08T23:00:00.000Z' })),
      complete: vi.fn(async () => ({
        id: 'f1',
        filename: 'shot.png',
        contentType: 'image/png',
        sizeBytes: PNG_BYTES.byteLength,
        downloadUrl: DOWNLOAD_URL,
      })),
      get: vi.fn(async () => ({
        id: 'f1',
        filename: '../../shot.png',
        contentType: 'image/png',
        sizeBytes: PNG_BYTES.byteLength,
        status: 'complete',
        downloadUrl: DOWNLOAD_URL,
      })),
    },
  };
}

async function connect(agentClient: ReturnType<typeof createAgentClient>) {
  const server = new McpServer({ name: 'files-test', version: '1.0.0' });
  registerMessagingTools(server, () => agentClient as never, async () => [{ name: 'linux-agent' }]);
  const client = new Client({ name: 'files-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function structured(result: unknown): Record<string, unknown> {
  const r = result as { isError?: boolean; structuredContent: Record<string, unknown> };
  expect(r.isError).not.toBe(true);
  return r.structuredContent;
}

describe('file attachments over MCP', () => {
  let dir: string;
  let agentClient: ReturnType<typeof createAgentClient>;

  beforeEach(async () => {
    vi.stubEnv('RELAY_ATTEST_SESSION_ID', '');
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'relay-mcp-files-')));
    agentClient = createAgentClient();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('upload_file stores a local screenshot so send_dm can attach its id', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = path.join(dir, 'shot.png');
    await writeFile(file, PNG_BYTES);
    const client = await connect(agentClient);

    const uploaded = structured(await client.callTool({ name: 'upload_file', arguments: { path: file } }));
    expect(agentClient.files.upload).toHaveBeenCalledWith({
      filename: 'shot.png',
      content_type: 'image/png',
      size_bytes: PNG_BYTES.byteLength,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UPLOAD_URL);
    expect(init.method).toBe('PUT');
    expect(Buffer.from(init.body as Uint8Array)).toEqual(PNG_BYTES);
    expect(agentClient.files.complete).toHaveBeenCalledWith('f1');
    expect(uploaded).toMatchObject({ id: 'f1', filename: 'shot.png', status: 'complete' });

    await client.callTool({
      name: 'send_dm',
      arguments: { to: 'linux-agent', text: 'see screenshot', attachments: [uploaded.id] },
    });
    expect(agentClient.dm).toHaveBeenCalledWith(
      'linux-agent',
      'see screenshot',
      expect.objectContaining({ attachments: ['f1'] })
    );
  });

  it('upload_file accepts inline base64 bytes and refuses a missing file without uploading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const client = await connect(agentClient);

    await client.callTool({
      name: 'upload_file',
      arguments: { filename: 'shot.png', content_base64: PNG_BYTES.toString('base64') },
    });
    expect(agentClient.files.upload).toHaveBeenCalledTimes(1);

    const missing = (await client.callTool({
      name: 'upload_file',
      arguments: { path: path.join(dir, 'missing.png') },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('not a readable file');
    expect(agentClient.files.upload).toHaveBeenCalledTimes(1);
  });

  it('send_group_dm forwards attachments', async () => {
    const client = await connect(agentClient);

    await client.callTool({
      name: 'send_group_dm',
      arguments: { participants: ['a', 'b'], text: 'see screenshot', attachments: ['f1'] },
    });

    expect(agentClient.dms.sendMessage).toHaveBeenCalledWith(
      'conv1',
      'see screenshot',
      expect.objectContaining({ attachments: ['f1'] })
    );
  });

  it('download_file saves the attachment under a sanitized name and returns a readable path', async () => {
    const fetchMock = vi.fn(async () => new Response(PNG_BYTES, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = await connect(agentClient);

    const saved = structured(
      await client.callTool({ name: 'download_file', arguments: { file_id: 'f1', path: dir } })
    );

    expect(fetchMock).toHaveBeenCalledWith(DOWNLOAD_URL);
    expect(saved.path).toBe(path.join(dir, 'shot.png'));
    expect(await readFile(saved.path as string)).toEqual(PNG_BYTES);
  });
});
