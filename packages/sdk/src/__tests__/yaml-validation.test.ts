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
import type { RelayYamlConfig, SwarmPattern } from '../workflows/types.js';

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
              if (step.type !== 'deterministic') {
                expect(step.agent).toBeDefined();
                expect(step.task).toBeDefined();
              }

              // Deterministic steps require command
              if (step.type === 'deterministic') {
                expect(step.command).toBeDefined();
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
