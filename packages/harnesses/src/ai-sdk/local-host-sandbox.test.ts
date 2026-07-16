import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalHostSandboxProvider } from './local-host-sandbox.js';

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'relay-local-sandbox-'));
  const workspace = resolve(root, 'workspace');
  const runtimeRoot = resolve(root, 'runtime');
  return {
    root,
    workspace,
    runtimeRoot,
    provider: new LocalHostSandboxProvider({ workspace, runtimeRoot, gracefulShutdownMs: 20 }),
  };
}

describe('LocalHostSandboxProvider', () => {
  it('requires an explicit absolute workspace', () => {
    expect(() => new LocalHostSandboxProvider({ workspace: 'relative' })).toThrow(/absolute/);
  });

  it('reads, writes, streams, and runs inside the workspace', async () => {
    const { provider, workspace } = await fixture();
    const session = await provider.createSession({ sessionId: 'one' });
    await session.writeTextFile({ path: 'nested/file.txt', content: 'a\nb\nc' });
    expect(await session.readTextFile({ path: 'nested/file.txt', startLine: 2, endLine: 3 })).toBe('b\nc');
    expect(await session.readTextFile({ path: 'missing' })).toBeNull();
    const pwd = await session.run({ command: 'pwd' });
    expect(pwd.exitCode).toBe(0);
    expect(pwd.stdout.trim()).toMatch(/relay-local-sandbox-[^/]+\/workspace$/);
    await expect(session.readTextFile({ path: resolve(workspace, '..', 'escape') })).rejects.toThrow(
      /outside/
    );
    await session.destroy?.();
  });

  it('allocates distinct loopback ports and releases them on idempotent cleanup', async () => {
    const { provider } = await fixture();
    const [first, second] = await Promise.all([
      provider.createSession({ sessionId: 'first' }),
      provider.createSession({ sessionId: 'second' }),
    ]);
    expect(first.ports[0]).not.toBe(second.ports[0]);
    await expect(first.getPortUrl({ port: second.ports[0], protocol: 'ws' })).rejects.toThrow(/not leased/);
    expect(await first.getPortUrl({ port: first.ports[0], protocol: 'ws' })).toMatch(/^ws:\/\/127\.0\.0\.1:/);
    await first.stop();
    await first.stop();
    await second.destroy?.();
  });

  it('holds the OS port reservation until handing it to the bridge process', async () => {
    const { provider } = await fixture();
    const session = await provider.createSession({ sessionId: 'reserved' });
    const port = session.ports[0];
    const competitor = createServer();
    await expect(
      new Promise<void>((resolveListen, reject) => {
        competitor.once('error', reject);
        competitor.listen(port, '127.0.0.1', resolveListen);
      })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });

    const bridge = await session.spawn({
      command:
        'node -e \'const net=require("node:net");const s=net.createServer();s.listen(Number(process.env.BRIDGE_WS_PORT),"127.0.0.1",()=>s.close())\'',
      env: { BRIDGE_WS_PORT: String(port) },
    });
    await expect(bridge.wait()).resolves.toEqual({ exitCode: 0 });
    await session.destroy?.();
  });

  it('applies one bootstrap per stable identity, including concurrent creates', async () => {
    const { provider } = await fixture();
    let calls = 0;
    const onFirstCreate = async () => {
      calls += 1;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    };
    const [first, second] = await Promise.all([
      provider.createSession({ sessionId: 'a', identity: 'recipe-v1', onFirstCreate }),
      provider.createSession({ sessionId: 'b', identity: 'recipe-v1', onFirstCreate }),
    ]);
    expect(calls).toBe(1);
    await first.destroy?.();
    await second.destroy?.();
    const third = await provider.createSession({
      sessionId: 'c',
      identity: 'recipe-v1',
      onFirstCreate,
    });
    expect(calls).toBe(1);
    await third.destroy?.();
  });

  it('kills owned processes on stop and preserves workspace files on destroy', async () => {
    const { provider, workspace } = await fixture();
    const session = await provider.createSession({ sessionId: 'owned' });
    await writeFile(resolve(workspace, 'keep.txt'), 'keep');
    const processHandle = await session.spawn({ command: 'sleep 30' });
    await session.destroy?.();
    await expect(processHandle.wait()).resolves.toMatchObject({ exitCode: expect.any(Number) });
    expect(await readFile(resolve(workspace, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('never uses an untrusted session id as a deletion path', async () => {
    const { provider, workspace } = await fixture();
    const session = await provider.createSession({ sessionId: '../../workspace' });
    await writeFile(resolve(workspace, 'keep.txt'), 'keep');
    await session.destroy?.();
    expect(await readFile(resolve(workspace, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('rejects read and write escapes through workspace symlinks', async () => {
    const { provider, root, workspace } = await fixture();
    const outside = resolve(root, 'outside');
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(outside, { recursive: true })]);
    await writeFile(resolve(outside, 'secret.txt'), 'secret');
    await symlink(outside, resolve(workspace, 'escape'));
    const session = await provider.createSession({ sessionId: 'symlink-safe' });
    await expect(session.readTextFile({ path: 'escape/secret.txt' })).rejects.toThrow(/symlink outside/);
    await expect(session.writeTextFile({ path: 'escape/new.txt', content: 'escaped' })).rejects.toThrow(
      /symlink outside/
    );
    await expect(readFile(resolve(outside, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await session.destroy?.();
  });

  it('propagates abort and allows an in-process resume before stop', async () => {
    const { provider } = await fixture();
    const session = await provider.createSession({ sessionId: 'resume' });
    expect(await provider.resumeSession({ sessionId: 'resume' })).toBe(session);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(session.run({ command: 'true', abortSignal: controller.signal })).rejects.toThrow(
      'cancelled'
    );
    await session.stop();
    await expect(provider.resumeSession({ sessionId: 'resume' })).rejects.toThrow(/unavailable/);
  });
});
