import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Command } from 'commander';

import { registerWorkspaceCommands } from '../commands/workspace.js';
import { originBindingsPath } from './relaycast-origin-binding.js';
import { createAgentRelay, resolveBaseUrl, resolveWorkspaceTransport } from './sdk-client.js';

const SELF_HOSTED_KEY = 'rk_live_selfhosted_origin_binding';
const SELF_HOSTED_TOKEN = 'at_live_selfhosted_origin_binding';

let home: string;
let project: string;

function envWith(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { AGENT_RELAY_HOME: home, AGENT_RELAY_PROJECT: project, ...extra };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-origin-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-origin-project-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe('Relaycast credential origin binding', () => {
  it('keeps sending a self-hosted key to its server after RELAY_BASE_URL is unset', () => {
    const first = resolveWorkspaceTransport({
      workspaceKey: SELF_HOSTED_KEY,
      env: envWith({ RELAY_BASE_URL: 'https://relay.corp.test:8443' }),
    });
    expect(first.baseUrl).toBe('https://relay.corp.test:8443');

    const later = resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith() });
    expect(later.baseUrl).toBe('https://relay.corp.test:8443');
    expect(resolveBaseUrl({ workspaceKey: SELF_HOSTED_KEY, env: envWith() })).toBe(
      'https://relay.corp.test:8443'
    );
  });

  it('lets an explicit URL move the binding, and an explicit hosted URL clear it', () => {
    const bind = (url: string) =>
      resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith({ RELAY_BASE_URL: url }) });
    bind('https://relay.corp.test');
    bind('https://relay-new.corp.test');
    expect(resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith() }).baseUrl).toBe(
      'https://relay-new.corp.test'
    );
    bind('https://cast.agentrelay.com');
    expect(resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith() }).baseUrl).toBe(
      undefined
    );
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('treats a %s RELAY_BASE_URL as unset, which still keeps a bound key on its server', (_label, value) => {
    resolveWorkspaceTransport({
      workspaceKey: SELF_HOSTED_KEY,
      env: envWith({ RELAY_BASE_URL: 'https://relay.corp.test' }),
    });
    expect(
      resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith({ RELAY_BASE_URL: value }) })
        .baseUrl
    ).toBe('https://relay.corp.test');
  });

  it.each([
    ['unparsable', 'relay corp test'],
    ['non-http', 'ftp://relay.corp.test'],
    ['credential-bearing', 'https://user:secret@relay.corp.test'],
  ])('rejects a %s RELAY_BASE_URL instead of defaulting to hosted', (_label, value) => {
    expect(() =>
      resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith({ RELAY_BASE_URL: value }) })
    ).toThrow(/Relaycast base URL/);
  });

  it('binds agent tokens the same way', () => {
    createAgentRelay({
      token: SELF_HOSTED_TOKEN,
      env: envWith({ RELAY_BASE_URL: 'https://relay.corp.test' }),
    });
    expect(fs.readFileSync(originBindingsPath(envWith()), 'utf8')).toContain('https://relay.corp.test');
  });

  it('records nothing for a hosted URL', () => {
    resolveWorkspaceTransport({
      workspaceKey: 'rk_live_hosted_explicit',
      env: envWith({ RELAY_BASE_URL: 'https://cast.agentrelay.com' }),
    });
    expect(fs.existsSync(originBindingsPath(envWith()))).toBe(false);
  });

  it('keeps bindings in the process home when a scoped env omits AGENT_RELAY_HOME', () => {
    const previous = process.env.AGENT_RELAY_HOME;
    process.env.AGENT_RELAY_HOME = home;
    try {
      resolveWorkspaceTransport({
        workspaceKey: SELF_HOSTED_KEY,
        env: { RELAY_BASE_URL: 'https://relay.corp.test' },
      });
      expect(fs.existsSync(path.join(home, 'relaycast-origins.json'))).toBe(true);
    } finally {
      process.env.AGENT_RELAY_HOME = previous;
    }
  });

  it('leaves an unbound key with no configured URL on the hosted default', () => {
    expect(resolveWorkspaceTransport({ workspaceKey: 'rk_live_hosted_only', env: envWith() }).baseUrl).toBe(
      undefined
    );
  });

  it('stores a fingerprint, never the credential, with private permissions', () => {
    resolveWorkspaceTransport({
      workspaceKey: SELF_HOSTED_KEY,
      env: envWith({ RELAY_BASE_URL: 'https://relay.corp.test' }),
    });
    const file = originBindingsPath(envWith());
    const contents = fs.readFileSync(file, 'utf8');
    expect(contents).not.toContain(SELF_HOSTED_KEY);
    expect(contents).toContain('https://relay.corp.test');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed on a corrupt binding file rather than forgetting every binding', () => {
    fs.mkdirSync(path.dirname(originBindingsPath(envWith())), { recursive: true });
    fs.writeFileSync(originBindingsPath(envWith()), '{not json');
    expect(() => resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith() })).toThrow(
      /not a valid Relaycast origin file/
    );
  });
});

describe('workspace commands bind keys to the configured server', () => {
  it('a key joined with RELAY_BASE_URL keeps going to that server afterwards', async () => {
    vi.stubEnv('AGENT_RELAY_HOME', home);
    vi.stubEnv('AGENT_RELAY_PROJECT', project);
    vi.stubEnv('RELAY_BASE_URL', 'https://relay.corp.test:8443');
    const program = new Command().exitOverride();
    registerWorkspaceCommands(program, { log: () => undefined, error: () => undefined });
    await program.parseAsync(['workspace', 'join', 'corp', SELF_HOSTED_KEY], { from: 'user' });

    vi.stubEnv('RELAY_BASE_URL', '');
    expect(resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith() }).baseUrl).toBe(
      'https://relay.corp.test:8443'
    );
    vi.unstubAllEnvs();
  });
});

describe('network: a self-hosted credential never reaches the hosted gateway', () => {
  let server: http.Server;
  let selfHostedOrigin: string;
  const requests: string[] = [];

  beforeEach(async () => {
    requests.length = 0;
    server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, data: [] }));
      void request;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    selfHostedOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (new URL(url).hostname.endsWith('agentrelay.com')) {
        throw new Error(`credential sent to the hosted gateway: ${url}`);
      }
      return realFetch(input, init);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function hostedRequests(): string[] {
    return requests.filter((url) => new URL(url).hostname.endsWith('agentrelay.com'));
  }

  it('sends a bound key to its own server when RELAY_BASE_URL is missing or blank', async () => {
    resolveWorkspaceTransport({
      workspaceKey: SELF_HOSTED_KEY,
      env: envWith({ RELAY_BASE_URL: selfHostedOrigin }),
    });

    for (const unset of [envWith(), envWith({ RELAY_BASE_URL: '' })]) {
      const relay = createAgentRelay({ workspaceKey: SELF_HOSTED_KEY, env: unset });
      await relay.agents.list().catch(() => undefined);
    }

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((url) => url.startsWith(selfHostedOrigin))).toBe(true);
    expect(hostedRequests()).toEqual([]);
  });

  it('sends nothing at all when RELAY_BASE_URL is malformed', () => {
    resolveWorkspaceTransport({
      workspaceKey: SELF_HOSTED_KEY,
      env: envWith({ RELAY_BASE_URL: selfHostedOrigin }),
    });
    for (const malformed of ['not a url', 'ftp://relay.corp.test', 'https://u:p@relay.corp.test']) {
      expect(() =>
        createAgentRelay({ workspaceKey: SELF_HOSTED_KEY, env: envWith({ RELAY_BASE_URL: malformed }) })
      ).toThrow();
    }
    expect(requests).toEqual([]);
  });

  it('sends a bound agent token to its own server when RELAY_BASE_URL is missing', async () => {
    createAgentRelay({ token: SELF_HOSTED_TOKEN, env: envWith({ RELAY_BASE_URL: selfHostedOrigin }) });

    const relay = createAgentRelay({ token: SELF_HOSTED_TOKEN, env: envWith() });
    await relay.agents.list().catch(() => undefined);

    expect(requests.length).toBeGreaterThan(0);
    expect(hostedRequests()).toEqual([]);
  });
});
