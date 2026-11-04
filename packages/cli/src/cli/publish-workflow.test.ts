import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  env?: Record<string, string>;
  strategy?: {
    matrix?: { package?: string[]; include?: Array<{ suffix: string; target: string; ext: string }> };
  };
  steps?: Array<{ name?: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown> }>;
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

  it('pins @relayflows/sdk optional @agent-relay peers during version bump', () => {
    const versionStep = loadPublishWorkflow().jobs.build?.steps?.find(
      (step) => step.name === 'Version all packages'
    );
    const run = versionStep?.run ?? '';

    expect(run).toContain("rootPkg.overrides['@relayflows/sdk']");
    expect(run).toContain("'@agent-relay/sdk': version");
    expect(run).toContain("'@agent-relay/harness-driver': version");

    const cleanReinstall = loadPublishWorkflow().jobs.build?.steps?.find(
      (step) => step.name === 'Clean reinstall after version bump'
    );
    expect(cleanReinstall?.run).toContain('npm install');
  });
});

function needsOf(job: WorkflowJob): string[] {
  return typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []);
}

// Evaluate the workflow's boolean conditions with simulated Actions results.
// Actions permits hyphenated property names; JavaScript needs bracket notation.
function expressionValue(
  expression: string | undefined,
  inputs: Record<string, string>,
  results: Record<string, string>,
  prerelease = false
): unknown {
  const javascript = (expression ?? 'true')
    .replace(/\$\{\{|\}\}/g, '')
    .replace(/needs\.([\w-]+)\.result/g, (_, name) => JSON.stringify(results[name] ?? 'success'))
    .replace(/needs\.build\.outputs\.is_prerelease/g, JSON.stringify(String(prerelease)))
    .replace(/github\.event\.inputs\.([\w-]+)/g, (_, name) => JSON.stringify(inputs[name] ?? ''))
    .replace(/steps\.release_tag\.outputs\.release_exists/g, JSON.stringify(''))
    .replace(/always\(\)/g, 'true');
  return Function(`return (${javascript});`)();
}

function condition(
  expression: string | undefined,
  inputs: Record<string, string>,
  results: Record<string, string>,
  prerelease = false
): boolean {
  return Boolean(expressionValue(expression, inputs, results, prerelease));
}

// GitHub implicitly adds success() unless the expression calls a status function.
function jobRuns(
  job: WorkflowJob,
  inputs: Record<string, string>,
  results: Record<string, string> = {},
  prerelease = false
): boolean {
  const statuses = needsOf(job).map((name) => results[name] ?? 'success');
  const success = statuses.every((status) => status === 'success');
  if (!/\b(always|success|failure|cancelled)\(/.test(job.if ?? '') && !success) return false;
  const expression = job.if
    ?.replace(/success\(\)/g, String(success))
    .replace(/failure\(\)/g, String(statuses.includes('failure')))
    .replace(/cancelled\(\)/g, String(statuses.includes('cancelled')));
  return condition(expression, inputs, results, prerelease);
}

// Pre-publication writes may push only an explicit version tag. Reject ambiguous
// destinations too, so quoting, push options, or variable branch names cannot
// hide a branch update from this guard.
function hasNonTagPush(script: string): boolean {
  const shellWord = String.raw`(?:[^\s;"']+|"[^"\n]*"|'[^'\n]*')+`;
  const commands = script
    .replace(/\\\n/g, ' ')
    .matchAll(new RegExp(String.raw`\bgit(?:\s+-(?:C|c)\s+${shellWord})*\s+push\b([^\n;]*)`, 'g'));
  return [...commands].some(([, operands]) => {
    const words = (operands.match(new RegExp(shellWord, 'g')) ?? []).map((word) => word.replace(/["']/g, ''));
    const positional = words.filter((word) => !word.startsWith('-'));
    const destinations = positional.slice(1);
    return (
      words.some((word) =>
        ['--all', '--mirror', '--force', '-f', '--tags', '--follow-tags'].includes(word)
      ) ||
      destinations.length === 0 ||
      destinations.some((destination) => !/^(?:refs\/tags\/[^:]+|v\$\{(?:NEW_)?VERSION\})$/.test(destination))
    );
  });
}

describe('Actions job status semantics', () => {
  it('applies implicit success to ordinary conditions and preserves explicit status expressions', () => {
    const inputs = { package: 'all' };
    const ordinary = { needs: ['dependency'], if: "github.event.inputs.package == 'all'" };
    expect(jobRuns(ordinary, inputs)).toBe(true);
    for (const status of ['failure', 'cancelled', 'skipped']) {
      expect(jobRuns(ordinary, inputs, { dependency: status })).toBe(false);
      expect(jobRuns({ ...ordinary, if: 'always()' }, inputs, { dependency: status })).toBe(true);
    }
    expect(jobRuns({ ...ordinary, if: 'success()' }, inputs, { dependency: 'failure' })).toBe(false);
    expect(jobRuns({ ...ordinary, if: 'failure()' }, inputs, { dependency: 'failure' })).toBe(true);
    expect(jobRuns({ ...ordinary, if: 'failure()' }, inputs, { dependency: 'skipped' })).toBe(false);
    expect(jobRuns({ ...ordinary, if: 'cancelled()' }, inputs, { dependency: 'cancelled' })).toBe(true);
    expect(jobRuns({ ...ordinary, if: 'cancelled()' }, inputs, { dependency: 'failure' })).toBe(false);
  });
});

describe('unified relay-node release', () => {
  it('uses one release workflow and builds all supported node targets at the CLI version', () => {
    expect(existsSync(repoPath('.github/workflows/relay-node-release.yml'))).toBe(false);
    const node = loadPublishWorkflow().jobs['build-node'];
    expect(needsOf(node)).toContain('build');
    expect(node.env?.VERSION).toBe('${{ needs.build.outputs.new_version }}');
    expect(node.strategy?.matrix?.include?.map(({ suffix, target, ext }) => [suffix, target, ext])).toEqual([
      ['linux-x64', 'x86_64-unknown-linux-gnu', ''],
      ['linux-arm64', 'aarch64-unknown-linux-gnu', ''],
      ['darwin-arm64', 'aarch64-apple-darwin', ''],
      ['darwin-x64', 'x86_64-apple-darwin', ''],
      ['windows-x64', 'x86_64-pc-windows-msvc', '.exe'],
    ]);
    const commands = node.steps?.map((step) => step.run ?? '').join('\n') ?? '';
    expect(commands).toContain('AGENT_RELAY_PROBE_VERSION="$VERSION"');
    expect(commands).toContain('${ASSET}.sha256');
    expect(commands).toContain('agent-relay-node ${VERSION}');
  });

  it('has no release dependency cycle and gates every npm publisher on successful assets', () => {
    const { jobs } = loadPublishWorkflow();
    const visit = (name: string, ancestors: string[] = []): void => {
      expect(ancestors, `dependency cycle through ${name}`).not.toContain(name);
      expect(jobs[name], `unknown dependency ${name}`).toBeDefined();
      for (const dependency of needsOf(jobs[name])) visit(dependency, [...ancestors, name]);
    };
    for (const name of Object.keys(jobs)) visit(name);
    const publishers = Object.entries(jobs).filter(([, job]) =>
      job.steps?.some((step) => step.run?.includes('npm publish'))
    );
    expect(publishers.length).toBeGreaterThan(0);
    for (const [name, job] of publishers) {
      expect(needsOf(job), name).toContain('create-release');
      expect(
        ['all', 'main', 'sdk', 'cli-prerelease'].some((mode) =>
          jobRuns(job, { package: mode, dry_run: 'false' })
        ),
        `${name} must publish in at least one mode`
      ).toBe(true);
      for (const result of ['failure', 'cancelled', 'skipped']) {
        for (const mode of ['all', 'main', 'sdk', 'cli-prerelease']) {
          for (const dryRun of ['true', 'false']) {
            expect(
              jobRuns(job, { package: mode, dry_run: dryRun }, { 'create-release': result }),
              `${name}, ${mode}, dry=${dryRun}, ${result}`
            ).toBe(false);
          }
        }
      }
    }
  });

  it.each(['all', 'main', 'sdk', 'cli-prerelease'])(
    'checks node assets in %s mode including dry runs',
    (mode) => {
      const release = loadPublishWorkflow().jobs['create-release'];
      expect(needsOf(release)).toContain('build-node');
      expect(needsOf(release)).toContain('smoke-broker-packages');
      const results = {
        'build-standalone': mode === 'sdk' || mode === 'cli-prerelease' ? 'skipped' : 'success',
        'verify-binaries': mode === 'sdk' || mode === 'cli-prerelease' ? 'skipped' : 'success',
      };
      for (const dryRun of ['true', 'false']) {
        expect(condition(release.if, { package: mode, dry_run: dryRun }, results)).toBe(true);
        if (mode === 'all' || mode === 'main') {
          expect(
            condition(
              release.if,
              { package: mode, dry_run: dryRun },
              { ...results, 'verify-binaries': 'skipped' }
            )
          ).toBe(false);
          expect(
            condition(
              release.if,
              { package: mode, dry_run: dryRun },
              { ...results, 'build-standalone': 'skipped' }
            )
          ).toBe(false);
        }
        for (const failed of ['failure', 'cancelled', 'skipped']) {
          expect(
            jobRuns(
              release,
              { package: mode, dry_run: dryRun },
              { ...results, 'smoke-broker-packages': failed }
            )
          ).toBe(false);
          expect(
            condition(release.if, { package: mode, dry_run: dryRun }, { ...results, 'build-node': failed })
          ).toBe(false);
        }
      }
      const verify = release.steps?.find((step) => step.name === 'Verify node assets and checksums');
      expect(verify?.if).toBeUndefined();
      expect(verify?.run).toContain('linux-x64 linux-arm64 darwin-arm64 darwin-x64 windows-x64.exe');
      expect(verify?.run).toContain('test -f "$asset"');
      expect(verify?.run).toContain('test -f "${asset}.sha256"');
      expect(verify?.run).toContain('sha256sum -c "${asset}.sha256"');
    }
  );

  it.each(['complete', 'missing-binary', 'missing-sidecar', 'corrupted'])(
    'executes the asset checksum gate with %s artifacts',
    (scenario) => {
      const verify = loadPublishWorkflow().jobs['create-release'].steps?.find(
        (step) => step.name === 'Verify node assets and checksums'
      );
      expect(verify?.run).toBeTruthy();
      const directory = mkdtempSync(resolve(tmpdir(), 'relay-release-gate-'));
      const version = '16.0.1-rc.2';
      try {
        mkdirSync(resolve(directory, 'release-binaries'));
        for (const suffix of ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'windows-x64.exe']) {
          const asset = `agent-relay-node-${version}-${suffix}`;
          const binary = Buffer.from(`binary for ${suffix}`);
          const path = resolve(directory, 'release-binaries', asset);
          writeFileSync(path, binary);
          writeFileSync(`${path}.sha256`, `${createHash('sha256').update(binary).digest('hex')}  ${asset}\n`);
          if (suffix === 'windows-x64.exe') {
            if (scenario === 'missing-binary') rmSync(path);
            if (scenario === 'missing-sidecar') rmSync(`${path}.sha256`);
            if (scenario === 'corrupted') writeFileSync(path, 'corrupted');
          }
        }
        const run = () =>
          execFileSync('bash', ['-c', verify!.run!], {
            cwd: directory,
            env: { ...process.env, VERSION: version },
            stdio: 'pipe',
          });
        if (scenario === 'complete') expect(run).not.toThrow();
        else expect(run).toThrow();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(['absent', 'matching', 'different-source', 'different-mode', 'missing-mode'])(
    'validates %s release tags against both source and package mode',
    (scenario) => {
      const release = loadPublishWorkflow().jobs['create-release'];
      const check = release.steps?.find((step) => step.name === 'Check existing release tag');
      const tag = release.steps?.find((step) => step.name === 'Commit and tag');
      expect(check?.env?.PACKAGE_MODE).toBe('${{ github.event.inputs.package }}');
      expect(tag?.env?.PACKAGE_MODE).toBe('${{ github.event.inputs.package }}');
      expect(tag?.run).toContain('-m "Mode: ${PACKAGE_MODE}"');
      const directory = mkdtempSync(resolve(tmpdir(), 'relay-release-tag-'));
      try {
        const git = (...args: string[]) =>
          execFileSync('git', args, { cwd: directory, stdio: 'pipe' }).toString().trim();
        git('init');
        git(
          '-c',
          'user.name=Release test',
          '-c',
          'user.email=release@example.test',
          'commit',
          '--allow-empty',
          '-m',
          'source'
        );
        const source = git('rev-parse', 'HEAD');
        if (scenario !== 'absent') {
          const messages = [
            '-m',
            'Release v16.0.1',
            '-m',
            `Source: ${scenario === 'different-source' ? 'wrong-source' : source}`,
          ];
          if (scenario !== 'missing-mode')
            messages.push('-m', `Mode: ${scenario === 'different-mode' ? 'sdk' : 'all'}`);
          git(
            '-c',
            'user.name=Release test',
            '-c',
            'user.email=release@example.test',
            'tag',
            '-a',
            'v16.0.1',
            ...messages
          );
        }
        const output = resolve(directory, 'output');
        writeFileSync(output, '');
        const run = () =>
          execFileSync('bash', ['-c', check!.run!], {
            cwd: directory,
            env: {
              ...process.env,
              VERSION: '16.0.1',
              PACKAGE_MODE: 'all',
              GITHUB_SHA: source,
              GITHUB_OUTPUT: output,
              DRY_RUN: 'true',
            },
            stdio: 'pipe',
          });
        if (scenario === 'absent' || scenario === 'matching') {
          expect(run).not.toThrow();
          expect(readFileSync(output, 'utf8')).toBe(scenario === 'matching' ? 'exists=true\n' : '');
        } else {
          expect(run).toThrow();
          expect(readFileSync(output, 'utf8')).toBe('');
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(['200', '404', '401', '500', 'network'])(
    'checks existing non-dry-run releases with a %s API response',
    (response) => {
      const check = loadPublishWorkflow().jobs['create-release'].steps?.find(
        (step) => step.name === 'Check existing release tag'
      );
      const directory = mkdtempSync(resolve(tmpdir(), 'relay-release-lookup-'));
      try {
        const git = (...args: string[]) =>
          execFileSync('git', args, { cwd: directory, stdio: 'pipe' }).toString().trim();
        git('init');
        git(
          '-c',
          'user.name=Release test',
          '-c',
          'user.email=release@example.test',
          'commit',
          '--allow-empty',
          '-m',
          'source'
        );
        const source = git('rev-parse', 'HEAD');
        git(
          '-c',
          'user.name=Release test',
          '-c',
          'user.email=release@example.test',
          'tag',
          '-a',
          'v16.0.1',
          '-m',
          `Source: ${source}`,
          '-m',
          'Mode: all'
        );
        const output = resolve(directory, 'output');
        writeFileSync(output, '');
        const mock = `gh() {
          printf '%s\\n' "$*" >> calls
          if [ "$MOCK_RESPONSE" = network ]; then return 1; fi
          printf 'HTTP/2.0 %s\\n' "$MOCK_RESPONSE"
          [ "$MOCK_RESPONSE" = 200 ]
        }
`;
        const run = () =>
          execFileSync('bash', ['-c', mock + check!.run!], {
            cwd: directory,
            env: {
              ...process.env,
              VERSION: '16.0.1',
              PACKAGE_MODE: 'all',
              GITHUB_SHA: source,
              GITHUB_OUTPUT: output,
              DRY_RUN: 'false',
              GITHUB_REPOSITORY: 'test/relay',
              MOCK_RESPONSE: response,
            },
            stdio: 'pipe',
          });
        if (response === '200' || response === '404') expect(run).not.toThrow();
        else expect(run).toThrow();
        expect(readFileSync(output, 'utf8')).toBe(
          response === '200' ? 'exists=true\nrelease_exists=true\n' : 'exists=true\n'
        );
        expect(readFileSync(resolve(directory, 'calls'), 'utf8')).toBe(
          'api --include repos/test/relay/releases/tags/v16.0.1\n'
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(['all', 'main', 'sdk', 'cli-prerelease'])(
    'keeps %s release discovery and install instructions consistent with its assets',
    (mode) => {
      const release = loadPublishWorkflow().jobs['create-release'];
      const stable = release.steps?.find((step) => step.name === 'Create GitHub Release (stable)');
      const prerelease = release.steps?.find((step) => step.name === 'Create GitHub Release (prerelease)');
      const hasStandalone = mode === 'all' || mode === 'main';
      expect(stable?.with?.make_latest).toBe(false);
      expect(prerelease?.with?.make_latest).toBe(false);
      const notes = release.steps?.find((step) => step.name === 'Write mode-specific release notes');
      expect(notes?.env?.PACKAGE_MODE).toBe('${{ github.event.inputs.package }}');
      expect(notes?.env?.IS_PRERELEASE).toBe('${{ needs.build.outputs.is_prerelease }}');
      expect(stable?.with?.body_path).toBe('/tmp/release-notes.md');
      expect(prerelease?.with?.body_path).toBe(stable?.with?.body_path);
      const directory = mkdtempSync(resolve(tmpdir(), 'relay-release-notes-'));
      try {
        for (const isPrerelease of [false, true]) {
          // Redirect only the output file, isolating each execution from other release tests.
          const script = notes!.run!.replace('/tmp/release-notes.md', 'release-notes.md');
          execFileSync('bash', ['-c', script], {
            cwd: directory,
            env: {
              ...process.env,
              VERSION: '16.0.1',
              PACKAGE_MODE: mode,
              IS_PRERELEASE: String(isPrerelease),
              NPM_TAG: isPrerelease ? 'next' : 'latest',
            },
            stdio: 'pipe',
          });
          const text = readFileSync(resolve(directory, 'release-notes.md'), 'utf8');
          expect(text.includes('Standalone CLI binaries')).toBe(hasStandalone);
          expect(text.includes('install.sh')).toBe(hasStandalone && !isPrerelease);
          expect(text.includes('npm install -g agent-relay@')).toBe(mode !== 'sdk');
          expect(text).toContain('npm install @agent-relay/sdk@16.0.1');
          expect(text).toContain('agent-relay-node-16.0.1-windows-x64.exe');
          expect(text).toContain('.sha256');
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it('uploads versioned assets to stable and prerelease tags before npm publication, without writing a release on dry runs', () => {
    const release = loadPublishWorkflow().jobs['create-release'];
    const uploads =
      release.steps?.filter((step) => step.uses?.startsWith('softprops/action-gh-release@')) ?? [];
    expect(uploads).toHaveLength(2);
    const remoteCheck = release.steps?.find((step) => step.name === 'Verify published node assets');
    expect(remoteCheck?.if).toBe("github.event.inputs.dry_run != 'true'");
    expect(remoteCheck?.run).toContain('gh release download "v${VERSION}"');
    expect(remoteCheck?.run).toContain('sha256sum -c "${asset}.sha256"');
    expect(release.steps?.indexOf(remoteCheck!)).toBeGreaterThan(
      Math.max(...uploads.map((step) => release.steps!.indexOf(step)))
    );
    for (const prerelease of [false, true]) {
      for (const dryRun of ['true', 'false']) {
        const active = uploads.filter((step) => condition(step.if, { dry_run: dryRun }, {}, prerelease));
        expect(active).toHaveLength(dryRun === 'true' ? 0 : 1);
        for (const step of active) {
          expect(step.with?.tag_name).toBe('v${{ needs.build.outputs.new_version }}');
          expect(step.with?.files).toContain('release-binaries/*');
          expect(step.with?.fail_on_unmatched_files).toBe(true);
          expect(step.with?.overwrite_files).toBe(false);
          expect(Boolean(step.with?.prerelease)).toBe(prerelease);
        }
      }
    }
  });
});

describe('release finalization', () => {
  it.each(['all', 'main', 'sdk', 'cli-prerelease'])(
    'finalizes %s only after npm verification and outside dry runs',
    (mode) => {
      const job = loadPublishWorkflow().jobs['finalize-release'];
      expect(job).toBeDefined();
      const results: Record<string, string> = mode === 'main' ? { 'verify-publish-sdk': 'skipped' } : {};
      for (const prerelease of [false, true]) {
        for (const dryRun of ['false', 'true']) {
          const inputs = { package: mode, dry_run: dryRun, hotfix: 'false' };
          const expected = dryRun === 'false' && (mode === 'all' || mode === 'main');
          expect(jobRuns(job, inputs, results, prerelease)).toBe(expected);
          if (!expected) continue;
          const required = [
            'build',
            'create-release',
            'publish-sdk-internal-deps',
            'publish-broker-packages',
            'publish-main',
            'verify-publish',
            ...(mode === 'all'
              ? ['publish-packages', 'publish-harnesses', 'publish-fleet', 'verify-publish-sdk']
              : ['publish-main-runtime-deps', 'publish-main-harnesses', 'publish-main-fleet']),
          ];
          for (const dependency of required) {
            expect(needsOf(job)).toContain(dependency);
            for (const status of ['failure', 'cancelled', 'skipped']) {
              expect(
                jobRuns(job, inputs, { ...results, [dependency]: status }, prerelease),
                `${mode}: ${dependency} ${status}`
              ).toBe(false);
            }
          }
        }
      }
      const promote = job.steps?.find((step) => step.name === 'Promote verified stable release to latest');
      expect(promote?.run).toContain('gh release edit "v${VERSION}"');
      expect(promote?.run).toContain('--latest');
      expect(condition(promote?.if, {}, {}, false)).toBe(true);
      expect(condition(promote?.if, {}, {}, true)).toBe(false);
    }
  );

  it('permits intentionally skipped SDK verification only for main or explicit all hotfix', () => {
    const job = loadPublishWorkflow().jobs['finalize-release'];
    const skipped = { 'verify-publish-sdk': 'skipped' };
    expect(jobRuns(job, { package: 'all', dry_run: 'false', hotfix: 'false' }, skipped)).toBe(false);
    expect(jobRuns(job, { package: 'all', dry_run: 'false', hotfix: 'true' }, skipped)).toBe(true);
    for (const status of ['failure', 'cancelled']) {
      expect(
        jobRuns(job, { package: 'all', dry_run: 'false', hotfix: 'true' }, { 'verify-publish-sdk': status })
      ).toBe(false);
    }
  });

  it('preserves an existing release latest status and uploads only missing assets on retries', () => {
    const release = loadPublishWorkflow().jobs['create-release'];
    const retry = release.steps?.find(
      (step) => step.name === 'Upload only missing assets on release retries'
    );
    const withExistingRelease = (expression: string | undefined) =>
      expression?.replace('steps.release_tag.outputs.release_exists', "'true'");
    for (const step of release.steps?.filter((step) =>
      step.uses?.startsWith('softprops/action-gh-release@')
    ) ?? []) {
      expect(condition(withExistingRelease(step.if), { dry_run: 'false' }, {}, false)).toBe(false);
      expect(condition(withExistingRelease(step.if), { dry_run: 'false' }, {}, true)).toBe(false);
    }
    expect(condition(withExistingRelease(retry?.if), { dry_run: 'false' }, {})).toBe(true);
    expect(condition(withExistingRelease(retry?.if), { dry_run: 'true' }, {})).toBe(false);
    const directory = mkdtempSync(resolve(tmpdir(), 'relay-retry-assets-'));
    try {
      mkdirSync(resolve(directory, 'release-binaries'));
      writeFileSync(
        resolve(directory, 'release-binaries', 'existing'),
        'rebuilt bytes must not replace original'
      );
      writeFileSync(resolve(directory, 'release-binaries', 'missing'), 'new asset');
      const mock = `gh() {
        if [ "$1 $2" = "release view" ]; then printf 'existing\\n';
        elif [ "$1 $2" = "release upload" ]; then printf '%s\\n' "$*" >> calls;
        else return 99; fi
      }
`;
      execFileSync(
        'bash',
        ['-c', mock + retry!.run!.replaceAll('/tmp/existing-release-assets', 'existing-release-assets')],
        {
          cwd: directory,
          env: { ...process.env, VERSION: '2.0.0', GITHUB_REPOSITORY: 'test/relay' },
          stdio: 'pipe',
        }
      );
      const calls = readFileSync(resolve(directory, 'calls'), 'utf8').trim().split('\n');
      expect(calls).toEqual(['release upload v2.0.0 release-binaries/missing --repo test/relay']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['git push origin "HEAD:refs/heads/main"', true],
    ["git push origin 'HEAD:staging'", true],
    ['git push --atomic origin "HEAD:refs/heads/${BRANCH}"', true],
    ['git push origin "refs/heads/main:refs/heads/main"', true],
    ['git push origin "$DESTINATION"', true],
    ['git push origin --all', true],
    ['git push origin --tags "v${NEW_VERSION}"', true],
    ['git push origin --follow-tags "v${NEW_VERSION}"', true],
    ['git -C . push origin HEAD:main', true],
    ['git -c push.default=current push origin', true],
    ['git -c user.name="Release Bot" push origin HEAD:main', true],
    ["git -C work' tree' -c user.name=\"Release\"' Bot' push origin HEAD:main", true],
    ['git -c user.name="Release Bot" push origin "refs/tags/v${VERSION}"', false],
    ['git -C "release worktree" -c "push.default=current" push origin "HEAD:refs/heads/main"', true],
    ["git -c 'push.default=current' -C 'release worktree' push origin 'HEAD:staging'", true],
    ['git -C "release worktree" push origin "v${NEW_VERSION}"', false],
    ['git -c "user.name=Release bot" push origin "refs/tags/v${VERSION}"', false],
    ['git push origin', true],
    ['git push origin "v${NEW_VERSION}"', false],
    ['git push origin "refs/tags/v${VERSION}"', false],
  ])('detects non-tag pushes in %s', (script, expected) => {
    expect(hasNonTagPush(script)).toBe(expected);
  });

  it('keeps branch updates and latest promotion out of the pre-npm asset job', () => {
    const release = loadPublishWorkflow().jobs['create-release'];
    const commands = release.steps?.map((step) => step.run ?? '').join('\n') ?? '';
    expect(hasNonTagPush(commands)).toBe(false);
    expect(commands).not.toContain('git pull --rebase');
    expect(commands).not.toContain('--latest');
    for (const step of release.steps?.filter((step) =>
      step.uses?.startsWith('softprops/action-gh-release@')
    ) ?? []) {
      expect(step.with?.make_latest).toBe(false);
    }
  });

  it.each(['main', 'staging', 'new-staging', 'older-staging', 'newer-release'])(
    'safely retries finalization onto %s while preserving newer source and generated commits',
    (scenario) => {
      const job = loadPublishWorkflow().jobs['finalize-release'];
      const advance = job.steps?.find(
        (step) => step.name === 'Advance release branch without rewriting history'
      );
      expect(advance?.run).toBeTruthy();
      const directory = mkdtempSync(resolve(tmpdir(), 'relay-finalize-'));
      try {
        const origin = resolve(directory, 'origin.git');
        const seed = resolve(directory, 'seed');
        const checkout = resolve(directory, 'checkout');
        const git = (cwd: string, ...args: string[]) =>
          execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
        git(directory, 'init', '--bare', origin);
        git(directory, 'init', '-b', 'main', seed);
        git(seed, 'config', 'user.name', 'Release test');
        git(seed, 'config', 'user.email', 'release@example.test');
        git(seed, 'remote', 'add', 'origin', origin);
        writeFileSync(resolve(seed, 'package.json'), '{"version":"1.0.0"}\n');
        git(seed, 'add', '.');
        git(seed, 'commit', '-m', 'source');
        const base = git(seed, 'rev-parse', 'HEAD');
        writeFileSync(resolve(seed, 'source-runtime.txt'), 'runtime source included in release build\n');
        git(seed, 'add', '.');
        git(seed, 'commit', '-m', 'runtime source');
        const source = git(seed, 'rev-parse', 'HEAD');
        writeFileSync(resolve(seed, 'package.json'), '{"version":"2.0.0"}\n');
        git(seed, 'commit', '-am', 'version');
        writeFileSync(resolve(seed, 'trajectory.txt'), 'generated trajectory summary\n');
        git(seed, 'add', '.');
        git(seed, 'commit', '-m', 'compact trajectory');
        git(seed, 'tag', '-a', 'v2.0.0', '-m', 'Release', '-m', `Source: ${source}`, '-m', 'Mode: all');
        const tagged = git(seed, 'rev-parse', 'v2.0.0^{}');
        git(seed, 'checkout', 'main');
        git(seed, 'reset', '--hard', source);
        writeFileSync(resolve(seed, 'newer.txt'), 'new source landed while publishing\n');
        git(seed, 'add', '.');
        git(seed, 'commit', '-m', 'new source');
        const newer = git(seed, 'rev-parse', 'HEAD');
        git(seed, 'push', 'origin', 'main', '--tags');
        if (scenario === 'staging') git(seed, 'push', 'origin', 'main:staging');
        if (scenario === 'older-staging') git(seed, 'push', 'origin', `${base}:refs/heads/staging`);
        git(directory, 'clone', '--branch', 'main', origin, checkout);
        const branch = scenario === 'main' || scenario === 'newer-release' ? 'main' : 'staging';
        const env = {
          ...process.env,
          VERSION: '2.0.0',
          PACKAGE_MODE: 'all',
          IS_PRERELEASE: String(branch === 'staging'),
          GITHUB_SHA: source,
        };
        const run = () => execFileSync('bash', ['-c', advance!.run!], { cwd: checkout, env, stdio: 'pipe' });
        expect(run).not.toThrow();
        const firstTip = git(directory, '--git-dir', origin, 'rev-parse', branch);
        // Another source commit lands after finalization but before a job retry.
        git(seed, 'fetch', 'origin');
        git(seed, 'checkout', '-B', 'retry-source', `origin/${branch}`);
        writeFileSync(resolve(seed, 'after-finalization.txt'), 'source landed after finalization\n');
        if (scenario === 'newer-release')
          writeFileSync(resolve(seed, 'package.json'), '{"version":"3.0.0"}\n');
        git(seed, 'add', '.');
        git(seed, 'commit', '-m', 'source after finalization');
        git(seed, 'push', 'origin', `HEAD:refs/heads/${branch}`);
        const advanced = git(seed, 'rev-parse', 'HEAD');
        if (scenario === 'newer-release') expect(run).toThrow();
        else expect(run).not.toThrow();
        expect(git(directory, '--git-dir', origin, 'rev-parse', branch)).toBe(advanced);
        if (scenario === 'newer-release') return;
        git(checkout, 'merge-base', '--is-ancestor', firstTip, 'HEAD');
        expect(readFileSync(resolve(checkout, 'after-finalization.txt'), 'utf8')).toContain('source landed');
        expect(git(checkout, 'rev-parse', 'v2.0.0^{}')).toBe(tagged);
        expect(JSON.parse(readFileSync(resolve(checkout, 'package.json'), 'utf8')).version).toBe('2.0.0');
        expect(readFileSync(resolve(checkout, 'trajectory.txt'), 'utf8')).toContain('generated trajectory');
        expect(readFileSync(resolve(checkout, 'source-runtime.txt'), 'utf8')).toContain('runtime source');
        if (scenario === 'main' || scenario === 'staging') {
          expect(readFileSync(resolve(checkout, 'newer.txt'), 'utf8')).toContain('new source');
          git(checkout, 'merge-base', '--is-ancestor', newer, 'HEAD');
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
