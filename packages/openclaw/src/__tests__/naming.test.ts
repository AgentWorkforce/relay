import { describe, it, expect } from 'vitest';
import { buildAgentName } from '../identity/naming.js';

describe('buildAgentName', () => {
  it('should build agent name from workspace and claw name', () => {
    const result = buildAgentName('ws123', 'researcher');
    expect(result).toBe('claw-ws123-researcher');
  });

  it('should handle hyphens in workspace id', () => {
    const result = buildAgentName('ws-abc-123', 'coder');
    expect(result).toBe('claw-ws-abc-123-coder');
  });

  it('should handle hyphens in claw name', () => {
    const result = buildAgentName('workspace', 'code-reviewer');
    expect(result).toBe('claw-workspace-code-reviewer');
  });

  it('should handle empty strings', () => {
    const result = buildAgentName('', '');
    expect(result).toBe('claw--');
  });
});
