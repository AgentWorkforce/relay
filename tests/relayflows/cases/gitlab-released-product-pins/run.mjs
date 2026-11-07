import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const caseId = 'gitlab-released-product-pins';
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const target = realpathSync(path.resolve(required('RELAY_PR_PROOF_TARGET_DIR')));
const harness = realpathSync(path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR')));
const arm = required('RELAY_PR_PROOF_ARM');
if (!['base', 'head'].includes(arm)) throw new Error('Invalid proof arm');
const expectedHead = required('RELAY_PR_PROOF_HEAD_SHA');
const expectedTarget = arm === 'base' ? required('RELAY_PR_PROOF_BASE_SHA') : expectedHead;
const sha = (dir) => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (sha(target) !== expectedTarget || sha(harness) !== expectedHead) {
  throw new Error('Proof checkout does not match its exact source SHA');
}
if (!fileURLToPath(import.meta.url).startsWith(harness + path.sep)) {
  throw new Error('Runner is not inside the head harness checkout');
}

const privateHome = mkdtempSync(path.join(os.tmpdir(), 'relay-gitlab-pins-'));
const env = {
  PATH: required('PATH'),
  HOME: privateHome,
  TMPDIR: privateHome,
  LANG: 'C.UTF-8',
  AGENT_RELAY_TELEMETRY_DISABLED: '1',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
};
function run(command, args, cwd = target, input) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.error ?? result.status}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

// Drive the mounted production flows command with a deliberately closed transport.
// The preload replaces only fetch: loading, auth resolution, preflight, refusal
// parsing and rendering all run in the actual published SDK. Dependencies come
// from npm; provider API requests stay inside the closed transport.
function flowsRefusals(cli) {
  const sdk = path.dirname(
    fileURLToPath(
      run(
        process.execPath,
        ['--input-type=module', '-e', "console.log(import.meta.resolve('@relayflows/sdk/relay-cli'))"],
        path.join(target, 'packages/cli')
      ).trim()
    )
  );
  const surfaceEntry = run(
    process.execPath,
    ['--input-type=module', '-e', "console.log(import.meta.resolve('@relayflows/surface'))"],
    sdk
  ).trim();
  const fixture = mkdtempSync(path.join(privateHome, 'project-'));
  mkdirSync(path.join(fixture, 'node_modules/@relayflows'), { recursive: true });
  writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
  const surfacePackage = JSON.parse(
    readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(surfaceEntry))), 'package.json'), 'utf8')
  );
  run('npm', [
    'install',
    '--prefix',
    fixture,
    '--ignore-scripts',
    '--no-save',
    '--package-lock=false',
    `@relayflows/surface@${surfacePackage.version}`,
  ]);
  if (lstatSync(path.join(fixture, 'node_modules/@relayflows/surface')).isSymbolicLink()) {
    throw new Error('Proof fixture must use a real published surface installation');
  }
  try {
    const source = path.join(fixture, 'listener.flow.ts');
    writeFileSync(
      source,
      `import { flow } from '@relayflows/surface';
export default flow('gitlab-proof', { budget: '$1/run' }, async (f) => {
  await f.run('echo proof'); f.done('success');
});
`
    );
    const outcomes = {};
    for (const scenario of ['selection', 'ingress']) {
      const trace = path.join(privateHome, `${scenario}-requests.jsonl`);
      writeFileSync(trace, '');
      const preload = path.join(privateHome, `${scenario}-transport.mjs`);
      writeFileSync(
        preload,
        `import { appendFileSync } from 'node:fs';
const scenario = ${JSON.stringify(scenario)};
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://gitlab-proof.invalid') throw new Error('Unexpected origin');
  const method = init?.method ?? 'GET';
  appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ method, path: url.pathname }) + String.fromCharCode(10));
  let status = 200; let body;
  if (method === 'GET' && url.pathname === '/cloud/api/v1/auth/whoami') {
    body = { authenticated: true, currentWorkspace: { id: 'proof-workspace' } };
  } else if (method === 'GET' && url.pathname === '/cloud/api/v1/workspaces/proof-workspace/integrations/gitlab/status') {
    body = { ready: true, state: 'ready', configKey: 'gitlab-pat', eventIngressReady: scenario === 'selection' };
  } else if (method === 'POST' && url.pathname === '/cloud/api/v1/flows/deploy') {
    status = 403;
    body = { code: 'flow_repository_not_allowlisted', error: 'Select proof-group/proof-project in this workspace GitLab integration before deploying.' };
  } else { throw new Error('Unexpected request: ' + method + ' ' + url.pathname); }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};
`
      );
      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--import',
          pathToFileURL(preload).href,
          cli,
          'flows',
          'deploy',
          source,
          '--repo',
          'gitlab:proof-group/proof-project',
          '--on',
          'gitlab:labels=proof',
          '--approver',
          'proof-user',
          '--agents',
          'claude',
          '--no-connect',
          '--json',
        ],
        {
          cwd: target,
          env: {
            ...env,
            FLOWS_CLOUD_URL: 'https://gitlab-proof.invalid/cloud',
            FLOWS_CLOUD_TOKEN: 'local-proof-fixture',
          },
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        }
      );
      if (result.error || result.status !== 2) {
        throw new Error(
          `flows ${scenario} failed: ${result.error ?? result.status}\n${result.stdout}\n${result.stderr}`
        );
      }
      const refusal = JSON.parse(result.stdout);
      const requests = readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (
        refusal.ok !== false ||
        !(
          ['flow_repository_not_allowlisted', 'integration_not_ready'].includes(refusal.code) ||
          (refusal.code === 'http_error' &&
            /Cloud refused \(flow_repository_not_allowlisted\)/.test(refusal.message))
        ) ||
        !requests.some((request) => request.path.endsWith('/integrations/gitlab/status'))
      ) {
        throw new Error(
          `Did not exercise the GitLab deploy refusal: ${JSON.stringify({ refusal, requests })}`
        );
      }
      const posts = requests.filter((request) => request.method === 'POST').length;
      outcomes[scenario] =
        scenario === 'selection'
          ? refusal.code === 'flow_repository_not_allowlisted' &&
            posts === 1 &&
            /select.*proof-group\/proof-project/i.test(refusal.message) &&
            !/cli:auth|cloud login/i.test(refusal.message)
          : refusal.code === 'integration_not_ready' &&
            posts === 0 &&
            /webhook ingress/i.test(refusal.message) &&
            /test event/i.test(refusal.message);
    }
    return outcomes;
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

try {
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  run('npm', ['run', 'build:core']);
  const cli = path.join(target, 'packages/cli/dist/cli/index.js');
  const help = run(process.execPath, [cli, 'file', 'integration', 'set-metadata', '--help']);
  if (!/Usage: agent-relay file integration set-metadata/.test(help)) {
    throw new Error(`Did not reach the mounted production command: ${help}`);
  }
  const versions = JSON.parse(
    run(
      process.execPath,
      ['--input-type=module'],
      path.join(target, 'packages/cli'),
      `
    import {createRelayCliSurface as file} from '@relayfile/sdk/relay-cli';
    import {createRelayCliSurface as flows} from '@relayflows/sdk/relay-cli';
    console.log(JSON.stringify({file: file().version, flows: flows().version}));
  `
    )
  );
  const metadataFile = /--metadata-file(?:[=\s]+)(?:<[^>]+>|\[[^\]]+\])/i.test(help);
  const refusals = flowsRefusals(cli);
  const filePatch = /^0\.10\.(\d+)$/.exec(versions.file);
  const fixed =
    metadataFile &&
    filePatch !== null &&
    Number(filePatch[1]) >= 77 &&
    versions.flows === '2.0.65' &&
    refusals.selection &&
    refusals.ingress;
  const observation = {
    version: 1,
    caseId,
    arm,
    outcome: fixed ? 'fixed' : 'bug',
    signature: fixed ? 'released_product_sdks_consumed' : 'stale_product_sdks',
    details: JSON.stringify({ versions, metadataFile, refusals }),
  };
  writeFileSync(required('RELAY_PR_PROOF_RESULT_PATH'), JSON.stringify(observation, null, 2) + '\n');
  console.log(JSON.stringify(observation));
} finally {
  rmSync(privateHome, { recursive: true, force: true });
}
