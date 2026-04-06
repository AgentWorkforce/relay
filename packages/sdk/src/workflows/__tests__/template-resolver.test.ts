import { describe, expect, it } from 'vitest';

// Import from the module that will be extracted from runner.ts
import { resolveStepOutputRef, resolveTemplate, TemplateResolver } from '../template-resolver.js';

describe('TemplateResolver', () => {
  const resolver = new TemplateResolver();

  describe('resolveTemplate', () => {
    it('replaces non-step placeholders and preserves deferred step outputs', () => {
      const result = resolveTemplate('Deploy {{env}} after {{steps.plan.output}}', { env: 'prod' });
      expect(result).toBe('Deploy prod after {{steps.plan.output}}');
    });

    it('throws on unresolved placeholders', () => {
      expect(() => resolveTemplate('Deploy {{missing}}', {})).toThrow('Unresolved variable: {{missing}}');
    });
  });

  describe('resolveStepOutputRef', () => {
    it('resolves a completed step output by reference', () => {
      const stepOutputs = new Map([['plan', 'Build a REST API']]);
      expect(resolveStepOutputRef('steps.plan.output', stepOutputs)).toBe('Build a REST API');
    });

    it('accepts references wrapped in template braces', () => {
      const stepOutputs = new Map([['code', 'Created 3 files']]);
      expect(resolveStepOutputRef('{{steps.code.output}}', stepOutputs)).toBe('Created 3 files');
    });
  });

  describe('resolveVariables', () => {
    it('replaces simple {{var}} placeholders in agent tasks', () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { mode: 'coordinate' as const },
        agents: [{ name: 'a1', cli: 'claude', task: 'Deploy {{env}} to {{region}}' }],
      };
      const result = resolver.resolveVariables(config as any, { env: 'staging', region: 'us-east-1' });
      expect(result.agents[0].task).toBe('Deploy staging to us-east-1');
    });

    it('replaces variables in workflow step tasks and commands', () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { mode: 'coordinate' as const },
        agents: [],
        workflows: [
          {
            name: 'wf1',
            steps: [
              { name: 's1', task: 'Build {{project}}', agent: 'a1' },
              { name: 's2', command: 'deploy --env={{env}}' },
            ],
          },
        ],
      };
      const result = resolver.resolveVariables(config as any, { project: 'relay', env: 'prod' });
      expect(result.workflows![0].steps[0].task).toBe('Build relay');
      expect(result.workflows![0].steps[1].command).toBe('deploy --env=prod');
    });

    it('replaces variables in step params', () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { mode: 'coordinate' as const },
        agents: [],
        workflows: [
          {
            name: 'wf1',
            steps: [{ name: 's1', agent: 'a1', params: { url: '{{base_url}}/api', count: 42 } }],
          },
        ],
      };
      const result = resolver.resolveVariables(config as any, { base_url: 'https://example.com' });
      expect((result.workflows![0].steps[0].params as any).url).toBe('https://example.com/api');
      // Non-string params are left untouched
      expect((result.workflows![0].steps[0].params as any).count).toBe(42);
    });

    it('preserves {{steps.X.output}} placeholders for later resolution', () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { mode: 'coordinate' as const },
        agents: [{ name: 'a1', cli: 'claude', task: 'Use {{steps.plan.output}} for {{env}}' }],
      };
      const result = resolver.resolveVariables(config as any, { env: 'prod' });
      expect(result.agents[0].task).toBe('Use {{steps.plan.output}} for prod');
    });

    it('throws on unresolved non-step variables', () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { mode: 'coordinate' as const },
        agents: [{ name: 'a1', cli: 'claude', task: 'Deploy to {{missing_var}}' }],
      };
      expect(() => resolver.resolveVariables(config as any, {})).toThrow('Unresolved variable: {{missing_var}}');
    });

    it('does not mutate the original config', () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { mode: 'coordinate' as const },
        agents: [{ name: 'a1', cli: 'claude', task: 'Deploy {{env}}' }],
      };
      resolver.resolveVariables(config as any, { env: 'staging' });
      expect(config.agents[0].task).toBe('Deploy {{env}}');
    });
  });

  describe('resolveDotPath', () => {
    it('resolves nested dot-path variables', () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { mode: 'coordinate' as const },
        agents: [{ name: 'a1', cli: 'claude', task: 'Region: {{aws.region}}' }],
      };
      const vars = { aws: { region: 'us-west-2' } } as any;
      const result = resolver.resolveVariables(config as any, vars);
      expect(result.agents[0].task).toBe('Region: us-west-2');
    });

    it('throws for undefined nested paths', () => {
      const config = {
        version: '1',
        name: 'test',
        swarm: { mode: 'coordinate' as const },
        agents: [{ name: 'a1', cli: 'claude', task: '{{a.b.c}}' }],
      };
      expect(() => resolver.resolveVariables(config as any, { a: { b: {} } } as any)).toThrow(
        'Unresolved variable: {{a.b.c}}'
      );
    });
  });

  describe('interpolateStepTask', () => {
    it('resolves step output references from completed steps', () => {
      const template = 'Review: {{steps.plan.output}} and {{steps.code.output}}';
      const context = {
        steps: {
          plan: { output: 'Build a REST API' },
          code: { output: 'Created 3 files' },
        },
      } as any;
      const result = resolver.interpolateStepTask(template, context);
      expect(result).toBe('Review: Build a REST API and Created 3 files');
    });

    it('leaves unresolved step references intact', () => {
      const template = 'Use {{steps.future.output}} later';
      const result = resolver.interpolateStepTask(template, { steps: {} } as any);
      expect(result).toBe('Use {{steps.future.output}} later');
    });
  });
});
