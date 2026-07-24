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

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function roomInvitationToken(character = 'A') {
  return `relay_room_inv_${character.repeat(43)}`;
}

function invite(token = roomInvitationToken()) {
  return {
    invite: {
      id: 'invite_1',
      email: 'person@example.com',
      role: 'participant',
      token,
      expiresAt: '2026-07-30T00:00:00.000Z',
      createdAt: '2026-07-23T00:00:00.000Z',
    },
  };
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
  it('registers the complete trusted-participant lifecycle', () => {
    const { room } = createHarness();
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

  it('creates only participant invitations', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse(invite()),
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
      '--expires-in',
      '600',
      '--token-stdout',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/room/invites',
      {
        method: 'POST',
        body: JSON.stringify({
          email: 'person@example.com',
          role: 'participant',
          expiresInSeconds: 600,
        }),
      },
      { interactive: false }
    );
    expect(deps.log).toHaveBeenCalledWith(roomInvitationToken());
  });

  it('does not expose viewer or email-delivery invite options', () => {
    const { room } = createHarness();
    const inviteCommand = room.commands.find((command) => command.name() === 'invite');
    expect(inviteCommand?.options.map((option) => option.long)).not.toContain('--role');
    expect(inviteCommand?.options.map((option) => option.long)).not.toContain('--email-delivery');
  });

  it('requires exactly one invitation token sink before authenticating', async () => {
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
      'Use exactly one invitation token sink: --token-stdout, --token-file, or --json.'
    );
  });

  it('writes a token only to a new owner-only file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-room-invite-'));
    const tokenFile = path.join(directory, 'token');
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse(invite(roomInvitationToken('B'))),
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
      expect(fs.readFileSync(tokenFile, 'utf8')).toBe(`${roomInvitationToken('B')}\n`);
      if (process.platform !== 'win32') {
        expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('revokes a newly-created invite when its token cannot be written', async () => {
    const { program, deps } = createHarness({
      writeSecretFile: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    vi.mocked(deps.authorizedApiFetch)
      .mockResolvedValueOnce({ response: jsonResponse(invite()), auth })
      .mockResolvedValueOnce({ response: jsonResponse({ ok: true }), auth });

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
        '/unused',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.authorizedApiFetch).toHaveBeenNthCalledWith(
      2,
      auth,
      '/api/v1/workspaces/rw_7ccfea89/room/invites/invite_1',
      { method: 'DELETE' },
      { interactive: false }
    );
  });

  it('accepts an invitation only from an explicit secret source', async () => {
    const token = roomInvitationToken('C');
    const { program, deps } = createHarness({
      readStdin: vi.fn(async () => `${token}\n`),
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

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'room', 'accept', '--token-stdin', '--json']);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/room/invites/accept',
      {
        method: 'POST',
        body: JSON.stringify({ token }),
      },
      { interactive: false }
    );
  });

  it('rejects invitation tokens outside the Relay Room wire contract', async () => {
    for (const token of [
      `product_inv_${'A'.repeat(43)}`,
      `relay_room_inv_${'A'.repeat(42)}`,
      `relay_room_inv_${'A'.repeat(44)}`,
      `relay_room_inv_${'A'.repeat(42)}!`,
    ]) {
      const { program, deps } = createHarness({
        readStdin: vi.fn(async () => `${token}\n`),
      });

      await expect(
        program.parseAsync(['node', 'agent-relay', 'cloud', 'room', 'accept', '--token-stdin'])
      ).rejects.toThrow('exit:1');
      expect(deps.error).toHaveBeenCalledWith('Invalid room invitation token.');
      expect(deps.ensureCloudSession).not.toHaveBeenCalled();
      expect(deps.authorizedApiFetch).not.toHaveBeenCalled();
    }
  });

  it('rejects non-participant member responses', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        members: [
          {
            id: 'member_1',
            userId: 'user_1',
            email: 'person@example.com',
            name: null,
            role: 'viewer',
            status: 'active',
            joinedAt: '2026-07-23T00:00:00.000Z',
          },
        ],
      }),
      auth,
    });

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'room', 'members', '--workspace', 'rw_7ccfea89'])
    ).rejects.toThrow('exit:1');
    expect(deps.error).toHaveBeenCalledWith('Cloud room returned an invalid member list response.');
  });

  it('creates a human Relaycast session for a participant device', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        role: 'participant',
        relaycastBaseUrl: 'https://relay.example.com',
        agentName: 'human-person-device',
        agentToken: 'at_live_device_secret',
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
      'herdr-device',
      '--json',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/room/session',
      {
        method: 'POST',
        body: JSON.stringify({ deviceId: 'herdr-device' }),
      },
      { interactive: false }
    );
    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('"role": "participant"');
    expect(output).toContain('at_live_device_secret');
  });

  it('rejects observer sessions from Cloud', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({
        role: 'viewer',
        relaycastBaseUrl: 'https://relay.example.com',
        observerToken: 'ot_live_observer',
      }),
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
        'herdr-device',
      ])
    ).rejects.toThrow('exit:1');
  });

  it('revokes the current device session', async () => {
    const { program, deps } = createHarness();

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'room',
      'revoke-session',
      '--workspace',
      'rw_7ccfea89',
      '--device-id',
      'herdr-device',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/room/session',
      {
        method: 'DELETE',
        body: JSON.stringify({ deviceId: 'herdr-device' }),
      },
      { interactive: false }
    );
  });

  it('does not reuse a login bound to another explicit API host', async () => {
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
        'https://other.test',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.authorizedApiFetch).not.toHaveBeenCalled();
  });

  it('maps rate limits without reflecting response bodies', async () => {
    const { program, deps } = createHarness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: jsonResponse({ error: 'private detail' }, 429, { 'retry-after': '5' }),
      auth,
    });

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'room', 'members', '--workspace', 'rw_7ccfea89'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith('Cloud room rate limit exceeded. Retry-After: 5 seconds.');
    expect(vi.mocked(deps.error).mock.calls.flat().join('\n')).not.toContain('private detail');
  });
});
