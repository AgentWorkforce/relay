import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { type StoredAuth } from '@agent-relay/cloud';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerDlqCommands, type DlqDependencies } from './dlq.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-dlq-'));
  tempRoots.push(root);
  return root;
}

function writeDlqRecord(root: string, workspace: string, fileName: string, record: unknown): void {
  const dir = path.join(root, '_dlq', workspace);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
}

function createHarness(options?: {
  projectRoot?: string;
  fetchImpl?: typeof fetch;
  authorizedApiFetchImpl?: DlqDependencies['authorizedApiFetch'];
  now?: number;
}) {
  const projectRoot = options?.projectRoot ?? makeTempRoot();
  const fetchImpl =
    options?.fetchImpl ??
    (vi.fn(
      async () => ({ ok: true, status: 202, text: async () => '' }) as unknown as Response
    ) as typeof fetch);
  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as DlqDependencies['exit'];

  const deps: DlqDependencies = {
    getProjectRoot: vi.fn(() => projectRoot),
    fs,
    fetch: fetchImpl,
    ensureAuthenticated: vi.fn(
      async () => ({ accessToken: 'access', refreshToken: 'refresh' }) as StoredAuth
    ),
    authorizedApiFetch:
      options?.authorizedApiFetchImpl ??
      vi.fn(async () => ({
        auth: { accessToken: 'access', refreshToken: 'refresh' } as StoredAuth,
        response: new Response(JSON.stringify({ error: 'unsupported' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      })),
    env: {},
    defaultCloudUrl: 'https://cloud.test',
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
    now: vi.fn(() => options?.now ?? Date.parse('2026-05-12T12:00:00.000Z')),
  };

  const program = new Command();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  program.exitOverride();
  registerDlqCommands(program, deps);

  return { program, deps, projectRoot, fetchImpl };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err: any) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    if (typeof err?.exitCode === 'number') {
      return err.exitCode;
    }
    throw err;
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('registerDlqCommands', () => {
  it('registers the dlq command group', () => {
    const { program } = createHarness();
    expect(program.commands.map((command) => command.name())).toContain('dlq');
  });

  it('lists summarized DLQ records for a workspace', async () => {
    const { program, deps, projectRoot } = createHarness();
    writeDlqRecord(projectRoot, 'support', 'evt_alpha.json', {
      event: { id: 'evt_alpha', type: 'message.created' },
      error: { message: 'timeout' },
      attemptCount: 3,
      firstSeenAt: '2026-05-10T10:00:00.000Z',
      lastSeenAt: '2026-05-11T11:00:00.000Z',
    });
    writeDlqRecord(projectRoot, 'support', 'evt_beta.json', {
      event_id: 'evt_beta',
      type: 'dm.received',
      error: 'unsupported_operation',
      attempts: 1,
      created_at: '2026-05-09T09:00:00.000Z',
      updated_at: '2026-05-09T09:30:00.000Z',
    });

    const exitCode = await runCommand(program, ['dlq', 'list', '--workspace', 'support']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenNthCalledWith(
      1,
      'evt_alpha | message.created | attempts=3 | first=2026-05-10T10:00:00.000Z | last=2026-05-11T11:00:00.000Z | error=timeout'
    );
    expect(deps.log).toHaveBeenNthCalledWith(
      2,
      'evt_beta | dm.received | attempts=1 | first=2026-05-09T09:00:00.000Z | last=2026-05-09T09:30:00.000Z | error=unsupported_operation'
    );
  });

  it('prints the full record for inspect', async () => {
    const { program, deps, projectRoot } = createHarness();
    const record = {
      event: { id: 'evt_inspect', type: 'thread.reply' },
      error: { message: 'delivery_failed' },
      attemptCount: 2,
    };
    writeDlqRecord(projectRoot, 'ops', 'evt_inspect.json', record);

    const exitCode = await runCommand(program, ['dlq', 'inspect', '--workspace', 'ops', 'evt_inspect']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(JSON.stringify(record, null, 2));
  });

  it('replays all records through their replay metadata when --all is passed', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 202, text: async () => '' }) as unknown as Response
    ) as typeof fetch;
    const { program, deps, projectRoot } = createHarness({ fetchImpl });
    writeDlqRecord(projectRoot, 'sales', 'evt_one.json', {
      event: { id: 'evt_one', type: 'message.created' },
      replay: {
        url: 'http://127.0.0.1:18790/replay',
        body: { eventId: 'evt_one' },
      },
    });
    writeDlqRecord(projectRoot, 'sales', 'evt_two.json', {
      event: { id: 'evt_two', type: 'dm.received' },
      replay: {
        url: 'http://127.0.0.1:18790/replay',
        body: { eventId: 'evt_two' },
      },
    });

    const exitCode = await runCommand(program, ['dlq', 'replay', '--workspace', 'sales', '--all']);

    expect(exitCode).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:18790/replay',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ eventId: 'evt_one' }),
      })
    );
    expect(deps.log).toHaveBeenNthCalledWith(1, 'Replayed evt_one -> http://127.0.0.1:18790/replay (202)');
    expect(deps.log).toHaveBeenNthCalledWith(2, 'Replayed evt_two -> http://127.0.0.1:18790/replay (202)');
  });

  it('purges only records older than the requested duration', async () => {
    const { program, deps, projectRoot } = createHarness({
      now: Date.parse('2026-05-12T12:00:00.000Z'),
    });
    writeDlqRecord(projectRoot, 'eng', 'evt_old.json', {
      event: { id: 'evt_old', type: 'message.created' },
      lastSeenAt: '2026-05-10T09:00:00.000Z',
    });
    writeDlqRecord(projectRoot, 'eng', 'evt_new.json', {
      event: { id: 'evt_new', type: 'message.created' },
      lastSeenAt: '2026-05-12T11:30:00.000Z',
    });

    const exitCode = await runCommand(program, ['dlq', 'purge', '--workspace', 'eng', '--older-than', '24h']);

    expect(exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(projectRoot, '_dlq', 'eng', 'evt_old.json'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '_dlq', 'eng', 'evt_new.json'))).toBe(true);
    expect(deps.log).toHaveBeenCalledWith('Purged 1 DLQ record(s) from workspace "eng".');
  });

  it('prefers the cloud workspace DLQ APIs when they are available', async () => {
    const authorizedApiFetchImpl = vi.fn(async (_auth, requestPath, init) => {
      if (requestPath === '/api/v1/workspaces/support/dlq' && init?.method === 'DELETE') {
        return {
          auth: { accessToken: 'access', refreshToken: 'refresh' } as StoredAuth,
          response: new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        };
      }
      if (requestPath === '/api/v1/workspaces/support/dlq/evt_remote/replay') {
        return {
          auth: { accessToken: 'access', refreshToken: 'refresh' } as StoredAuth,
          response: new Response(JSON.stringify({ ok: true }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          }),
        };
      }
      if (requestPath === '/api/v1/workspaces/support/dlq/evt_remote') {
        return {
          auth: { accessToken: 'access', refreshToken: 'refresh' } as StoredAuth,
          response: new Response(
            JSON.stringify({
              ok: true,
              data: {
                event: { id: 'evt_remote', type: 'message.created' },
                error: { message: 'remote_timeout' },
                attemptCount: 2,
                firstSeenAt: '2026-05-10T10:00:00.000Z',
                lastSeenAt: '2026-05-11T11:00:00.000Z',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ),
        };
      }
      return {
        auth: { accessToken: 'access', refreshToken: 'refresh' } as StoredAuth,
        response: new Response(
          JSON.stringify({
            ok: true,
            data: {
              items: [{ eventId: 'evt_remote' }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      };
    }) as DlqDependencies['authorizedApiFetch'];
    const { program, deps } = createHarness({ authorizedApiFetchImpl });

    const listExitCode = await runCommand(program, ['dlq', 'list', '--workspace', 'support']);
    expect(listExitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(
      'evt_remote | message.created | attempts=2 | first=2026-05-10T10:00:00.000Z | last=2026-05-11T11:00:00.000Z | error=remote_timeout'
    );

    const inspectExitCode = await runCommand(program, [
      'dlq',
      'inspect',
      '--workspace',
      'support',
      'evt_remote',
    ]);
    expect(inspectExitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          event: { id: 'evt_remote', type: 'message.created' },
          error: { message: 'remote_timeout' },
          attemptCount: 2,
          firstSeenAt: '2026-05-10T10:00:00.000Z',
          lastSeenAt: '2026-05-11T11:00:00.000Z',
        },
        null,
        2
      )
    );

    const replayExitCode = await runCommand(program, [
      'dlq',
      'replay',
      '--workspace',
      'support',
      'evt_remote',
    ]);
    expect(replayExitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Replayed evt_remote via cloud workspace API.');

    const purgeExitCode = await runCommand(program, ['dlq', 'purge', '--workspace', 'support']);
    expect(purgeExitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(
      'Purged DLQ records from workspace "support" via cloud workspace API.'
    );
  });
});
