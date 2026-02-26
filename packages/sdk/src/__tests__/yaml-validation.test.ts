/**
 * YAML Workflow Template Validation Tests
 *
 * Tests that all built-in workflow templates are valid, parse correctly,
 * and have correct structure. Also tests error handling for invalid YAML.
 *
 * These tests are CI-friendly (no CLI or API keys needed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { TemplateRegistry, BUILT_IN_TEMPLATE_NAMES } from '../workflows/templates.js';
import { SwarmCoordinator } from '../workflows/coordinator.js';
import type { RelayYamlConfig, SwarmPattern, WorkflowStep, CustomStepDefinition } from '../workflows/types.js';
import { isDeterministicStep, isWorktreeStep, isAgentStep, isCustomStep } from '../workflows/types.js';
import {
  resolveCustomStep,
  resolveAllCustomSteps,
  validateCustomStepsUsage,
  CustomStepsParseError,
  CustomStepResolutionError,
} from '../workflows/custom-steps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, '../workflows/builtin-templates');

// Mock DB for coordinator tests
const mockDb = {
  query: async () => ({ rows: [] }),
};

describe('YAML Template Validation', () => {
  let registry: TemplateRegistry;
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    registry = new TemplateRegistry({ builtInTemplatesDir: TEMPLATES_DIR });
    coordinator = new SwarmCoordinator(mockDb as any);
  });

  // ── Built-in Template Registration ─────────────────────────────────────────

  describe('Built-in Template Registration', () => {
    it('should have all expected built-in templates registered', () => {
      const templates = registry.listBuiltInTemplates();
      expect(templates).toContain('feature-dev');
      expect(templates).toContain('bug-fix');
      expect(templates).toContain('code-review');
      expect(templates).toContain('security-audit');
      expect(templates).toContain('refactor');
      expect(templates).toContain('documentation');
      expect(templates).toContain('review-loop');
    });

    it('should have correct number of built-in templates', () => {
      const templates = registry.listBuiltInTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(7);
    });
  });

  // ── Individual Template Validation ─────────────────────────────────────────

  describe('Template Loading and Validation', () => {
    for (const templateName of BUILT_IN_TEMPLATE_NAMES) {
      describe(`${templateName} template`, () => {
        it('should load successfully', async () => {
          const config = await registry.loadTemplate(templateName);
          expect(config).toBeDefined();
          expect(config.name).toBe(templateName);
        });

        it('should have required fields', async () => {
          const config = await registry.loadTemplate(templateName);
          expect(config.version).toBeDefined();
          expect(config.name).toBeDefined();
          expect(config.swarm).toBeDefined();
          expect(config.swarm.pattern).toBeDefined();
          expect(config.agents).toBeDefined();
          expect(config.agents.length).toBeGreaterThan(0);
        });

        it('should have valid swarm pattern', async () => {
          const config = await registry.loadTemplate(templateName);
          const validPatterns: SwarmPattern[] = [
            'fan-out', 'pipeline', 'hub-spoke', 'consensus', 'mesh',
            'handoff', 'cascade', 'dag', 'debate', 'hierarchical',
            'map-reduce', 'scatter-gather', 'supervisor', 'reflection',
            'red-team', 'verifier', 'auction', 'escalation', 'saga',
            'circuit-breaker', 'blackboard', 'swarm', 'competitive', 'review-loop',
          ];
          expect(validPatterns).toContain(config.swarm.pattern);
        });

        it('should have valid agent definitions', async () => {
          const config = await registry.loadTemplate(templateName);
          for (const agent of config.agents) {
            expect(agent.name).toBeDefined();
            expect(typeof agent.name).toBe('string');
            expect(agent.cli).toBeDefined();
            expect(['claude', 'codex', 'gemini', 'aider', 'goose', 'opencode', 'droid']).toContain(agent.cli);
          }
        });

        it('should have unique agent names', async () => {
          const config = await registry.loadTemplate(templateName);
          const names = config.agents.map((a) => a.name);
          const uniqueNames = new Set(names);
          expect(uniqueNames.size).toBe(names.length);
        });

        it('should resolve topology without error', async () => {
          const config = await registry.loadTemplate(templateName);
          const topology = coordinator.resolveTopology(config);
          expect(topology).toBeDefined();
          expect(topology.pattern).toBe(config.swarm.pattern);
          expect(topology.agents).toEqual(config.agents);
          expect(topology.edges).toBeInstanceOf(Map);
        });
      });
    }
  });

  // ── Workflow Steps Validation ──────────────────────────────────────────────

  describe('Workflow Steps Validation', () => {
    for (const templateName of BUILT_IN_TEMPLATE_NAMES) {
      it(`${templateName}: workflow steps should be valid`, async () => {
        const config = await registry.loadTemplate(templateName);

        if (config.workflows && config.workflows.length > 0) {
          for (const workflow of config.workflows) {
            expect(workflow.name).toBeDefined();
            expect(workflow.steps).toBeDefined();
            expect(Array.isArray(workflow.steps)).toBe(true);

            for (const step of workflow.steps) {
              expect(step.name).toBeDefined();
              expect(typeof step.name).toBe('string');

              // Agent steps require agent and task
              if (step.type !== 'deterministic' && step.type !== 'worktree') {
                expect(step.agent).toBeDefined();
                expect(step.task).toBeDefined();
              }

              // Deterministic steps require command
              if (step.type === 'deterministic') {
                expect(step.command).toBeDefined();
              }

              // Worktree steps require branch
              if (step.type === 'worktree') {
                expect(step.branch).toBeDefined();
              }

              // Check dependsOn is array if present
              if (step.dependsOn) {
                expect(Array.isArray(step.dependsOn)).toBe(true);
              }
            }
          }
        }
      });

      it(`${templateName}: step dependencies should reference existing steps`, async () => {
        const config = await registry.loadTemplate(templateName);

        if (config.workflows && config.workflows.length > 0) {
          for (const workflow of config.workflows) {
            const stepNames = new Set(workflow.steps.map((s) => s.name));

            for (const step of workflow.steps) {
              if (step.dependsOn) {
                for (const dep of step.dependsOn) {
                  expect(stepNames.has(dep)).toBe(true);
                }
              }
            }
          }
        }
      });

      it(`${templateName}: step agents should reference existing agents`, async () => {
        const config = await registry.loadTemplate(templateName);
        const agentNames = new Set(config.agents.map((a) => a.name));

        if (config.workflows && config.workflows.length > 0) {
          for (const workflow of config.workflows) {
            for (const step of workflow.steps) {
              if (step.agent) {
                expect(agentNames.has(step.agent)).toBe(true);
              }
            }
          }
        }
      });
    }
  });

  // ── review-loop Template Specific Tests ────────────────────────────────────

  describe('review-loop Template Specifics', () => {
    it('should have implementer agent', async () => {
      const config = await registry.loadTemplate('review-loop');
      const implementer = config.agents.find((a) => a.name.includes('implementer'));
      expect(implementer).toBeDefined();
    });

    it('should have multiple reviewer agents', async () => {
      const config = await registry.loadTemplate('review-loop');
      const reviewers = config.agents.filter((a) => a.name.includes('reviewer'));
      expect(reviewers.length).toBeGreaterThanOrEqual(2);
    });

    it('should have non-interactive reviewers', async () => {
      const config = await registry.loadTemplate('review-loop');
      const reviewers = config.agents.filter((a) => a.name.includes('reviewer'));
      for (const reviewer of reviewers) {
        expect(reviewer.interactive).toBe(false);
      }
    });

    it('should have deterministic git diff step', async () => {
      const config = await registry.loadTemplate('review-loop');
      if (config.workflows && config.workflows.length > 0) {
        const workflow = config.workflows[0];
        const diffStep = workflow.steps.find((s) => s.name === 'capture-diff');
        expect(diffStep).toBeDefined();
        expect(diffStep?.type).toBe('deterministic');
        expect(diffStep?.command).toContain('git diff');
      }
    });

    it('should have review steps depending on implement step', async () => {
      const config = await registry.loadTemplate('review-loop');
      if (config.workflows && config.workflows.length > 0) {
        const workflow = config.workflows[0];
        const reviewSteps = workflow.steps.filter((s) => s.name.startsWith('review-'));
        expect(reviewSteps.length).toBeGreaterThan(0);
      }
    });

    it('should have consolidate step depending on all reviews', async () => {
      const config = await registry.loadTemplate('review-loop');
      if (config.workflows && config.workflows.length > 0) {
        const workflow = config.workflows[0];
        const consolidateStep = workflow.steps.find((s) => s.name === 'consolidate');
        expect(consolidateStep).toBeDefined();
        expect(consolidateStep?.dependsOn).toBeDefined();
        expect(consolidateStep?.dependsOn?.length).toBeGreaterThanOrEqual(3);
      }
    });

    it('should have address-feedback step', async () => {
      const config = await registry.loadTemplate('review-loop');
      if (config.workflows && config.workflows.length > 0) {
        const workflow = config.workflows[0];
        const addressStep = workflow.steps.find((s) => s.name === 'address-feedback');
        expect(addressStep).toBeDefined();
        expect(addressStep?.dependsOn).toContain('consolidate');
      }
    });

    it('should have coordination barriers', async () => {
      const config = await registry.loadTemplate('review-loop');
      expect(config.coordination).toBeDefined();
      expect(config.coordination?.barriers).toBeDefined();
      expect(config.coordination?.barriers?.length).toBeGreaterThan(0);
    });
  });

  // ── Error Handling Tests ───────────────────────────────────────────────────

  describe('Error Handling', () => {
    it('should reject template with missing version', () => {
      const invalidYaml = `
name: test
swarm:
  pattern: fan-out
agents:
  - name: test
    cli: claude
`;
      const parsed = parseYaml(invalidYaml);
      expect(() =>
        (registry as any).validateRelayConfig(parsed, 'test')
      ).toThrow(/version/);
    });

    it('should reject template with missing name', () => {
      const invalidYaml = `
version: "1.0"
swarm:
  pattern: fan-out
agents:
  - name: test
    cli: claude
`;
      const parsed = parseYaml(invalidYaml);
      expect(() =>
        (registry as any).validateRelayConfig(parsed, 'test')
      ).toThrow(/name/);
    });

    it('should reject template with empty agents', () => {
      const invalidYaml = `
version: "1.0"
name: test
swarm:
  pattern: fan-out
agents: []
`;
      const parsed = parseYaml(invalidYaml);
      expect(() =>
        (registry as any).validateRelayConfig(parsed, 'test')
      ).toThrow(/agents/);
    });

    it('should reject template with invalid agent definition', () => {
      const invalidYaml = `
version: "1.0"
name: test
swarm:
  pattern: fan-out
agents:
  - name: test
`;
      const parsed = parseYaml(invalidYaml);
      expect(() =>
        (registry as any).validateRelayConfig(parsed, 'test')
      ).toThrow(/invalid agent/i);
    });

    it('should reject non-existent template', async () => {
      await expect(registry.loadTemplate('non-existent-template')).rejects.toThrow(
        /not found/i
      );
    });
  });

  // ── Template Override Tests ────────────────────────────────────────────────

  describe('Template Overrides', () => {
    it('should apply simple override', async () => {
      const config = await registry.loadTemplate('feature-dev', {
        overrides: { description: 'Custom description' },
      });
      expect(config.description).toBe('Custom description');
    });

    it('should apply nested override', async () => {
      const config = await registry.loadTemplate('feature-dev', {
        overrides: { 'swarm.maxConcurrency': 10 },
      });
      expect(config.swarm.maxConcurrency).toBe(10);
    });

    it('should apply agent override by index', async () => {
      const config = await registry.loadTemplate('feature-dev', {
        overrides: { 'agents[0].constraints.model': 'claude-opus' },
      });
      expect(config.agents[0].constraints?.model).toBe('claude-opus');
    });
  });

  // ── DAG Validation Tests ───────────────────────────────────────────────────

  describe('DAG Dependency Validation', () => {
    for (const templateName of BUILT_IN_TEMPLATE_NAMES) {
      it(`${templateName}: should not have circular dependencies`, async () => {
        const config = await registry.loadTemplate(templateName);

        if (config.workflows && config.workflows.length > 0) {
          for (const workflow of config.workflows) {
            const deps = new Map<string, string[]>();
            for (const step of workflow.steps) {
              deps.set(step.name, step.dependsOn ?? []);
            }

            // Check for cycles using DFS
            const visited = new Set<string>();
            const recursionStack = new Set<string>();

            const hasCycle = (node: string): boolean => {
              if (recursionStack.has(node)) return true;
              if (visited.has(node)) return false;

              visited.add(node);
              recursionStack.add(node);

              for (const dep of deps.get(node) ?? []) {
                if (hasCycle(dep)) return true;
              }

              recursionStack.delete(node);
              return false;
            };

            for (const step of workflow.steps) {
              expect(hasCycle(step.name)).toBe(false);
            }
          }
        }
      });
    }
  });

  // ── Verification Check Tests ───────────────────────────────────────────────

  describe('Verification Check Validation', () => {
    for (const templateName of BUILT_IN_TEMPLATE_NAMES) {
      it(`${templateName}: verification checks should be valid`, async () => {
        const config = await registry.loadTemplate(templateName);

        if (config.workflows && config.workflows.length > 0) {
          for (const workflow of config.workflows) {
            for (const step of workflow.steps) {
              if (step.verification) {
                expect(['output_contains', 'exit_code', 'file_exists', 'custom']).toContain(
                  step.verification.type
                );
                expect(step.verification.value).toBeDefined();
              }
            }
          }
        }
      });
    }
  });

  // ── Variable Substitution Tests ────────────────────────────────────────────

  describe('Variable Substitution Patterns', () => {
    for (const templateName of BUILT_IN_TEMPLATE_NAMES) {
      it(`${templateName}: variable references should be valid`, async () => {
        const config = await registry.loadTemplate(templateName);

        if (config.workflows && config.workflows.length > 0) {
          for (const workflow of config.workflows) {
            const stepNames = new Set(workflow.steps.map((s) => s.name));

            for (const step of workflow.steps) {
              if (step.task) {
                // Check for {{steps.X.output}} references
                const stepRefs = step.task.match(/\{\{steps\.([^.]+)\.output\}\}/g) ?? [];
                for (const ref of stepRefs) {
                  const match = ref.match(/\{\{steps\.([^.]+)\.output\}\}/);
                  if (match) {
                    const referencedStep = match[1];
                    // The referenced step should exist
                    expect(stepNames.has(referencedStep)).toBe(true);
                  }
                }
              }
            }
          }
        }
      });
    }
  });

  // ── Error Handling Configuration ───────────────────────────────────────────

  describe('Error Handling Configuration', () => {
    for (const templateName of BUILT_IN_TEMPLATE_NAMES) {
      it(`${templateName}: error handling should be valid if present`, async () => {
        const config = await registry.loadTemplate(templateName);

        if (config.errorHandling) {
          expect(['fail-fast', 'continue', 'retry']).toContain(config.errorHandling.strategy);

          if (config.errorHandling.maxRetries !== undefined) {
            expect(config.errorHandling.maxRetries).toBeGreaterThanOrEqual(0);
          }

          if (config.errorHandling.retryDelayMs !== undefined) {
            expect(config.errorHandling.retryDelayMs).toBeGreaterThanOrEqual(0);
          }
        }
      });
    }
  });
});

// ── Step Type Guard Tests ───────────────────────────────────────────────────

describe('Step Type Guards', () => {
  it('should identify deterministic steps', () => {
    const step: WorkflowStep = { name: 'test', type: 'deterministic', command: 'echo hello' };
    expect(isDeterministicStep(step)).toBe(true);
    expect(isWorktreeStep(step)).toBe(false);
    expect(isAgentStep(step)).toBe(false);
  });

  it('should identify worktree steps', () => {
    const step: WorkflowStep = { name: 'test', type: 'worktree', branch: 'feature/test' };
    expect(isDeterministicStep(step)).toBe(false);
    expect(isWorktreeStep(step)).toBe(true);
    expect(isAgentStep(step)).toBe(false);
  });

  it('should identify agent steps (explicit type)', () => {
    const step: WorkflowStep = { name: 'test', type: 'agent', agent: 'dev', task: 'Do work' };
    expect(isDeterministicStep(step)).toBe(false);
    expect(isWorktreeStep(step)).toBe(false);
    expect(isAgentStep(step)).toBe(true);
  });

  it('should identify agent steps (implicit type)', () => {
    const step: WorkflowStep = { name: 'test', agent: 'dev', task: 'Do work' };
    expect(isDeterministicStep(step)).toBe(false);
    expect(isWorktreeStep(step)).toBe(false);
    expect(isAgentStep(step)).toBe(true);
  });

  it('should identify custom steps', () => {
    const step: WorkflowStep = { name: 'test', use: 'docker-build' };
    expect(isCustomStep(step)).toBe(true);
  });

  it('should not identify non-custom steps as custom', () => {
    const agentStep: WorkflowStep = { name: 'test', agent: 'dev', task: 'Do work' };
    const deterministicStep: WorkflowStep = { name: 'test', type: 'deterministic', command: 'echo hello' };
    expect(isCustomStep(agentStep)).toBe(false);
    expect(isCustomStep(deterministicStep)).toBe(false);
  });
});

// ── Custom Step Resolution Tests ────────────────────────────────────────────

describe('Custom Step Resolution', () => {
  const customSteps = new Map<string, CustomStepDefinition>([
    ['docker-build', {
      params: [
        { name: 'image', required: true },
        { name: 'dockerfile', default: 'Dockerfile' },
      ],
      command: 'docker build -t {{image}} -f {{dockerfile}} .',
      captureOutput: true,
    }],
    ['setup-worktree', {
      type: 'worktree',
      params: [
        { name: 'branch', required: true },
      ],
      branch: '{{branch}}',
      baseBranch: 'main',
      createBranch: true,
    }],
  ]);

  it('should resolve custom step with required param', () => {
    const step = { name: 'build', use: 'docker-build', image: 'myapp:latest' } as WorkflowStep;
    const resolved = resolveCustomStep(step, customSteps);

    expect(resolved.type).toBe('deterministic');
    expect(resolved.command).toBe('docker build -t myapp:latest -f Dockerfile .');
    expect(resolved.captureOutput).toBe(true);
  });

  it('should resolve custom step with all params', () => {
    const step = { name: 'build', use: 'docker-build', image: 'myapp:v2', dockerfile: 'Dockerfile.prod' } as WorkflowStep;
    const resolved = resolveCustomStep(step, customSteps);

    expect(resolved.command).toBe('docker build -t myapp:v2 -f Dockerfile.prod .');
  });

  it('should throw on missing required param', () => {
    const step = { name: 'build', use: 'docker-build' } as WorkflowStep;

    expect(() => resolveCustomStep(step, customSteps)).toThrow(/Missing required parameter/);
  });

  it('should throw on unknown custom step', () => {
    const step = { name: 'build', use: 'unknown-step' } as WorkflowStep;

    expect(() => resolveCustomStep(step, customSteps)).toThrow(/Custom step "unknown-step" not found/);
  });

  it('should resolve worktree custom step', () => {
    const step = { name: 'setup', use: 'setup-worktree', branch: 'feature/test' } as WorkflowStep;
    const resolved = resolveCustomStep(step, customSteps);

    expect(resolved.type).toBe('worktree');
    expect(resolved.branch).toBe('feature/test');
    expect(resolved.baseBranch).toBe('main');
    expect(resolved.createBranch).toBe(true);
  });

  it('should preserve step name and dependsOn', () => {
    const step = {
      name: 'my-build',
      use: 'docker-build',
      image: 'app:latest',
      dependsOn: ['setup']
    } as WorkflowStep;
    const resolved = resolveCustomStep(step, customSteps);

    expect(resolved.name).toBe('my-build');
    expect(resolved.dependsOn).toEqual(['setup']);
  });

  it('should pass through non-custom steps unchanged', () => {
    const step: WorkflowStep = { name: 'test', type: 'deterministic', command: 'echo hello' };
    const resolved = resolveCustomStep(step, customSteps);

    expect(resolved).toBe(step);
  });

  it('should resolve all custom steps in array', () => {
    const steps: WorkflowStep[] = [
      { name: 'build1', use: 'docker-build', image: 'app1:latest' } as WorkflowStep,
      { name: 'regular', type: 'deterministic', command: 'echo done' },
      { name: 'build2', use: 'docker-build', image: 'app2:latest' } as WorkflowStep,
    ];

    const resolved = resolveAllCustomSteps(steps, customSteps);

    expect(resolved).toHaveLength(3);
    expect(resolved[0].command).toBe('docker build -t app1:latest -f Dockerfile .');
    expect(resolved[1].command).toBe('echo done');
    expect(resolved[2].command).toBe('docker build -t app2:latest -f Dockerfile .');
  });
});

// ── Custom Step Validation Tests ────────────────────────────────────────────

describe('Custom Step Validation', () => {
  const customSteps = new Map<string, CustomStepDefinition>([
    ['docker-build', {
      params: [
        { name: 'image', required: true },
        { name: 'dockerfile', default: 'Dockerfile' },
      ],
      command: 'docker build -t {{image}} -f {{dockerfile}} .',
    }],
    ['deploy', {
      params: [
        { name: 'env', required: true },
      ],
      command: 'deploy --env={{env}}',
    }],
  ]);

  describe('validateCustomStepsUsage', () => {
    it('should pass validation for correctly configured steps', () => {
      const steps: WorkflowStep[] = [
        { name: 'build', use: 'docker-build', image: 'myapp:latest' } as WorkflowStep,
      ];

      const result = validateCustomStepsUsage(steps, customSteps);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should report missing custom step definition', () => {
      const steps: WorkflowStep[] = [
        { name: 'build', use: 'unknown-step' } as WorkflowStep,
      ];

      const result = validateCustomStepsUsage(steps, customSteps);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('unknown-step');
      expect(result.missingSteps).toContain('unknown-step');
    });

    it('should report missing required parameters', () => {
      const steps: WorkflowStep[] = [
        { name: 'build', use: 'docker-build' } as WorkflowStep, // missing 'image'
      ];

      const result = validateCustomStepsUsage(steps, customSteps);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('image');
      expect(result.missingParams).toHaveLength(1);
      expect(result.missingParams[0]).toEqual({
        step: 'build',
        use: 'docker-build',
        param: 'image',
      });
    });

    it('should warn about undefined variables in command', () => {
      const customStepsWithUndefinedVar = new Map<string, CustomStepDefinition>([
        ['bad-step', {
          params: [{ name: 'known' }],
          command: 'run {{known}} {{unknown}}',
        }],
      ]);

      const steps: WorkflowStep[] = [
        { name: 'test', use: 'bad-step', known: 'value' } as WorkflowStep,
      ];

      const result = validateCustomStepsUsage(steps, customStepsWithUndefinedVar);

      expect(result.valid).toBe(true); // warnings don't fail validation
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('unknown');
      expect(result.unresolvedVariables).toHaveLength(1);
    });

    it('should warn about extra parameters not in definition', () => {
      const steps: WorkflowStep[] = [
        { name: 'build', use: 'docker-build', image: 'app', extraParam: 'ignored' } as WorkflowStep,
      ];

      const result = validateCustomStepsUsage(steps, customSteps);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.includes('extraParam'))).toBe(true);
    });

    it('should validate multiple steps with different issues', () => {
      const steps: WorkflowStep[] = [
        { name: 'build1', use: 'docker-build' } as WorkflowStep, // missing image
        { name: 'build2', use: 'missing-step' } as WorkflowStep, // unknown step
        { name: 'deploy', use: 'deploy', env: 'prod' } as WorkflowStep, // valid
      ];

      const result = validateCustomStepsUsage(steps, customSteps);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(result.missingSteps).toContain('missing-step');
      expect(result.missingParams).toHaveLength(1);
    });

    it('should skip validation for non-custom steps', () => {
      const steps: WorkflowStep[] = [
        { name: 'agent-step', agent: 'dev', task: 'Do work' },
        { name: 'det-step', type: 'deterministic', command: 'echo hello' },
      ];

      const result = validateCustomStepsUsage(steps, customSteps);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });
});

// ── Custom Step Error Classes Tests ─────────────────────────────────────────

describe('Custom Step Error Classes', () => {
  it('CustomStepsParseError should have helpful message', () => {
    const error = new CustomStepsParseError(
      'Missing "steps" key',
      'Add a "steps" object',
      '/path/to/steps.yaml'
    );

    expect(error.name).toBe('CustomStepsParseError');
    expect(error.issue).toBe('Missing "steps" key');
    expect(error.suggestion).toBe('Add a "steps" object');
    expect(error.filePath).toBe('/path/to/steps.yaml');
    expect(error.message).toContain('Missing "steps" key');
    expect(error.message).toContain('Add a "steps" object');
  });

  it('CustomStepResolutionError should have helpful message', () => {
    const error = new CustomStepResolutionError(
      'my-step',
      'Custom step "docker-build" not found',
      'Add it to .relay/steps.yaml'
    );

    expect(error.name).toBe('CustomStepResolutionError');
    expect(error.stepName).toBe('my-step');
    expect(error.issue).toBe('Custom step "docker-build" not found');
    expect(error.suggestion).toBe('Add it to .relay/steps.yaml');
    expect(error.message).toContain('my-step');
  });
});

// ── Worktree Step Tests ─────────────────────────────────────────────────────

describe('Worktree Step Validation', () => {
  it('should accept valid worktree step', () => {
    const validYaml = `
version: "1.0"
name: test-worktree
swarm:
  pattern: dag
agents:
  - name: developer
    cli: claude
workflows:
  - name: default
    steps:
      - name: setup-worktree
        type: worktree
        branch: feature/test
      - name: develop
        agent: developer
        task: "Work in worktree"
        dependsOn: [setup-worktree]
`;
    const parsed = parseYaml(validYaml);
    expect(parsed.workflows[0].steps[0].type).toBe('worktree');
    expect(parsed.workflows[0].steps[0].branch).toBe('feature/test');
  });

  it('should accept worktree step with all options', () => {
    const validYaml = `
version: "1.0"
name: test-worktree
swarm:
  pattern: dag
agents:
  - name: developer
    cli: claude
workflows:
  - name: default
    steps:
      - name: setup-worktree
        type: worktree
        branch: feature/test
        baseBranch: main
        path: .worktrees/dev
        createBranch: true
        timeoutMs: 30000
`;
    const parsed = parseYaml(validYaml);
    const step = parsed.workflows[0].steps[0];
    expect(step.type).toBe('worktree');
    expect(step.branch).toBe('feature/test');
    expect(step.baseBranch).toBe('main');
    expect(step.path).toBe('.worktrees/dev');
    expect(step.createBranch).toBe(true);
    expect(step.timeoutMs).toBe(30000);
  });

  it('should support variable interpolation in worktree branch', () => {
    const validYaml = `
version: "1.0"
name: test-worktree
swarm:
  pattern: dag
agents:
  - name: developer
    cli: claude
workflows:
  - name: default
    steps:
      - name: setup-worktree
        type: worktree
        branch: "feature/{{branch-name}}"
`;
    const parsed = parseYaml(validYaml);
    expect(parsed.workflows[0].steps[0].branch).toBe('feature/{{branch-name}}');
  });
});

// ── Pattern Selection Tests ──────────────────────────────────────────────────

describe('Pattern Selection for Templates', () => {
  let registry: TemplateRegistry;
  let coordinator: SwarmCoordinator;

  beforeEach(() => {
    registry = new TemplateRegistry({ builtInTemplatesDir: TEMPLATES_DIR });
    coordinator = new SwarmCoordinator(mockDb as any);
  });

  it('review-loop should select review-loop pattern', async () => {
    const config = await registry.loadTemplate('review-loop');
    const pattern = coordinator.selectPattern(config);
    expect(pattern).toBe('review-loop');
  });

  for (const templateName of BUILT_IN_TEMPLATE_NAMES) {
    it(`${templateName}: selected pattern should match declared pattern`, async () => {
      const config = await registry.loadTemplate(templateName);
      // If pattern is explicit, selection should return it
      if (config.swarm.pattern) {
        const selected = coordinator.selectPattern(config);
        expect(selected).toBe(config.swarm.pattern);
      }
    });
  }
});
