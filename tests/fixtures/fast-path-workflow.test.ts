// Pins the safety properties of the approval-gated fast path: it can only be
// dispatched by hand, starts with read-only permissions, nothing runs until
// the fast-path environment (Khaliq's approval) passes, and it never saves
// into a cache that normal CI or release workflows restore.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const file = path.resolve(__dirname, '../../.github/workflows/fast-path.yml');
const text = readFileSync(file, 'utf8');
const workflow = parse(text) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<
    string,
    { environment?: unknown; needs?: string | string[]; steps?: Array<Record<string, any>> }
  >;
};
const jobNames = Object.keys(workflow.jobs);
const gate = jobNames[0];
const needsOf = (job: string) => {
  const needs = workflow.jobs[job].needs;
  return needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];
};

describe('fast-path workflow', () => {
  it('is workflow_dispatch only', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  });

  it('starts with contents: read only', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('puts the fast-path environment on the first job only', () => {
    expect(workflow.jobs[gate].environment).toBe('fast-path');
    for (const name of jobNames.slice(1)) expect(workflow.jobs[name].environment, name).toBeUndefined();
  });

  it('makes every other job need the gate, directly or transitively', () => {
    const reaches = (job: string, seen = new Set<string>()): boolean => {
      if (job === gate) return true;
      if (seen.has(job)) return false;
      seen.add(job);
      return needsOf(job).some((need) => {
        expect(jobNames, `${job} needs unknown job ${need}`).toContain(need);
        return reaches(need, seen);
      });
    };
    for (const name of jobNames.slice(1)) expect(reaches(name), `${name} can run before approval`).toBe(true);
  });

  it('never lets one dispatch cancel another that waits for approval', () => {
    expect(workflow.concurrency.group).toContain('github.run_id');
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });

  it('never saves into a cache other workflows restore', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        const uses = String(step.uses ?? '');
        const withs = step.with ?? {};
        if (uses.startsWith('actions/setup-node') || uses.startsWith('actions/setup-go')) {
          expect([undefined, false], `${name}: ${uses} cache`).toContain(withs.cache);
        }
        if (uses.startsWith('Swatinem/rust-cache'))
          expect(withs['save-if'], `${name}: rust-cache`).toBe(false);
        if (uses.startsWith('oven-sh/setup-bun')) expect(withs['no-cache'], `${name}: setup-bun`).toBe(true);
        expect(uses.startsWith('actions/cache@'), `${name}: actions/cache saves`).toBe(false);
        expect(withs['cache-to'], `${name}: cache-to`).toBeUndefined();
      }
    }
  });
});
