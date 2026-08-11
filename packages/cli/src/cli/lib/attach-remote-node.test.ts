import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { attachRemoteNode, buildRemoteNodeAttachCommand, quoteRemoteArg } from './attach-remote-node.js';

describe('buildRemoteNodeAttachCommand', () => {
  it('uses the standard fleet-node state directory without moving the broker credential off-host', () => {
    const target = buildRemoteNodeAttachCommand('chief-barry', 'drive', 'barry', {});
    expect(target?.host).toBe('barry');
    expect(target?.command).toContain('relay_state="$HOME"/.agentworkforce/relay/\'barry-node\'/state');
    expect(target?.command).toContain("exec agent-relay node agent attach --mode 'drive'");
    expect(target?.command).toContain('--state-dir "$relay_state"');
    expect(target?.command).toMatch(/-- 'chief-barry'$/);
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
    expect(target?.command).toContain('ps axww -o ppid= -o ucomm= -o command=');
    expect(target?.command).toContain('$2 ~ /^agent-relay-brok/');
    expect(target?.command).toContain('/proc/$broker_pid/cwd');
    expect(target?.command).toContain('lsof -a -p "$broker_pid" -d cwd');
    expect(target?.command).toContain('broker_state_ambiguous=0');
    expect(target?.command).toContain('if [ "$broker_state_ambiguous" -ne 0 ]');
    expect(target?.command).toContain('relay_state="$broker_state"');
  });

  it('quotes option-like agent names and exact remote state paths as shell data', () => {
    const agentName = "-lead'; touch /tmp/nope; '\\agent";
    const stateDir = " /Users/ops/relay state'; touch /tmp/nope; ' ";
    const target = buildRemoteNodeAttachCommand(agentName, 'view', 'ops@barry', {
      stateDir,
      json: true,
      diagnostics: true,
    });
    expect(target?.host).toBe('ops@barry');
    expect(target?.command).toContain(`--state-dir ${quoteRemoteArg(stateDir)}`);
    expect(target?.command).toContain('--json --diagnostics -- ');
    expect(target?.command.endsWith(`-- ${quoteRemoteArg(agentName)}`)).toBe(true);
  });

  it('passes discovery names through the environment without awk escape decoding', () => {
    const target = buildRemoteNodeAttachCommand('back\\slash', 'view', 'barry', {});
    expect(target?.command).toContain('ATTACH_AGENT="$attach_agent" awk');
    expect(target?.command).toContain('ENVIRON["ATTACH_AGENT"]');
    expect(target?.command).not.toContain('awk -v target=');
  });

  it('preserves a whitespace-only explicit state directory like local attach', () => {
    const target = buildRemoteNodeAttachCommand('lead', 'view', 'barry', { stateDir: '   ' });
    expect(target?.command).toBe(
      "exec agent-relay node agent attach --mode 'view' --state-dir '   ' -- 'lead'"
    );
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
      ['-T', '-n', 'barry', expect.any(String)],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('maps child signals to conventional shell exit codes', async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(() => child as never);
    const result = attachRemoteNode('lead', 'view', 'barry', {}, { spawn, error: vi.fn() });
    child.emit('exit', null, 'SIGTERM');
    await expect(result).resolves.toBe(143);
  });
});
