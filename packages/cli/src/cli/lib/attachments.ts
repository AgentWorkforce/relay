import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Largest file sent or saved as a message attachment; recipients' injectors use the same cap. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
};

/** The MIME type for a file name's extension, or `application/octet-stream`. */
export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** A sender-supplied file name reduced to one safe path segment. */
export function safeAttachmentFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'attachment';
}

/** Read a local file to attach, enforcing that it is a non-empty regular file under the size cap. */
export async function readAttachment(
  filePath: string
): Promise<{ filename: string; contentType: string; data: Buffer }> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) {
    throw new Error(`Cannot attach ${filePath}: not a readable file.`);
  }
  if (info.size === 0) {
    throw new Error(`Cannot attach ${filePath}: the file is empty.`);
  }
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Cannot attach ${filePath}: ${info.size} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit.`
    );
  }
  const filename = path.basename(filePath);
  return { filename, contentType: contentTypeFor(filename), data: await readFile(filePath) };
}

/**
 * Write a downloaded attachment and return its absolute path. `out` may be a
 * file or an existing directory; by default the file lands in
 * `.agent-relay/attachments/<fileId>/` under the working directory.
 */
export async function saveAttachment(
  fileId: string,
  filename: string,
  data: Uint8Array,
  out?: string
): Promise<string> {
  const name = safeAttachmentFilename(filename);
  let target: string;
  if (!out) {
    target = path.resolve('.agent-relay', 'attachments', safeAttachmentFilename(fileId), name);
  } else {
    const outInfo = await stat(out).catch(() => undefined);
    target = path.resolve(outInfo?.isDirectory() ? path.join(out, name) : out);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  return target;
}
