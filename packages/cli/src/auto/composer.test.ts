import { describe, it, expect } from 'vitest';
import { classifyTask } from './classifier.js';
import { composeTeam } from './composer.js';

describe('composeTeam', () => {
  it('selects sonnet lead for low complexity', () => {
    const assessment = classifyTask('Fix the typo in the README');
    const team = composeTeam(assessment, 'Fix the typo in the README');
    expect(team.lead.model).toBe('sonnet');
    expect(team.lead.onboarding).toBe('one-liner');
  });

  it('selects opus lead for high complexity', () => {
    const assessment = classifyTask(
      'Conduct a comprehensive security audit of the entire authentication system across all services'
    );
    const team = composeTeam(assessment, 'security audit task');
    expect(team.lead.model).toBe('opus');
  });

  it('assigns haiku workers for low-complexity parallel tasks', () => {
    const assessment = classifyTask(
      'Update the README and also fix the CSS style in the frontend and add a basic test'
    );
    const team = composeTeam(assessment, 'multi-update task');
    if (assessment.parallelizable) {
      expect(team.workers.some((w) => w.model === 'haiku')).toBe(true);
    }
  });

  it('never selects haiku as lead', () => {
    const tasks = [
      'Fix a typo',
      'Implement a feature',
      'Run a full audit',
    ];
    for (const task of tasks) {
      const assessment = classifyTask(task);
      const team = composeTeam(assessment, task);
      expect(team.lead.model).not.toBe('haiku');
    }
  });

  it('caps team size at 6 workers', () => {
    const assessment = classifyTask(
      'security backend frontend testing devops mobile docs data api'
    );
    const team = composeTeam(assessment, 'large task');
    expect(team.workers.length).toBeLessThanOrEqual(7); // 6 + optional synth
  });

  it('adds synthesiser for medium parallel tasks', () => {
    const assessment = {
      complexity: 'medium' as const,
      parallelizable: true,
      subtasks: ['backend work', 'frontend work'],
      domains: ['backend', 'frontend'],
      estimatedWorkers: 2,
      reasoning: 'test',
    };
    const team = composeTeam(assessment, 'build the full feature');
    const hasSynth = team.workers.some((w) => w.role.includes('Synthesiser'));
    expect(hasSynth).toBe(true);
  });
});
