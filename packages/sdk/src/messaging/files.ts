import { normalizeFileInfo, normalizeFileUpload } from './normalize.js';
import type { RelayDownloadedFile, RelayFileInfo, RelayUploadFileInput } from './types.js';

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
  input: RelayUploadFileInput
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
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: data,
  });
  if (!response.ok) {
    // The upload URL carries a signature in its query string; name only its origin.
    throw new Error(
      `files.upload: storing the bytes failed with HTTP ${response.status} at ${new URL(uploadUrl).origin}; the file was not attached.`
    );
  }
  return { ...normalizeFileInfo(await files.complete(id)), status: 'complete' };
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
  options: { maxBytes?: number } = {}
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
  const response = await fetch(file.downloadUrl);
  if (!response.ok) {
    throw new Error(
      `files.download: fetching file ${id} failed with HTTP ${response.status} at ${new URL(file.downloadUrl).origin}.`
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
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
