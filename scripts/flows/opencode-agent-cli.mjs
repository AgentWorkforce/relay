#!/usr/bin/env node

/**
 * `relayflows-agent-cli-v1` wrapper for the OpenCode harness.
 *
 * Relayflows v2 runs only raw Claude/Codex executables directly; every other
 * harness must identify with the `relayflows-agent-cli-v1` contract or
 * preflight refuses the step with `cli_unsupported`. The v1 verification flows
 * deliberately ran their cheap first-pass reviewer and one preflight probe on
 * OpenCode — a third-party model reviewing Relay's own evidence is the point,
 * so substituting Claude there would make the step attest something it never
 * checked. This wrapper keeps that property instead of dropping it.
 *
 * ## The contract, as the SDK actually implements it
 *
 * Identity probe (`packages/sdk/src/adapters/wrapper.ts`):
 *   `<cli> --relayflows-adapter-v1` must print exactly `relayflows-agent-cli-v1`
 *   and exit 0 within 10s. The probe compares trimmed stdout, so nothing else
 *   may reach stdout on that path.
 *
 * Auth probe: `<cli> auth status` exits 0 when usable.
 * Model probe: the same command with `RELAYFLOW_MODEL=<model>` in the
 *   environment, exiting 0 when that exact model is ready.
 *
 * Execution (`packages/sdk/src/wrapper-session.ts`): the same
 *   `--relayflows-adapter-v1` invocation, but the SDK keeps stdin open, reads
 *   the identity line, writes one JSON request line
 *   (`{protocol, instruction, model?, wakeContext?}`) and closes stdin. The
 *   wrapper acknowledges with `relayflows-agent-cli-v1-execute` and then
 *   streams the agent's output. Identity and execution therefore share one
 *   argv, and are told apart by whether a request arrives before stdin ends.
 *
 * ## Credentials
 *
 * A credential stored under HOME — what `opencode auth login` writes to
 * `~/.local/share/opencode/auth.json` — works on every path, because HOME is
 * allowlisted. Nothing to do if OpenCode is already logged in.
 *
 * An environment-variable-only credential does not, and fails asymmetrically:
 *
 *   - `flows check` probes through `runProbe` (`cli/check.ts`), which passes
 *     the FULL `process.env`, so `OPENCODE_API_KEY` is visible and the harness
 *     reports as authenticated.
 *   - execution goes through `runWrapperSession` (`worker-cli.ts`), which
 *     passes `wrapperEnvironment(process.env)` — a closed allowlist (PATH,
 *     HOME, TMPDIR, SHELL, LANG, USER, …) that strips it.
 *
 * So an env-only key passes preflight and then fails at run. `authStatus`
 * below deliberately reads the credential STORE rather than trusting the
 * environment, so the probe answers the question execution will actually ask.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const IDENTIFY_ARG = '--relayflows-adapter-v1';
const IDENTIFY_TOKEN = 'relayflows-agent-cli-v1';
const EXECUTE_TOKEN = 'relayflows-agent-cli-v1-execute';
// Resolved from PATH deliberately, with no override env var: the SDK's
// allowlist would drop one, leaving a knob that silently did nothing. PATH
// itself crosses, so a test or a pinned install redirects this by PATH.
const OPENCODE = 'opencode';
const IDENTITY_IDLE_MS = 5_000;

function run(args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(OPENCODE, args, {
      stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', () => resolve({ code: 127, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * `opencode auth list` exits 0 even with zero credentials, so its exit status
 * is not an authentication answer. Read the credential store it names instead,
 * and require the declared model to be one OpenCode actually lists.
 */
async function authStatus() {
  const credentials = await run(['auth', 'list'], { capture: true });
  if (credentials.code !== 0) {
    process.stderr.write('opencode auth list failed; the harness is not usable\n');
    return 1;
  }
  if (/\b0 credentials\b/.test(credentials.stdout)) {
    process.stderr.write(
      'opencode has no stored credentials. Relayflows strips OPENCODE_API_KEY from the wrapper ' +
        'environment at execution, so an env-only key would pass this probe and then fail at run; ' +
        'run `opencode auth login` so the credential is stored under HOME.\n'
    );
    return 1;
  }
  const model = process.env.RELAYFLOW_MODEL?.trim();
  if (!model) return 0;
  const models = await run(['models'], { capture: true });
  if (models.code !== 0) {
    process.stderr.write('opencode models failed; cannot prove the declared model is ready\n');
    return 1;
  }
  const available = models.stdout.split('\n').map((line) => line.trim());
  if (!available.includes(model)) {
    process.stderr.write(`opencode does not list model ${JSON.stringify(model)}\n`);
    return 1;
  }
  return 0;
}

/** Read one request line, or resolve undefined when stdin ends without one. */
function readRequest() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      reader.close();
      resolve(value);
    };
    const reader = createInterface({ input: process.stdin });
    // The identity probe spawns with a pipe it never writes to and waits for
    // exit. Without this the wrapper would block until the probe's own 10s
    // timeout and be reported as unsupported.
    const idle = setTimeout(() => done(undefined), IDENTITY_IDLE_MS);
    reader.on('line', (line) => done(line));
    reader.on('close', () => done(undefined));
    process.stdin.on('error', () => done(undefined));
  });
}

async function adapterSession() {
  process.stdout.write(`${IDENTIFY_TOKEN}\n`);
  const line = await readRequest();
  // No request before stdin ended: this was the identity probe, which compares
  // trimmed stdout against the token alone.
  if (line === undefined || line.trim() === '') return 0;

  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`wrapper request was not JSON: ${error.message}\n`);
    return 1;
  }
  if (request?.protocol !== IDENTIFY_TOKEN || typeof request.instruction !== 'string') {
    process.stderr.write('wrapper request did not carry the expected protocol and instruction\n');
    return 1;
  }

  process.stdout.write(`${EXECUTE_TOKEN}\n`);
  const args = ['run'];
  if (typeof request.model === 'string' && request.model.trim()) args.push('--model', request.model.trim());
  args.push(request.instruction);
  const { code } = await run(args);
  return code;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === IDENTIFY_ARG && args.length === 1) return adapterSession();
  if (args[0] === 'auth' && args[1] === 'status' && args.length === 2) return authStatus();
  process.stderr.write(
    `Usage: opencode-agent-cli.mjs ${IDENTIFY_ARG} | auth status\n` +
      'This is a Relayflows harness adapter, not a general OpenCode entry point.\n'
  );
  return 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
);
