import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import ssh2, { type AuthContext, type Connection } from 'ssh2';

import { loadSSH2 } from '../../src/cli/lib/auth-ssh.js';
import { runInteractiveSession } from '../../src/cli/lib/ssh-interactive.js';

const { Server: SSH2Server } = ssh2;

function createHostKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  return privateKey;
}

async function listenOnEphemeralPort(server: InstanceType<typeof SSH2Server>): Promise<number> {
  return await new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('error', onError);
      reject(err);
    };

    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('ssh2 test server did not bind to a TCP port'));
        return;
      }

      resolve((address as AddressInfo).port);
    });
  });
}

async function closeServer(server: InstanceType<typeof SSH2Server> | undefined): Promise<void> {
  if (!server || !server.listening) return;

  await new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

function acceptPasswordAuth(ctx: AuthContext): void {
  if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test') {
    ctx.accept();
    return;
  }

  ctx.reject(['password']);
}

function captureStdout(): { getCapturedStdout: () => string; restore: () => void } {
  let capturedStdout = '';

  const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    capturedStdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  }) as typeof process.stdout.write);

  return {
    getCapturedStdout: () => capturedStdout,
    restore: () => stdoutWriteSpy.mockRestore(),
  };
}

function mockStdin(): { restore: () => void } {
  const setRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');

  if (typeof process.stdin.setRawMode !== 'function') {
    Object.defineProperty(process.stdin, 'setRawMode', {
      configurable: true,
      value: () => process.stdin,
    });
  }

  const setRawModeSpy = vi.spyOn(process.stdin, 'setRawMode').mockImplementation(() => process.stdin);
  const resumeSpy = vi.spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
  const pauseSpy = vi.spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);

  return {
    restore: () => {
      pauseSpy.mockRestore();
      resumeSpy.mockRestore();
      setRawModeSpy.mockRestore();

      if (setRawModeDescriptor) {
        Object.defineProperty(process.stdin, 'setRawMode', setRawModeDescriptor);
      } else {
        delete (process.stdin as { setRawMode?: unknown }).setRawMode;
      }
    },
  };
}

describe('ssh interactive live ssh2 integration', () => {
  let server: InstanceType<typeof SSH2Server> | undefined;
  const serverClients = new Set<Connection>();

  afterEach(async () => {
    for (const client of serverClients) {
      client.end();
    }
    serverClients.clear();

    await closeServer(server);
    server = undefined;
    vi.restoreAllMocks();
  });

  it('writes exec sh -c with launch checkpoint through a real ssh2 connection', async () => {
    let capturedWrite = '';
    let serverSawConnection = false;
    const launchBreadcrumb = '\x1b[2m[agent-relay] launching provider CLI\u2026\x1b[0m\n';
    let resolveConnected = () => {};

    const connected = new Promise<void>((resolve) => {
      resolveConnected = () => resolve();
    });
    const sshServer = new SSH2Server({ hostKeys: [{ key: createHostKey() }] }, (client) => {
      serverSawConnection = true;
      serverClients.add(client);
      resolveConnected();

      client.on('error', () => {
        // The client may close while the test is tearing down.
      });
      client.on('close', () => {
        serverClients.delete(client);
      });
      client.on('authentication', acceptPasswordAuth);
      client.on('session', (accept) => {
        const session = accept();

        session.on('pty', (acceptPty) => {
          acceptPty();
        });

        session.on('shell', (acceptShell) => {
          const stream = acceptShell();

          stream.once('data', (chunk: Buffer) => {
            capturedWrite = chunk.toString('utf8');

            // Echo the shell-channel write back through the SSH stream so
            // runInteractiveSession has real ssh2 data to pipe to stdout.
            stream.write(chunk);
            stream.write(launchBreadcrumb);

            setTimeout(() => {
              stream.exit(0);
              stream.end();
            }, 10);
          });
        });
      });
    });
    server = sshServer;

    const port = await listenOnEphemeralPort(sshServer);
    const stdout = captureStdout();
    const stdin = mockStdin();

    try {
      const result = await runInteractiveSession({
        ssh: { host: '127.0.0.1', port, user: 'test', password: 'test' },
        remoteCommand: 'claude',
        successPatterns: [],
        errorPatterns: [],
        timeoutMs: 5000,
        tunnelPort: 0,
        io: { log: vi.fn(), error: vi.fn() },
      });

      await connected;

      expect(result.exitCode).toBe(0);
      expect(serverSawConnection).toBe(true);
      expect(capturedWrite.startsWith("exec sh -c '")).toBe(true);
      expect(capturedWrite).toContain('launching provider CLI');
      expect(capturedWrite).not.toContain('; exit $?');
      expect(stdout.getCapturedStdout()).toContain('launching provider CLI');
      expect(stdout.getCapturedStdout()).toContain(launchBreadcrumb);
    } finally {
      stdin.restore();
      stdout.restore();
    }
  }, 10_000);

  it('loadSSH2 returns a truthy ssh2 module in the default runtime', async () => {
    const ssh2Module = await loadSSH2();

    expect(ssh2Module).toBeTruthy();
    expect(ssh2Module?.Client).toEqual(expect.any(Function));
  }, 10_000);
});
