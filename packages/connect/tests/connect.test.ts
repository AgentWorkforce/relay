import http from 'node:http';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  downloadCommands,
  ensureProbe,
  findLiveSocket,
  findRecoveringProbe,
  getPlatformAsset,
  installLinux,
  macStageCommands,
  probeVersionSupported,
  requireExistingProbe,
  startDetachedProbe,
  swapMacApp,
  verifyChecksum,
  waitForLiveSocket,
} from '../src/install.js';
import { requestJson } from '../src/http.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function listen(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void
) {
  const root = await mkdtemp(join(os.tmpdir(), 'connect-cli-test-'));
  const home = join(root, 'home');
  const socketPath = join(root, 'relay.sock');
  await mkdir(join(home, '.agentworkforce/desktop'), { recursive: true });
  await writeFile(join(home, '.agentworkforce/desktop/relay-socket'), `${socketPath}\n`);

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => handler(request, response, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolveListen);
  });
  cleanups.push(async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  });
  return { home, socketPath };
}

function json(response: http.ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function runCli(home: string, args: string[], input = '') {
  const launcher = join(home, 'connect');
  await symlink(cli, launcher).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(process.execPath, [launcher, ...args], {
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (code) =>
      resolveRun({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    );
    child.stdin.end(input);
  });
}

describe('@agent-relay/connect CLI', () => {
  it('joins through a fake socket, keeps the host claim private, sends one hello, and is repeatable', async () => {
    const joins: Array<Record<string, string>> = [];
    const hellos: string[] = [];
    const { home } = await listen((request, response, body) => {
      if (request.url === '/setup/status') {
        json(response, { ok: true, data: { version: '2026.10.4' } });
      } else if (request.url === '/connect/join') {
        expect(request.headers['content-type']).toBe('application/json');
        joins.push(JSON.parse(body));
        json(response, {
          ok: true,
          data: {
            connect_id: 'connect-1',
            agent_name: 'guest-one',
            role: 'guest',
            task: 'Review the patch',
            expires_at: '2026-10-02T08:00:00Z',
            host: { person: 'Host Person', agent_name: 'host-agent' },
            participants: [],
          },
        });
      } else if (request.url === '/connect/send?to=host-agent') {
        hellos.push(body);
        json(response, { ok: true, data: { sent: [{ to: 'host-agent', message_id: 'message-1' }] } });
      } else {
        json(response, { ok: false, error: { code: 'unexpected', message: request.url } }, 404);
      }
    });

    const claim = 'single-use-private-claim';
    const first = await runCli(
      home,
      ['join', 'connect-1', '--name', 'guest-one', '--host-claim-stdin'],
      claim
    );
    expect(first.code).toBe(0);
    expect(first.stderr).toBe('');
    expect(first.stdout).toContain('Joined Relay Connect as guest-one (guest).');
    expect(first.stdout).toContain('Replies arrive injected into this session.');
    expect(first.stdout).not.toContain(claim);

    const second = await runCli(home, ['join', 'connect-1', '--json']);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).data.connect_id).toBe('connect-1');
    expect(joins).toEqual([
      { link: 'connect-1', name: 'guest-one', host_claim: claim },
      { link: 'connect-1' },
    ]);
    expect(hellos).toEqual([
      'guest-one joined this Relay Connect and is ready to help.',
      'guest-one joined this Relay Connect and is ready to help.',
    ]);
  });

  it('wraps send, status, and leave routes', async () => {
    const sent: Array<{ url: string; body: string }> = [];
    const { home } = await listen((request, response, body) => {
      if (request.url === '/setup/status') {
        json(response, { ok: true, data: { version: '2026.10.4' } });
      } else if (request.url?.startsWith('/connect/send')) {
        sent.push({ url: request.url, body });
        json(response, { ok: true, data: { sent: [{ to: 'host agent', message_id: 'm1' }] } });
      } else if (request.url === '/connect/status') {
        json(response, {
          ok: true,
          data: {
            connect_id: 'connect-2',
            agent_name: 'guest-two',
            role: 'guest',
            task: 'Test wrappers',
            expires_at: 'later',
            participants: [{ agent_name: 'host agent', role: 'host', online: true }],
          },
        });
      } else if (request.url === '/connect/leave') {
        json(response, { ok: true, data: { left: true, connect_id: 'connect-2' } });
      }
    });

    const send = await runCli(home, ['send', '--to', 'host agent'], 'line one\nline two\n');
    const status = await runCli(home, ['status']);
    const leave = await runCli(home, ['leave', '--json']);
    expect(send).toMatchObject({ code: 0, stdout: 'Sent to host agent.\n', stderr: '' });
    expect(sent).toEqual([{ url: '/connect/send?to=host%20agent', body: 'line one\nline two\n' }]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('host agent (host, online)');
    expect(JSON.parse(leave.stdout).data.left).toBe(true);
  });

  it('does not send a hello when the joining session is the host', async () => {
    let sendRequests = 0;
    const { home } = await listen((request, response) => {
      if (request.url === '/setup/status') {
        json(response, { ok: true, data: { version: '2026.10.4' } });
      } else if (request.url === '/connect/join') {
        json(response, {
          ok: true,
          data: {
            connect_id: 'connect-host',
            agent_name: 'host-agent',
            role: 'host',
            task: 'Host a Connect',
            expires_at: 'later',
            host: { agent_name: 'host-agent' },
          },
        });
      } else if (request.url?.startsWith('/connect/send')) {
        sendRequests += 1;
        json(response, { ok: true, data: { sent: [] } });
      }
    });

    const joined = await runCli(home, ['join', 'connect-host']);
    expect(joined.code).toBe(0);
    expect(joined.stdout).toContain('(host)');
    expect(sendRequests).toBe(0);
  });

  it('keeps a completed join successful when the host hello fails', async () => {
    const { home } = await listen((request, response) => {
      if (request.url === '/setup/status') {
        json(response, { ok: true, data: { version: '2026.10.4' } });
      } else if (request.url === '/connect/join') {
        json(response, {
          ok: true,
          data: {
            connect_id: 'connect-joined',
            agent_name: 'guest-joined',
            role: 'guest',
            task: 'Keep the join result',
            expires_at: 'later',
            host: { agent_name: 'host-left' },
          },
        });
      } else if (request.url === '/connect/send?to=host-left') {
        json(response, {
          ok: false,
          error: { code: 'connect_unreachable', message: 'host unavailable' },
        });
      }
    });

    const joined = await runCli(home, ['join', 'connect-joined', '--json']);
    expect(joined.code).toBe(0);
    expect(JSON.parse(joined.stdout).data.connect_id).toBe('connect-joined');
    expect(joined.stderr).toBe(
      'Joined, but could not notify the host: Relay Connect cannot reach Cloud or Relaycast; retry once.\n'
    );
  });

  it('maps socket errors and preserves their code in JSON mode', async () => {
    const { home } = await listen((request, response) => {
      if (request.url === '/setup/status') {
        json(response, { ok: true, data: { version: '2026.10.4' } });
      } else {
        json(response, { ok: false, error: { code: 'connect_expired', message: 'expired upstream' } }, 410);
      }
    });

    const plain = await runCli(home, ['status']);
    expect(plain).toEqual({
      code: 3,
      stdout: '',
      stderr: 'Relay Connect has expired; ask the host for a new link.\n',
    });
    const structured = await runCli(home, ['status', '--json']);
    expect(structured.code).toBe(3);
    expect(JSON.parse(structured.stdout).error.code).toBe('connect_expired');
    expect(structured.stderr).toBe('');
  });
});

describe('probe installer', () => {
  it('selects release assets for every supported platform and architecture', () => {
    expect(getPlatformAsset('linux', 'x64')).toBe('AgentRelay-Linux-x64.tar.gz');
    expect(getPlatformAsset('linux', 'arm64')).toBe('AgentRelay-Linux-arm64.tar.gz');
    expect(getPlatformAsset('darwin', 'x64')).toBe('AgentRelay-macOS-x64.dmg');
    expect(getPlatformAsset('darwin', 'arm64')).toBe('AgentRelay-macOS-arm64.dmg');
    expect(() => getPlatformAsset('linux', 'riscv64')).toThrow('Unsupported Linux architecture');
    expect(() => getPlatformAsset('win32', 'x64')).toThrow('Unsupported platform');
  });

  it('requires probe version 2026.10.4 or newer', () => {
    expect(probeVersionSupported('2026.10.3')).toBe(false);
    expect(probeVersionSupported('2026.10.4')).toBe(true);
    expect(probeVersionSupported('v2026.10.5')).toBe(true);
    expect(probeVersionSupported('2027.1.0-beta.1')).toBe(true);
    expect(probeVersionSupported('unknown')).toBe(false);
  });

  it('reports a responsive probe older than 2026.10.4 distinctly', async () => {
    const { home } = await listen((request, response) => {
      if (request.url === '/setup/status') {
        json(response, { ok: true, data: { version: '2026.10.3' } });
      }
    });
    await expect(findLiveSocket(home)).resolves.toMatchObject({
      version: '2026.10.3',
      supported: false,
    });
  });

  it('fails on an old Linux probe without starting a second probe', async () => {
    let installs = 0;
    await expect(
      ensureProbe({
        home: '/tmp/old-linux-probe',
        platform: 'linux',
        find: async () => ({
          socketPath: '/tmp/old.sock',
          status: { ok: true, data: { version: '2026.10.3' } },
          version: '2026.10.3',
          supported: false,
        }),
        installLinuxFn: async () => {
          installs += 1;
          throw new Error('must not install');
        },
      })
    ).rejects.toMatchObject({
      code: 'probe_too_old',
      exitCode: 9,
      message:
        'Agent Relay 2026.10.3 is too old for Relay Connect (needs 2026.10.4 or newer); update it and retry.',
    });
    expect(installs).toBe(0);
  });

  it('updates an old macOS probe rather than reusing it', async () => {
    let installs = 0;
    const result = await ensureProbe({
      home: '/tmp/old-mac-probe',
      platform: 'darwin',
      find: async () => ({
        socketPath: '/tmp/old.sock',
        status: { ok: true, data: { version: '2026.10.3' } },
        version: '2026.10.3',
        supported: false,
      }),
      installMacFn: async () => {
        installs += 1;
        return {
          socketPath: '/tmp/new.sock',
          status: { ok: true, data: { version: '2026.10.4' } },
        };
      },
    });
    expect(installs).toBe(1);
    expect(result).toMatchObject({ socketPath: '/tmp/new.sock', installed: true });
  });

  it('gives status, send, and leave the same distinct old-probe error', async () => {
    const { home } = await listen((request, response) => {
      if (request.url === '/setup/status') {
        json(response, { ok: true, data: { version: '2026.10.3' } });
      }
    });
    for (const [args, input] of [
      [['status'], ''],
      [['send'], 'hello'],
      [['leave'], ''],
    ] as Array<[string[], string]>) {
      const result = await runCli(home, args, input);
      expect(result).toEqual({
        code: 9,
        stdout: '',
        stderr:
          'Agent Relay 2026.10.3 is too old for Relay Connect (needs 2026.10.4 or newer); update it and retry.\n',
      });
    }
  });

  it('constructs the verified checksum and macOS staging commands', () => {
    expect(downloadCommands('darwin', '/private/tmp/connect', 'AgentRelay-macOS-arm64.dmg')).toEqual([
      [
        'curl',
        [
          '-fsSL',
          '--retry',
          '3',
          '-o',
          '/private/tmp/connect/AgentRelay-macOS-arm64.dmg',
          'https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-macOS-arm64.dmg',
        ],
      ],
      [
        'curl',
        [
          '-fsSL',
          '--retry',
          '3',
          '-o',
          '/private/tmp/connect/AgentRelay-macOS-arm64.dmg.sha256',
          'https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download/AgentRelay-macOS-arm64.dmg.sha256',
        ],
      ],
      ['shasum', ['-a', '256', '--check', 'AgentRelay-macOS-arm64.dmg.sha256']],
    ]);
    expect(
      macStageCommands({
        volume: '/Volumes/Agent Relay',
        staged: '/Applications/Agent Relay.app.new',
        app: '/Applications/Agent Relay.app',
      })
    ).toEqual([
      ['ditto', ['/Volumes/Agent Relay/Agent Relay.app', '/Applications/Agent Relay.app.new']],
      ['codesign', ['--verify', '--deep', '--strict', '/Applications/Agent Relay.app.new']],
      ['open', ['/Applications/Agent Relay.app']],
    ]);
  });

  it('restores the previous macOS app when the verified replacement cannot be installed', async () => {
    const app = '/Applications/Agent Relay.app';
    const staged = `${app}.new`;
    const backup = `${app}.old`;
    const paths = new Set([app, staged]);
    const move = async (source: string, destination: string) => {
      if (!paths.has(source)) {
        const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
        throw error;
      }
      if (source === staged) throw new Error('simulated replacement failure');
      paths.delete(source);
      paths.add(destination);
    };
    const remove = async (path: string) => {
      paths.delete(path);
    };

    await expect(swapMacApp(app, staged, { move, remove })).rejects.toThrow(
      'Could not install the replacement'
    );
    expect(paths.has(app)).toBe(true);
    expect(paths.has(backup)).toBe(false);
    expect(paths.has(staged)).toBe(true);
  });

  it('surfaces a detached probe launch error as an InstallError', async () => {
    const child = new EventEmitter();
    const starting = startDetachedProbe('/missing/agent-relay-probe', 2, () => {
      queueMicrotask(() => child.emit('error', new Error('ENOENT')));
      return child as ReturnType<typeof spawn>;
    });
    await expect(starting).rejects.toThrow('Could not start agent-relay-probe: ENOENT');
  });

  it('retries liveness before choosing installation', async () => {
    let attempts = 0;
    let sleeps = 0;
    const result = await ensureProbe({
      home: '/tmp/retry-home',
      find: async () => {
        attempts += 1;
        return attempts === 3
          ? {
              socketPath: '/tmp/relay.sock',
              status: { ok: true, data: { version: '2026.10.4' } },
            }
          : null;
      },
      active: async () => true,
      sleep: async () => {
        sleeps += 1;
      },
    });
    expect(result).toMatchObject({ socketPath: '/tmp/relay.sock', installed: false });
    expect({ attempts, sleeps }).toEqual({ attempts: 3, sleeps: 2 });
  });

  it('waits the full 15-second recovery window when a probe may be restarting', async () => {
    let clock = 0;
    let attempts = 0;
    const result = await findRecoveringProbe({
      home: '/tmp/restarting-probe',
      find: async () => {
        attempts += 1;
        return null;
      },
      active: async () => true,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });
    expect(result).toBeNull();
    expect(clock).toBe(15_000);
    expect(attempts).toBeGreaterThan(3);
  });

  it('does not wait when the pointer names nothing and no probe process is running', async () => {
    let sleeps = 0;
    const result = await findRecoveringProbe({
      home: '/tmp/absent-probe',
      find: async () => null,
      active: async () => false,
      sleep: async () => {
        sleeps += 1;
      },
    });
    expect(result).toBeNull();
    expect(sleeps).toBe(0);
  });

  it('applies the recovery window when an existing probe is required', async () => {
    let clock = 0;
    let attempts = 0;
    const existing = await requireExistingProbe({
      home: '/tmp/recovering-required-probe',
      find: async () => {
        attempts += 1;
        return attempts === 5
          ? {
              socketPath: '/tmp/recovered.sock',
              status: { ok: true, data: { version: '2026.10.4' } },
              version: '2026.10.4',
              supported: true,
            }
          : null;
      },
      active: async () => true,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });
    expect(existing?.socketPath).toBe('/tmp/recovered.sock');
    expect(clock).toBe(1_000);
  });

  it('extracts Linux into a fresh sibling and swaps only the verified tree into current', async () => {
    const root = await mkdtemp(join(os.tmpdir(), 'connect-linux-swap-test-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const installRoot = join(home, '.local/lib/agent-relay');
    const current = join(installRoot, 'current');
    await mkdir(current, { recursive: true });
    await writeFile(join(current, 'stale-file'), 'old');

    const run = async (file: string, args: string[]) => {
      if (file === 'tar') {
        const destination = args[args.indexOf('-C') + 1];
        const probe = join(destination, 'release/agent_relay/helpers/agent-relay-probe');
        await mkdir(join(probe, '..'), { recursive: true });
        await writeFile(probe, '#!/bin/sh\n');
        await chmod(probe, 0o755);
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const child = { pid: undefined, unref() {} };
    const result = await installLinux({
      home,
      arch: 'x64',
      run,
      start: async (link: string) => {
        expect(await readFile(link, 'utf8')).toBe('#!/bin/sh\n');
        return child;
      },
      wait: async () => ({
        socketPath: '/tmp/relay.sock',
        status: { ok: true, data: { version: '2026.10.4' } },
      }),
    });

    expect(result.socketPath).toBe('/tmp/relay.sock');
    await expect(readFile(join(current, 'stale-file'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(current, 'release/agent_relay/helpers/agent-relay-probe'), 'utf8')).toBe(
      '#!/bin/sh\n'
    );
    await expect(readFile(`${current}.old`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${current}.new`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an unsafe socket pointer before sending a request', async () => {
    const { home } = await listen((request, response) => {
      if (request.url === '/setup/status') {
        json(response, { ok: true, data: { version: '2026.10.4' } });
      }
    });
    await chmod(join(home, '.agentworkforce/desktop/relay-socket'), 0o666);
    await expect(findLiveSocket(home)).rejects.toThrow('group- or world-writable');
  });

  it('fails closed when checksum verification fails', async () => {
    await expect(
      verifyChecksum('linux', '/tmp/connect', 'AgentRelay-Linux-x64.tar.gz', async () => {
        throw new Error('mismatch');
      })
    ).rejects.toThrow('checksum verification failed');
  });

  it('times out when no pointer ever names a responsive socket', async () => {
    let clock = 0;
    await expect(
      waitForLiveSocket({
        timeoutMs: 3_000,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        pointer: async () => '',
        check: async () => null,
      })
    ).rejects.toThrow('Timed out waiting');
    expect(clock).toBe(3_000);
  });

  it('enforces a timeout on each Unix-socket request', async () => {
    const { socketPath } = await listen(() => {
      // Deliberately leave the response open until the client destroys it.
    });
    await expect(requestJson(socketPath, { path: '/hang', timeoutMs: 20 })).rejects.toMatchObject({
      code: 'SOCKET_TIMEOUT',
    });
  });
});
