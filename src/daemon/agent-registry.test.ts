import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AgentRegistry } from './agent-registry.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-registry-'));
}

describe('AgentRegistry', () => {
  it('creates and persists agent records', () => {
    const dir = makeTempDir();
    const registry = new AgentRegistry(dir);

    const created = registry.registerOrUpdate({
      name: 'alice',
      cli: 'claude',
      workingDirectory: '/tmp/alice',
    });

    expect(created.id).toBeTruthy();
    expect(created.firstSeen).toBeTruthy();
    expect(created.messagesSent).toBe(0);
    expect(created.messagesReceived).toBe(0);

    registry.recordSend('alice');
    registry.recordReceive('alice');

    const agentsPath = path.join(dir, 'agents.json');
    const fileData = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
    const fileAgent = fileData.agents.find((a: any) => a.name === 'alice');
    expect(fileAgent.messagesSent).toBe(1);
    expect(fileAgent.messagesReceived).toBe(1);

    const registryReloaded = new AgentRegistry(dir);
    const [loaded] = registryReloaded.getAgents();
    expect(loaded.name).toBe('alice');
    expect(loaded.messagesSent).toBe(1);
    expect(loaded.messagesReceived).toBe(1);
  });

  it('updates metadata on re-register', () => {
    const dir = makeTempDir();
    const registry = new AgentRegistry(dir);

    registry.registerOrUpdate({
      name: 'bob',
      cli: 'claude',
      workingDirectory: '/tmp/one',
    });
    const first = registry.getAgents()[0];

    registry.registerOrUpdate({
      name: 'bob',
      cli: 'gemini',
      workingDirectory: '/tmp/two',
    });
    const [updated] = registry.getAgents();

    expect(updated.firstSeen).toBe(first.firstSeen);
    expect(updated.cli).toBe('gemini');
    expect(updated.workingDirectory).toBe('/tmp/two');
    expect(new Date(updated.lastSeen).getTime()).toBeGreaterThanOrEqual(new Date(first.lastSeen).getTime());
  });

  it('handles malformed agents.json gracefully', () => {
    const dir = makeTempDir();
    const agentsPath = path.join(dir, 'agents.json');
    fs.writeFileSync(agentsPath, '{bad json', 'utf-8');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const registry = new AgentRegistry(dir);
    expect(registry.getAgents()).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('logs write failures without throwing', () => {
    const dir = makeTempDir();
    const registry = new AgentRegistry(dir);
    registry.registerOrUpdate({ name: 'carol' });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    // Trigger a save
    registry.recordSend('carol');

    expect(errorSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
