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
  strategy?: { matrix?: { package?: string[]; include?: Array<{ suffix: string; target: string; ext: string }> } };
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
  return typeof job.needs === 'string' ? [job.needs] : job.needs ?? [];
}

// Evaluate the workflow's boolean conditions with simulated Actions results.
// Actions permits hyphenated property names; JavaScript needs bracket notation.
function expressionValue(expression: string | undefined, inputs: Record<string, string>, results: Record<string, string>, prerelease = false): unknown {
  const javascript = (expression ?? 'true')
    .replace(/\$\{\{|\}\}/g, '')
    .replace(/needs\.([\w-]+)\.result/g, (_, name) => JSON.stringify(results[name] ?? 'success'))
    .replace(/needs\.build\.outputs\.is_prerelease/g, JSON.stringify(String(prerelease)))
    .replace(/github\.event\.inputs\.([\w-]+)/g, (_, name) => JSON.stringify(inputs[name] ?? ''))
    .replace(/always\(\)/g, 'true');
  return Function(`return (${javascript});`)();
}

function condition(expression: string | undefined, inputs: Record<string, string>, results: Record<string, string>, prerelease = false): boolean {
  return Boolean(expressionValue(expression, inputs, results, prerelease));
}

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
    const publishers = Object.entries(jobs).filter(([, job]) => job.steps?.some((step) => step.run?.includes('npm publish')));
    expect(publishers.length).toBeGreaterThan(0);
    for (const [name, job] of publishers) {
      expect(needsOf(job), name).toContain('create-release');
      for (const result of ['failure', 'cancelled', 'skipped']) {
        // Jobs without an explicit status function inherit success() in Actions.
        if (job.if?.includes('always()')) {
          for (const mode of ['all', 'main', 'sdk', 'cli-prerelease']) {
            expect(condition(job.if, { package: mode, dry_run: 'false' }, { 'create-release': result }), `${name}, ${mode}, ${result}`).toBe(false);
          }
        }
      }
    }
  });

  it.each(['all', 'main', 'sdk', 'cli-prerelease'])('checks node assets in %s mode including dry runs', (mode) => {
    const release = loadPublishWorkflow().jobs['create-release'];
    expect(needsOf(release)).toContain('build-node');
    const results = { 'build-standalone': mode === 'sdk' || mode === 'cli-prerelease' ? 'skipped' : 'success', 'verify-binaries': mode === 'sdk' || mode === 'cli-prerelease' ? 'skipped' : 'success' };
    for (const dryRun of ['true', 'false']) {
      expect(condition(release.if, { package: mode, dry_run: dryRun }, results)).toBe(true);
      if (mode === 'all' || mode === 'main') {
        expect(condition(release.if, { package: mode, dry_run: dryRun }, { ...results, 'verify-binaries': 'skipped' })).toBe(false);
        expect(condition(release.if, { package: mode, dry_run: dryRun }, { ...results, 'build-standalone': 'skipped' })).toBe(false);
      }
      for (const failed of ['failure', 'cancelled', 'skipped']) {
        expect(condition(release.if, { package: mode, dry_run: dryRun }, { ...results, 'build-node': failed })).toBe(false);
      }
    }
    const verify = release.steps?.find((step) => step.name === 'Verify node assets and checksums');
    expect(verify?.if).toBeUndefined();
    expect(verify?.run).toContain('linux-x64 linux-arm64 darwin-arm64 darwin-x64 windows-x64.exe');
    expect(verify?.run).toContain('test -f "$asset"');
    expect(verify?.run).toContain('test -f "${asset}.sha256"');
    expect(verify?.run).toContain('sha256sum -c "${asset}.sha256"');
  });

  it.each(['complete', 'missing-binary', 'missing-sidecar', 'corrupted'])('executes the asset checksum gate with %s artifacts', (scenario) => {
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
      const run = () => execFileSync('bash', ['-c', verify!.run!], {
        cwd: directory, env: { ...process.env, VERSION: version }, stdio: 'pipe',
      });
      if (scenario === 'complete') expect(run).not.toThrow();
      else expect(run).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['absent', 'matching', 'different-source', 'different-mode', 'missing-mode'])('validates %s release tags against both source and package mode', (scenario) => {
    const release = loadPublishWorkflow().jobs['create-release'];
    const check = release.steps?.find((step) => step.name === 'Check existing release tag');
    const tag = release.steps?.find((step) => step.name === 'Commit and tag');
    expect(check?.env?.PACKAGE_MODE).toBe('${{ github.event.inputs.package }}');
    expect(tag?.env?.PACKAGE_MODE).toBe('${{ github.event.inputs.package }}');
    expect(tag?.run).toContain('-m "Mode: ${PACKAGE_MODE}"');
    const directory = mkdtempSync(resolve(tmpdir(), 'relay-release-tag-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' }).toString().trim();
      git('init');
      git('-c', 'user.name=Release test', '-c', 'user.email=release@example.test', 'commit', '--allow-empty', '-m', 'source');
      const source = git('rev-parse', 'HEAD');
      if (scenario !== 'absent') {
        const messages = ['-m', 'Release v16.0.1', '-m', `Source: ${scenario === 'different-source' ? 'wrong-source' : source}`];
        if (scenario !== 'missing-mode') messages.push('-m', `Mode: ${scenario === 'different-mode' ? 'sdk' : 'all'}`);
        git('-c', 'user.name=Release test', '-c', 'user.email=release@example.test', 'tag', '-a', 'v16.0.1', ...messages);
      }
      const output = resolve(directory, 'output');
      writeFileSync(output, '');
      const run = () => execFileSync('bash', ['-c', check!.run!], {
        cwd: directory,
        env: { ...process.env, VERSION: '16.0.1', PACKAGE_MODE: 'all', GITHUB_SHA: source, GITHUB_OUTPUT: output },
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
  });

  it.each(['all', 'main', 'sdk', 'cli-prerelease'])('keeps %s release discovery and install instructions consistent with its assets', (mode) => {
    const release = loadPublishWorkflow().jobs['create-release'];
    const stable = release.steps?.find((step) => step.name === 'Create GitHub Release (stable)');
    const prerelease = release.steps?.find((step) => step.name === 'Create GitHub Release (prerelease)');
    const hasStandalone = mode === 'all' || mode === 'main';
    expect(expressionValue(String(stable?.with?.make_latest), { package: mode }, {})).toBe(String(hasStandalone));
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
          env: { ...process.env, VERSION: '16.0.1', PACKAGE_MODE: mode, IS_PRERELEASE: String(isPrerelease), NPM_TAG: isPrerelease ? 'next' : 'latest' },
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
  });

  it('uploads versioned assets to stable and prerelease tags before npm publication, without writing a release on dry runs', () => {
    const release = loadPublishWorkflow().jobs['create-release'];
    const uploads = release.steps?.filter((step) => step.uses?.startsWith('softprops/action-gh-release@')) ?? [];
    expect(uploads).toHaveLength(2);
    const remoteCheck = release.steps?.find((step) => step.name === 'Verify published node assets');
    expect(remoteCheck?.if).toBe("github.event.inputs.dry_run != 'true'");
    expect(remoteCheck?.run).toContain('gh release download "v${VERSION}"');
    expect(remoteCheck?.run).toContain('sha256sum -c "${asset}.sha256"');
    expect(release.steps?.indexOf(remoteCheck!)).toBeGreaterThan(Math.max(...uploads.map((step) => release.steps!.indexOf(step))));
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
