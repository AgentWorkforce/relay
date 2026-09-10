import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// @ts-expect-error The generated helper is also executed directly by Node in Daytona.
import { buildNodeAppServerModelProofScript } from '../../scripts/verify-features/fleet-daytona.mjs';

async function executeGeneratedHelper(options: { modelFails?: boolean; releaseFails?: boolean } = {}) {
  const commands: string[][] = [];
  const requests: string[] = [];
  const handlers = new Map<string, () => void>();
  let stdout = '';
  let stderr = '';
  let sessionExists = false;
  let workerExists = false;
  let tempExists = true;
  const provider = { pid: 1234, exitCode: null, signalCode: null as string | null, unref() {} };
  const processStub = {
    argv: ['node', 'test-worker', 'openai/gpt-5.4', 'test-node', 'test-sandbox'],
    env: {},
    cwd: () => '/test-sandbox',
    on: (signal: string, handler: () => void) => handlers.set(signal, handler),
    kill: (_pid: number, signal: string | number) => {
      if (signal === 'SIGTERM') provider.signalCode = 'SIGTERM';
    },
    stdout: {
      write: (text: string) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text: string) => {
        stderr += text;
      },
    },
    exitCode: undefined as number | undefined,
  };
  const modules = {
    'node:path': path,
    'node:os': { homedir: () => '/test-home', tmpdir: () => '/tmp' },
    'node:fs': {
      existsSync: (p: string) => (p === '/tmp/model-proof' ? tempExists : true),
      readdirSync: () => [{ name: 'connection.json', isFile: () => true, isDirectory: () => false }],
      readFileSync: () => JSON.stringify({ url: 'http://broker', api_key: 'test-key' }),
      mkdtempSync: () => '/tmp/model-proof',
      rmSync: () => {
        tempExists = false;
      },
    },
    'node:net': {
      createServer: () => ({
        once() {},
        listen: (_port: number, _host: string, callback: () => void) => callback(),
        address: () => ({ port: 4096 }),
        close: (callback: () => void) => callback(),
      }),
    },
    'node:child_process': {
      spawn: () => provider,
      spawnSync: (command: string, args: string[], config: { env?: Record<string, string> }) => {
        commands.push([command, ...args]);
        if (command === 'opencode') return { status: 0, stdout: '1.18.29', stderr: '' };
        expect(config.env?.AGENT_RELAY_STATE_DIR).toBe('/test-home/.agentworkforce/relay');
        if (args[2] === 'spawn') workerExists = true;
        if (args[2] === 'release') workerExists = false;
        const failure =
          (args[2] === 'set-model' && options.modelFails) || (args[2] === 'release' && options.releaseFails);
        return {
          status: failure ? 1 : 0,
          stderr: failure ? 'injected CLI failure' : '',
          stdout:
            args[2] === 'set-model'
              ? JSON.stringify(
                  {
                    name: 'test-worker',
                    requestedModel: 'openai/gpt-5.4',
                    effectiveModel: 'openai/gpt-5.4',
                    status: 'applied',
                    applied: true,
                    accepted: true,
                    success: true,
                    pending: false,
                    requestId: 'request-1',
                    generation: 'generation-1',
                  },
                  null,
                  2
                )
              : '',
        };
      },
    },
  };
  const fetchStub = async (url: string, init: { method?: string } = {}) => {
    requests.push(`${init.method ?? 'GET'} ${url}`);
    let status = 200;
    let body: unknown = {};
    if (url.endsWith('/api/status')) body = { node_name: 'test-node' };
    else if (url.endsWith('/global/health')) {
      if (provider.signalCode) throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } });
    } else if (url.endsWith('/api/spawned/test-worker/model')) status = workerExists ? 200 : 404;
    else if (url.endsWith('/session') && init.method === 'POST') {
      sessionExists = true;
      body = { id: 'session-1' };
    } else if (url.endsWith('/session/session-1')) {
      if (init.method === 'DELETE') sessionExists = false;
      else if (!sessionExists) status = 404;
      body = { id: 'session-1', model: { providerID: 'openai', id: 'gpt-5.4' } };
    } else throw new Error(`Unexpected request ${url}`);
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  await runInNewContext(buildNodeAppServerModelProofScript(), {
    require: (name: keyof typeof modules) => modules[name],
    process: processStub,
    fetch: fetchStub,
    AbortSignal,
    setTimeout,
  });
  return {
    commands,
    requests,
    handlers,
    stdout,
    stderr,
    exitCode: processStub.exitCode,
    sessionExists,
    workerExists,
    tempExists,
    provider,
  };
}

describe('generated Daytona OpenCode helper execution', () => {
  it('executes its own cleanup after a confirmed public model change', async () => {
    const result = await executeGeneratedHelper();
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ cleanup: true, providerModel: 'openai/gpt-5.4' });
    expect(result.commands.some((argv) => argv[3] === 'set-model' && argv.at(-1) === '--json')).toBe(true);
    expect(result.commands.some((argv) => argv[3] === 'release')).toBe(true);
    expect(result.requests).toContain('DELETE http://127.0.0.1:4096/session/session-1');
    expect(result.sessionExists || result.workerExists || result.tempExists).toBe(false);
    expect(result.provider.signalCode).toBe('SIGTERM');
    expect([...result.handlers.keys()]).toEqual(['SIGTERM', 'SIGINT']);
  });

  it('cleans up provider resources when the public model command fails', async () => {
    const result = await executeGeneratedHelper({ modelFails: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('public set-model failed');
    expect(result.sessionExists || result.workerExists || result.tempExists).toBe(false);
    expect(result.provider.signalCode).toBe('SIGTERM');
  });

  it('keeps release failure red while still deleting the session and stopping the provider', async () => {
    const result = await executeGeneratedHelper({ releaseFails: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('worker release failed');
    expect(result.stdout).toBe('');
    expect(result.sessionExists || result.tempExists).toBe(false);
    expect(result.provider.signalCode).toBe('SIGTERM');
  });
});
