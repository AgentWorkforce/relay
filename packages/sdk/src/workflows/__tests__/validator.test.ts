import { describe, expect, it } from 'vitest';

import { validateWorkflow } from '../validator.js';
import type { RelayYamlConfig } from '../types.js';

function makeConfig(overrides: Partial<RelayYamlConfig> = {}): RelayYamlConfig {
  return {
    version: '1',
    name: 'test-workflow',
    swarm: {
      pattern: 'dag',
    },
    agents: [
      {
        name: 'lead-agent',
        cli: 'claude',
        role: 'lead engineer',
      },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'step-1',
            agent: 'lead-agent',
            task: 'Implement the requested change',
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('validateWorkflow', () => {
  it('warns when an interactive step explicitly sets retries to zero', () => {
    const issues = validateWorkflow(
      makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-1',
                agent: 'lead-agent',
                task: 'Implement the requested change',
                retries: 0,
              },
            ],
          },
        ],
      })
    );

    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'INTERACTIVE_ZERO_RETRIES',
        location: 'step:step-1',
      })
    );
  });

  it('does not warn when an interactive step leaves retries unset and uses the default retry budget', () => {
    const issues = validateWorkflow(makeConfig());

    expect(issues.some((issue) => issue.code === 'INTERACTIVE_ZERO_RETRIES')).toBe(false);
  });

  it('warns when an interactive step inherits an effective retry budget of zero', () => {
    const issues = validateWorkflow(
      makeConfig({
        errorHandling: {
          strategy: 'retry',
          maxRetries: 0,
        },
      })
    );

    expect(issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'INTERACTIVE_ZERO_RETRIES',
        location: 'step:step-1',
      })
    );
  });
});
