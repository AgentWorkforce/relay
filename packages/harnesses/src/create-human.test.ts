import { describe, expect, it, vi } from 'vitest';

import type { AgentRelay } from '@agent-relay/sdk';

import { createHuman } from './create-human.js';

describe('createHuman', () => {
  it('registers a human participant and returns the live client', async () => {
    const client = { id: 'h1', name: 'will-washburn', handle: 'will-washburn', sendMessage: vi.fn() };
    const register = vi.fn(async () => client);
    const relay = { workspace: { register } } as unknown as AgentRelay;

    const human = await createHuman({ relay, name: 'will-washburn', persona: 'operator' });

    expect(register).toHaveBeenCalledWith({
      name: 'will-washburn',
      type: 'human',
      persona: 'operator',
      metadata: undefined,
    });
    expect(human).toBe(client);
  });
});
