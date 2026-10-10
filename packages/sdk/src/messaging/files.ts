import { normalizeFileInfo, normalizeFileUpload } from './normalize.js';
import type {
  RelayDownloadedFile,
  RelayFileInfo,
  RelayFileTransferOptions,
  RelayUploadFileInput,
} from './types.js';

const DEFAULT_FILE_TRANSFER_TIMEOUT_MS = 30_000;

async function fetchFileBytes(
  url: string,
  init: RequestInit,
  operation: 'upload' | 'download',
  options: RelayFileTransferOptions
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FILE_TRANSFER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`files.${operation}: timeoutMs must be a positive finite number.`);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, timeoutMs);
  (timeout as { unref?: () => void }).unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    const reason = controller.signal.aborted ? 'was cancelled or timed out' : 'failed';
    throw new Error(`files.${operation}: signed byte transfer ${reason}.`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** The slice of the relaycast agent `files` API the upload and download helpers use. */
export interface RelayFilesApiLike {
  upload(data: { filename: string; content_type: string; size_bytes: number }): Promise<unknown>;
  complete(fileId: string): Promise<unknown>;
  get(fileId: string): Promise<unknown>;
}

/**
 * Store a file so its id can be attached to a message: request an upload,
 * PUT the bytes to the returned URL, then complete it. The file is never
 * completed when the byte upload fails.
 */
export async function uploadRelayFile(
  files: RelayFilesApiLike,
  input: RelayUploadFileInput,
  options: RelayFileTransferOptions = {}
): Promise<RelayFileInfo> {
  const filename = input.filename.trim();
  if (!filename) {
    throw new Error('files.upload requires a filename.');
  }
  const data = new Uint8Array(input.data);
  if (data.byteLength === 0) {
    throw new Error('files.upload cannot upload an empty file.');
  }
  const contentType = input.contentType?.trim() || 'application/octet-stream';
  const { id, uploadUrl } = normalizeFileUpload(
    await files.upload({ filename, content_type: contentType, size_bytes: data.byteLength })
  );
  if (!id || !uploadUrl) {
    throw new Error('files.upload: the server did not return a file id and upload URL.');
  }
  const response = await fetchFileBytes(
    uploadUrl,
    {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: data,
    },
    'upload',
    options
  );
  if (!response.ok) {
    await cancelResponseBody(response);
    // The upload URL carries a signature in its query string; name only its origin.
    throw new Error(
      `files.upload: storing the bytes failed with HTTP ${response.status} at ${new URL(uploadUrl).origin}; the file was not attached.`
    );
  }
  return { ...normalizeFileInfo(await files.complete(id)), id, status: 'complete' };
}

/** Default largest attachment `downloadRelayFile` reads (25 MiB), matching the injectors' cap. */
export const RELAY_FILE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Fetch a completed file's bytes through its short-lived download URL,
 * refusing the body as soon as it exceeds `maxBytes`.
 */
export async function downloadRelayFile(
  files: RelayFilesApiLike,
  id: string,
  options: RelayFileTransferOptions & { maxBytes?: number } = {}
): Promise<RelayDownloadedFile> {
  const maxBytes = options.maxBytes ?? RELAY_FILE_DOWNLOAD_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error('files.download: maxBytes must be a non-negative finite number.');
  }
  const file = normalizeFileInfo(await files.get(id));
  if (file.status !== 'complete' || !file.downloadUrl) {
    throw new Error(`files.download: file ${id} has no completed upload to download.`);
  }
  const tooLarge = () => new Error(`files.download: file ${id} is over the ${maxBytes}-byte download limit.`);
  if (file.sizeBytes > maxBytes) throw tooLarge();
  const response = await fetchFileBytes(file.downloadUrl, {}, 'download', options);
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new Error(
      `files.download: fetching file ${id} failed with HTTP ${response.status} at ${new URL(file.downloadUrl).origin}.`
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(response);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (!reader) break;
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  // A body that ends early (or is missing) is not the file the record describes.
  if (file.sizeBytes > 0 && total !== file.sizeBytes) {
    throw new Error(`files.download: file ${id} arrived with ${total} of ${file.sizeBytes} bytes.`);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { file, data };
}
