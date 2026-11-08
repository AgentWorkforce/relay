import { createHash, createHmac } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CallerCredential,
  authenticate,
  callerTranscript,
  readCallerCredential,
  type CallerChallenge,
  type CallerTranscriptInput,
} from './auth.js';
import type { CoreClient, HelloResult } from './client.js';
import { CoreBridgeError, CoreRpcError } from './errors.js';

interface Vectors {
  version: number;
  base: {
    secret: string;
    key_hex: string;
    challenge_id: string;
    nonce: string;
    caller_id: string;
    site_url: string;
    workspace_id: string;
    user_id: string;
    issued_at_ms: number;
    expires_at_ms: number;
    transcript_len: number;
    transcript_hex: string;
    authenticator_hex: string;
    authenticator: string;
  };
  substitutions: Array<{ field: string; value: string | number; authenticator: string }>;
}

const vectors = JSON.parse(
  readFileSync(new URL('../fixtures/caller-transcript-v1.json', import.meta.url), 'utf8')
) as Vectors;
const base = vectors.base;

const document = (fields: Record<string, unknown> = {}) => ({
  schema: 'agent-relay-service-caller/2',
  auth: 'challenge-hmac-sha256/v1',
  caller_id: base.caller_id,
  secret: base.secret,
  workspace: { site_url: base.site_url, workspace_id: base.workspace_id },
  account: { user_id: base.user_id },
  harnesses: ['claude'],
  ...fields,
});

const challenge: CallerChallenge = {
  version: 1,
  challenge_id: base.challenge_id,
  nonce: base.nonce,
  issued_at_ms: base.issued_at_ms,
  expires_at_ms: base.expires_at_ms,
};

const input = (): CallerTranscriptInput => ({
  challengeId: base.challenge_id,
  nonce: Buffer.from(base.nonce, 'base64url'),
  callerId: base.caller_id,
  siteUrl: base.site_url,
  workspaceId: base.workspace_id,
  userId: base.user_id,
  issuedAtMs: base.issued_at_ms,
  expiresAtMs: base.expires_at_ms,
});

const key = () => createHash('sha256').update(base.secret, 'utf8').digest();
const mac = (transcript: Buffer) => createHmac('sha256', key()).update(transcript).digest('base64url');

describe('caller transcript v1', () => {
  it('matches the worked example byte for byte', () => {
    const transcript = callerTranscript(input());
    expect(key().toString('hex')).toBe(base.key_hex);
    expect(transcript.length).toBe(base.transcript_len);
    expect(transcript.toString('hex')).toBe(base.transcript_hex);
    expect(createHmac('sha256', key()).update(transcript).digest('hex')).toBe(base.authenticator_hex);
    expect(CallerCredential.fromDocument(document()).authenticatorFor(challenge)).toBe(base.authenticator);
  });

  it.each(vectors.substitutions.map((s) => [s.field, s] as const))(
    'changes the authenticator when %s changes',
    (_field, substitution) => {
      let transcript: Buffer;
      if (substitution.field === 'version') {
        transcript = Buffer.from(callerTranscript(input()));
        transcript[0] = substitution.value as number;
      } else if (substitution.field === 'domain') {
        const domain = Buffer.from(substitution.value as string, 'ascii');
        transcript = Buffer.from(callerTranscript(input()));
        expect(domain.length).toBe(29);
        domain.copy(transcript, 3);
      } else {
        const names: Record<string, keyof CallerTranscriptInput> = {
          challenge_id: 'challengeId',
          nonce: 'nonce',
          caller_id: 'callerId',
          site_url: 'siteUrl',
          workspace_id: 'workspaceId',
          user_id: 'userId',
          issued_at_ms: 'issuedAtMs',
          expires_at_ms: 'expiresAtMs',
        };
        const name = names[substitution.field];
        expect(name).toBeDefined();
        const value =
          substitution.field === 'nonce'
            ? Buffer.from(substitution.value as string, 'base64url')
            : substitution.value;
        transcript = callerTranscript({ ...input(), [name]: value });
      }
      const authenticator = mac(transcript);
      expect(authenticator).toBe(substitution.authenticator);
      expect(authenticator).not.toBe(base.authenticator);
    }
  );

  it('refuses values outside their bounds', () => {
    const bad: Array<Partial<CallerTranscriptInput>> = [
      { nonce: Buffer.alloc(31) },
      { challengeId: 'ch_00112233445566778899AABBCCDDEEFF' },
      { callerId: 'sc_0123456789ABCDEF' },
      { callerId: 'sc_0123456789abcde' },
      { siteUrl: '' },
      { siteUrl: 'x'.repeat(2049) },
      { workspaceId: 'x'.repeat(257) },
      { userId: '' },
      { issuedAtMs: -1 },
      { expiresAtMs: 2 ** 53 },
      { issuedAtMs: 1.5 },
    ];
    for (const fields of bad) {
      expect(() => callerTranscript({ ...input(), ...fields }), JSON.stringify(Object.keys(fields))).toThrow(
        CoreBridgeError
      );
    }
    expect(callerTranscript({ ...input(), siteUrl: 'x'.repeat(2048), userId: 'u'.repeat(256) }).length).toBe(
      base.transcript_len - 16 + 2048 - 12 + 256
    );
  });
});

describe('CallerCredential', () => {
  it('never prints its key or secret', () => {
    const credential = CallerCredential.fromDocument(document());
    const printed = [
      JSON.stringify(credential),
      String(credential),
      inspect(credential),
      inspect({ credential }),
    ];
    for (const text of printed) {
      expect(text).toContain('[redacted]');
      expect(text).not.toContain(base.secret);
      expect(text).not.toContain(base.key_hex);
    }
    expect(credential.callerId).toBe(base.caller_id);
    expect(Object.values(credential)).not.toContain(base.secret);
  });

  it('accepts a schema 1 file and refuses unknown schemas, auth schemes and malformed fields', () => {
    expect(
      CallerCredential.fromDocument(document({ schema: 'agent-relay-service-caller/1', auth: undefined }))
        .callerId
    ).toBe(base.caller_id);
    const bad = [
      document({ schema: 'agent-relay-service-caller/3' }),
      document({ auth: 'challenge-hmac-sha256/v2' }),
      document({ auth: undefined }),
      document({ caller_id: 'sc_0123456789ABCDEF' }),
      document({ caller_id: 'sc_0123456789abcdef0' }),
      document({ caller_id: 'xx_0123456789abcdef' }),
      document({ secret: 'rsc_short' }),
      document({ secret: undefined }),
      document({ workspace: { site_url: '', workspace_id: 'ws' } }),
      document({ workspace: undefined }),
      document({ account: { user_id: 7 } }),
      [],
      null,
    ];
    for (const doc of bad) {
      const error = (() => {
        try {
          CallerCredential.fromDocument(doc);
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(CoreBridgeError);
      expect((error as CoreBridgeError).code).toBe('caller_file_invalid');
      expect((error as Error).message).not.toContain(base.secret);
    }
  });
});

const BOUND = { caller_id: base.caller_id, caller_name: 'flows-runner', authority_generation: 7 };

function fakeClient(
  replies: Record<string, unknown>,
  methods = ['hello', 'spawn_callers.challenge', 'spawn_callers.authenticate']
) {
  const calls: Array<{ method: string; params: unknown; options: unknown }> = [];
  const hello: HelloResult = { bridge_version: 2, daemon_version: '17.2.1', pid: 1, methods, topics: [] };
  const client = {
    hello,
    socket: '/tmp/core.sock',
    closed: false,
    call: async (method: string, params?: unknown, options?: unknown) => {
      calls.push({ method, params, options });
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      return structuredClone(reply);
    },
  } as unknown as CoreClient;
  return { client, calls };
}

describe('authenticate', () => {
  const credential = CallerCredential.fromDocument(document());

  it('sends only the caller id, then the authenticator, and returns the bound caller', async () => {
    const { client, calls } = fakeClient({
      'spawn_callers.challenge': challenge,
      'spawn_callers.authenticate': BOUND,
    });
    const signal = new AbortController().signal;
    await expect(authenticate(client, credential, { timeoutMs: 5_000, signal })).resolves.toEqual(BOUND);
    expect(calls).toEqual([
      {
        method: 'spawn_callers.challenge',
        params: { caller_id: base.caller_id },
        options: { timeoutMs: 5_000, signal },
      },
      {
        method: 'spawn_callers.authenticate',
        params: { challenge_id: base.challenge_id, authenticator: base.authenticator },
        options: { timeoutMs: 5_000, signal },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(base.secret);
    expect(JSON.stringify(calls)).not.toContain(base.key_hex);
  });

  it('passes the core refusal through unchanged', async () => {
    const locked = new CoreRpcError('auth_locked', {
      rpcCode: -32000,
      kind: 'rate_limited',
      retryable: false,
    });
    const { client } = fakeClient({ 'spawn_callers.challenge': locked });
    await expect(authenticate(client, credential)).rejects.toBe(locked);
  });

  it('refuses a malformed challenge without answering it', async () => {
    const malformed: Array<Partial<CallerChallenge> | null> = [
      null,
      { version: 2 },
      { challenge_id: 'ch_short' },
      { nonce: base.nonce.slice(0, 42) },
      { nonce: `${base.nonce.slice(0, 42)}B` },
      { expires_at_ms: base.issued_at_ms + 60_000 },
      { issued_at_ms: -1, expires_at_ms: 29_999 },
    ];
    for (const fields of malformed) {
      const reply = fields === null ? null : { ...challenge, ...fields };
      const { client, calls } = fakeClient({
        'spawn_callers.challenge': reply,
        'spawn_callers.authenticate': BOUND,
      });
      const error = await authenticate(client, credential).catch((e: unknown) => e);
      expect(error, JSON.stringify(fields)).toBeInstanceOf(CoreRpcError);
      expect(calls.map((c) => c.method)).toEqual(['spawn_callers.challenge']);
    }
  });

  it('refuses a bound reply for another caller or out of range', async () => {
    for (const bound of [
      { ...BOUND, caller_id: 'sc_ffffffffffffffff' },
      { ...BOUND, caller_name: 'bad name' },
      { ...BOUND, authority_generation: 0 },
      { ...BOUND, authority_generation: 2 ** 53 },
    ]) {
      const { client } = fakeClient({
        'spawn_callers.challenge': challenge,
        'spawn_callers.authenticate': bound,
      });
      await expect(authenticate(client, credential)).rejects.toBeInstanceOf(CoreRpcError);
    }
  });

  it('reports method_not_found when the core has no spawn caller extension, sending nothing', async () => {
    const { client, calls } = fakeClient({}, ['hello', 'spawn.invoke']);
    const error = await authenticate(client, credential).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreRpcError);
    expect((error as CoreRpcError).kind).toBe('method_not_found');
    expect(calls).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('readCallerCredential (POSIX)', () => {
  let dir: string;
  let file: string;
  const contents = JSON.stringify(document());

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'core-bridge-caller-'));
    await chmod(dir, 0o700);
    file = path.join(dir, 'caller.json');
    await writeFile(file, contents, { mode: 0o600 });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const unsafe = async (target: string) => {
    const error = await readCallerCredential(target).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreBridgeError);
    expect((error as CoreBridgeError).code).toBe('caller_file_unsafe');
    expect((error as Error).message).not.toContain(base.secret);
  };

  it('reads a 0600 file owned by this user', async () => {
    const credential = await readCallerCredential(file);
    expect(credential.callerId).toBe(base.caller_id);
    expect(credential.authenticatorFor(challenge)).toBe(base.authenticator);
    await chmod(file, 0o400);
    expect((await readCallerCredential(file)).callerId).toBe(base.caller_id);
  });

  it('reports a missing file, or a path through a file, unchanged and without a caller error', async () => {
    await rm(file);
    await expect(readCallerCredential(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(file, contents, { mode: 0o600 });
    await expect(readCallerCredential(path.join(file, 'caller.json'))).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });

  it('refuses a symlink in place of a valid 0600 file and a dangling one', async () => {
    const real = path.join(dir, 'real.json');
    await writeFile(real, contents, { mode: 0o600 });
    await rm(file);
    await symlink(real, file);
    await unsafe(file);
    await rm(file);
    await symlink(path.join(dir, 'absent.json'), file);
    await unsafe(file);
  });

  it('refuses a FIFO without blocking on it', async () => {
    await rm(file);
    execFileSync('mkfifo', ['-m', '600', file]);
    await unsafe(file);
  });

  it('refuses a file other users can read or write', async () => {
    for (const mode of [0o640, 0o604, 0o620, 0o602, 0o644, 0o666]) {
      await chmod(file, mode);
      await unsafe(file);
    }
  });

  it('refuses a symlink, a directory and a relative path', async () => {
    const link = path.join(dir, 'link.json');
    await symlink(file, link);
    await unsafe(link);
    const sub = path.join(dir, 'sub.json');
    await mkdir(sub, { mode: 0o700 });
    await unsafe(sub);
    await unsafe(path.relative(process.cwd(), file));
  });

  it('refuses a file in a directory other users can write, unless it is sticky', async () => {
    await chmod(dir, 0o777);
    await unsafe(file);
    await chmod(dir, 0o1777);
    expect((await readCallerCredential(file)).callerId).toBe(base.caller_id);
  });

  it('refuses a file larger than 64 KiB', async () => {
    await writeFile(file, ' '.repeat(64 * 1024 + 1), { mode: 0o600 });
    await unsafe(file);
  });

  it('refuses malformed contents without echoing them', async () => {
    await writeFile(file, `{"secret": "${base.secret}"`, { mode: 0o600 });
    const error = await readCallerCredential(file).catch((e: unknown) => e);
    expect((error as CoreBridgeError).code).toBe('caller_file_invalid');
    expect((error as Error).message).not.toContain(base.secret);
    await writeFile(file, JSON.stringify(document({ caller_id: 'sc_XYZ' })), { mode: 0o600 });
    await expect(readCallerCredential(file)).rejects.toMatchObject({ code: 'caller_file_invalid' });
  });

  it.skipIf(typeof process.getuid !== 'function' || process.getuid() !== 0)(
    'refuses a file owned by another user',
    async () => {
      const { chown } = await import('node:fs/promises');
      await chown(file, 65534, 65534);
      await unsafe(file);
    }
  );
});
