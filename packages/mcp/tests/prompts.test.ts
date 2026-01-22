import { describe, it, expect } from 'vitest';
import { getProtocolPrompt } from '../src/prompts/index.js';

describe('Prompts', () => {
  it('getProtocolPrompt returns documentation', () => {
    const prompt = getProtocolPrompt();
    
    expect(prompt).toContain('# Agent Relay Protocol');
    expect(prompt).toContain('relay_send');
    expect(prompt).toContain('relay_spawn');
  });
});
