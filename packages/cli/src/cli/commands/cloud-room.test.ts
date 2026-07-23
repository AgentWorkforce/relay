import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerCloudRoomCommands } from './cloud-room.js';
import type { CloudDependencies } from './cloud.js';

vi.mock('@agent-relay/cloud', () => ({
  defaultApiUrl: () => 'https://cloud.test',
}));

type RoomDeps = Pick<
  CloudDependencies,
  'log' | 'error' | 'exit' | 'ensureCloudSession' | 'authorizedApiFetch'
>;

const auth = {
  apiUrl: 'https://cloud.test',
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
};
const refreshedAuth = {
  ...auth,
  accessToken: 'refreshed-access-secret',
  refreshToken: 'rotated-refresh-secret',
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function createHarness(roomIo?: Parameters<typeof registerCloudRoomCommands>[2]) {
  const exit = vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as unknown as RoomDeps['exit'];
  const deps: RoomDeps = {
    log: vi.fn(),
    error: vi.fn(),
    exit,
    ensureCloudSession: vi.fn(async () => ({ auth, client: {} as never })) as RoomDeps['ensureCloudSession'],
    authorizedApiFetch: vi.fn(async () => ({
      response: jsonResponse({}),
      auth,
    })) as RoomDeps['authorizedApiFetch'],
  };
  const program = new Command();
  program.exitOverride();
  const cloud = program.command('cloud');
  registerCloudRoomCommands(cloud, deps, roomIo);
  return { program, deps, room: cloud.commands[0] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerCloudRoomCommands', () => {
  it('registers the complete room lifecycle', () => {
    const { room } = createHarness();

    expect(room.name()).toBe('room');
    expect(room.commands.map((command) => command.name())).toEqual([
      'invite',
      'invites',
      'revoke-invite',
      'members',
      'remove-member',
      'accept',
      'revoke-session',
      'session',
    ]);
  });

  it('creates an email-bound invite with a finite role and lifetime', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        invite: {
          id: 'invite_1',
          email: 'person@example.com',
          role: 'viewer',
          token: 'herdr_inv_single_use_secret',
          expiresAt: '2026-07-30T00:00:00.000Z',
          createdAt: '2026-07-23T00:00:00.000Z',
        },
      }),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'room',
      'invite',
      '--workspace',
      'rw_7ccfea89',
      '--email',
      'Person@Example.com',
      '--role',
      'viewer',
      '--expires-in',
      '600',
      '--token-stdout',
    ]);

    expect(deps.ensureCloudSession).toHaveBeenCalledWith({
      apiUrl: 'https://cloud.test',
      interactive: false,
    });
    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/room/invites',
      {
        method: 'POST',
        body: JSON.stringify({
          email: 'person@example.com',
          role: 'viewer',
          expiresInSeconds: 600,
        }),
      },
      { interactive: false }
    );
    expect(deps.log).toHaveBeenCalledWith('herdr_inv_single_use_secret');
  });

  it('sends an invitation by email without returning its one-time token', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        invite: {
          id: 'invite_1',
          email: 'person@example.com',
          role: 'participant',
          expiresAt: '2026-07-30T00:00:00.000Z',
          createdAt: '2026-07-23T00:00:00.000Z',
        },
        delivery: { mode: 'email', status: 'sent' },
      }),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'room',
      'invite',
      '--workspace',
      'rw_7ccfea89',
      '--email',
      'person@example.com',
      '--email-delivery',
      '--json',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/room/invites',
      {
        method: 'POST',
        body: JSON.stringify({
          email: 'person@example.com',
          role: 'participant',
          expiresInSeconds: 604800,
          delivery: 'email',
        }),
      },
      { interactive: false }
    );
    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('"status": "sent"');
    expect(output).not.toContain('herdr_inv_');
  });

  it('requires explicit email delivery or one token sink before authenticating', async () => {
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'room',
        'invite',
        '--workspace',
        'rw_7ccfea89',
        '--email',
        'person@example.com',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(
      'Use --email-delivery (optionally with --json), or exactly one manual token sink: --token-stdout, --token-file, or --json.'
    );
  });

  it('rejects combining email delivery with a manual token sink before authenticating', async () => {
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'room',
        'invite',
        '--workspace',
        'rw_7ccfea89',
        '--email',
        'person@example.com',
        '--email-delivery',
        '--token-stdout',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
  });

  it('writes an invitation token only to a new owner-only file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-room-invite-output-'));
    const tokenFile = path.join(directory, 'invite-token');
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        invite: {
          id: 'invite_1',
          email: 'person@example.com',
          role: 'participant',
          token: 'herdr_inv_file_secret',
          expiresAt: '2026-07-30T00:00:00.000Z',
          createdAt: '2026-07-23T00:00:00.000Z',
        },
      }),
      auth,
    });

    try {
      await program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'room',
        'invite',
        '--workspace',
        'rw_7ccfea89',
        '--email',
        'person@example.com',
        '--token-file',
        tokenFile,
      ]);
      expect(fs.readFileSync(tokenFile, 'utf8')).toBe('herdr_inv_file_secret\n');
      if (process.platform !== 'win32') {
        expect(fs.statSync(tokenFile).mode & 0o077).toBe(0);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).not.toContain('herdr_inv_file_secret');
  });

  it('revokes a newly created invite when its token file cannot be created', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-room-invite-output-'));
    const tokenFile = path.join(directory, 'existing');
    fs.writeFileSync(tokenFile, 'do-not-overwrite', { mode: 0o600 });
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch)
      .mockResolvedValueOnce({
        response: jsonResponse({
          invite: {
            id: 'invite_1',
            email: 'person@example.com',
            role: 'participant',
            token: 'herdr_inv_lost_secret',
            expiresAt: '2026-07-30T00:00:00.000Z',
            createdAt: '2026-07-23T00:00:00.000Z',
          },
        }),
        auth: refreshedAuth,
      })
      .mockResolvedValueOnce({
        response: new Response(null, { status: 204 }),
        auth: refreshedAuth,
      });

    try {
      await expect(
        program.parseAsync([
          'node',
          'agent-relay',
          'cloud',
          'room',
          'invite',
          '--workspace',
          'rw_7ccfea89',
          '--email',
          'person@example.com',
          '--token-file',
          tokenFile,
        ])
      ).rejects.toThrow('exit:1');
      expect(fs.readFileSync(tokenFile, 'utf8')).toBe('do-not-overwrite');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    expect(deps.authorizedApiFetch).toHaveBeenNthCalledWith(
      2,
      refreshedAuth,
      '/api/v1/workspaces/rw_7ccfea89/room/invites/invite_1',
      { method: 'DELETE' },
      { interactive: false }
    );
    expect(deps.ensureCloudSession).toHaveBeenCalledTimes(1);
    expect(
      [...vi.mocked(deps.log).mock.calls, ...vi.mocked(deps.error).mock.calls].flat().join('\n')
    ).not.toContain('herdr_inv_lost_secret');
  });

  it('reports invite write and rollback failure without printing either error detail', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-room-token-'));
    const tokenFile = path.join(directory, 'existing');
    fs.writeFileSync(tokenFile, 'do-not-overwrite', { mode: 0o600 });
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch)
      .mockResolvedValueOnce({
        response: jsonResponse({
          invite: {
            id: 'invite_1',
            email: 'person@example.com',
            role: 'viewer',
            token: 'herdr_inv_lost_secret',
            expiresAt: '2026-07-30T00:00:00.000Z',
            createdAt: '2026-07-23T00:00:00.000Z',
          },
        }),
        auth: refreshedAuth,
      })
      .mockRejectedValueOnce(new Error('cleanup-secret-marker'));
    try {
      await expect(
        program.parseAsync([
          'node',
          'agent-relay',
          'cloud',
          'room',
          'invite',
          '--workspace',
          'rw_7ccfea89',
          '--email',
          'person@example.com',
          '--token-file',
          tokenFile,
        ])
      ).rejects.toThrow('exit:1');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    const output = vi.mocked(deps.error).mock.calls.flat().join('\n');
    expect(output).toContain('Revocation could not be confirmed; revoke invitation invite_1');
    expect(output).not.toContain('cleanup-secret-marker');
    expect(output).not.toContain('EEXIST');
    expect(output).not.toContain('herdr_inv_lost_secret');
  });

  it.each([
    {
      args: ['invites', '--workspace', 'rw_7ccfea89', '--json'],
      path: '/api/v1/workspaces/rw_7ccfea89/room/invites',
      method: 'GET',
      response: { invites: [] },
    },
    {
      args: ['revoke-invite', 'invite_1', '--workspace', 'rw_7ccfea89', '--json'],
      path: '/api/v1/workspaces/rw_7ccfea89/room/invites/invite_1',
      method: 'DELETE',
      response: null,
    },
    {
      args: ['members', '--workspace', 'rw_7ccfea89', '--json'],
      path: '/api/v1/workspaces/rw_7ccfea89/room/members',
      method: 'GET',
      response: { members: [] },
    },
    {
      args: ['remove-member', 'member_1', '--workspace', 'rw_7ccfea89', '--json'],
      path: '/api/v1/workspaces/rw_7ccfea89/room/members/member_1',
      method: 'DELETE',
      response: null,
    },
    {
      args: ['revoke-session', '--workspace', 'rw_7ccfea89', '--device-id', 'herdr-desktop-1', '--json'],
      path: '/api/v1/workspaces/rw_7ccfea89/room/session',
      method: 'DELETE',
      body: JSON.stringify({ deviceId: 'herdr-desktop-1' }),
      response: null,
    },
  ])('routes $args.0 through the scoped workspace API', async ({ args, path, method, body, response }) => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response === null ? new Response(null, { status: 204 }) : jsonResponse(response),
      auth,
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'room', ...args]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(auth, path, body ? { method, body } : { method }, {
      interactive: false,
    });
  });

  it('accepts an invitation without echoing its token', async () => {
    const token = 'herdr_inv_room_secret';
    const { program, deps } = createHarness({
      readStdin: vi.fn(async () => token),
    });
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        membership: {
          id: 'member_1',
          workspaceId: 'rw_7ccfea89',
          role: 'participant',
        },
      }),
      auth,
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'room', 'accept', '--token-stdin']);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/room/invites/accept',
      {
        method: 'POST',
        body: JSON.stringify({ token }),
      },
      { interactive: false }
    );
    expect(
      [...vi.mocked(deps.log).mock.calls, ...vi.mocked(deps.error).mock.calls].flat().join('\n')
    ).not.toContain(token);
  });

  it('requires exactly one private invitation-token input', async () => {
    const { program, deps } = createHarness();

    await expect(program.parseAsync(['node', 'agent-relay', 'cloud', 'room', 'accept'])).rejects.toThrow(
      'exit:1'
    );

    expect(deps.error).toHaveBeenCalledWith('Use exactly one of --token-stdin or --token-file.');
    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
  });

  it('reads an invitation token from an owner-only regular file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-room-token-'));
    const tokenFile = path.join(directory, 'invite');
    fs.writeFileSync(tokenFile, 'herdr_inv_single_use_secret\n', { mode: 0o600 });
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        membership: {
          id: 'member_1',
          workspaceId: 'rw_7ccfea89',
          role: 'viewer',
        },
      }),
      auth,
    });

    try {
      await program.parseAsync(['node', 'agent-relay', 'cloud', 'room', 'accept', '--token-file', tokenFile]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/room/invites/accept',
      {
        method: 'POST',
        body: JSON.stringify({ token: 'herdr_inv_single_use_secret' }),
      },
      { interactive: false }
    );
  });

  it('rejects a symlink invitation-token file before authenticating', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-room-token-'));
    const tokenFile = path.join(directory, 'invite');
    const tokenLink = path.join(directory, 'invite-link');
    fs.writeFileSync(tokenFile, 'herdr_inv_single_use_secret\n', { mode: 0o600 });
    fs.symlinkSync(tokenFile, tokenLink);
    const { program, deps } = createHarness();

    try {
      await expect(
        program.parseAsync(['node', 'agent-relay', 'cloud', 'room', 'accept', '--token-file', tokenLink])
      ).rejects.toThrow('exit:1');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }

    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
  });

  it('rejects a malformed invitation token before authenticating', async () => {
    const { program, deps } = createHarness({
      readStdin: vi.fn(async () => 'not-a-room-invitation'),
    });

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'room', 'accept', '--token-stdin'])
    ).rejects.toThrow('exit:1');

    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith('Invalid room invitation token.');
  });

  it('hides the scoped room credential unless JSON was explicitly requested', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        role: 'participant',
        relaycastBaseUrl: 'https://relay.test',
        agentName: 'human-device-1',
        agentToken: 'at_live_scoped_secret',
      }),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'room',
      'session',
      '--workspace',
      'rw_7ccfea89',
      '--device-id',
      'herdr-desktop-1',
    ]);

    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('Room session ready with role participant.');
    expect(output).not.toContain('at_live_scoped_secret');
  });

  it('supports an explicit Cloud API URL only when the stored login matches it', async () => {
    const { program, deps } = createHarness();
    const localAuth = { ...auth, apiUrl: 'http://127.0.0.1:8787' };
    vi.mocked(deps.ensureCloudSession).mockResolvedValueOnce({
      auth: localAuth,
      client: {} as never,
    });
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({ members: [] }),
      auth: localAuth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'room',
      'members',
      '--workspace',
      'rw_7ccfea89',
      '--api-url',
      'http://127.0.0.1:8787',
    ]);

    expect(deps.ensureCloudSession).toHaveBeenCalledWith({
      apiUrl: 'http://127.0.0.1:8787',
      interactive: false,
    });
    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      localAuth,
      '/api/v1/workspaces/rw_7ccfea89/room/members',
      { method: 'GET' },
      { interactive: false }
    );
  });

  it('fails closed when an explicit API URL differs from the stored login host', async () => {
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'room',
        'members',
        '--workspace',
        'rw_7ccfea89',
        '--api-url',
        'http://127.0.0.1:8787',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.authorizedApiFetch).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(
      expect.stringContaining('cloud login --api-url http://127.0.0.1:8787 --force')
    );
  });

  it('emits the scoped room credential for an explicitly requested machine-readable session', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        role: 'viewer',
        relaycastBaseUrl: 'https://relay.test',
        observerToken: 'ot_live_scoped_secret',
      }),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'room',
      'session',
      '--workspace',
      'rw_7ccfea89',
      '--device-id',
      'herdr-desktop-1',
      '--json',
    ]);

    expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).toContain('ot_live_scoped_secret');
  });

  it.each([
    {
      role: 'participant',
      relaycastBaseUrl: 'https://relay.test',
      agentName: 'human-device-1',
      agentToken: 'workspace-owner-key',
    },
    {
      role: 'viewer',
      relaycastBaseUrl: 'https://relay.test',
      observerToken: 'workspace-owner-key',
    },
    {
      role: 'participant',
      relaycastBaseUrl: 'http://relay.example.com',
      agentName: 'human-device-1',
      agentToken: 'at_live_scoped_secret',
    },
    {
      role: 'viewer',
      relaycastBaseUrl: 'https://user:password@relay.example.com',
      observerToken: 'ot_live_scoped_secret',
    },
  ])('rejects unsafe or incorrectly scoped session material', async (session) => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse(session),
      auth,
    });

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'room',
        'session',
        '--workspace',
        'rw_7ccfea89',
        '--device-id',
        'herdr-desktop-1',
        '--json',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('invalid'));
  });

  it('rejects unsafe workspace selectors before authenticating', async () => {
    const { program, deps } = createHarness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'room',
        'members',
        '--workspace',
        'rk_live_workspace_secret',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith(
      'Unsupported Cloud workspace identifier. Use a Cloud workspace UUID or unified rw_ workspace ID.'
    );
    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
    expect(vi.mocked(deps.error).mock.calls.flat().join('\n')).not.toContain('rk_live_workspace_secret');
  });

  it('does not reflect server response bodies that may contain credentials', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({ error: 'bad session at_live_should_not_leak' }, 400),
      auth,
    });

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'room', 'members', '--workspace', 'rw_7ccfea89'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith('Cloud rejected the room request (400).');
    expect(vi.mocked(deps.error).mock.calls.flat().join('\n')).not.toContain('at_live_should_not_leak');
  });

  it('sanitizes terminal controls and bidi overrides in human-readable room lists', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        members: [
          {
            id: 'member_1',
            userId: 'user_1',
            email: '\u001b[31mmallory@example.com\n\u202e',
            name: 'Mallory\nAdmin\u202e',
            role: 'participant',
            status: 'active',
            joinedAt: '2026-07-23T00:00:00.000Z',
          },
        ],
      }),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'room',
      'members',
      '--workspace',
      'rw_7ccfea89',
    ]);

    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('mallory@example.com��');
    expect(output).not.toContain('\u001b');
    expect(output).not.toContain('\u202e');
  });

  it('treats server resource IDs as opaque while encoding them into URL paths', async () => {
    const { program, deps } = createHarness();

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'room',
      'revoke-invite',
      'future:id/with+safe?shape',
      '--workspace',
      'rw_7ccfea89',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/room/invites/future%3Aid%2Fwith%2Bsafe%3Fshape',
      { method: 'DELETE' },
      { interactive: false }
    );
  });

  it.each(['12s', '1.5', '59', '2592001'])(
    'rejects an invalid invitation lifetime %s before authenticating',
    async (expiresIn) => {
      const { program, deps } = createHarness();

      await expect(
        program.parseAsync([
          'node',
          'agent-relay',
          'cloud',
          'room',
          'invite',
          '--workspace',
          'rw_7ccfea89',
          '--email',
          'person@example.com',
          '--expires-in',
          expiresIn,
        ])
      ).rejects.toThrow();

      expect(deps.ensureCloudSession).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['invitation', ['invite', '--workspace', 'rw_7ccfea89', '--email', 'p@example.com', '--token-stdout']],
    ['invitation list', ['invites', '--workspace', 'rw_7ccfea89']],
    ['member list', ['members', '--workspace', 'rw_7ccfea89']],
    ['membership', ['accept', '--token-stdin']],
    ['session', ['session', '--workspace', 'rw_7ccfea89', '--device-id', 'herdr-1']],
  ])('rejects a malformed successful %s response', async (_label, args) => {
    const { program, deps } = createHarness({
      readStdin: vi.fn(async () => 'herdr_inv_single_use_secret'),
    });

    await expect(program.parseAsync(['node', 'agent-relay', 'cloud', 'room', ...args])).rejects.toThrow(
      'exit:1'
    );

    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('invalid'));
  });

  it('rejects forbidden workspace credentials even in a successful response', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        members: [],
        workspaceKey: 'rk_live_must_not_escape',
      }),
      auth,
    });

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'room',
        'members',
        '--workspace',
        'rw_7ccfea89',
        '--json',
      ])
    ).rejects.toThrow('exit:1');

    const output = [...vi.mocked(deps.log).mock.calls, ...vi.mocked(deps.error).mock.calls].flat().join('\n');
    expect(output).not.toContain('rk_live_must_not_escape');
    expect(deps.error).toHaveBeenCalledWith(
      'Cloud room returned a forbidden workspace or integration credential.'
    );
  });

  it.each([
    {
      role: 'viewer',
      relaycastBaseUrl: 'https://relay.test',
      agentToken: 'at_wrong_role',
    },
    {
      role: 'participant',
      relaycastBaseUrl: 'https://relay.test',
      agentName: 'human-device-1',
      observerToken: 'ot_wrong_role',
    },
    {
      role: 'participant',
      relaycastBaseUrl: 'https://relay.test',
      agentToken: 'at_missing_name',
    },
  ])('rejects a mismatched session credential matrix', async (response) => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse(response),
      auth,
    });

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'room',
        'session',
        '--workspace',
        'rw_7ccfea89',
        '--device-id',
        'herdr-1',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith(
      expect.stringMatching(/invalid (viewer|participant) session response/)
    );
  });
});
