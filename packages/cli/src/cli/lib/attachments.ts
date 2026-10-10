import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
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

/** Device names Windows reserves, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A sender-supplied file name reduced to one safe path segment that also
 * saves on Windows: no control characters, no `<>:"|?*`, no leading dot, no
 * trailing dots or spaces, and no reserved device name.
 */
export function safeAttachmentFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    // Trim before removing leading dots so names such as ` .env` cannot
    // become hidden only after the whitespace is stripped.
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '');
  if (!cleaned) return 'attachment';
  return WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Decode strict base64 (standard alphabet, optional padding, whitespace
 * ignored). `Buffer.from(..., 'base64')` silently skips invalid characters,
 * which would upload different bytes than the caller meant.
 */
export function decodeBase64Strict(value: string, maxBytes = MAX_ATTACHMENT_BYTES): Buffer {
  const compact = value.replace(/\s+/g, '');
  // Refuse oversized input by its encoded length, before decoding it.
  if (Math.floor((compact.length * 3) / 4) - 2 > maxBytes) {
    throw new Error(`content_base64 exceeds the ${maxBytes}-byte limit.`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('content_base64 is not valid base64.');
  }
  const data = Buffer.from(compact, 'base64');
  if (data.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw new Error('content_base64 is not valid base64.');
  }
  return data;
}

/** Check that a local file can be attached: a non-empty regular file under the size cap. */
export async function checkAttachment(filePath: string): Promise<void> {
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
}

/** Read a local file to attach, enforcing the same rules on the bytes actually read. */
export async function readAttachment(
  filePath: string
): Promise<{ filename: string; contentType: string; data: Buffer }> {
  await checkAttachment(filePath);
  // The file can change between stat and read; check what was read.
  const data = await readFile(filePath);
  if (data.byteLength === 0) {
    throw new Error(`Cannot attach ${filePath}: the file is empty.`);
  }
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Cannot attach ${filePath}: ${data.byteLength} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit.`
    );
  }
  const filename = path.basename(filePath);
  return { filename, contentType: contentTypeFor(filename), data };
}

async function ensurePlainDefaultDirectory(fileId: string): Promise<{ path: string; real: string }> {
  let currentPath = path.resolve('.');
  let currentReal = await realpath(currentPath);
  for (const segment of ['.agent-relay', 'attachments', safeAttachmentFilename(fileId)]) {
    currentPath = path.join(currentPath, segment);
    try {
      await mkdir(currentPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const expected = path.join(currentReal, segment);
    if (process.platform !== 'win32') {
      let directory;
      try {
        directory = await open(
          currentPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENOTDIR') {
          throw new Error(`Cannot save attachment ${fileId}: default destination contains a symlink.`, {
            cause: error,
          });
        }
        throw error;
      }
      try {
        const [opened, visible, pinnedReal] = await Promise.all([
          directory.stat(),
          lstat(currentPath),
          realpath(currentPath),
        ]);
        if (
          pinnedReal !== expected ||
          !opened.isDirectory() ||
          !visible.isDirectory() ||
          visible.isSymbolicLink() ||
          visible.dev !== opened.dev ||
          visible.ino !== opened.ino
        ) {
          throw new Error(`Cannot save attachment ${fileId}: default destination changed while opening.`);
        }
        if ((opened.mode & 0o077) !== 0) await directory.chmod(0o700);
        const privateInfo = await directory.stat();
        if ((privateInfo.mode & 0o077) !== 0) {
          throw new Error(`Cannot save attachment ${fileId}: default destination is not private.`);
        }
        currentReal = pinnedReal;
      } finally {
        await directory.close();
      }
    } else {
      const info = await lstat(currentPath).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Cannot save attachment ${fileId}: default destination contains a symlink.`);
      }
      const resolved = await realpath(currentPath);
      if (resolved !== expected) {
        throw new Error(`Cannot save attachment ${fileId}: default destination escaped its root.`);
      }
      currentReal = resolved;
    }
  }
  return { path: currentPath, real: currentReal };
}

async function writePinnedDefaultFile(
  directory: string,
  expectedDirectoryReal: string,
  target: string,
  data: Uint8Array
): Promise<void> {
  // Create the final file before validating the path again, then write only
  // through that open descriptor. A directory or file substitution between
  // validation and byte transfer can no longer redirect the write.
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  const file = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600
  );
  try {
    const [directoryReal, visible, opened] = await Promise.all([
      realpath(directory),
      lstat(target),
      file.stat(),
    ]);
    if (
      directoryReal !== expectedDirectoryReal ||
      !visible.isFile() ||
      visible.isSymbolicLink() ||
      visible.dev !== opened.dev ||
      visible.ino !== opened.ino
    ) {
      throw new Error('default destination changed while opening the attachment file');
    }
    await file.writeFile(data);
    const [directoryRealAfter, visibleAfter] = await Promise.all([realpath(directory), lstat(target)]);
    if (
      directoryRealAfter !== expectedDirectoryReal ||
      !visibleAfter.isFile() ||
      visibleAfter.isSymbolicLink() ||
      visibleAfter.dev !== opened.dev ||
      visibleAfter.ino !== opened.ino
    ) {
      throw new Error('default destination changed while saving the attachment file');
    }
  } finally {
    await file.close();
  }
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
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Cannot save attachment ${fileId}: ${data.byteLength} bytes exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit.`
    );
  }
  const name = safeAttachmentFilename(filename);
  let defaultDirectoryReal: string | undefined;
  if (!out) {
    const destination = await ensurePlainDefaultDirectory(fileId);
    out = destination.path;
    defaultDirectoryReal = destination.real;
  }
  const outInfo = await stat(out).catch(() => undefined);
  if (!outInfo?.isDirectory()) {
    // An explicit output file is the caller's choice to overwrite.
    const target = path.resolve(out);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    return target;
  }
  // In a directory, the sender chose the name: never replace an existing file
  // (or follow a link); pick the first free `name (n).ext` instead.
  const { name: stem, ext } = path.parse(name);
  for (let n = 0; n < 1000; n += 1) {
    const target = path.resolve(out, n === 0 ? name : `${stem} (${n})${ext}`);
    try {
      if (defaultDirectoryReal) {
        await writePinnedDefaultFile(out, defaultDirectoryReal, target, data);
      } else {
        await writeFile(target, data, { flag: 'wx' });
      }
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Cannot save attachment ${fileId}: no free file name in ${out}.`);
}
