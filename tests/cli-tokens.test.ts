import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Command } from 'commander';
import { test } from 'vitest';

import { AUTH_FILE_PATH } from '../packages/cloud/src/index.js';
import {
  registerProactiveBootstrapCommands,
  type ProactiveBootstrapDependencies,
} from '../src/cli/commands/proactive-bootstrap.js';

function createHarness(overrides: Partial<ProactiveBootstrapDependencies> = {}) {
  const deps: ProactiveBootstrapDependencies = {
    log: () => {},
    error: () => {},
    exit: ((code: number) => {
      throw new Error(`exit:${code}`);
    }) as ProactiveBootstrapDependencies['exit'],
    ...overrides,
  };

  const program = new Command();
  registerProactiveBootstrapCommands(program, deps);

  return { program, deps };
}

function installEnvAuth(): () => void {
  const original = {
    CLOUD_API_URL: process.env.CLOUD_API_URL,
    CLOUD_API_ACCESS_TOKEN: process.env.CLOUD_API_ACCESS_TOKEN,
    CLOUD_API_REFRESH_TOKEN: process.env.CLOUD_API_REFRESH_TOKEN,
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT,
  };

  process.env.CLOUD_API_URL = 'https://cloud.test';
  process.env.CLOUD_API_ACCESS_TOKEN = 'access_token_test';
  process.env.CLOUD_API_REFRESH_TOKEN = 'refresh_token_test';
  process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT = new Date(Date.now() + 10 * 60_000).toISOString();

  return () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function createLogCollector(): {
  deps: Pick<ProactiveBootstrapDependencies, 'log' | 'error'>;
  lines: string[];
  errors: string[];
} {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    deps: {
      log: (...args: unknown[]) => {
        lines.push(args.map((value) => String(value)).join(' '));
      },
      error: (...args: unknown[]) => {
        errors.push(args.map((value) => String(value)).join(' '));
      },
    },
    lines,
    errors,
  };
}

async function restoreAuthFile(previousContents: string | null): Promise<void> {
  if (previousContents === null) {
    await fs.rm(AUTH_FILE_PATH, { force: true });
    return;
  }

  await fs.writeFile(AUTH_FILE_PATH, previousContents, 'utf8');
}

test('tokens issue prints the issued workspace key by default', async () => {
  const collector = createLogCollector();
  const { program } = createHarness(collector.deps);
  const { lines, errors } = collector;
  const restoreEnv = installEnvAuth();
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    url: string;
    method: string;
    authorization: string | null;
    body: { workspaceId: string; name: string };
  }> = [];

  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const body = (await request.json()) as { workspaceId: string; name: string };
    requests.push({
      url: request.url,
      method: request.method,
      authorization: request.headers.get('authorization'),
      body,
    });

    return Response.json(
      {
        key: 'relay_ws_live_support',
        workspaceToken: {
          workspaceId: 'support',
          kind: 'workspace_token',
        },
      },
      { status: 200 }
    );
  }) as typeof globalThis.fetch;

  try {
    await program.parseAsync(['node', 'agent-relay', 'tokens', 'issue', '--workspace', 'support']);

    assert.deepEqual(errors, []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, 'https://cloud.test/api/v1/workspaces/support/tokens/workspace');
    assert.equal(requests[0]?.method, 'POST');
    assert.equal(requests[0]?.authorization, 'Bearer access_token_test');
    assert.deepEqual(requests[0]?.body, {
      workspaceId: 'support',
      name: 'workspace:support',
    });
    assert.deepEqual(lines, [
      'RELAY_API_KEY=relay_ws_live_support',
      'Export this value before starting SDK-backed proactive runtime commands.',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test('tokens issue prints raw JSON when --json is set', async () => {
  const collector = createLogCollector();
  const { program } = createHarness(collector.deps);
  const { lines, errors } = collector;
  const restoreEnv = installEnvAuth();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    Response.json(
      {
        key: 'relay_ws_live_sales',
        workspaceToken: {
          workspaceId: 'sales',
          kind: 'workspace_token',
          name: 'workspace:sales',
        },
      },
      { status: 200 }
    )) as typeof globalThis.fetch;

  try {
    await program.parseAsync(['node', 'agent-relay', 'tokens', 'issue', '--workspace', 'sales', '--json']);

    assert.deepEqual(errors, []);
    assert.deepEqual(lines, [
      JSON.stringify(
        {
          key: 'relay_ws_live_sales',
          workspaceToken: {
            workspaceId: 'sales',
            kind: 'workspace_token',
            name: 'workspace:sales',
          },
        },
        null,
        2
      ),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test('login prints a success message after fresh OAuth', async () => {
  const collector = createLogCollector();
  const { program } = createHarness(collector.deps);
  const { lines, errors } = collector;
  const originalConsoleLog = console.log;
  const loginUrls: string[] = [];
  let previousAuthFile: string | null = null;

  try {
    previousAuthFile = await fs.readFile(AUTH_FILE_PATH, 'utf8');
  } catch {
    previousAuthFile = null;
  }

  console.log = ((...args: unknown[]) => {
    const line = args.map((value) => String(value)).join(' ');
    if (line.startsWith('Opening browser for cloud login: ')) {
      loginUrls.push(line.slice('Opening browser for cloud login: '.length));
    }
  }) as typeof console.log;

  try {
    const loginPromise = program.parseAsync([
      'node',
      'agent-relay',
      'login',
      '--api-url',
      'https://cloud.test',
      '--force',
    ]);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (loginUrls.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.ok(loginUrls[0], 'expected browser login URL to be emitted');
    const loginUrl = new URL(loginUrls[0]);
    const redirectUri = loginUrl.searchParams.get('redirect_uri');
    const state = loginUrl.searchParams.get('state');

    assert.ok(redirectUri, 'expected redirect_uri in login URL');
    assert.ok(state, 'expected state in login URL');

    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set('state', state);
    callbackUrl.searchParams.set('access_token', 'access_token_test');
    callbackUrl.searchParams.set('refresh_token', 'refresh_token_test');
    callbackUrl.searchParams.set('access_token_expires_at', new Date(Date.now() + 60_000).toISOString());
    callbackUrl.searchParams.set('api_url', 'https://cloud.test');

    const callbackResponse = await fetch(callbackUrl, { redirect: 'manual' });
    assert.equal(callbackResponse.status, 302);

    await loginPromise;

    assert.deepEqual(errors, []);
    assert.deepEqual(lines, ['Logged in to https://cloud.test']);
  } finally {
    console.log = originalConsoleLog;
    await restoreAuthFile(previousAuthFile);
    delete process.env.CLOUD_API_URL;
    delete process.env.CLOUD_API_ACCESS_TOKEN;
    delete process.env.CLOUD_API_REFRESH_TOKEN;
    delete process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT;
  }
}, 10000);

test('workspaces create prints a formatted result by default', async () => {
  const collector = createLogCollector();
  const { program } = createHarness(collector.deps);
  const { lines, errors } = collector;
  const restoreEnv = installEnvAuth();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    Response.json(
      {
        workspaceId: 'ws_support',
        name: 'support',
        relayfileUrl: 'https://relayfile.test',
        relaycronUrl: 'https://relaycron.test',
        relaycastUrl: 'https://relaycast.test',
        relayauthUrl: 'https://relayauth.test',
        joinCommand: 'relay on codex --workspace ws_support',
      },
      { status: 201 }
    )) as typeof globalThis.fetch;

  try {
    await program.parseAsync(['node', 'agent-relay', 'workspaces', 'create', 'support']);

    assert.deepEqual(errors, []);
    assert.ok(lines.includes('Workspace created: ws_support'));
    assert.ok(lines.includes('Name: support'));
    assert.ok(lines.includes('Relayfile URL: https://relayfile.test'));
    assert.ok(lines.includes('Relaycron URL: https://relaycron.test'));
    assert.ok(lines.includes('Relaycast URL: https://relaycast.test'));
    assert.ok(lines.includes('Relayauth URL: https://relayauth.test'));
    assert.ok(lines.includes('Join command: relay on codex --workspace ws_support'));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test('init reuses the workspace bootstrap flow', async () => {
  const collector = createLogCollector();
  const { program } = createHarness(collector.deps);
  const { lines, errors } = collector;
  const restoreEnv = installEnvAuth();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    Response.json(
      {
        workspaceId: 'ws_init',
        name: 'init-workspace',
        relayfileUrl: 'https://relayfile.test',
        relaycronUrl: 'https://relaycron.test',
        relaycastUrl: 'https://relaycast.test',
        relayauthUrl: 'https://relayauth.test',
      },
      { status: 201 }
    )) as typeof globalThis.fetch;

  try {
    await program.parseAsync(['node', 'agent-relay', 'init', 'init-workspace']);

    assert.deepEqual(errors, []);
    assert.ok(lines.includes('Workspace created: ws_init'));
    assert.ok(lines.includes('Name: init-workspace'));
    assert.ok(lines.includes('Relayfile URL: https://relayfile.test'));
    assert.ok(lines.includes('Relaycron URL: https://relaycron.test'));
    assert.ok(lines.includes('Relaycast URL: https://relaycast.test'));
    assert.ok(lines.includes('Relayauth URL: https://relayauth.test'));
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test('tokens issue exits cleanly with a user-facing error on request failure', async () => {
  const collector = createLogCollector();
  const { program } = createHarness(collector.deps);
  const { errors } = collector;
  const restoreEnv = installEnvAuth();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    Response.json(
      { error: 'workspace_not_found', message: 'Workspace not found' },
      { status: 404 }
    )) as typeof globalThis.fetch;

  try {
    await assert.rejects(
      program.parseAsync(['node', 'agent-relay', 'tokens', 'issue', '--workspace', 'missing']),
      /exit:1/
    );

    assert.deepEqual(errors, [
      'Workspace token issue failed at /api/v1/workspaces/missing/token: 404 workspace_not_found',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test('workspaces create exits cleanly with a user-facing error on request failure', async () => {
  const collector = createLogCollector();
  const { program } = createHarness(collector.deps);
  const { errors } = collector;
  const restoreEnv = installEnvAuth();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    Response.json(
      { error: 'invalid_request', message: 'Workspace name is invalid' },
      { status: 400 }
    )) as typeof globalThis.fetch;

  try {
    await assert.rejects(
      program.parseAsync(['node', 'agent-relay', 'workspaces', 'create', '!!!']),
      /exit:1/
    );

    assert.deepEqual(errors, ['Workspace create failed at /api/v1/workspaces/create: 400 invalid_request']);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
