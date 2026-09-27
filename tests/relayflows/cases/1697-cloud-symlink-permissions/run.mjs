#!/usr/bin/env node

/** Exercise the exact target checkout's compiler with symlinked files and directories. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = '1697-cloud-symlink-permissions';
const targetDir = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harnessDir = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = path.resolve(required('RELAY_PR_PROOF_RESULT_PATH'));
const arm = required('RELAY_PR_PROOF_ARM');
if (arm !== 'base' && arm !== 'head') throw new Error(`Invalid arm ${arm}`);
const expectedSha = required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');
const actualSha = execFileSync('git', ['-C', targetDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actualSha !== expectedSha) throw new Error(`Target SHA mismatch: ${actualSha}`);
const runner = fileURLToPath(import.meta.url);
if (!runner.startsWith(`${harnessDir}${path.sep}`))
  throw new Error('Runner is not in the exact-head harness');

const scratch = await mkdtemp(path.join(os.tmpdir(), 'relayflow-1697-'));
try {
  // Install the exact target checkout's locked workspace dependencies.
  // The target's compiler source is imported directly, never replaced by head code.
  if (process.env.RELAY_PR_PROOF_DEV_SKIP_INSTALL !== '1') {
    const install = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: targetDir,
      encoding: 'utf8',
      timeout: 240_000,
    });
    if (install.status !== 0) throw new Error(`Target dependency install failed: ${install.stderr}`);
  }
  const project = path.join(scratch, 'project');
  const outside = path.join(scratch, 'outside');
  await mkdir(path.join(project, 'docs'), { recursive: true });
  await mkdir(path.join(project, 'private'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(project, 'private', 'key.txt'), 'internal secret');
  await writeFile(path.join(outside, 'key.txt'), 'external secret');
  await symlink(path.join(outside, 'key.txt'), path.join(project, 'docs', 'outside.md'));
  await symlink(path.join(project, 'private', 'key.txt'), path.join(project, 'docs', 'inside.md'));
  await symlink(path.join(outside, 'missing'), path.join(project, 'docs', 'dangling.md'));
  await symlink(outside, path.join(project, 'docs', 'external-dir'), 'dir');
  const input = {
    agentName: 'proof-agent',
    workspace: 'proof',
    projectDir: project,
    permissions: { access: 'restricted', inherit: false, files: { read: ['docs/**'], deny: ['private/**'] } },
  };
  const probe = `import { compileAgentScopes } from ${JSON.stringify(path.join(targetDir, 'packages/cloud/src/compiler.ts'))};
const result = compileAgentScopes(${JSON.stringify(input)});
console.log(JSON.stringify({ readonly: result.readonlyPaths, write: result.readwritePaths, denied: result.deniedPaths, acl: result.acl, scopes: result.scopes }));`;
  const processResult = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', probe],
    {
      cwd: targetDir,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }
  );
  if (processResult.status !== 0) throw new Error(`Compiler probe failed: ${processResult.stderr}`);
  const observation = JSON.parse(processResult.stdout.trim());
  const paths = [...observation.readonly, ...observation.write, ...observation.denied];
  if (paths.length !== 5 || new Set(paths).size !== 5)
    throw new Error(`Partition invalid: ${JSON.stringify(observation)}`);
  const baseObserved =
    observation.readonly.includes('docs/outside.md') &&
    observation.readonly.includes('docs/inside.md') &&
    observation.readonly.includes('docs/dangling.md') &&
    observation.readonly.includes('docs/external-dir');
  const headObserved =
    observation.readonly.length === 0 &&
    observation.write.length === 0 &&
    ['docs/outside.md', 'docs/inside.md', 'docs/dangling.md', 'docs/external-dir'].every((item) =>
      observation.denied.includes(item)
    ) &&
    observation.acl['/docs']?.includes('deny:agent:proof-agent') &&
    !observation.scopes.some((scope) => scope.includes('/docs/'));
  const outcome = baseObserved ? 'bug' : headObserved ? 'fixed' : undefined;
  if (!outcome) throw new Error(`Unexpected compiler observation: ${JSON.stringify(observation)}`);
  const signature =
    outcome === 'bug' ? 'symlink_target_granted_by_link_path' : 'symlink_target_rules_and_denies';
  const details =
    outcome === 'bug'
      ? 'The base compiler grants external, dangling, and in-tree-to-denied links by their docs path.'
      : 'The head compiler denies external, dangling, and in-tree-to-denied links and retains deny-only ACL accounting.';
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    JSON.stringify({ version: 1, caseId, arm, outcome, signature, details }, null, 2) + '\n'
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
