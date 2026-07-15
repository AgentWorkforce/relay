import { describe, it, expect } from 'vitest';
import { classifyTask } from './classifier.js';

describe('classifyTask', () => {
  it('classifies a simple one-liner as low complexity', () => {
    // No medium/high keywords, short word count, single domain — should route low.
    const r = classifyTask('Rename the variable in config.ts');
    expect(r.complexity).toBe('low');
    expect(r.parallelizable).toBe(false);
    expect(r.estimatedWorkers).toBeGreaterThanOrEqual(1);
  });

  it('classifies a multi-step task as medium complexity', () => {
    const r = classifyTask('Implement a REST API endpoint for user registration and add unit tests');
    expect(r.complexity).toBe('medium');
  });

  it('classifies an audit task as high complexity', () => {
    const r = classifyTask(
      'Run a full security audit of the authentication module and identify all vulnerabilities'
    );
    expect(r.complexity).toBe('high');
  });

  it('detects parallelism when multiple domains are present', () => {
    const r = classifyTask(
      'Build a React UI for the dashboard and implement the API endpoints and write test coverage'
    );
    expect(r.parallelizable).toBe(true);
    expect(r.domains.length).toBeGreaterThanOrEqual(2);
  });

  it('detects domains correctly', () => {
    const r = classifyTask('Optimize the database query and add API caching');
    expect(r.domains).toContain('backend');
    expect(r.domains).toContain('data');
  });

  it('caps estimatedWorkers at 6', () => {
    const bigTask = 'security audit api backend frontend testing devops mobile docs';
    const r = classifyTask(bigTask);
    expect(r.estimatedWorkers).toBeLessThanOrEqual(6);
  });

  it('includes reasoning string', () => {
    const r = classifyTask('Write a test for the login function');
    expect(r.reasoning).toBeTruthy();
    expect(r.reasoning).toContain('complexity=');
  });
});
