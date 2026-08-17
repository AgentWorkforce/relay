import { describe, expect, it, vi } from 'vitest';

/**
 * Unit tests for {@link HarnessDriverClient.listFleetInventory}.
 *
 * The broker's `GET /api/fleet-inventory` handler wraps the snapshot in an
 * envelope with a `success` flag. When the broker's runtime channel is
 * unavailable it returns `HTTP 200 { "success": false, "agents": [] }`
 * (see `crates/broker/src/listen_api.rs::listen_api_fleet_inventory`).
 *
 * Dropping that flag would silently conflate two very different situations
 * that a fleet-visibility tool absolutely must distinguish:
 *   - **broker down / cannot answer** → callers should treat as unknown and
 *     surface an error row.
 *   - **broker up, genuinely empty inventory** → callers should render `0`.
 *
 * Both are covered as independent bites below so a regression in either
 * direction fails a test.
 */

import { HarnessDriverClient } from './client.js';
import { HarnessDriverProtocolError } from './transport.js';

function stubClient(body: unknown, status = 200): HarnessDriverClient {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  ) as unknown as typeof globalThis.fetch;
  return new HarnessDriverClient({ baseUrl: 'http://x', apiKey: 'k', fetch });
}

describe('listFleetInventory — success:false must not be conflated with empty inventory', () => {
  it('must-fire: rejects with fleet_inventory_unavailable when the broker envelope reports failure', async () => {
    // This is the bite that catches the defect three reviewers flagged on
    // relay#1556: the CLI was rendering "broker cannot answer" as "0 agents"
    // by dropping the success flag. Remove the guard and this test flips red.
    const client = stubClient({ success: false, agents: [] });

    let failure: unknown;
    try {
      await client.listFleetInventory();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HarnessDriverProtocolError);
    expect(failure).toMatchObject({
      code: 'fleet_inventory_unavailable',
      retryable: true,
    });
    expect((failure as Error).message).toMatch(/success:false/);
    expect((failure as Error).message).toMatch(/not zero/);
  });

  it('must-not-fire: an actually empty inventory returns agents:[] without throwing', async () => {
    // The other half of the required distinction: an operator with a healthy
    // broker and no agents on the node must see a clean empty result, not an
    // ERROR row. This is why the guard checks `success === false` explicitly
    // rather than falsy — the successful envelope has no `success` field.
    const client = stubClient({ node_name: 'sf-mini', agents: [] });

    const result = await client.listFleetInventory();
    expect(result).toEqual({ nodeName: 'sf-mini', agents: [] });
  });

  it('must-not-fire: a populated inventory returns its agents intact', async () => {
    // Guard against a lazy fix that always throws. Preserve full agent
    // payloads verbatim so the CLI can join on `name`.
    const client = stubClient({
      success: true,
      node_name: 'finn-mini',
      agents: [
        { agent_id: 'ag_1', name: 'worker-a', invocation_id: 'inv_1' },
        { agent_id: 'ag_2', name: 'worker-b' },
      ],
    });

    const result = await client.listFleetInventory();
    expect(result.nodeName).toBe('finn-mini');
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0]).toMatchObject({ name: 'worker-a', invocation_id: 'inv_1' });
  });

  it('surfaces the transport error when the broker route is missing (HTTP 404)', async () => {
    // Older brokers do not expose `/api/fleet-inventory` at all. This must
    // surface as a proper protocol error the CLI can distinguish from
    // success:false (both are diagnostic — but only one implies "the endpoint
    // exists but had trouble"), and it must not silently return empty agents.
    const client = stubClient({ error: { code: 'not_found', message: 'no route' } }, 404);
    await expect(client.listFleetInventory()).rejects.toBeInstanceOf(HarnessDriverProtocolError);
  });
});
