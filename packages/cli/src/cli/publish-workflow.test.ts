import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowJob = {
  if?: string;
  needs?: string[];
  strategy?: { matrix?: { package?: string[] } };
  steps?: Array<{ name?: string; run?: string }>;
};

type PublishWorkflow = {
  env?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

function repoPath(path: string): string {
  return resolve(repoRoot, path);
}

function loadPublishWorkflow(): PublishWorkflow {
  return parse(readFileSync(repoPath('.github/workflows/publish.yml'), 'utf8')) as PublishWorkflow;
}

describe('package=main publish dependency chain', () => {
  it('publishes every exact-version Agent Relay dependency before the root CLI', () => {
    const workflow = loadPublishWorkflow();
    const cliPackage = JSON.parse(readFileSync(repoPath('packages/cli/package.json'), 'utf8')) as {
      version: string;
      dependencies?: Record<string, string>;
    };

    const directInternalDependencies = Object.entries(cliPackage.dependencies ?? {})
      .filter(([name]) => name.startsWith('@agent-relay/'))
      .map(([name, version]) => {
        expect(version).toBe(cliPackage.version);
        return name;
      })
      .sort();
    const parallelRuntimePackages =
      workflow.jobs['publish-main-runtime-deps']?.strategy?.matrix?.package ?? [];
    const publishedByMainChain = [
      ...parallelRuntimePackages.map((name) => `@agent-relay/${name}`),
      '@agent-relay/harnesses',
      '@agent-relay/fleet',
    ].sort();

    expect(publishedByMainChain).toEqual(directInternalDependencies);
  });

  it('orders harnesses and fleet after their exact-version dependencies', () => {
    const jobs = loadPublishWorkflow().jobs;

    expect(jobs['publish-main-harnesses']?.needs).toContain('publish-main-runtime-deps');
    expect(jobs['publish-main-fleet']?.needs).toContain('publish-main-harnesses');
    expect(jobs['publish-main-harnesses']?.steps).toEqual(jobs['publish-harnesses']?.steps);
    expect(jobs['publish-main-fleet']?.steps).toEqual(jobs['publish-fleet']?.steps);
    expect(jobs['publish-main']?.needs).toEqual(
      expect.arrayContaining(['publish-main-runtime-deps', 'publish-main-harnesses', 'publish-main-fleet'])
    );

    const publishMainIf = jobs['publish-main']?.if;
    for (const job of ['publish-packages', 'publish-fleet']) {
      expect(publishMainIf).toContain(
        `(needs.${job}.result == 'success' || ((github.event.inputs.package == 'main' || github.event.inputs.package == 'cli-prerelease') && needs.${job}.result == 'skipped'))`
      );
    }
    for (const job of ['publish-main-runtime-deps', 'publish-main-harnesses', 'publish-main-fleet']) {
      expect(publishMainIf).toContain(
        `(needs.${job}.result == 'success' || (github.event.inputs.package == 'all' && needs.${job}.result == 'skipped'))`
      );
    }
  });

  it('passes the untrusted npm tag to publish commands through a quoted environment variable', () => {
    const workflow = loadPublishWorkflow();
    expect(workflow.env?.NPM_TAG).toBe('${{ github.event.inputs.tag }}');

    const publishCommands = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? '')
      .filter((run) => run.includes('npm publish'));

    expect(publishCommands.length).toBeGreaterThan(0);
    for (const command of publishCommands) {
      expect(command).toContain('--tag "$NPM_TAG"');
      expect(command).not.toContain('github.event.inputs.tag');
    }
  });

  it('allows enough time for provenance-published versions to become queryable', () => {
    const waitStep = loadPublishWorkflow().jobs['publish-main']?.steps?.find(
      (step) => step.name === 'Wait for CLI internal dependencies'
    );

    expect(waitStep?.run).toContain('for attempt in {0..60}');
    expect(waitStep?.run).toContain('sleep 10');
    expect(waitStep?.run).toContain('if [ "$attempt" -lt 60 ]');
  });
});
