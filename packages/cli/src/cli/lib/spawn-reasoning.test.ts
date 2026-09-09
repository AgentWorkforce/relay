import { describe, expect, it } from 'vitest';
import { spawnReasoningArgs } from './spawn-reasoning.js';

describe('spawnReasoningArgs', () => {
  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'encodes Codex %s as a TOML string',
    (level) => {
      expect(spawnReasoningArgs('codex', level, 'pty')).toEqual(['-c', `model_reasoning_effort="${level}"`]);
    }
  );
  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('preserves Claude %s', (level) => {
    expect(spawnReasoningArgs('claude', level, 'pty')).toEqual(['--effort', level]);
  });
  it.each(['low', 'medium', 'high', 'xhigh'])('preserves Grok %s', (level) => {
    expect(spawnReasoningArgs('grok', level, 'pty')).toEqual(['--reasoning-effort', level]);
  });
  it.each(['cursor-agent', 'cursor', 'toString', '__proto__', '/usr/bin/codex'])(
    'fails closed for %s',
    (cli) => {
      expect(() => spawnReasoningArgs(cli, 'high', 'pty')).toThrow('not supported');
      expect(spawnReasoningArgs(cli, undefined, 'pty')).toEqual([]);
    }
  );
});
