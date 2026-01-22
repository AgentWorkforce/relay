import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  composeForAgent,
  getAvailableRoles,
  parseRoleFromProfile,
  clearPromptCache,
  type AgentProfile,
} from './prompt-composer.js';
import fs from 'node:fs/promises';

// Mock fs module
vi.mock('node:fs/promises');

describe('prompt-composer', () => {
  beforeEach(() => {
    clearPromptCache();
    vi.clearAllMocks();
  });

  describe('parseRoleFromProfile', () => {
    it('should parse role from frontmatter', () => {
      const content = `---
name: Lead
role: planner
canSpawnChildren: true
---

Lead agent description.
`;
      expect(parseRoleFromProfile(content)).toBe('planner');
    });

    it('should return undefined for missing role', () => {
      const content = `---
name: Worker
---

Worker description.
`;
      expect(parseRoleFromProfile(content)).toBeUndefined();
    });

    it('should return undefined for invalid role', () => {
      const content = `---
name: Agent
role: invalid
---

Description.
`;
      expect(parseRoleFromProfile(content)).toBeUndefined();
    });

    it('should handle case-insensitive roles', () => {
      const content = `---
role: WORKER
---
`;
      expect(parseRoleFromProfile(content)).toBe('worker');
    });

    it('should return undefined for no frontmatter', () => {
      const content = 'Just plain markdown without frontmatter.';
      expect(parseRoleFromProfile(content)).toBeUndefined();
    });
  });

  describe('composeForAgent', () => {
    const mockProjectRoot = '/test/project';

    it('should compose prompt with role-specific content', async () => {
      const mockRolePrompt = '# Planner Strategy\n\nPlanner instructions...';
      vi.mocked(fs.readFile).mockResolvedValueOnce(mockRolePrompt);

      const profile: AgentProfile = {
        name: 'Lead',
        role: 'planner',
      };

      const result = await composeForAgent(profile, mockProjectRoot);

      expect(result.content).toContain('Planner Strategy');
      expect(result.rolePrompt).toBe(mockRolePrompt);
    });

    it('should include parent context', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('# Worker Focus\n');

      const profile: AgentProfile = {
        name: 'SubWorker',
        role: 'worker',
        parentAgent: 'Lead',
      };

      const result = await composeForAgent(profile, mockProjectRoot);

      expect(result.content).toContain('working under **Lead**');
    });

    it('should include task description', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('# Worker Focus\n');

      const profile: AgentProfile = {
        name: 'Worker',
        role: 'worker',
      };

      const result = await composeForAgent(profile, mockProjectRoot, {
        taskDescription: 'Implement user authentication',
      });

      expect(result.content).toContain('Implement user authentication');
    });

    it('should include team members', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('# Planner Strategy\n');

      const profile: AgentProfile = {
        name: 'Lead',
        role: 'planner',
      };

      const result = await composeForAgent(profile, mockProjectRoot, {
        teamMembers: ['Backend', 'Frontend', 'Database'],
      });

      expect(result.content).toContain('Backend');
      expect(result.content).toContain('Frontend');
      expect(result.content).toContain('Database');
    });

    it('should include custom prompt', async () => {
      vi.mocked(fs.readFile).mockResolvedValueOnce('# Worker Focus\n');

      const profile: AgentProfile = {
        name: 'SpecialWorker',
        role: 'worker',
        customPrompt: 'Always use TypeScript strict mode.',
      };

      const result = await composeForAgent(profile, mockProjectRoot);

      expect(result.content).toContain('TypeScript strict mode');
      expect(result.customAdditions).toBe('Always use TypeScript strict mode.');
    });

    it('should handle missing role prompt file', async () => {
      vi.mocked(fs.readFile).mockRejectedValueOnce({ code: 'ENOENT' });

      const profile: AgentProfile = {
        name: 'Worker',
        role: 'worker',
      };

      const result = await composeForAgent(profile, mockProjectRoot);

      // Should not throw, just return without role prompt
      expect(result.rolePrompt).toBeUndefined();
    });

    it('should cache prompt files', async () => {
      const mockPrompt = '# Cached Content\n';
      vi.mocked(fs.readFile).mockResolvedValue(mockPrompt);

      const profile: AgentProfile = {
        name: 'Worker',
        role: 'worker',
      };

      // First call
      await composeForAgent(profile, mockProjectRoot);
      // Second call should use cache
      await composeForAgent(profile, mockProjectRoot);

      // readFile should only be called once due to caching
      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAvailableRoles', () => {
    const mockProjectRoot = '/test/project';

    it('should return available roles based on files', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce([
        'planner-strategy.md',
        'worker-focus.md',
        'reviewer-criteria.md',
      ] as any);

      const roles = await getAvailableRoles(mockProjectRoot);

      expect(roles).toContain('planner');
      expect(roles).toContain('lead');
      expect(roles).toContain('worker');
      expect(roles).toContain('reviewer');
      expect(roles).toContain('shadow');
    });

    it('should return partial list if some files missing', async () => {
      vi.mocked(fs.readdir).mockResolvedValueOnce([
        'worker-focus.md',
      ] as any);

      const roles = await getAvailableRoles(mockProjectRoot);

      expect(roles).toContain('worker');
      expect(roles).not.toContain('planner');
      expect(roles).not.toContain('reviewer');
    });

    it('should return empty array if directory missing', async () => {
      vi.mocked(fs.readdir).mockRejectedValueOnce({ code: 'ENOENT' });

      const roles = await getAvailableRoles(mockProjectRoot);

      expect(roles).toEqual([]);
    });
  });
});
