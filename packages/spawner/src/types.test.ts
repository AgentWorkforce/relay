/**
 * Spawner Types Tests
 *
 * TDD approach - tests written first to define expected behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  SpeakOnTriggerSchema,
  ShadowRolePresetSchema,
  PolicyDecisionSchema,
  SpawnRequestSchema,
  SpawnResultSchema,
  WorkerInfoSchema,
  PrimaryAgentConfigSchema,
  ShadowAgentConfigSchema,
  SpawnWithShadowRequestSchema,
  SpawnWithShadowResultSchema,
  ProjectConfigSchema,
  BridgeConfigSchema,
  LeadInfoSchema,
} from './types.js';

describe('Spawner Types', () => {
  describe('SpeakOnTriggerSchema', () => {
    it('should validate all trigger types', () => {
      expect(SpeakOnTriggerSchema.parse('SESSION_END')).toBe('SESSION_END');
      expect(SpeakOnTriggerSchema.parse('CODE_WRITTEN')).toBe('CODE_WRITTEN');
      expect(SpeakOnTriggerSchema.parse('REVIEW_REQUEST')).toBe('REVIEW_REQUEST');
      expect(SpeakOnTriggerSchema.parse('EXPLICIT_ASK')).toBe('EXPLICIT_ASK');
      expect(SpeakOnTriggerSchema.parse('ALL_MESSAGES')).toBe('ALL_MESSAGES');
    });

    it('should reject invalid triggers', () => {
      expect(() => SpeakOnTriggerSchema.parse('INVALID')).toThrow();
      expect(() => SpeakOnTriggerSchema.parse('session_end')).toThrow(); // lowercase
    });
  });

  describe('ShadowRolePresetSchema', () => {
    it('should validate role presets', () => {
      expect(ShadowRolePresetSchema.parse('reviewer')).toBe('reviewer');
      expect(ShadowRolePresetSchema.parse('auditor')).toBe('auditor');
      expect(ShadowRolePresetSchema.parse('active')).toBe('active');
    });

    it('should reject invalid roles', () => {
      expect(() => ShadowRolePresetSchema.parse('observer')).toThrow();
    });
  });

  describe('PolicyDecisionSchema', () => {
    it('should validate allowed decision', () => {
      const decision = {
        allowed: true,
        reason: 'Policy permits spawn',
        policySource: 'repo',
      };
      const result = PolicyDecisionSchema.parse(decision);
      expect(result.allowed).toBe(true);
      expect(result.policySource).toBe('repo');
    });

    it('should validate denied decision', () => {
      const decision = {
        allowed: false,
        reason: 'Agent limit exceeded',
        policySource: 'workspace',
      };
      const result = PolicyDecisionSchema.parse(decision);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Agent limit exceeded');
    });

    it('should validate all policy sources', () => {
      const sources = ['repo', 'local', 'workspace', 'default'];
      for (const source of sources) {
        const decision = { allowed: true, reason: 'test', policySource: source };
        const result = PolicyDecisionSchema.parse(decision);
        expect(result.policySource).toBe(source);
      }
    });
  });

  describe('SpawnRequestSchema', () => {
    it('should validate minimal spawn request', () => {
      const request = {
        name: 'Worker1',
        cli: 'claude',
        task: 'Implement feature X',
      };
      const result = SpawnRequestSchema.parse(request);
      expect(result.name).toBe('Worker1');
      expect(result.cli).toBe('claude');
      expect(result.task).toBe('Implement feature X');
    });

    it('should validate full spawn request', () => {
      const request = {
        name: 'ShadowAgent',
        cli: 'claude:opus',
        task: 'Review code changes',
        team: 'backend',
        cwd: '/workspace/project',
        spawnerName: 'Lead',
        interactive: false,
        shadowMode: 'process',
        shadowOf: 'Primary',
        shadowAgent: 'reviewer',
        shadowTriggers: ['CODE_WRITTEN', 'REVIEW_REQUEST'],
        shadowSpeakOn: ['EXPLICIT_ASK'],
        userId: 'user-123',
      };
      const result = SpawnRequestSchema.parse(request);
      expect(result.shadowMode).toBe('process');
      expect(result.shadowOf).toBe('Primary');
      expect(result.shadowTriggers).toHaveLength(2);
    });

    it('should validate shadow modes', () => {
      const subagent = { name: 'A', cli: 'claude', task: 't', shadowMode: 'subagent' };
      const process = { name: 'B', cli: 'claude', task: 't', shadowMode: 'process' };

      expect(SpawnRequestSchema.parse(subagent).shadowMode).toBe('subagent');
      expect(SpawnRequestSchema.parse(process).shadowMode).toBe('process');
    });

    it('should reject invalid shadow mode', () => {
      const request = { name: 'A', cli: 'claude', task: 't', shadowMode: 'invalid' };
      expect(() => SpawnRequestSchema.parse(request)).toThrow();
    });

    it('should allow various CLI formats', () => {
      const clis = ['claude', 'claude:opus', 'codex', 'gemini', 'cursor', 'agent'];
      for (const cli of clis) {
        const request = { name: 'Agent', cli, task: 'task' };
        expect(SpawnRequestSchema.parse(request).cli).toBe(cli);
      }
    });
  });

  describe('SpawnResultSchema', () => {
    it('should validate success result', () => {
      const result = {
        success: true,
        name: 'Worker1',
        pid: 12345,
      };
      const parsed = SpawnResultSchema.parse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.pid).toBe(12345);
    });

    it('should validate failure result', () => {
      const result = {
        success: false,
        name: 'Worker1',
        error: 'Agent already exists',
      };
      const parsed = SpawnResultSchema.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('Agent already exists');
    });

    it('should validate policy blocked result', () => {
      const result = {
        success: false,
        name: 'Worker1',
        error: 'Policy denied',
        policyDecision: {
          allowed: false,
          reason: 'Spawner not authorized',
          policySource: 'repo',
        },
      };
      const parsed = SpawnResultSchema.parse(result);
      expect(parsed.policyDecision?.allowed).toBe(false);
      expect(parsed.policyDecision?.policySource).toBe('repo');
    });
  });

  describe('WorkerInfoSchema', () => {
    it('should validate complete worker info', () => {
      const info = {
        name: 'Worker1',
        cli: 'claude',
        task: 'Build API endpoints',
        team: 'backend',
        spawnedAt: 1705920600000,
        pid: 12345,
      };
      const result = WorkerInfoSchema.parse(info);
      expect(result.name).toBe('Worker1');
      expect(result.team).toBe('backend');
      expect(result.pid).toBe(12345);
    });

    it('should allow worker without optional fields', () => {
      const info = {
        name: 'Worker2',
        cli: 'codex',
        task: 'Fix bug',
        spawnedAt: Date.now(),
      };
      const result = WorkerInfoSchema.parse(info);
      expect(result.team).toBeUndefined();
      expect(result.pid).toBeUndefined();
    });
  });

  describe('PrimaryAgentConfigSchema', () => {
    it('should validate minimal config', () => {
      const config = { name: 'Lead' };
      const result = PrimaryAgentConfigSchema.parse(config);
      expect(result.name).toBe('Lead');
    });

    it('should validate full config', () => {
      const config = {
        name: 'Lead',
        command: 'claude:opus',
        task: 'Coordinate team',
        team: 'core',
      };
      const result = PrimaryAgentConfigSchema.parse(config);
      expect(result.command).toBe('claude:opus');
      expect(result.team).toBe('core');
    });
  });

  describe('ShadowAgentConfigSchema', () => {
    it('should validate minimal shadow config', () => {
      const config = { name: 'ShadowReviewer' };
      const result = ShadowAgentConfigSchema.parse(config);
      expect(result.name).toBe('ShadowReviewer');
    });

    it('should validate full shadow config', () => {
      const config = {
        name: 'Auditor',
        command: 'codex',
        role: 'auditor',
        speakOn: ['SESSION_END', 'EXPLICIT_ASK'],
        prompt: 'Review all code changes for security issues',
      };
      const result = ShadowAgentConfigSchema.parse(config);
      expect(result.role).toBe('auditor');
      expect(result.speakOn).toHaveLength(2);
      expect(result.prompt).toContain('security');
    });

    it('should allow custom role string', () => {
      const config = { name: 'Custom', role: 'custom-observer' };
      const result = ShadowAgentConfigSchema.parse(config);
      expect(result.role).toBe('custom-observer');
    });
  });

  describe('SpawnWithShadowRequestSchema', () => {
    it('should validate spawn with shadow request', () => {
      const request = {
        primary: {
          name: 'Lead',
          command: 'claude',
          task: 'Implement feature',
          team: 'core',
        },
        shadow: {
          name: 'Reviewer',
          role: 'reviewer',
          speakOn: ['CODE_WRITTEN'],
        },
      };
      const result = SpawnWithShadowRequestSchema.parse(request);
      expect(result.primary.name).toBe('Lead');
      expect(result.shadow.name).toBe('Reviewer');
    });
  });

  describe('SpawnWithShadowResultSchema', () => {
    it('should validate full success result', () => {
      const result = {
        success: true,
        primary: { success: true, name: 'Lead', pid: 1000 },
        shadow: { success: true, name: 'Reviewer', pid: 1001 },
      };
      const parsed = SpawnWithShadowResultSchema.parse(result);
      expect(parsed.primary?.pid).toBe(1000);
      expect(parsed.shadow?.pid).toBe(1001);
    });

    it('should validate partial success (shadow failed)', () => {
      const result = {
        success: true,
        primary: { success: true, name: 'Lead', pid: 1000 },
        shadow: { success: false, name: 'Reviewer', error: 'No authenticated CLI' },
        error: 'Shadow spawn failed',
      };
      const parsed = SpawnWithShadowResultSchema.parse(result);
      expect(parsed.success).toBe(true); // Overall success because primary worked
      expect(parsed.shadow?.success).toBe(false);
    });

    it('should validate failure result', () => {
      const result = {
        success: false,
        error: 'Primary agent spawn failed',
      };
      const parsed = SpawnWithShadowResultSchema.parse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.primary).toBeUndefined();
    });
  });

  describe('ProjectConfigSchema', () => {
    it('should validate project config', () => {
      const config = {
        path: '/workspace/myproject',
        id: 'proj-abc123',
        socketPath: '/tmp/relay-myproject.sock',
        leadName: 'ProjectLead',
        cli: 'claude',
      };
      const result = ProjectConfigSchema.parse(config);
      expect(result.path).toBe('/workspace/myproject');
      expect(result.leadName).toBe('ProjectLead');
    });
  });

  describe('BridgeConfigSchema', () => {
    it('should validate bridge config', () => {
      const config = {
        projects: [
          {
            path: '/workspace/project1',
            id: 'proj-1',
            socketPath: '/tmp/relay-1.sock',
            leadName: 'Lead1',
            cli: 'claude',
          },
          {
            path: '/workspace/project2',
            id: 'proj-2',
            socketPath: '/tmp/relay-2.sock',
            leadName: 'Lead2',
            cli: 'codex',
          },
        ],
        cliOverride: 'claude:opus',
      };
      const result = BridgeConfigSchema.parse(config);
      expect(result.projects).toHaveLength(2);
      expect(result.cliOverride).toBe('claude:opus');
    });

    it('should allow bridge config without override', () => {
      const config = { projects: [] };
      const result = BridgeConfigSchema.parse(config);
      expect(result.cliOverride).toBeUndefined();
    });
  });

  describe('LeadInfoSchema', () => {
    it('should validate lead info', () => {
      const info = {
        name: 'ProjectLead',
        projectId: 'proj-123',
        connected: true,
      };
      const result = LeadInfoSchema.parse(info);
      expect(result.name).toBe('ProjectLead');
      expect(result.connected).toBe(true);
    });

    it('should validate disconnected lead', () => {
      const info = {
        name: 'OldLead',
        projectId: 'proj-456',
        connected: false,
      };
      const result = LeadInfoSchema.parse(info);
      expect(result.connected).toBe(false);
    });
  });
});
