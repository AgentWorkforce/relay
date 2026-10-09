import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RelaycastMessagingClient,
  downloadRelayFile,
  normalizeFileInfo,
  type RelaycastAgentLike,
} from '../messaging/index.js';
import { AgentRelay } from '../index.js';

const UPLOAD_URL = 'https://files.example.test/_relayfiles?token=secret-signature';
const DOWNLOAD_URL = 'https://files.example.test/_relayfiles?token=download-signature';

function createWorkspace() {
  return { agents: {}, channels: {}, messages: {} } as never;
}

function createAgentFiles() {
  return {
    // @relaycast/sdk camelizes response keys.
    upload: vi.fn(async () => ({
      id: 'file-1',
      uploadUrl: UPLOAD_URL,
      expiresAt: '2026-10-08T23:00:00.000Z',
    })),
    complete: vi.fn(async () => ({
      id: 'file-1',
      filename: 'shot.png',
      contentType: 'image/png',
      sizeBytes: 4,
      downloadUrl: DOWNLOAD_URL,
    })),
    get: vi.fn(async () => ({
      id: 'file-1',
      filename: 'shot.png',
      contentType: 'image/png',
      sizeBytes: 4,
      status: 'complete',
      uploadedBy: 'sender',
      downloadUrl: DOWNLOAD_URL,
      createdAt: '2026-10-08T22:00:00.000Z',
    })),
  };
}

function clientWith(files: ReturnType<typeof createAgentFiles> | undefined) {
  const agentClient = { files } as unknown as RelaycastAgentLike;
  return new RelaycastMessagingClient({ relaycast: createWorkspace(), agentClient });
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RelaycastMessagingClient files', () => {
  it('uploads the bytes to the upload URL before completing, so the id can be attached', async () => {
    const files = createAgentFiles();
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const uploaded = await clientWith(files).files.upload({
      filename: 'shot.png',
      contentType: 'image/png',
      data: PNG_BYTES,
    });

    expect(files.upload).toHaveBeenCalledWith({
      filename: 'shot.png',
      content_type: 'image/png',
      size_bytes: 4,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(UPLOAD_URL);
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'content-type': 'image/png' });
    expect(Array.from(init.body as Uint8Array)).toEqual(Array.from(PNG_BYTES));
    expect(files.complete).toHaveBeenCalledWith('file-1');
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(files.complete.mock.invocationCallOrder[0]);
    expect(uploaded).toEqual({
      id: 'file-1',
      filename: 'shot.png',
      contentType: 'image/png',
      sizeBytes: 4,
      status: 'complete',
      downloadUrl: DOWNLOAD_URL,
    });
  });

  it('does not complete an upload whose bytes were rejected and keeps the signature out of the error', async () => {
    const files = createAgentFiles();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }))
    );

    const error = await clientWith(files)
      .files.upload({ filename: 'shot.png', contentType: 'image/png', data: PNG_BYTES })
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('HTTP 403');
    expect(error.message).toContain('https://files.example.test');
    expect(error.message).not.toContain('secret-signature');
    expect(files.complete).not.toHaveBeenCalled();
  });

  it('defaults the content type and rejects empty files and blank names before any request', async () => {
    const files = createAgentFiles();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 }))
    );
    const client = clientWith(files);

    await client.files.upload({ filename: 'notes.bin', data: new Uint8Array([1]).buffer });
    expect(files.upload).toHaveBeenCalledWith({
      filename: 'notes.bin',
      content_type: 'application/octet-stream',
      size_bytes: 1,
    });

    files.upload.mockClear();
    await expect(client.files.upload({ filename: 'empty.png', data: new Uint8Array() })).rejects.toThrow(
      /empty/
    );
    await expect(client.files.upload({ filename: '  ', data: PNG_BYTES })).rejects.toThrow(/filename/);
    expect(files.upload).not.toHaveBeenCalled();
  });

  it('downloads a completed file through its download URL', async () => {
    const files = createAgentFiles();
    const fetchMock = vi.fn(async () => new Response(PNG_BYTES, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const downloaded = await clientWith(files).files.download('file-1');

    expect(files.get).toHaveBeenCalledWith('file-1');
    expect(fetchMock).toHaveBeenCalledWith(DOWNLOAD_URL);
    expect(downloaded.file).toMatchObject({ id: 'file-1', filename: 'shot.png', contentType: 'image/png' });
    expect(Array.from(downloaded.data)).toEqual(Array.from(PNG_BYTES));
  });

  it('refuses to download a file that never completed', async () => {
    const files = createAgentFiles();
    files.get.mockResolvedValueOnce({
      id: 'file-1',
      filename: 'shot.png',
      contentType: 'image/png',
      sizeBytes: 4,
      status: 'pending',
      downloadUrl: null,
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(clientWith(files).files.download('file-1')).rejects.toThrow(/no completed upload/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires an agent client with the files API', async () => {
    await expect(clientWith(undefined).files.get('file-1')).rejects.toThrow(/files API/);
    const workspaceOnly = new RelaycastMessagingClient({ relaycast: createWorkspace() });
    await expect(workspaceOnly.files.get('file-1')).rejects.toThrow(/agentToken/);
  });

  it('exposes files on the AgentRelay facade', () => {
    const messaging = clientWith(createAgentFiles());
    const relay = new AgentRelay({ messaging });
    expect(relay.files).toBe(messaging.files);
  });

  it('refuses a download whose body exceeds the limit even when the record claims it is small', async () => {
    const files = createAgentFiles();
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16));
          controller.enqueue(new Uint8Array(16));
          controller.close();
        },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body(), { status: 200 }))
    );

    const messaging = clientWith(files);
    await expect(downloadRelayFile(files, 'file-1', { maxBytes: 20 })).rejects.toThrow(/download limit/);
    // Under the cap, 32 bytes still don't match the 4-byte record.
    await expect(messaging.files.download('file-1')).rejects.toThrow(/arrived with 32 of 4 bytes/);
  });

  it('refuses a truncated body and an invalid maxBytes', async () => {
    const files = createAgentFiles();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([0x89, 0x50]), { status: 200 }))
    );

    await expect(downloadRelayFile(files, 'file-1')).rejects.toThrow(/arrived with 2 of 4 bytes/);
    await expect(downloadRelayFile(files, 'file-1', { maxBytes: Number.NaN })).rejects.toThrow(/maxBytes/);
    await expect(downloadRelayFile(files, 'file-1', { maxBytes: -1 })).rejects.toThrow(/maxBytes/);
  });

  it('treats a file record without a status but with a download URL as complete', () => {
    expect(
      normalizeFileInfo({
        id: 'f',
        filename: 'a.png',
        contentType: 'image/png',
        sizeBytes: 1,
        downloadUrl: 'https://x',
      }).status
    ).toBe('complete');
    expect(normalizeFileInfo({ id: 'f', filename: 'a.png' }).status).toBeUndefined();
  });
});
