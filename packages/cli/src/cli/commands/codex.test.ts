import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerCodexCommands, resolveLiveTeleportWorkspaceSource } from './codex.js';

const temporary: string[] = [];

afterEach(() => {
  temporary.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
});

describe('resolveLiveTeleportWorkspaceSource', () => {
  it('fails closed for a plain unmanaged or Git-only cwd', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-unmanaged-'));
    temporary.push(root);
    fs.mkdirSync(path.join(root, '.git'));

    expect(() => resolveLiveTeleportWorkspaceSource(root)).toThrow('fails closed for an unmanaged');
  });

  it('recognizes a Relayfile mount', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-relayfile-'));
    temporary.push(root);
    const mountStatePath = path.join(root, '.relayfile-mount-state.json');
    fs.writeFileSync(mountStatePath, '{}');

    expect(resolveLiveTeleportWorkspaceSource(root)).toEqual({ kind: 'relayfile-mount', mountStatePath });
  });

  it('accepts an explicit opaque convergence receipt for Cloud verification', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-receipt-'));
    temporary.push(root);
    const receipt = path.join(root, 'receipt.jwt');
    fs.writeFileSync(receipt, 'signed.convergence.receipt\n');

    expect(resolveLiveTeleportWorkspaceSource(root, receipt)).toEqual({
      kind: 'verified-convergence-receipt',
      receipt: 'signed.convergence.receipt',
    });
  });
});

describe('registerCodexCommands', () => {
  it('makes teleport one command against the active persisted generation', async () => {
    const sendControl = vi.fn(async () => ({
      ok: true as const,
      status: {
        version: 1 as const,
        sessionId: 'session-1',
        threadId: 'thread-1',
        workspaceRoot: '/repo',
        generation: 4,
        phase: 'teleport_pending' as const,
        controllerPid: 10,
        socketPath: '/state/controller.sock',
        turnActive: false,
        pending: { requestId: 'request-1', expectedGeneration: 4 },
        lastRequestId: 'request-1',
        updatedAt: '2026-08-23T12:00:00.000Z',
        controller: 'local' as const,
        execution: 'local' as const,
        workspaceSource: 'relayfile-mount' as const,
      },
    }));
    const log = vi.fn();
    const program = new Command().exitOverride();
    registerCodexCommands(program, {
      readState: () => ({ generation: 4 }) as never,
      sendControl,
      requestId: () => 'request-1',
      log,
    });

    await program.parseAsync(['node', 'relay', 'codex', 'teleport']);

    expect(sendControl).toHaveBeenCalledWith({
      operation: 'teleport',
      requestId: 'request-1',
      expectedGeneration: 4,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('local controller remains authoritative'));
  });

  it('refuses teleport when the session was not started under Relay control', async () => {
    const sendControl = vi.fn();
    const program = new Command().exitOverride();
    registerCodexCommands(program, { readState: () => null, sendControl });

    await expect(program.parseAsync(['node', 'relay', 'codex', 'teleport'])).rejects.toThrow(
      'No active Relay-managed Codex session'
    );
    expect(sendControl).not.toHaveBeenCalled();
  });
});
