/**
 * Harden the npm publish path after the registry rejected agent-relay with:
 *
 *   E415 Unsupported Media Type - Hard link is not allowed
 *
 * Root cause: the root package publishes `packages/` wholesale. During the
 * publish job, workspace installs can leave nested package node_modules trees
 * under packages/*; esbuild can materialize its bin shim as a hard link, which
 * npm's registry rejects after provenance is already signed.
 *
 * Long-term target:
 *   1. Publish a validated .tgz, not the live working directory.
 *   2. Keep nested workspace node_modules out of the root package.
 *   3. Add a tarball validator that fails on hard links and unexpected files.
 *   4. Run the same validator in PR package validation and release publish.
 *
 * Run from relay repo root:
 *   agent-relay run workflows/ci/harden-npm-publish.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const BRANCH = 'fix/npm-publish-hardening';
const WORKTREE = '.worktrees/npm-publish-hardening';

async function main() {
  const wf = workflow('harden-npm-publish')
    .description('Make npm publish use a clean, validated tarball artifact')
    .pattern('dag')
    .channel('wf-npm-publish-hardening')
    .maxConcurrency(4)
    .timeout(1_800_000)
    .agent('architect', {
      cli: 'claude',
      preset: 'lead',
      role: 'Design the npm packaging hardening plan',
      retries: 2,
    })
    .agent('package-worker', {
      cli: 'codex',
      preset: 'worker',
      role: 'Implement package manifest and tarball validation changes',
      retries: 2,
    })
    .agent('workflow-worker', {
      cli: 'codex',
      preset: 'worker',
      role: 'Harden GitHub Actions publish and validation jobs',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Review release hardening for correctness and low regression risk',
      retries: 2,
    });

  wf.step('setup-worktree', {
    type: 'deterministic',
    command: `
set -eu
repo_root="$(git rev-parse --show-toplevel)"
target="$repo_root/${WORKTREE}"

if git worktree list --porcelain | grep -Fxq "worktree $target"; then
  echo "Worktree already ready at ${WORKTREE}"
elif [ -e "${WORKTREE}" ]; then
  echo "Path exists but is not a registered git worktree: ${WORKTREE}" >&2
  exit 1
elif git show-ref --verify --quiet refs/heads/${BRANCH}; then
  git worktree add "${WORKTREE}" "${BRANCH}"
else
  git worktree add "${WORKTREE}" -b "${BRANCH}" HEAD
fi

git -C "${WORKTREE}" status --short
`.trim(),
    failOnError: true,
  });

  wf.step('install-worktree-deps', {
    type: 'deterministic',
    cwd: WORKTREE,
    dependsOn: ['setup-worktree'],
    command: 'npm ci --ignore-scripts',
    failOnError: true,
  });

  wf.step('read-package-context', {
    type: 'deterministic',
    cwd: WORKTREE,
    dependsOn: ['setup-worktree'],
    command: [
      `echo "=== root package files and bundled deps ==="`,
      `sed -n '1,120p' package.json`,
      `sed -n '245,270p' package.json`,
      `echo "=== root npmignore ==="`,
      `sed -n '1,120p' .npmignore`,
      `echo "=== bundled workspace package file allowlists ==="`,
      `node -e "const fs=require('fs'); const names=new Set((require('./package.json').bundledDependencies||require('./package.json').bundleDependencies||[])); for (const d of fs.readdirSync('packages')) { const f='packages/'+d+'/package.json'; if (!fs.existsSync(f)) continue; const p=require('./'+f); if (names.has(p.name)) console.log(f, JSON.stringify(p.files||[])); }"`,
      `echo "=== postinstall workspace linking ==="`,
      `sed -n '559,690p' scripts/postinstall.js`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('read-ci-context', {
    type: 'deterministic',
    cwd: WORKTREE,
    dependsOn: ['setup-worktree'],
    command: [
      `echo "=== publish-main job ==="`,
      `sed -n '873,931p' .github/workflows/publish.yml`,
      `echo "=== build artifact upload ==="`,
      `sed -n '405,437p' .github/workflows/publish.yml`,
      `echo "=== package validation workflow ==="`,
      `sed -n '1,135p' .github/workflows/package-validation.yml`,
      `echo "=== existing bundled-deps audit ==="`,
      `sed -n '1,160p' scripts/audit-bundled-deps.mjs`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('plan', {
    agent: 'architect',
    dependsOn: ['read-package-context', 'read-ci-context'],
    task: `
Design the durable fix for npm publish hardening.

Known failure: npm registry rejected the package because the tarball contained
a hard-link entry under packages/openclaw/node_modules/esbuild/bin/esbuild.

Package context:
{{steps.read-package-context.output}}

CI context:
{{steps.read-ci-context.output}}

Produce an implementation checklist for:
1. A reusable tarball validator script.
2. Package manifest or npmignore changes that exclude nested workspace node_modules.
3. publish.yml changes that pack once, validate, then publish that exact .tgz.
4. package-validation.yml changes that run the same gate on PRs.
5. Smoke checks that prove agent-relay still imports and the CLI entry exists.

Do not write code. End with PLAN_COMPLETE.
`.trim(),
    verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
  });

  wf.step('implement-tarball-validator', {
    agent: 'package-worker',
    cwd: WORKTREE,
    dependsOn: ['plan'],
    task: `
Implement the tarball validation utility from this plan:
{{steps.plan.output}}

Create or update scripts/validate-npm-tarball.mjs and update package.json scripts.

Requirements:
1. Use Node.js and the existing tar package; do not add dependencies.
2. Accept one or more .tgz paths. If no path is provided, create a temporary
   package with npm pack --ignore-scripts --json and validate it.
3. Fail if any tar entry type is a hard link.
4. Fail if any path matches package/packages/*/node_modules/*.
5. Fail if non-bundled workspace packages appear under package/packages/.
6. Print a concise summary of entry count, package size, and violations.

Only touch scripts/validate-npm-tarball.mjs and package.json.
`.trim(),
    verification: { type: 'exit_code', value: '0' },
  });

  wf.step('verify-validator-was-added', {
    type: 'deterministic',
    cwd: WORKTREE,
    dependsOn: ['implement-tarball-validator'],
    command: [
      `test -f scripts/validate-npm-tarball.mjs`,
      `node --check scripts/validate-npm-tarball.mjs`,
      `node -e "const s=require('./package.json').scripts||{}; if (!s['pack:validate']) { console.error('missing pack:validate script'); process.exit(1); } console.log(s['pack:validate']);"`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('harden-package-surface', {
    agent: 'package-worker',
    cwd: WORKTREE,
    dependsOn: ['verify-validator-was-added'],
    task: `
Harden package inclusion using this plan:
{{steps.plan.output}}

Current validation output:
{{steps.verify-validator-was-added.output}}

Update package.json and/or .npmignore so the root package cannot include:
1. packages/*/node_modules/**
2. packages/openclaw/** unless there is a deliberate runtime requirement
3. workspace test files, .turbo logs, and transient build caches

Prefer replacing the broad "packages" files entry with explicit runtime
entries for the bundled @agent-relay packages. Preserve files needed by root
exports, postinstall workspace linking, SDK binaries, README, and licenses.

Only touch package.json and .npmignore.
`.trim(),
    verification: { type: 'exit_code', value: '0' },
  });

  wf.step('verify-package-surface', {
    type: 'deterministic',
    cwd: WORKTREE,
    dependsOn: ['harden-package-surface', 'install-worktree-deps'],
    command: [
      `node --check scripts/validate-npm-tarball.mjs`,
      `node -e "const fs=require('fs'); const p=require('./package.json'); const files=p.files||[]; const npmignore=fs.existsSync('.npmignore')?fs.readFileSync('.npmignore','utf8'):''; const hasBroadPackages=files.includes('packages'); const ignoresNested=/packages\\/\\*\\/node_modules|packages\\/\\*\\*\\/node_modules|\\*\\*\\/node_modules/.test(npmignore); if (hasBroadPackages && !ignoresNested) { console.error('package.json still includes broad packages without an explicit nested node_modules exclusion'); process.exit(1); } console.log('package surface guard ok');"`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('harden-publish-workflow', {
    agent: 'workflow-worker',
    cwd: WORKTREE,
    dependsOn: ['plan'],
    task: `
Harden .github/workflows/publish.yml using this plan:
{{steps.plan.output}}

Required publish-main behavior:
1. Install dependencies for bundling without dev workspace node_modules.
2. Remove nested packages/*/node_modules and transient package caches before pack.
3. Run npm pack --ignore-scripts once into a temporary directory.
4. Run node scripts/validate-npm-tarball.mjs against that exact tarball.
5. Publish that exact .tgz with npm publish <tarball> --provenance.
6. Dry-run mode must dry-run the same validated .tgz.

Keep provenance and tag behavior unchanged. Only touch .github/workflows/publish.yml.
`.trim(),
    verification: { type: 'exit_code', value: '0' },
  });

  wf.step('verify-publish-workflow', {
    type: 'deterministic',
    cwd: WORKTREE,
    dependsOn: ['harden-publish-workflow'],
    command: [
      `if git diff --quiet .github/workflows/publish.yml; then echo "publish workflow was not changed"; exit 1; fi`,
      `grep -q "validate-npm-tarball" .github/workflows/publish.yml`,
      `grep -q "npm publish .*\\.tgz\\|npm publish.*NPM_TARBALL" .github/workflows/publish.yml`,
    ].join(' && '),
    failOnError: true,
  });

  wf.step('harden-pr-validation', {
    agent: 'workflow-worker',
    cwd: WORKTREE,
    dependsOn: ['verify-package-surface'],
    task: `
Update .github/workflows/package-validation.yml for the same artifact gate.

Inputs:
{{steps.plan.output}}
{{steps.verify-package-surface.output}}

Add a validation step after build and bundled dependency audit that runs:
  npm run pack:validate

The PR gate must fail before merge if the root npm tarball contains hard links,
nested workspace node_modules, or non-bundled workspace packages.

Only touch .github/workflows/package-validation.yml.
`.trim(),
    verification: { type: 'exit_code', value: '0' },
  });

  wf.step('verify-pr-validation', {
    type: 'deterministic',
    cwd: WORKTREE,
    dependsOn: ['harden-pr-validation'],
    command: [
      `if git diff --quiet .github/workflows/package-validation.yml; then echo "package validation workflow was not changed"; exit 1; fi`,
      `grep -q "pack:validate" .github/workflows/package-validation.yml`,
    ].join(' && '),
    failOnError: true,
  });

  wf.step('build-for-pack-validation', {
    type: 'deterministic',
    cwd: WORKTREE,
    dependsOn: ['verify-publish-workflow', 'verify-pr-validation', 'install-worktree-deps'],
    command: 'npm run build',
    failOnError: true,
  });

  wf.step('full-verification', {
    type: 'deterministic',
    cwd: WORKTREE,
    dependsOn: ['build-for-pack-validation'],
    command: [
      `npm run pack:validate`,
      `node -e "import('./dist/src/index.js').then(() => console.log('root import ok'))"`,
      `test -f dist/src/cli/index.js`,
      `git diff --stat`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  wf.step('review', {
    agent: 'reviewer',
    cwd: WORKTREE,
    dependsOn: ['full-verification'],
    task: `
Review the npm publish hardening changes.

Verification output:
{{steps.full-verification.output}}

Check:
1. The package tarball validator catches hard links and nested workspace node_modules.
2. Root package contents still include files required by exports and postinstall.
3. publish.yml publishes the exact validated .tgz, not the mutable directory.
4. package-validation.yml runs the same gate on PRs.
5. No unrelated workflow or package metadata churn was introduced.

Fix small issues if needed, then run npm run pack:validate.
`.trim(),
    verification: { type: 'exit_code', value: '0' },
  });

  wf.step('final-check', {
    type: 'deterministic',
    cwd: WORKTREE,
    dependsOn: ['review'],
    command: [`npm run pack:validate`, `git diff --check`, `git status --short`].join(' && '),
    captureOutput: true,
    failOnError: true,
  });

  const result = await wf.run();
  console.log(`Done: ${result.status} (${result.id})`);
}

main().catch(console.error);
