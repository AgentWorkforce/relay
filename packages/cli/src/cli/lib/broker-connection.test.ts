import { describe, expect, it, vi } from 'vitest';

import { resolveBrokerConnection, toWsUrl, type BrokerConnectionDeps } from './broker-connection.js';

function makeDeps(overrides: Partial<BrokerConnectionDeps> = {}): BrokerConnectionDeps {
  return {
    readConnectionFile: vi.fn(() => null),
    getDefaultStateDir: vi.fn(() => '/tmp/fake/.agentworkforce/relay'),
    env: {},
    ...overrides,
  };
}

describe('resolveBrokerConnection', () => {
  it('prefers --broker-url over env and connection.json', () => {
    const deps = makeDeps({
      env: { RELAY_BROKER_URL: 'http://env-host:1234' },
      readConnectionFile: vi.fn(() => ({ url: 'http://file-host:5678', api_key: 'file-key' })),
    });
    const conn = resolveBrokerConnection({ brokerUrl: 'http://flag-host:9999' }, deps);
    expect(conn).toEqual({ url: 'http://flag-host:9999', apiKey: 'file-key' });
  });

  it('uses RELAY_BROKER_URL when no flag is provided', () => {
    const deps = makeDeps({
      env: { RELAY_BROKER_URL: 'http://env-host:1234', RELAY_BROKER_API_KEY: 'env-key' },
      readConnectionFile: vi.fn(() => ({ url: 'http://file-host:5678', api_key: 'file-key' })),
    });
    const conn = resolveBrokerConnection({}, deps);
    expect(conn).toEqual({ url: 'http://env-host:1234', apiKey: 'env-key' });
  });

  it('falls back to connection.json for both url and api_key', () => {
    const deps = makeDeps({
      readConnectionFile: vi.fn(() => ({ url: 'http://file-host:5678/', api_key: 'file-key' })),
    });
    const conn = resolveBrokerConnection({}, deps);
    expect(conn).toEqual({ url: 'http://file-host:5678', apiKey: 'file-key' });
  });

  it('returns null when no source provides a URL', () => {
    expect(resolveBrokerConnection({}, makeDeps())).toBeNull();
  });

  it('preserves an internal per-request timeout override', () => {
    const conn = resolveBrokerConnection(
      { brokerUrl: 'http://loopback:3889', requestTimeoutMs: 162_500 },
      makeDeps()
    );
    expect(conn).toEqual({ url: 'http://loopback:3889', apiKey: undefined, requestTimeoutMs: 162_500 });
  });

  // ---- Regression: empty-trim falls through (cubic P2 finding) ----

  it('falls through to env URL when --broker-url is blank/whitespace', () => {
    const deps = makeDeps({
      env: { RELAY_BROKER_URL: 'http://env-host:1234' },
    });
    // `'   '.trim()` is `''`, which is not nullish — `??` would have
    // kept it as the URL. The trim-empty filter must fall through.
    const conn = resolveBrokerConnection({ brokerUrl: '   ' }, deps);
    expect(conn?.url).toBe('http://env-host:1234');
  });

  it('falls through to env API key when --api-key is blank/whitespace', () => {
    const deps = makeDeps({
      env: { RELAY_BROKER_URL: 'http://env-host:1234', RELAY_BROKER_API_KEY: 'env-key' },
    });
    const conn = resolveBrokerConnection({ apiKey: '   ' }, deps);
    expect(conn).toEqual({ url: 'http://env-host:1234', apiKey: 'env-key' });
  });

  it('falls through to file URL when env URL is blank/whitespace', () => {
    const deps = makeDeps({
      env: { RELAY_BROKER_URL: '   ' },
      readConnectionFile: vi.fn(() => ({ url: 'http://file-host:5678' })),
    });
    const conn = resolveBrokerConnection({}, deps);
    expect(conn?.url).toBe('http://file-host:5678');
  });

  it('falls through to file API key when env API key is blank/whitespace', () => {
    const deps = makeDeps({
      env: { RELAY_BROKER_API_KEY: '   ' },
      readConnectionFile: vi.fn(() => ({ url: 'http://localhost:3889', api_key: 'file-key' })),
    });
    const conn = resolveBrokerConnection({}, deps);
    expect(conn?.apiKey).toBe('file-key');
  });

  // ---- Regression: URL and API key must resolve as an atomic pair (#1382) ----

  it('does not pair an env-sourced API key with a file-sourced URL', () => {
    // A relay agent's own broker key sitting in env (RELAY_BROKER_API_KEY)
    // must not get paired with a different repo's broker URL, resolved
    // here from that repo's connection.json with no explicit/env URL.
    const deps = makeDeps({
      env: { RELAY_BROKER_API_KEY: 'own-broker-key' },
      readConnectionFile: vi.fn(() => ({ url: 'http://target-repo-host:4000' })),
    });
    const conn = resolveBrokerConnection({}, deps);
    expect(conn).toEqual({ url: 'http://target-repo-host:4000', apiKey: undefined });
  });

  it('an explicit --api-key still overrides a file-sourced URL', () => {
    const deps = makeDeps({
      env: { RELAY_BROKER_API_KEY: 'own-broker-key' },
      readConnectionFile: vi.fn(() => ({ url: 'http://target-repo-host:4000' })),
    });
    const conn = resolveBrokerConnection({ apiKey: 'explicit-key' }, deps);
    expect(conn).toEqual({ url: 'http://target-repo-host:4000', apiKey: 'explicit-key' });
  });

  it('an explicit --broker-url still discovers its key from env or file normally', () => {
    const deps = makeDeps({
      readConnectionFile: vi.fn(() => ({ url: 'http://file-host:5678', api_key: 'file-key' })),
    });
    const conn = resolveBrokerConnection({ brokerUrl: 'http://flag-host:9999' }, deps);
    expect(conn).toEqual({ url: 'http://flag-host:9999', apiKey: 'file-key' });
  });
});

describe('toWsUrl', () => {
  it('rewrites http://host:port to ws://host:port/ws', () => {
    expect(toWsUrl('http://localhost:3889')).toBe('ws://localhost:3889/ws');
  });

  it('rewrites https://… to wss://…/ws', () => {
    expect(toWsUrl('https://broker.example.com')).toBe('wss://broker.example.com/ws');
  });
});
