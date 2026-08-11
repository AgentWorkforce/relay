import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { attachRemoteNode, buildRemoteNodeAttachCommand, quoteRemoteArg } from './attach-remote-node.js';

describe('buildRemoteNodeAttachCommand', () => {
  it('uses the standard fleet-node state directory without moving the broker credential off-host', () => {
    const target = buildRemoteNodeAttachCommand('chief-barry', 'drive', 'barry', {});
    expect(target?.host).toBe('barry');
    expect(target?.command).toContain('relay_state="$HOME"/.agentworkforce/relay/\'barry-node\'/state');
    expect(target?.command).toContain("exec agent-relay node agent attach 'chief-barry'");
    expect(target?.command).toContain('--state-dir "$relay_state"');
  });

  it('falls back to the only fleet broker state directory when the SSH alias differs', () => {
    const target = buildRemoteNodeAttachCommand('chief-barry', 'view', 'barry-vpn', {});
    expect(target?.command).toContain('relay_state="$HOME"/.agentworkforce/relay/\'barry-vpn-node\'/state');
    expect(target?.command).toContain('set -- "$HOME"/.agentworkforce/relay/*-node/state/connection.json');
    expect(target?.command).toContain('could not uniquely find');
  });

  it('discovers an ordinary project-local broker from the target agent process', () => {
    const target = buildRemoteNodeAttachCommand('project-worker', 'view', 'build-host', {});
    expect(target?.command).toContain('agent-relay-broker pty --agent-name');
    expect(target?.command).toContain('target="$attach_agent"');
    expect(target?.command).toContain('/proc/$broker_pid/cwd');
    expect(target?.command).toContain('lsof -a -p "$broker_pid" -d cwd');
    expect(target?.command).toContain('relay_state="$broker_root/.agentworkforce/relay"');
  });

  it('quotes agent names and explicit remote state paths as shell data', () => {
    const target = buildRemoteNodeAttachCommand("lead'; touch /tmp/nope; '", 'view', 'ops@barry', {
      stateDir: '/Users/ops/relay state',
      json: true,
      diagnostics: true,
    });
    expect(target?.host).toBe('ops@barry');
    expect(target?.command).toContain(quoteRemoteArg("lead'; touch /tmp/nope; '"));
    expect(target?.command).toContain("--state-dir '/Users/ops/relay state'");
    expect(target?.command).toMatch(/--json --diagnostics$/);
  });

  it('rejects option-like or shell-bearing node names', () => {
    expect(buildRemoteNodeAttachCommand('lead', 'view', '-oProxyCommand=bad', {})).toBeNull();
    expect(buildRemoteNodeAttachCommand('lead', 'view', 'barry;touch /tmp/nope', {})).toBeNull();
  });
});

describe('attachRemoteNode', () => {
  it('preserves the remote attach exit code and allocates a TTY', async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(() => child as never);
    const result = attachRemoteNode('lead', 'passthrough', 'barry', {}, { spawn, error: vi.fn() });
    child.emit('exit', 7, null);
    await expect(result).resolves.toBe(7);
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['-tt', 'barry']),
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('distinguishes an unreachable SSH node', async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(() => child as never);
    const error = vi.fn();
    const result = attachRemoteNode('lead', 'view', 'barry', {}, { spawn, error });
    child.emit('exit', 255, null);
    await expect(result).resolves.toBe(255);
    expect(error).toHaveBeenCalledWith("Error: node 'barry' is not reachable over SSH.");
  });

  it('disables the SSH TTY for machine-readable JSON output', async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(() => child as never);
    const result = attachRemoteNode('lead', 'view', 'barry', { json: true }, { spawn, error: vi.fn() });
    child.emit('exit', 0, null);
    await expect(result).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['-T', 'barry']),
      expect.objectContaining({ stdio: 'inherit' })
    );
  });
});
