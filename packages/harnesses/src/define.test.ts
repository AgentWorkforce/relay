import { describe, expect, it } from 'vitest';

import { claude, codex, definePtyHarness } from './index.js';

describe('harness factories (Phase C)', () => {
  it('exposes the static definition shape for the runtime', () => {
    expect(claude.runtime).toBe('pty');
    expect(claude.command).toBe('claude');
    expect(claude.name).toBe('claude');
  });

  it('create() returns a registerable agent handle with identity + model', async () => {
    const agent = await codex.create({ model: 'gpt-5.5' });
    expect(agent.cli).toBe('codex');
    expect(agent.runtime).toBe('pty');
    expect(agent.model).toBe('gpt-5.5');
    expect(agent.name).toBeTruthy();
    expect(agent.handle).toBe(agent.name);
    expect(agent.id).toContain('codex');
  });

  it('new() builds synchronously and honors an explicit name', () => {
    const agent = definePtyHarness({ runtime: 'pty', command: 'gemini' }).new({ name: 'reviewer' });
    expect(agent.name).toBe('reviewer');
    expect(agent.cli).toBe('gemini');
  });

  it('agent handles expose status/tools predicate builders', async () => {
    const agent = await claude.create({ model: 'sonnet' });
    const statusPredicate = agent.status.becomes('idle');
    const toolPredicate = agent.tools.called('bash');
    expect(typeof statusPredicate.subscribe).toBe('function');
    expect(typeof toolPredicate.where).toBe('function');
  });

  it('auto-generated names are unique per command', () => {
    const harness = definePtyHarness({ runtime: 'pty', command: 'aider' });
    const a = harness.new();
    const b = harness.new();
    expect(a.name).not.toBe(b.name);
  });
});
