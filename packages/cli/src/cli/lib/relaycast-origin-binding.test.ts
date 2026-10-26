import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Command } from 'commander';

import { registerWorkspaceCommands } from '../commands/workspace.js';
import { writeProjectWorkspaceKey } from './project-workspace-key.js';
import { bindOrigin, boundOrigin, originBindingsPath, unbindOrigin } from './relaycast-origin-binding.js';
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
  vi.unstubAllEnvs();
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

  it('keeps a path prefix (a server behind a proxy) across shells', () => {
    resolveWorkspaceTransport({
      workspaceKey: SELF_HOSTED_KEY,
      env: envWith({ RELAY_BASE_URL: 'https://proxy.corp.test/relaycast/' }),
    });
    expect(resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith() }).baseUrl).toBe(
      'https://proxy.corp.test/relaycast'
    );
  });

  it('rejects a RELAY_BASE_URL with a query or fragment', () => {
    for (const value of ['https://relay.corp.test/?x=1', 'https://relay.corp.test/#frag']) {
      expect(() =>
        resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith({ RELAY_BASE_URL: value }) })
      ).toThrow(/query or fragment/);
    }
  });

  it('never lets a persisted hosted route take a key bound to a self-hosted server', () => {
    bindOrigin(SELF_HOSTED_KEY, 'https://relay.corp.test', envWith());
    writeProjectWorkspaceKey(path.join(project, '.agentworkforce/relay'), SELF_HOSTED_KEY, {
      workspaceId: 'rw_route',
      relaycastRoute: 'canonical',
      relaycastBaseUrl: 'https://cast.agentrelay.com',
    });
    expect(() => resolveWorkspaceTransport({ env: envWith() })).toThrow(
      /belongs to https:\/\/relay\.corp\.test/
    );
    expect(() => resolveBaseUrl({ env: envWith() })).toThrow(/belongs to/);
    // RELAY_BASE_URL does not override a persisted route, so it must not unbind either.
    expect(() =>
      resolveWorkspaceTransport({ env: envWith({ RELAY_BASE_URL: 'https://relay.corp.test' }) })
    ).toThrow(/belongs to/);
    expect(boundOrigin(SELF_HOSTED_KEY, envWith())).toBe('https://relay.corp.test');
    // An explicit --base-url is a deliberate choice and moves the key.
    expect(
      resolveWorkspaceTransport({ baseUrl: 'https://cast.agentrelay.com', env: envWith() }).baseUrl
    ).toBe('https://cast.agentrelay.com');
    expect(boundOrigin(SELF_HOSTED_KEY, envWith())).toBeUndefined();
  });

  it.each([
    ['an array of origins', { version: 1, origins: ['https://relay.corp.test'] }],
    ['a null server', { version: 1, origins: { ['a'.repeat(32)]: null } }],
    ['an empty server', { version: 1, origins: { ['a'.repeat(32)]: '' } }],
    ['a non-http server', { version: 1, origins: { ['a'.repeat(32)]: 'file:///etc/passwd' } }],
    ['a credential-bearing server', { version: 1, origins: { ['a'.repeat(32)]: 'https://u:p@evil.test' } }],
    ['a hosted server', { version: 1, origins: { ['a'.repeat(32)]: 'https://cast.agentrelay.com' } }],
    ['a malformed fingerprint', { version: 1, origins: { 'not-a-fingerprint': 'https://relay.corp.test' } }],
    ['an array root', [{ version: 1, origins: {} }]],
    ['an unknown version', { version: 2, origins: {} }],
  ])('fails closed on a binding file with %s', (_label, contents) => {
    fs.mkdirSync(path.dirname(originBindingsPath(envWith())), { recursive: true });
    fs.writeFileSync(originBindingsPath(envWith()), JSON.stringify(contents));
    expect(() => resolveWorkspaceTransport({ workspaceKey: SELF_HOSTED_KEY, env: envWith() })).toThrow(
      /not a valid Relaycast origin file/
    );
  });

  it("does not lose another process's binding written while this one waits for the lock", async () => {
    const file = originBindingsPath(envWith());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const otherFingerprint = 'b'.repeat(32);
    // Another CLI process takes the lock, then writes its own binding.
    const other = spawn(
      process.execPath,
      [
        '-e',
        `const fs = require('node:fs');
         const path = require('node:path');
         const [file, fingerprint] = process.argv.slice(1);
         fs.mkdirSync(file + '.lock');
         fs.writeFileSync(path.join(file + '.lock', 'owner'), String(process.pid));
         console.log('locked');
         setTimeout(() => {
           fs.writeFileSync(file, JSON.stringify({ version: 1, origins: { [fingerprint]: 'https://other.corp.test' } }));
           fs.rmSync(file + '.lock', { recursive: true, force: true });
         }, 300);`,
        file,
        otherFingerprint,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    await new Promise<void>((resolve) => other.stdout.once('data', () => resolve()));
    bindOrigin(SELF_HOSTED_KEY, 'https://relay.corp.test', envWith());
    await new Promise((resolve) => other.once('exit', resolve));

    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { origins: Record<string, string> };
    expect(saved.origins[otherFingerprint]).toBe('https://other.corp.test');
    expect(boundOrigin(SELF_HOSTED_KEY, envWith())).toBe('https://relay.corp.test');
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('recovers a lock left by a process that exited', () => {
    const file = originBindingsPath(envWith());
    fs.mkdirSync(`${file}.lock`, { recursive: true });
    // Far above any real pid limit, so it is never alive.
    fs.writeFileSync(path.join(`${file}.lock`, 'owner'), '2147483646');
    bindOrigin(SELF_HOSTED_KEY, 'https://relay.corp.test', envWith());
    expect(boundOrigin(SELF_HOSTED_KEY, envWith())).toBe('https://relay.corp.test');
    expect(unbindOrigin(SELF_HOSTED_KEY, envWith())).toBe(true);
    expect(boundOrigin(SELF_HOSTED_KEY, envWith())).toBeUndefined();
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
  });

  it('checks the binding file before workspace create mints a key', async () => {
    vi.stubEnv('AGENT_RELAY_HOME', home);
    vi.stubEnv('AGENT_RELAY_PROJECT', project);
    vi.stubEnv('RELAY_BASE_URL', 'https://relay.corp.test');
    fs.writeFileSync(originBindingsPath(envWith()), '{not json');
    const createWorkspace = vi.fn(async () => ({ workspaceKey: 'rk_live_minted' }));
    const errors: string[] = [];
    const program = new Command().exitOverride();
    registerWorkspaceCommands(program, {
      log: () => undefined,
      error: (...args: unknown[]) => errors.push(args.join(' ')),
      exit: ((code: number) => {
        throw new Error(`exit:${code}`);
      }) as never,
      createWorkspace: createWorkspace as never,
    });
    await expect(program.parseAsync(['workspace', 'create', 'corp'], { from: 'user' })).rejects.toThrow(
      'exit:1'
    );
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('not a valid Relaycast origin file');
  });
});

function isAgentRelayHost(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === 'agentrelay.com' || hostname.endsWith('.agentrelay.com');
}

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
      if (isAgentRelayHost(url)) {
        throw new Error(`credential sent to the hosted gateway: ${url}`);
      }
      return realFetch(input, init);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function hostedRequests(): string[] {
    return requests.filter(isAgentRelayHost);
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
