import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CASE_ID = '1400-fleet-rollout-contract';
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const CLI_TIMEOUT_MS = 30_000;
const LEGACY_COMMANDS = ['config', 'enable', 'disable', 'inherit'];
const REMOVED_MESSAGE =
  'Fleet rollout controls were removed because Fleet node delivery is always on. ' +
  "'fleet config', 'fleet enable', 'fleet disable', and 'fleet inherit' no longer apply; " +
  "use 'agent-relay fleet nodes' or 'agent-relay fleet status' to inspect Fleet.";
const BASE_DEPENDENCY_ERROR =
  'RelaycastMessagingClient.workspace.fleetNodes requires @relaycast/sdk with the workspace fleet nodes API.';

const arm = required('RELAY_PR_PROOF_ARM');
const targetDir = path.resolve(required('RELAY_PR_PROOF_TARGET_DIR'));
const harnessDir = path.resolve(required('RELAY_PR_PROOF_HARNESS_DIR'));
const resultPath = path.resolve(required('RELAY_PR_PROOF_RESULT_PATH'));
const expectedSha = required(arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA');

if (arm !== 'base' && arm !== 'head') throw new Error(`invalid proof arm: ${arm}`);
const targetSha = run('git', ['rev-parse', 'HEAD'], targetDir, 'target revision').stdout.trim();
if (targetSha !== expectedSha) throw new Error(`target ${targetSha} does not match ${expectedSha}`);
if (!isWithin(harnessDir, fileURLToPath(import.meta.url))) {
  throw new Error('runner must execute from the exact PR-head harness checkout');
}

run('npm', ['ci', '--ignore-scripts'], targetDir, 'dependency installation');
run('npm', ['run', 'build:core'], targetDir, 'compiled Relay build');

const cliPath = path.join(targetDir, 'packages', 'cli', 'dist', 'cli', 'index.js');
const canary = 'rk_live_relayflow_1400_must_not_echo';
const networkAuditPath = `${resultPath}.network-audit.log`;
const networkDenyPath = `${resultPath}.network-deny.mjs`;
const trapRequests = [];
let trap;
let outcome;
let signature;
let details;
try {
  await writeFile(networkAuditPath, '');
  await writeFile(networkDenyPath, networkDenySource());
  trap = createServer((request, response) => {
    trapRequests.push(`${request.method ?? 'UNKNOWN'} ${request.url ?? '/'}`);
    response.writeHead(418, { 'content-type': 'text/plain' });
    response.end('network access is forbidden in the Fleet rollout compatibility proof');
  });
  trap.listen(0, '127.0.0.1');
  await once(trap, 'listening');
  const address = trap.address();
  if (!address || typeof address === 'string') throw new Error('network trap did not bind a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const commandEnv = {
    ...process.env,
    AGENT_RELAY_TELEMETRY_DISABLED: '1',
    CI: '1',
    NO_COLOR: '1',
    NODE_OPTIONS: `--import=${pathToFileURL(networkDenyPath).href}`,
    RELAY_PR_1400_NETWORK_AUDIT: networkAuditPath,
    RELAY_API_KEY: canary,
    RELAY_WORKSPACE_KEY: canary,
  };

  const denyCanary = await runChild(
    process.execPath,
    ['--input-type=module', '--eval', networkDenyCanarySource()],
    commandEnv,
    'network-deny self-test'
  );
  assertExit(denyCanary, 0, 'network-deny self-test');
  const denyCanaryAudit = await readFile(networkAuditPath, 'utf8');
  for (const expected of [
    'fetch ',
    'node:http.get ',
    'node:https.get ',
    'node:http2.connect ',
    'node:net.connect ',
    'node:net.Socket.connect ',
    'node:tls.connect ',
    'node:dgram.createSocket ',
    'node:dns.lookup ',
    'node:dns/promises.lookup ',
  ]) {
    if (!denyCanaryAudit.includes(expected)) {
      throw new Error(`network-deny self-test did not exercise ${expected.trim()}`);
    }
  }
  await writeFile(networkAuditPath, '');

  const help = await runCli(cliPath, ['fleet', '--help'], commandEnv);
  assertExit(help, 0, 'fleet --help');
  const advertised = LEGACY_COMMANDS.filter((command) =>
    new RegExp(`^\\s+${command}(?:\\s|$)`, 'm').test(help.stdout)
  );

  if (arm === 'base') {
    if (advertised.length !== LEGACY_COMMANDS.length) {
      throw new Error(`base did not advertise every retired command: ${JSON.stringify(advertised)}`);
    }
    const config = await runCli(
      cliPath,
      ['fleet', 'config', '--workspace-key', canary, '--base-url', baseUrl],
      commandEnv
    );
    assertExit(config, 1, 'base fleet config');
    const output = `${config.stdout}${config.stderr}`;
    if (!output.includes(BASE_DEPENDENCY_ERROR)) {
      throw new Error(`base did not reproduce the removed Relaycast dependency: ${tail(output)}`);
    }
    assertCredentialSafe(output, 'base fleet config');

    outcome = 'bug';
    signature = 'obsolete_fleet_rollout_controls_advertised';
    details =
      'The exact compiled base CLI advertises all four rollout controls, and fleet config exits 1 through the missing Relaycast workspace API.';
  } else {
    if (advertised.length !== 0) {
      throw new Error(`head still advertises retired commands: ${JSON.stringify(advertised)}`);
    }

    for (const command of LEGACY_COMMANDS) {
      const result = await runCli(
        cliPath,
        ['fleet', command, '--workspace-key', canary, '--base-url', baseUrl, 'ignored-legacy-argument'],
        commandEnv
      );
      assertExit(result, 1, `head fleet ${command}`);
      if (result.stdout.trim() !== '' || result.stderr.trim() !== REMOVED_MESSAGE) {
        throw new Error(
          `head fleet ${command} did not emit only the exact safe migration diagnostic: ${tail(
            `${result.stdout}${result.stderr}`
          )}`
        );
      }
      assertCredentialSafe(`${result.stdout}${result.stderr}`, `head fleet ${command}`);
    }

    await assertCompiledSdkCompatibility(targetDir, commandEnv);
    await new Promise((resolve) => setImmediate(resolve));
    if (trapRequests.length !== 0) {
      throw new Error(`head compatibility shims contacted the network trap: ${JSON.stringify(trapRequests)}`);
    }
    const networkAttempts = await readFile(networkAuditPath, 'utf8');
    if (networkAttempts.trim() !== '') {
      throw new Error(`head compatibility shims attempted network access: ${tail(networkAttempts)}`);
    }

    outcome = 'fixed';
    signature = 'fleet_rollout_contract_removed_with_migration_shims';
    details =
      'The exact compiled head hides all four CLI controls; every legacy invocation exits 1 with exact credential-safe guidance and zero network requests, while the deprecated SDK surface reports immutable always-on state locally.';
  }
} finally {
  await closeServer(trap);
  await Promise.all([rm(networkAuditPath, { force: true }), rm(networkDenyPath, { force: true })]);
}

await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, outcome, signature, details })}\n`
);

async function assertCompiledSdkCompatibility(directory, networkEnv) {
  const typeProbePath = path.join(directory, '.relayflow-1400-sdk-compat-typecheck.ts');
  const typeProbe = String.raw`
    import { AgentRelay, RelaycastMessagingClient } from './packages/sdk/dist/index.js';
    import type { RelayMessagingClient, RelayWorkspaceFleetNodesConfig } from './packages/sdk/dist/index.js';
    import type { RelaycastWorkspaceLike } from './packages/sdk/dist/messaging/relaycast-client.js';
    declare const relay: AgentRelay;
    declare const relaycast: RelaycastMessagingClient;
    declare const messaging: RelayMessagingClient;
    declare const upstream: RelaycastWorkspaceLike;
    const values: Promise<RelayWorkspaceFleetNodesConfig>[] = [
      relay.workspace.fleetNodes.get(),
      relay.workspace.fleetNodes.set(false),
      relay.workspace.fleetNodes.set(true),
      relay.workspace.fleetNodes.inherit(),
      relaycast.workspace.fleetNodes.get(),
      relaycast.workspace.fleetNodes.set(false),
      relaycast.workspace.fleetNodes.inherit(),
      messaging.workspace.fleetNodes.get(),
      messaging.workspace.fleetNodes.set(true),
      messaging.workspace.fleetNodes.inherit(),
    ];
    // @ts-expect-error The compatibility setter remains boolean-only.
    relay.workspace.fleetNodes.set('disabled');
    // @ts-expect-error The upstream Relaycast adapter no longer requires or exposes rollout state.
    upstream.workspace?.fleetNodes;
    void values;
  `;
  await writeFile(typeProbePath, typeProbe);
  try {
    run(
      process.execPath,
      [
        path.join(directory, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        typeProbePath,
      ],
      directory,
      'compiled downstream SDK type consumer',
      networkEnv
    );
  } finally {
    await rm(typeProbePath, { force: true });
  }

  const runtimeProbe = String.raw`
    import { AgentRelay, RelaycastMessagingClient } from './packages/sdk/dist/index.js';
    import * as relaycastTranslate from './packages/sdk/dist/messaging/relaycast-translate.js';
    if ('toRelayWorkspaceFleetNodesConfig' in relaycastTranslate) process.exit(4);
    const upstream = { workspace: { info: async () => ({ id: 'workspace-proof' }) } };
    const messaging = new RelaycastMessagingClient({ relaycast: upstream });
    const relay = new AgentRelay({ messaging });
    const values = [
      await relay.workspace.fleetNodes.get(),
      await relay.workspace.fleetNodes.set(false),
      await relay.workspace.fleetNodes.set(true),
      await relay.workspace.fleetNodes.inherit(),
    ];
    const expected = JSON.stringify({ enabled: true, defaultEnabled: true, override: null });
    if (values.some((value) => JSON.stringify(value) !== expected)) process.exit(2);
    if ('fleetNodes' in upstream.workspace) process.exit(3);
  `;
  const probe = run(
    process.execPath,
    ['--input-type=module', '--eval', runtimeProbe],
    directory,
    'SDK compatibility probe',
    networkEnv
  );
  assertCredentialSafe(`${probe.stdout}${probe.stderr}`, 'SDK compatibility probe');
}

function run(command, args, cwd, label, env = process.env) {
  const completed = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (completed.error) throw new Error(`${label} could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    throw new Error(
      `${label} failed with ${
        completed.signal ? `signal ${completed.signal}` : `exit ${completed.status ?? 'unknown'}`
      }: ${tail(`${completed.stdout ?? ''}${completed.stderr ?? ''}`)}`
    );
  }
  return completed;
}

function runCli(cliPath, args, env) {
  return runChild(process.execPath, [cliPath, ...args], env, `CLI ${args.join(' ')}`);
}

function runChild(command, args, env, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: targetDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timeout = setTimeout(() => child.kill('SIGKILL'), CLI_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error(`${label} exited by signal ${signal}`));
      else resolve({ status, stdout, stderr });
    });
  });
}

function networkDenySource() {
  return String.raw`
    import { appendFileSync } from 'node:fs';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const auditPath = process.env.RELAY_PR_1400_NETWORK_AUDIT;
    if (!auditPath) throw new Error('missing RELAY_PR_1400_NETWORK_AUDIT');
    const record = (kind, args) => {
      const target = args.length > 0 ? String(args[0]) : '<none>';
      appendFileSync(auditPath, kind + ' ' + target + '\\n');
      const error = new Error('network denied by RelayFlow 1400 proof');
      error.code = 'ERR_RELAYFLOW_NETWORK_DENIED';
      throw error;
    };
    globalThis.fetch = async (...args) => record('fetch', args);
    const require = createRequire(import.meta.url);
    for (const [moduleName, methods] of [
      ['node:http', ['request', 'get']],
      ['node:https', ['request', 'get']],
      ['node:http2', ['connect']],
      ['node:net', ['connect', 'createConnection']],
      ['node:tls', ['connect']],
      ['node:dgram', ['createSocket']],
      ['node:dns', ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']],
    ]) {
      const module = require(moduleName);
      for (const method of methods) module[method] = (...args) => record(moduleName + '.' + method, args);
    }
    const net = require('node:net');
    net.Socket.prototype.connect = (...args) => record('node:net.Socket.connect', args);
    const dgram = require('node:dgram');
    dgram.Socket.prototype.connect = (...args) => record('node:dgram.Socket.connect', args);
    dgram.Socket.prototype.send = (...args) => record('node:dgram.Socket.send', args);
    const dns = require('node:dns');
    for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) {
      dns.promises[method] = (...args) => record('node:dns.promises.' + method, args);
    }
    const dnsPromises = require('node:dns/promises');
    for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) {
      dnsPromises[method] = (...args) => record('node:dns/promises.' + method, args);
    }
    syncBuiltinESMExports();
  `;
}

function networkDenyCanarySource() {
  return String.raw`
    await import('./packages/sdk/dist/index.js');
    const http = await import('node:http');
    const https = await import('node:https');
    const http2 = await import('node:http2');
    const net = await import('node:net');
    const tls = await import('node:tls');
    const dgram = await import('node:dgram');
    const dns = await import('node:dns');
    const dnsPromises = await import('node:dns/promises');
    const host = 'alternate-host.invalid';
    const checks = [
      () => fetch('https://' + host + '/relayflow-1400-canary'),
      () => http.get('http://' + host + '/relayflow-1400-canary'),
      () => https.get('https://' + host + '/relayflow-1400-canary'),
      () => http2.connect('https://' + host),
      () => net.connect(443, host),
      () => new net.Socket().connect(443, host),
      () => tls.connect(443, host),
      () => dgram.createSocket('udp4'),
      () => dns.lookup(host, () => {}),
      () => dnsPromises.lookup(host),
    ];
    for (const check of checks) {
      let denied = false;
      try {
        await check();
      } catch (error) {
        if (error?.code !== 'ERR_RELAYFLOW_NETWORK_DENIED') throw error;
        denied = true;
      }
      if (!denied) process.exit(8);
    }
  `;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function assertExit(result, expected, label) {
  if (result.status !== expected) {
    throw new Error(
      `${label} exited ${result.status}, expected ${expected}: ${tail(`${result.stdout}${result.stderr}`)}`
    );
  }
}

function assertCredentialSafe(output, label) {
  if (output.includes(canary)) throw new Error(`${label} echoed the workspace-key canary`);
}

function tail(value) {
  return value.slice(-2_000);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
