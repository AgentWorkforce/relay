import { describe, expect, it, vi } from 'vitest';

import {
  formatDeviceInstructions,
  isHeadlessEnvironment,
  pollForDeviceToken,
  runDeviceAuthorizationFlow,
  startDeviceAuthorization,
  type DeviceAuthorization,
} from './device-auth.js';
import { CloudAuthError } from './types.js';

const API_URL = 'https://agentrelay.com';

const AUTHORIZATION: DeviceAuthorization = {
  deviceCode: 'cld_dc_test',
  userCode: 'BCDF-GHJK',
  verificationUri: 'https://agentrelay.com/cloud/device',
  verificationUriComplete: 'https://agentrelay.com/cloud/device?user_code=BCDF-GHJK',
  expiresInSeconds: 600,
  intervalSeconds: 5,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/**
 * A poll harness that records every sleep, so a client that busy-loops is
 * detectable rather than merely slow.
 */
function harness(responses: Response[]) {
  const sleeps: number[] = [];
  let clock = 0;
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra poll');
    return next;
  });

  return {
    sleeps,
    fetchImpl,
    hooks: {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    },
  };
}

/**
 * A request that never answers on its own, so only the abort signal can end
 * it. If the client passes no signal the promise never settles — which is
 * exactly the hang under test, surfaced here as a test timeout.
 */
function stallingFetch() {
  return vi.fn(
    (_url: unknown, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
  );
}

/**
 * A poll harness whose plan entries may be the literal `'stall'`, standing in
 * for a connection that opens and then goes quiet.
 */
function stallHarness(plan: Array<Response | 'stall'>) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  let clock = 0;
  const fetchImpl = vi.fn((_url: unknown, init: RequestInit = {}) => {
    const next = plan.shift();
    if (!next) throw new Error('unexpected extra poll');
    if (next !== 'stall') return Promise.resolve(next);
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });

  return {
    sleeps,
    logs,
    fetchImpl,
    hooks: {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // Short enough to keep the suite fast; the production default is 30s.
      requestTimeoutMs: 20,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      log: (message: string) => logs.push(message),
    },
  };
}

describe('device authorization start', () => {
  it('sends the hostname so the approval screen can name this machine', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          device_code: 'cld_dc_test',
          user_code: 'BCDF-GHJK',
          verification_uri: 'https://agentrelay.com/cloud/device',
          verification_uri_complete: 'https://agentrelay.com/cloud/device?user_code=BCDF-GHJK',
          expires_in: 600,
          interval: 5,
        },
        { status: 201 }
      )
    );

    const result = await startDeviceAuthorization(API_URL, {
      clientName: 'barry',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual(AUTHORIZATION);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://agentrelay.com/api/v1/auth/device/start');
    expect(JSON.parse(String(init.body))).toEqual({ client_name: 'barry' });
  });

  it('explains that the deployment is too old on a 404', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 404 }));

    await expect(
      startDeviceAuthorization(API_URL, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/does not support device login/);
  });

  it('rejects a response missing the device code', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ user_code: 'BCDF-GHJK' }, { status: 201 }));

    await expect(
      startDeviceAuthorization(API_URL, { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/missing required fields/);
  });

  it('times out a stalled connection instead of hanging with no output', async () => {
    // Node's fetch has no default timeout. Nothing has been printed by this
    // point in the flow, so an unbounded start request shows an ssh user a
    // bare cursor forever — the one failure mode this feature cannot have.
    const fetchImpl = stallingFetch();

    await expect(
      startDeviceAuthorization(API_URL, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        requestTimeoutMs: 20,
      })
    ).rejects.toThrow(/Timed out after 20ms trying to reach https:\/\/agentrelay\.com/);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a timeout as a CloudAuthError, not a bare DOMException', async () => {
    const fetchImpl = stallingFetch();

    const error = await startDeviceAuthorization(API_URL, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestTimeoutMs: 20,
    }).then(
      () => {
        throw new Error('expected the start request to reject');
      },
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(CloudAuthError);
    expect((error as CloudAuthError).code).toBe('AUTH_DEVICE_FLOW_FAILED');
  });
});

describe('device authorization poll', () => {
  it('waits the interval between polls instead of spinning', async () => {
    const { hooks, sleeps, fetchImpl } = harness([
      jsonResponse({ error: 'authorization_pending', interval: 5 }, { status: 400 }),
      jsonResponse({ error: 'authorization_pending', interval: 5 }, { status: 400 }),
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
        refresh_token_expires_at: '2026-11-04T00:00:00.000Z',
        api_url: 'https://agentrelay.com/cloud',
      }),
    ]);

    const auth = await pollForDeviceToken(API_URL, AUTHORIZATION, hooks);

    expect(auth).toEqual({
      accessToken: 'cld_at_abc',
      refreshToken: 'cld_rt_abc',
      accessTokenExpiresAt: '2026-08-07T00:00:00.000Z',
      refreshTokenExpiresAt: '2026-11-04T00:00:00.000Z',
      apiUrl: 'https://agentrelay.com/cloud',
    });
    // This is the assertion that fails if the client busy-loops: one full
    // interval of sleep before every request, including the first.
    expect(sleeps).toEqual([5000, 5000, 5000]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never polls before sleeping, so it cannot spin even once', async () => {
    const { hooks, sleeps } = harness([
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      }),
    ]);

    await pollForDeviceToken(API_URL, AUTHORIZATION, hooks);
    expect(sleeps).toEqual([5000]);
  });

  it('widens the interval on slow_down (RFC 8628 §3.5)', async () => {
    const { hooks, sleeps } = harness([
      jsonResponse({ error: 'authorization_pending', interval: 5 }, { status: 400 }),
      jsonResponse({ error: 'slow_down', interval: 10 }, { status: 400 }),
      jsonResponse({ error: 'slow_down', interval: 15 }, { status: 400 }),
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      }),
    ]);

    await pollForDeviceToken(API_URL, AUTHORIZATION, hooks);

    // 5s, then +5 each time the server says slow down. The client must never
    // go back down to the original interval afterwards.
    expect(sleeps).toEqual([5000, 5000, 10_000, 15_000]);
  });

  it('takes the server interval when it exceeds the client step', async () => {
    const { hooks, sleeps } = harness([
      jsonResponse({ error: 'slow_down', interval: 30 }, { status: 400 }),
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      }),
    ]);

    await pollForDeviceToken(API_URL, AUTHORIZATION, hooks);
    expect(sleeps).toEqual([5000, 30_000]);
  });

  it('honours Retry-After when rate limited', async () => {
    const { hooks, sleeps } = harness([
      jsonResponse({ error: 'slow_down' }, { status: 429, headers: { 'retry-after': '20' } }),
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      }),
    ]);

    await pollForDeviceToken(API_URL, AUTHORIZATION, hooks);
    expect(sleeps).toEqual([5000, 20_000]);
  });

  it('never lets the interval grow without bound', async () => {
    const responses = Array.from({ length: 30 }, () => jsonResponse({ error: 'slow_down' }, { status: 400 }));
    responses.push(
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      })
    );
    // A long-lived grant so the deadline does not end the loop first.
    const { hooks, sleeps } = harness(responses);

    await pollForDeviceToken(API_URL, { ...AUTHORIZATION, expiresInSeconds: 60 * 60 * 24 }, hooks);

    expect(Math.max(...sleeps)).toBe(60_000);
  });

  it('reports a denial as a clear error rather than hanging', async () => {
    const { hooks } = harness([jsonResponse({ error: 'access_denied' }, { status: 400 })]);

    await expect(pollForDeviceToken(API_URL, AUTHORIZATION, hooks)).rejects.toThrow(
      /denied\. No credentials were issued/
    );
  });

  it('reports an expired grant as a clear error rather than hanging', async () => {
    const { hooks } = harness([jsonResponse({ error: 'expired_token' }, { status: 400 })]);

    await expect(pollForDeviceToken(API_URL, AUTHORIZATION, hooks)).rejects.toThrow(
      /expired before it was approved/
    );
  });

  it('reports a replayed device code as a clear error', async () => {
    const { hooks } = harness([jsonResponse({ error: 'invalid_grant' }, { status: 400 })]);

    await expect(pollForDeviceToken(API_URL, AUTHORIZATION, hooks)).rejects.toThrow(/no longer valid/);
  });

  it('gives up locally once the grant lifetime elapses', async () => {
    // The server should say expired_token first, but a client that trusted the
    // server to end the loop could poll forever if it never did.
    const responses = Array.from({ length: 500 }, () =>
      jsonResponse({ error: 'authorization_pending' }, { status: 400 })
    );
    const { hooks, fetchImpl } = harness(responses);

    await expect(
      pollForDeviceToken(API_URL, { ...AUTHORIZATION, expiresInSeconds: 30 }, hooks)
    ).rejects.toThrow(/expired before it was approved/);

    // 30s of grant at a 5s interval — six polls, not five hundred.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(6);
  });

  // The server keeps the grant claimable across an issuance failure precisely
  // so the next poll can still succeed (cloud#2941 wraps claim+mint in one
  // transaction and answers 503 `server_error`). Aborting here would throw away
  // an approval the human already gave and make them redo the whole flow —
  // exactly the harm the server-side fix exists to prevent.
  it('keeps polling through a transient server_error and still logs in', async () => {
    const { hooks, sleeps, fetchImpl } = harness([
      jsonResponse({ error: 'authorization_pending', interval: 5 }, { status: 400 }),
      jsonResponse(
        { error: 'server_error', error_description: 'Unable to complete device authorization' },
        { status: 503 }
      ),
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      }),
    ]);

    const auth = await pollForDeviceToken(API_URL, AUTHORIZATION, hooks);

    expect(auth.accessToken).toBe('cld_at_abc');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Backs off rather than hammering a server that is already struggling.
    expect(sleeps).toEqual([5000, 5000, 10_000]);
  });

  it('retries a gateway 502 with no JSON body at all', async () => {
    // A proxy blip in front of the app yields HTML, not an OAuth error object.
    const { hooks, fetchImpl } = harness([
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      }),
    ]);

    const auth = await pollForDeviceToken(API_URL, AUTHORIZATION, hooks);
    expect(auth.accessToken).toBe('cld_at_abc');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('still gives up on a server outage that outlasts the grant', async () => {
    // Retrying must stay bounded by the grant deadline, not loop forever.
    const responses = Array.from({ length: 500 }, () =>
      jsonResponse({ error: 'server_error' }, { status: 503 })
    );
    const { hooks, fetchImpl } = harness(responses);

    await expect(
      pollForDeviceToken(API_URL, { ...AUTHORIZATION, expiresInSeconds: 60 }, hooks)
    ).rejects.toThrow(/expired before it was approved/);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('bounds every poll request so a stalled socket cannot hang the wait', async () => {
    const { hooks, fetchImpl } = stallHarness([
      'stall',
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      }),
    ]);

    await pollForDeviceToken(API_URL, AUTHORIZATION, hooks);

    // Both polls must carry an abort budget, not just the first.
    for (const call of fetchImpl.mock.calls) {
      const [, init] = call as unknown as [URL, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('retries a stalled poll rather than discarding an approval', async () => {
    // A stall is the same class of failure as the transient 5xx above: the
    // request died, but the grant the human may already have approved is
    // still claimable. Giving up here would make them redo the whole flow.
    const { hooks, sleeps, logs } = stallHarness([
      'stall',
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      }),
    ]);

    const auth = await pollForDeviceToken(API_URL, AUTHORIZATION, hooks);

    expect(auth.accessToken).toBe('cld_at_abc');
    // Backed off after the stall rather than retrying at pace.
    expect(sleeps).toEqual([5000, 10_000]);
    // And said so: a slow network must not look like a hang.
    expect(logs).toContainEqual(
      expect.stringContaining('No response from https://agentrelay.com within 20ms')
    );
  });

  it('gives up with the expiry error when stalls outlast the grant', async () => {
    const { hooks, fetchImpl } = stallHarness(Array.from({ length: 20 }, () => 'stall' as const));

    await expect(
      pollForDeviceToken(API_URL, { ...AUTHORIZATION, expiresInSeconds: 60 }, hooks)
    ).rejects.toThrow(/expired before it was approved/);
    // Bounded by the grant, not looping forever on a dead host.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('surfaces an unexpected error code instead of looping on it', async () => {
    const { hooks } = harness([jsonResponse({ error: 'invalid_client' }, { status: 400 })]);

    await expect(pollForDeviceToken(API_URL, AUTHORIZATION, hooks)).rejects.toThrow(
      /Device login failed: invalid_client/
    );
  });

  it('reports a CloudAuthError so callers can branch on the code', async () => {
    const { hooks } = harness([jsonResponse({ error: 'access_denied' }, { status: 400 })]);

    const error = await pollForDeviceToken(API_URL, AUTHORIZATION, hooks).then(
      () => {
        throw new Error('expected the poll to reject');
      },
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(CloudAuthError);
    expect((error as CloudAuthError).code).toBe('AUTH_DEVICE_FLOW_FAILED');
  });

  it('falls back to the requested api url when the server omits one', async () => {
    const { hooks } = harness([
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      }),
    ]);

    const auth = await pollForDeviceToken(API_URL, AUTHORIZATION, hooks);
    expect(auth.apiUrl).toBe(API_URL);
  });
});

describe('headless detection', () => {
  it('treats an ssh session as headless', () => {
    expect(isHeadlessEnvironment({ SSH_CONNECTION: '10.0.0.1 22' }, 'darwin')).toBe(true);
    expect(isHeadlessEnvironment({ SSH_TTY: '/dev/pts/0' }, 'linux')).toBe(true);
  });

  it('does not treat CI alone as headless', () => {
    // CI has no browser, but it also has no human to approve the code, so
    // routing it to the device flow would hang for the whole grant lifetime
    // instead of failing fast with "login required".
    expect(isHeadlessEnvironment({ CI: 'true', DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(isHeadlessEnvironment({ CI: 'true' }, 'darwin')).toBe(false);
  });

  it('treats a Unix host with no display server as headless', () => {
    expect(isHeadlessEnvironment({}, 'linux')).toBe(true);
    expect(isHeadlessEnvironment({ DISPLAY: ':0' }, 'linux')).toBe(false);
    expect(isHeadlessEnvironment({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(false);
  });

  it('does not treat a local desktop as headless', () => {
    // macOS and Windows always have a way to open a browser.
    expect(isHeadlessEnvironment({}, 'darwin')).toBe(false);
    expect(isHeadlessEnvironment({}, 'win32')).toBe(false);
  });
});

describe('instructions', () => {
  it('shows the URL and the code the user must type', () => {
    const text = formatDeviceInstructions(AUTHORIZATION);
    expect(text).toContain('https://agentrelay.com/cloud/device');
    expect(text).toContain('BCDF-GHJK');
  });

  it('prints the code before waiting, so the user is never left guessing', async () => {
    const logs: string[] = [];
    const responses = [
      jsonResponse(
        {
          device_code: 'cld_dc_test',
          user_code: 'BCDF-GHJK',
          verification_uri: 'https://agentrelay.com/cloud/device',
          expires_in: 600,
          interval: 5,
        },
        { status: 201 }
      ),
      jsonResponse({
        access_token: 'cld_at_abc',
        refresh_token: 'cld_rt_abc',
        access_token_expires_at: '2026-08-07T00:00:00.000Z',
      }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);

    await runDeviceAuthorizationFlow(API_URL, {
      clientName: 'barry',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      log: (message) => logs.push(message),
    });

    expect(logs.join('\n')).toContain('BCDF-GHJK');
    expect(logs.join('\n')).toContain('Waiting for authorization');
  });
});
