import { describe, expect, it, vi } from 'vitest';

import { JoinTicketRedemptionError, redeemJoinTicket } from './join-ticket.js';

const TICKET = `rjt_live_${'a'.repeat(64)}`;

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('redeemJoinTicket', () => {
  it('matches the cloud redemption contract and returns its persistable credential', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          ok: true,
          data: {
            workspace_id: 'rw_redeemed',
            workspace_key: 'rk_live_redeemed',
            scope: {
              purpose: 'node_attach',
              node: 'sf-mini',
              agent: 'lead',
              mode: 'drive',
            },
          },
        },
        200
      )
    );

    await expect(
      redeemJoinTicket({
        ticket: TICKET,
        node: 'sf-mini',
        agent: 'lead',
        mode: 'drive',
        baseUrl: 'https://relay.example/',
        fetch: fetch as typeof globalThis.fetch,
      })
    ).resolves.toEqual({ workspaceId: 'rw_redeemed', workspaceKey: 'rk_live_redeemed' });

    expect(fetch).toHaveBeenCalledWith(
      'https://relay.example/v1/workspace/join-tickets/redeem',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ticket: TICKET,
          node: 'sf-mini',
          agent: 'lead',
          mode: 'drive',
        }),
      })
    );
  });

  it.each([
    [410, 'join_ticket_expired', 'Workspace join ticket expired'],
    [401, 'invalid_or_consumed_ticket', 'Invalid or already redeemed workspace join ticket'],
  ])(
    'keeps HTTP %s %s failures specific and never falls through to credential resolution',
    async (status, code, message) => {
      const fetch = vi.fn(async () =>
        jsonResponse({ ok: false, error: { code, message: `${message}: ${TICKET}` } }, status)
      );

      const promise = redeemJoinTicket({
        ticket: TICKET,
        node: 'sf-mini',
        agent: 'lead',
        mode: 'view',
        fetch: fetch as typeof globalThis.fetch,
      });

      await expect(promise).rejects.toMatchObject({
        name: 'JoinTicketRedemptionError',
        code,
        status,
        message: expect.stringContaining(message),
      });
      await expect(promise).rejects.not.toMatchObject({
        message: expect.stringContaining(TICKET),
      });
      await expect(promise).rejects.not.toMatchObject({
        message: expect.stringContaining('No workspace key found'),
      });
    }
  );

  it('rejects a malformed ticket locally without sending or echoing it', async () => {
    const fetch = vi.fn();
    const malformed = 'rjt_live_not-a-ticket';

    const promise = redeemJoinTicket({
      ticket: malformed,
      node: 'sf-mini',
      agent: 'lead',
      mode: 'view',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(promise).rejects.toBeInstanceOf(JoinTicketRedemptionError);
    await expect(promise).rejects.not.toMatchObject({ message: expect.stringContaining(malformed) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a mismatched success scope before returning the credential', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          ok: true,
          data: {
            workspace_id: 'rw_redeemed',
            workspace_key: 'rk_live_redeemed',
            scope: {
              purpose: 'node_attach',
              node: 'another-node',
              agent: 'lead',
              mode: 'drive',
            },
          },
        },
        200
      )
    );

    await expect(
      redeemJoinTicket({
        ticket: TICKET,
        node: 'sf-mini',
        agent: 'lead',
        mode: 'drive',
        fetch: fetch as typeof globalThis.fetch,
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('turns an unstructured response into a clear redemption failure', async () => {
    const fetch = vi.fn(async () => jsonResponse(null, 502));

    await expect(
      redeemJoinTicket({
        ticket: TICKET,
        node: 'sf-mini',
        agent: 'lead',
        mode: 'view',
        fetch: fetch as typeof globalThis.fetch,
      })
    ).rejects.toMatchObject({
      name: 'JoinTicketRedemptionError',
      status: 502,
      message: expect.stringContaining('redemption request failed (HTTP 502)'),
    });
  });
});
