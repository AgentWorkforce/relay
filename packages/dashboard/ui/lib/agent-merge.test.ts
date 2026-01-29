import { describe, it, expect } from 'vitest';
import type { Agent } from '../types';
import { mergeAgentsForDashboard } from './agent-merge.js';

describe('mergeAgentsForDashboard', () => {
  it('filters out the Dashboard user', () => {
    const agents: Agent[] = [
      { name: 'Dashboard', status: 'online' },
      { name: 'Lead', status: 'online' },
    ];

    const merged = mergeAgentsForDashboard({ agents });

    expect(merged.map((agent) => agent.name)).toEqual(['Lead']);
  });

  it('keeps cloud agents from being marked as local on name collision', () => {
    const agents: Agent[] = [
      { name: 'Lead', status: 'online' },
    ];
    const localAgents: Agent[] = [
      { name: 'Lead', status: 'online', isLocal: true, daemonName: 'local-daemon' },
    ];

    const merged = mergeAgentsForDashboard({ agents, localAgents });

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Lead');
    expect(merged[0].isLocal).toBe(false);
  });

  it('preserves local agents when no cloud agent exists', () => {
    const localAgents: Agent[] = [
      { name: 'Worker', status: 'online', isLocal: true, daemonName: 'local-daemon' },
    ];

    const merged = mergeAgentsForDashboard({ localAgents });

    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Worker');
    expect(merged[0].isLocal).toBe(true);
  });
});
