import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  describeMissingBrokerConnection,
  readConnectionFileFromDisk,
  resolveBrokerConnection,
  resolveConnectionStateDir,
  toWsUrl,
  type BrokerConnectionDeps,
} from './broker-connection.js';

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
      env: { RELAY_BROKER_API_KEY: 'env-key' },
      readConnectionFile: vi.fn(() => ({ url: 'http://localhost:3889' })),
    });
    const conn = resolveBrokerConnection({ apiKey: '   ' }, deps);
    expect(conn?.apiKey).toBe('env-key');
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
});

describe('explicit --state-dir selection', () => {
  // Fixture keys go through path.resolve, as the resolver does, so they match on every platform.
  const nodeDir = path.resolve('/srv/node');
  const nodeStateDir = path.join(nodeDir, 'state');
  const files: Record<string, unknown> = {
    [nodeStateDir]: { url: 'http://node-host:4100/', api_key: 'node-key' },
  };
  const readConnectionFile = vi.fn((dir: string) => files[dir] ?? null);

  it('wins over ambient RELAY_BROKER_URL / RELAY_BROKER_API_KEY (relay#1822)', () => {
    const deps = makeDeps({
      env: { RELAY_BROKER_URL: 'http://other:1', RELAY_BROKER_API_KEY: 'other-key' },
      readConnectionFile,
    });
    expect(resolveBrokerConnection({ stateDir: nodeStateDir }, deps)).toEqual({
      url: 'http://node-host:4100',
      apiKey: 'node-key',
    });
  });

  it('never falls back to env when the named state dir has no broker', () => {
    const deps = makeDeps({ env: { RELAY_BROKER_URL: 'http://other:1' }, readConnectionFile });
    expect(resolveBrokerConnection({ stateDir: path.resolve('/srv/missing') }, deps)).toBeNull();
  });

  it('still lets --api-key override the connection file key', () => {
    const deps = makeDeps({ readConnectionFile });
    expect(resolveBrokerConnection({ stateDir: nodeStateDir, apiKey: 'flag-key' }, deps)?.apiKey).toBe(
      'flag-key'
    );
  });

  it('pairs --broker-url with the named state dir key, not the env key', () => {
    const deps = makeDeps({ env: { RELAY_BROKER_API_KEY: 'other-key' }, readConnectionFile });
    expect(resolveBrokerConnection({ stateDir: nodeDir, brokerUrl: 'http://tunnel:9000' }, deps)).toEqual({
      url: 'http://tunnel:9000',
      apiKey: 'node-key',
    });
  });

  it('accepts a fleet node directory whose broker state lives in state/ (relay#1575)', () => {
    const deps = makeDeps({ readConnectionFile });
    expect(resolveBrokerConnection({ stateDir: nodeDir }, deps)?.url).toBe('http://node-host:4100');
  });

  it('reads the nested state/connection.json from disk and prefers an exact match', () => {
    const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-dir-'));
    try {
      fs.mkdirSync(path.join(nodeDir, 'state'));
      fs.writeFileSync(
        path.join(nodeDir, 'state', 'connection.json'),
        JSON.stringify({ url: 'http://127.0.0.1:4555', api_key: 'nested' })
      );
      const deps = makeDeps({ readConnectionFile: readConnectionFileFromDisk });
      expect(resolveConnectionStateDir(nodeDir)).toBe(path.join(nodeDir, 'state'));
      expect(resolveBrokerConnection({ stateDir: nodeDir }, deps)?.apiKey).toBe('nested');

      fs.writeFileSync(
        path.join(nodeDir, 'connection.json'),
        JSON.stringify({ url: 'http://127.0.0.1:4666', api_key: 'exact' })
      );
      expect(resolveConnectionStateDir(nodeDir)).toBe(nodeDir);
      expect(resolveBrokerConnection({ stateDir: nodeDir }, deps)?.apiKey).toBe('exact');
    } finally {
      fs.rmSync(nodeDir, { recursive: true, force: true });
    }
  });
});

describe('malformed exact connection file', () => {
  it('fails instead of falling back to a nested broker', () => {
    const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-node-dir-'));
    try {
      fs.mkdirSync(path.join(nodeDir, 'state'));
      fs.writeFileSync(path.join(nodeDir, 'connection.json'), '{not json');
      fs.writeFileSync(
        path.join(nodeDir, 'state', 'connection.json'),
        JSON.stringify({ url: 'http://127.0.0.1:4555', api_key: 'nested' })
      );
      const deps = makeDeps({ readConnectionFile: readConnectionFileFromDisk });
      expect(resolveBrokerConnection({ stateDir: nodeDir }, deps)).toBeNull();
    } finally {
      fs.rmSync(nodeDir, { recursive: true, force: true });
    }
  });
});

describe('describeMissingBrokerConnection', () => {
  it('names the --state-dir paths that were searched', () => {
    const nodeDir = path.resolve('/srv/node');
    expect(describeMissingBrokerConnection({ stateDir: nodeDir }, makeDeps())).toBe(
      `Error: no broker connection at ${path.join(nodeDir, 'connection.json')} (from --state-dir; also checked ${path.join(nodeDir, 'state', 'connection.json')}). Pass the same --state-dir the broker was started with.`
    );
  });

  it('labels the project default and points at --state-dir', () => {
    const message = describeMissingBrokerConnection({}, makeDeps());
    expect(message).toContain(
      `${path.join('/tmp/fake/.agentworkforce/relay', 'connection.json')} (project default)`
    );
    expect(message).toContain('If the broker was started with --state-dir, pass the same --state-dir here');
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
