import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RelaycastMessagingClient,
  delegationCovers,
  parseConfigChangeTarget,
  parsePrOpsTarget,
  withdrawOwnerApproval,
  sessionSocketEndpoint,
  redeemOwnerApproval,
  verifyDelegationAttestation,
  withVerifiedDelegation,
  type RelayDelegationJwks,
  type RelayMessage,
} from '../messaging/index.js';

const KID = 'k-test';

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const jwks: RelayDelegationJwks = { keys: [{ kty: 'OKP', crv: 'Ed25519', kid: KID, x: jwk.x }] };
  const signJws = (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const head = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'relay-delegation+jws', kid: KID, ...header })
    ).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = sign(null, Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${signature}`;
  };
  return { jwks, signJws };
}

const NOW = 1_800_000_000;

/**
 * Listens where the SDK connects for `path` (the path itself, or on Windows
 * the core's named pipe), rejecting when the listener cannot bind.
 */
function listenOn(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sessionSocketEndpoint(path), () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    ws: 'ws_1',
    owner_id: 'hum_owner',
    owner_display: 'Ada Owner',
    delegate_agent_id: 'agent_assistant',
    grant_id: 'grt_1',
    message_id: 'msg_1',
    recipient_agent_id: 'agent_relay',
    approval_id: 'apv_7Q2abcdEF',
    tier: 'D',
    standing: 'code_owner',
    actions: [
      {
        class: 'merge',
        target: 'AgentWorkforce/relay#2250',
        conditions: [{ type: 'ci_green' }, { type: 'head_sha', sha: 'a'.repeat(40) }],
      },
    ],
    single_use: false,
    iat: NOW,
    exp: NOW + 300,
    jti: 'jti_1',
    ...overrides,
  };
}

const expected = {
  workspaceId: 'ws_1',
  messageId: 'msg_1',
  recipientAgentId: 'agent_relay',
  senderId: 'agent_assistant',
  now: NOW + 10,
};

describe('delegate approvals', () => {
  it('verifies an attestation and exposes only verified fields', () => {
    const { jwks, signJws } = signer();
    const delegation = verifyDelegationAttestation(signJws(claims()), jwks, expected);
    expect(delegation).toMatchObject({
      verified: true,
      tier: 'D',
      standing: 'code_owner',
      ownerDisplay: 'Ada Owner',
      approvalId: 'apv_7Q2abcdEF',
      singleUse: false,
    });
    expect(delegation?.expiresAt).toBe(new Date((NOW + 300) * 1000).toISOString());
  });

  it('refuses another delivery, a forged signature, an unknown key or expiry', () => {
    const { jwks, signJws } = signer();
    const other = signer();
    const refused = [
      signJws(claims({ recipient_agent_id: 'agent_other' })),
      signJws(claims({ message_id: 'msg_other' })),
      signJws(claims({ ws: 'ws_other' })),
      signJws(claims({ delegate_agent_id: 'agent_mallory' })),
      signJws(claims({ exp: NOW })),
      signJws(claims({ exp: NOW + 3600 })),
      // Issued long ago, expiring soon: its whole life is too long.
      signJws(claims({ iat: NOW - 3600, exp: NOW + 30 })),
      signJws(claims({ standing: 'org_admin' })),
      signJws(claims({ actions: [{ class: 'merge', target: 'x', conditions: [{ type: 'when_green' }] }] })),
      signJws(claims(), { kid: 'k-unknown' }),
      signJws(claims(), { alg: 'none' }),
      other.signJws(claims()),
      'not.a.jws',
    ];
    for (const jws of refused) {
      expect(verifyDelegationAttestation(jws, jwks, expected)).toBeUndefined();
    }
  });

  it('verifies a config_change of the recipient, never of its delegation settings', () => {
    const { jwks, signJws } = signer();
    const change = (target: string, singleUse = true) =>
      signJws(claims({ single_use: singleUse, actions: [{ class: 'config_change', target }] }));
    // A reusable config change is refused.
    expect(
      verifyDelegationAttestation(change('agent_relay:spawn_native_input=false', false), jwks, expected)
    ).toBeUndefined();
    const ok = verifyDelegationAttestation(change('agent_relay:spawn_native_input=false'), jwks, expected);
    expect(ok?.singleUse).toBe(true);
    expect(parseConfigChangeTarget('agent_relay:spawn_native_input=false')).toEqual({
      agentId: 'agent_relay',
      setting: 'spawn_native_input',
      value: 'false',
    });
    for (const target of [
      'agent_relay:delegated_approvals_from=code_owners',
      'agent_relay:spawn_delegate_approvals=true',
      'agent_other:spawn_native_input=false',
      'agent_relay:spawn_native_input',
      '*:spawn_native_input=false',
    ]) {
      expect(verifyDelegationAttestation(change(target), jwks, expected)).toBeUndefined();
    }
  });

  it('sets message.delegation only when verified, and covers exact actions', () => {
    const { jwks, signJws } = signer();
    const message: RelayMessage = {
      id: 'msg_1',
      messageId: 'msg_1',
      text: 'merge it',
      from: { id: 'agent_assistant', name: 'assistant' },
      // An unverified claim on the way in is dropped.
      delegation: { verified: true } as RelayMessage['delegation'],
    };
    const base = { workspaceId: 'ws_1', recipientAgentId: 'agent_relay', now: NOW + 10 };
    const verified = withVerifiedDelegation(message, signJws(claims()), jwks, base);
    expect(verified.delegation?.approvalId).toBe('apv_7Q2abcdEF');
    const at = (NOW + 10) * 1000;
    expect(delegationCovers(verified, { class: 'merge', target: 'AgentWorkforce/relay#2250' }, at)).toBe(
      true
    );
    // Not once the attestation expired.
    expect(
      delegationCovers(verified, { class: 'merge', target: 'AgentWorkforce/relay#2250' }, (NOW + 300) * 1000)
    ).toBe(false);
    expect(delegationCovers(verified, { class: 'merge', target: 'AgentWorkforce/relay#2251' }, at)).toBe(
      false
    );
    const forged = withVerifiedDelegation(message, signer().signJws(claims()), jwks, base);
    expect(forged.delegation).toBeUndefined();
  });

  it('sends ownerApproval through as owner_approval beside the message', async () => {
    const post = vi.fn(async () => ({
      conversation_id: 'dm-1',
      message: { id: 'dm-send', agent_name: 'assistant', text: 'merge', attachments: [] },
    }));
    const agentClient = { client: { post } } as unknown as ConstructorParameters<
      typeof RelaycastMessagingClient
    >[0]['agentClient'];
    const client = new RelaycastMessagingClient({
      relaycast: {} as ConstructorParameters<typeof RelaycastMessagingClient>[0]['relaycast'],
      agentClient,
      sessionRef: 'session-1',
    });
    await client.messages.direct({
      to: 'relay',
      text: 'The owner approved: merge #2250 once CI is green.',
      idempotencyKey: 'idem-1',
      ownerApproval: {
        ownerId: 'hum_owner',
        actions: [
          { class: 'merge', target: 'AgentWorkforce/relay#2250', conditions: [{ type: 'ci_green' }] },
        ],
        quote: 'yes merge 2250 when green',
        quotedAt: '2026-11-23T07:49:00Z',
        quoteSource: 'chat:dm',
        expiresAt: '2026-11-23T08:49:00Z',
      },
    });
    expect(post).toHaveBeenCalledWith(
      '/v1/dm',
      {
        to: 'relay',
        text: 'The owner approved: merge #2250 once CI is green.',
        data: { session_ref: 'session-1' },
        mode: 'wait',
        owner_approval: {
          v: 1,
          owner_id: 'hum_owner',
          actions: [
            { class: 'merge', target: 'AgentWorkforce/relay#2250', conditions: [{ type: 'ci_green' }] },
          ],
          quote: 'yes merge 2250 when green',
          quoted_at: '2026-11-23T07:49:00Z',
          quote_source: 'chat:dm',
          expires_at: '2026-11-23T08:49:00Z',
        },
      },
      { headers: { 'Idempotency-Key': 'idem-1', 'X-Idempotency-Key': 'idem-1' } }
    );
  });

  describe('redeem', () => {
    let server: Server | undefined;
    let dir: string | undefined;
    afterEach(() => {
      server?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    async function socket(answer: unknown, seen: string[]): Promise<string> {
      dir = mkdtempSync(join(tmpdir(), 'relay-redeem-'));
      const path = join(dir, 'relay.sock');
      server = createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        res.setHeader('content-type', 'application/json');
        // As the core answers every route: `{"ok": true, "data": …}`.
        res.end(JSON.stringify({ ok: true, data: answer }));
      });
      // Where the SDK connects: the path itself, or on Windows the core's pipe.
      await listenOn(server, path);
      return path;
    }

    it('redeems through the session socket and passes on unmet conditions', async () => {
      const seen: string[] = [];
      const socketPath = await socket(
        { ok: false, reason: 'condition_unmet', unmet: [{ type: 'ci_green' }] },
        seen
      );
      const result = await redeemOwnerApproval(
        'apv_7Q2abcdEF',
        { class: 'merge', target: 'AgentWorkforce/relay#2250' },
        { socketPath }
      );
      expect(result).toEqual({ ok: false, reason: 'condition_unmet', unmet: [{ type: 'ci_green' }] });
      expect(seen).toEqual([
        'POST /delegation/redeem?approval=apv_7Q2abcdEF&class=merge&target=AgentWorkforce%2Frelay%232250',
      ]);
    });

    it('reports a consumed approval', async () => {
      const socketPath = await socket({ ok: true, consumed: true }, []);
      await expect(
        redeemOwnerApproval('apv_7Q2abcdEF', { class: 'release', target: 'pkg' }, { socketPath })
      ).resolves.toEqual({ ok: true, consumed: true });
    });
  });

  it('derives the Windows named pipe as the core does', () => {
    // The core's own vector (transport::pipe_name).
    expect(sessionSocketEndpoint('C:\\Users\\A\\.agentworkforce\\desktop\\core.sock', 'win32')).toBe(
      '\\\\.\\pipe\\agent-relay-367ccf5106272db6'
    );
    expect(sessionSocketEndpoint('c:/users/a/.agentworkforce/desktop/core.sock', 'win32')).toBe(
      '\\\\.\\pipe\\agent-relay-367ccf5106272db6'
    );
    expect(sessionSocketEndpoint('/run/agent-relay/relay.sock', 'linux')).toBe('/run/agent-relay/relay.sock');
  });

  it('checks prompt_approval, pr_ops and config_change shapes, and carries the signed quote', () => {
    const { jwks, signJws } = signer();
    const one = (action: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      verifyDelegationAttestation(signJws(claims({ actions: [action], ...extra })), jwks, expected);
    expect(one({ class: 'prompt_approval', target: 'agent_relay:0123456789abcdef:approve' })).toBeDefined();
    expect(one({ class: 'prompt_approval', target: 'agent_relay:0123456789abcdef' })).toBeUndefined();
    expect(
      one({
        class: 'prompt_approval',
        target: 'agent_relay:0123456789abcdef:deny',
        conditions: [{ type: 'not_before', at: '2020-01-01T00:00:00Z' }],
      })
    ).toBeUndefined();
    expect(one({ class: 'pr_ops', target: 'acme/api#12:label=bug' })).toBeDefined();
    expect(one({ class: 'pr_ops', target: 'acme/api#12' })).toBeUndefined();
    expect(parsePrOpsTarget('acme/api#12:label=area:api')).toEqual({
      pull: 'acme/api#12',
      op: 'label=area:api',
    });
    expect(parsePrOpsTarget('acme/api#12:request_review=ada')).toEqual({
      pull: 'acme/api#12',
      op: 'request_review=ada',
    });
    expect(
      one(
        {
          class: 'config_change',
          target: 'agent_relay:spawn_native_input=false',
          conditions: [{ type: 'ci_green' }],
        },
        { single_use: true }
      )
    ).toBeUndefined();
    expect(parsePrOpsTarget('acme//api#12:close')).toBeUndefined();
    expect(parsePrOpsTarget('acme/api#12:label=help wanted')).toEqual({
      pull: 'acme/api#12',
      op: 'label=help wanted',
    });
    expect(parsePrOpsTarget('acme/api#12:label=help  wanted')).toBeUndefined();
    expect(parsePrOpsTarget('acme/api#12:request_review=a b')).toBeUndefined();
    expect(one({ class: 'merge', target: 'acme/api#12' }, { quote: 'yes merge 12' })?.quote).toBe(
      'yes merge 12'
    );
  });

  it('passes on the commit Cloud checked and withdraws through the socket', async () => {
    const { createServer } = await import('node:http');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'relay-withdraw-'));
    const socketPath = join(dir, 'relay.sock');
    const seen: string[] = [];
    const sha = 'a'.repeat(40);
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const data = req.url?.startsWith('/delegation/withdraw')
        ? { ok: true }
        : { ok: true, consumed: false, checked: { head_sha: sha } };
      res.end(JSON.stringify({ ok: true, data }));
    });
    try {
      await listenOn(server, socketPath);
      await expect(
        redeemOwnerApproval('apv_7Q2abcdEF', { class: 'merge', target: 'acme/api#12' }, { socketPath })
      ).resolves.toEqual({ ok: true, consumed: false, checked: { head_sha: sha } });
      await expect(withdrawOwnerApproval('apv_7Q2abcdEF', { socketPath })).resolves.toEqual({ ok: true });
      expect(seen[1]).toBe('POST /delegation/withdraw?approval=apv_7Q2abcdEF');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
