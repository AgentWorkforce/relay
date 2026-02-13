import { describe, it, expect } from 'vitest';
import {
  findAgentRelayBinary,
  hasAgentRelayBinary,
  getCachedAgentRelayPath,
} from './agent-relay-path.js';
import {
  findRelayPtyBinary,
  hasRelayPtyBinary,
  getCachedRelayPtyPath,
} from './relay-pty-path.js';

describe('agent-relay-path compatibility aliases', () => {
  it('exports function aliases for binary path lookup', () => {
    expect(findAgentRelayBinary).toBe(findRelayPtyBinary);
    expect(hasAgentRelayBinary).toBe(hasRelayPtyBinary);
    expect(getCachedAgentRelayPath).toBe(getCachedRelayPtyPath);
  });
});
