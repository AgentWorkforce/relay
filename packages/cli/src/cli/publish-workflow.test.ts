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
    // cloud and config are published earlier by publish-sdk-internal-deps,
    // a `needs` of publish-main-runtime-deps; listing them again in that
    // matrix would race the registry into a duplicate-publish E409, so this
    // chain's coverage spans both jobs.
    const sdkInternalDepsPackages =
      workflow.jobs['publish-sdk-internal-deps']?.strategy?.matrix?.package ?? [];
    const parallelRuntimePackages =
      workflow.jobs['publish-main-runtime-deps']?.strategy?.matrix?.package ?? [];
    const publishedByMainChain = [
      ...sdkInternalDepsPackages.map((name) => `@agent-relay/${name}`),
      ...parallelRuntimePackages.map((name) => `@agent-relay/${name}`),
    ].sort();

    expect(publishedByMainChain).toEqual(directInternalDependencies);
  });

  it('publishes every CLI dependency before the root CLI on package=all too', () => {
    const jobs = loadPublishWorkflow().jobs;
    const cliPackage = JSON.parse(readFileSync(repoPath('packages/cli/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const published = new Set(
      [
        ...(jobs['publish-sdk-internal-deps']?.strategy?.matrix?.package ?? []),
        ...(jobs['publish-packages']?.strategy?.matrix?.package ?? []),
      ].map((name) => `@agent-relay/${name}`)
    );
    for (const name of Object.keys(cliPackage.dependencies ?? {}).filter((dep) =>
      dep.startsWith('@agent-relay/')
    )) {
      expect(published.has(name), name).toBe(true);
    }
    expect(jobs['publish-packages']?.needs).toContain('publish-sdk-internal-deps');
  });

  it('gates the root CLI on its dependency publish jobs', () => {
    const jobs = loadPublishWorkflow().jobs;

    expect(jobs['publish-main-runtime-deps']?.needs).toContain('publish-sdk-internal-deps');
    expect(jobs['publish-main']?.needs).toEqual(
      expect.arrayContaining(['publish-packages', 'publish-main-runtime-deps'])
    );

    const publishMainIf = jobs['publish-main']?.if;
    expect(publishMainIf).toContain(
      "(needs.publish-packages.result == 'success' || ((github.event.inputs.package == 'main' || github.event.inputs.package == 'cli-prerelease') && needs.publish-packages.result == 'skipped'))"
    );
    expect(publishMainIf).toContain(
      "(needs.publish-main-runtime-deps.result == 'success' || (github.event.inputs.package == 'all' && needs.publish-main-runtime-deps.result == 'skipped'))"
    );
  });

  it('no longer builds, stages or publishes the retired broker packages', () => {
    const text = readFileSync(repoPath('.github/workflows/publish.yml'), 'utf8');
    expect(text).not.toMatch(
      /agent-relay-broker|harness-driver|@agent-relay\/(harnesses|fleet|evals)|broker-(darwin|linux|win32)|cargo/
    );
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

  it('pins @relayflows/sdk optional @agent-relay peers during version bump', () => {
    const versionStep = loadPublishWorkflow().jobs.build?.steps?.find(
      (step) => step.name === 'Version all packages'
    );
    const run = versionStep?.run ?? '';

    expect(run).toContain("rootPkg.overrides['@relayflows/sdk']");
    expect(run).toContain("'@agent-relay/sdk': version");
    expect(run).not.toContain('harness-driver');

    const cleanReinstall = loadPublishWorkflow().jobs.build?.steps?.find(
      (step) => step.name === 'Clean reinstall after version bump'
    );
    expect(cleanReinstall?.run).toContain('npm install');
  });
});
