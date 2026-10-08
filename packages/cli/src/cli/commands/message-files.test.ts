import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerMessageCommands } from './message.js';
import type { SdkCommandDeps } from '../lib/sdk-command.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let dir: string;

beforeEach(async () => {
  // macOS resolves /var to /private/var once the process chdirs into it.
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'relay-message-files-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness() {
  const relay = {
    agents: { list: vi.fn(async () => [{ id: 'a1', name: 'lead' }]) },
    messages: {
      send: vi.fn(async (i: unknown) => ({ id: 'm1', ...(i as object) })),
      direct: vi.fn(async (i: unknown) => ({ id: 'd1', ...(i as object) })),
      groupDirect: vi.fn(async (i: unknown) => ({ id: 'g1', ...(i as object) })),
    },
    files: {
      upload: vi.fn(async (i: { filename: string; contentType?: string; data: Uint8Array }) => ({
        id: `file-${i.filename}`,
        filename: i.filename,
        contentType: i.contentType ?? 'application/octet-stream',
        sizeBytes: i.data.byteLength,
        status: 'complete',
      })),
      get: vi.fn(async (id: string) => ({ id, filename: 'shot.png', contentType: 'image/png', sizeBytes: 8 })),
      download: vi.fn(async (id: string) => ({
        file: { id, filename: '../../evil/shot.png', contentType: 'image/png', sizeBytes: 8 },
        data: new Uint8Array(PNG_BYTES),
      })),
    },
  };
  const log = vi.fn();
  const error = vi.fn();
  const exit = vi.fn();
  const deps: Partial<SdkCommandDeps> = {
    createAgentRelay: vi.fn(() => relay as never),
    createWorkspaceRelay: vi.fn(() => relay as never),
    log,
    error,
    exit: exit as never,
  };
  const program = new Command();
  program.exitOverride();
  registerMessageCommands(program, deps);
  return { program, relay, log, error, exit };
}

async function png(name = 'shot.png'): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, PNG_BYTES);
  return file;
}

describe('message file attachments', () => {
  it('file upload stores the bytes first and posts the stored file id, not the local path', async () => {
    const { program, relay, exit } = harness();
    const file = await png();

    await program.parseAsync(['message', 'file', 'upload', file, '--channel', 'ops', '--text', 'look'], {
      from: 'user',
    });

    expect(relay.files.upload).toHaveBeenCalledTimes(1);
    const upload = relay.files.upload.mock.calls[0][0];
    expect(upload).toMatchObject({ filename: 'shot.png', contentType: 'image/png' });
    expect(Buffer.from(upload.data)).toEqual(PNG_BYTES);
    expect(relay.messages.send).toHaveBeenCalledWith({
      channel: 'ops',
      text: 'look',
      attachments: ['file-shot.png'],
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it('file upload --to sends the file as a direct message and defaults the text to the file name', async () => {
    const { program, relay } = harness();
    const file = await png();

    await program.parseAsync(['message', 'file', 'upload', file, '--to', 'lead'], { from: 'user' });

    expect(relay.messages.direct).toHaveBeenCalledWith({
      to: 'lead',
      text: 'shot.png',
      attachments: ['file-shot.png'],
    });
    expect(relay.messages.send).not.toHaveBeenCalled();
  });

  it('file upload requires exactly one destination', async () => {
    const { program, relay, error, exit } = harness();
    const file = await png();

    await program.parseAsync(['message', 'file', 'upload', file], { from: 'user' });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('exactly one of --channel'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.files.upload).not.toHaveBeenCalled();
  });

  it('dm send --file attaches every uploaded file to the direct message', async () => {
    const { program, relay } = harness();
    const first = await png('one.png');
    const second = await png('two.pdf');

    await program.parseAsync(['message', 'dm', 'send', 'lead', 'see these', '--file', first, '--file', second], {
      from: 'user',
    });

    expect(relay.files.upload.mock.calls.map(([i]) => [i.filename, i.contentType])).toEqual([
      ['one.png', 'image/png'],
      ['two.pdf', 'application/pdf'],
    ]);
    expect(relay.messages.direct).toHaveBeenCalledWith({
      to: 'lead',
      text: 'see these',
      attachments: ['file-one.png', 'file-two.pdf'],
    });
  });

  it('post and send_group accept --file', async () => {
    const { program, relay } = harness();
    const file = await png();

    await program.parseAsync(['message', 'post', 'ops', 'hello', '--file', file], { from: 'user' });
    await program.parseAsync(['message', 'dm', 'send_group', 'hi team', '--to', 'lead', 'worker', '--file', file], {
      from: 'user',
    });

    expect(relay.messages.send).toHaveBeenCalledWith({ channel: 'ops', text: 'hello', attachments: ['file-shot.png'] });
    expect(relay.messages.groupDirect).toHaveBeenCalledWith({
      participants: ['lead', 'worker'],
      text: 'hi team',
      attachments: ['file-shot.png'],
    });
  });

  it('does not send the message when a file cannot be read', async () => {
    const { program, relay, error, exit } = harness();

    await program.parseAsync(['message', 'dm', 'send', 'lead', 'hi', '--file', path.join(dir, 'missing.png')], {
      from: 'user',
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining('not a readable file'));
    expect(exit).toHaveBeenCalledWith(1);
    expect(relay.files.upload).not.toHaveBeenCalled();
    expect(relay.messages.direct).not.toHaveBeenCalled();
  });

  it('file download writes the attachment under a sanitized name and prints the path', async () => {
    const { program, relay, log } = harness();

    await program.parseAsync(['message', 'file', 'download', 'file-1', '--out', dir], { from: 'user' });

    expect(relay.files.download).toHaveBeenCalledWith('file-1');
    const printed = JSON.parse(log.mock.calls[0][0] as string) as { path: string; contentType: string };
    expect(printed.path).toBe(path.join(dir, 'shot.png'));
    expect(printed.contentType).toBe('image/png');
    expect(await readFile(printed.path)).toEqual(PNG_BYTES);
  });

  it('file download defaults to .agent-relay/attachments/<id>/ under the working directory', async () => {
    const { program, log } = harness();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await program.parseAsync(['message', 'file', 'download', 'file-1'], { from: 'user' });
    } finally {
      process.chdir(cwd);
    }

    const printed = JSON.parse(log.mock.calls[0][0] as string) as { path: string };
    expect(await readFile(printed.path)).toEqual(PNG_BYTES);
    expect(path.relative(dir, printed.path).split(path.sep)).toEqual([
      '.agent-relay',
      'attachments',
      'file-1',
      'shot.png',
    ]);
  });
});
