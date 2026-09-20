#!/usr/bin/env node

/**
 * `relayflows-agent-cli-v1` wrapper for the cursor-agent harness.
 *
 * Relayflows v2 runs only raw Claude/Codex executables directly; anything else
 * is refused `cli_unsupported` unless it identifies with this contract. Written
 * as a sibling to `opencode-agent-cli.mjs`, for a different reason: a Codex
 * credential can exhaust mid-campaign, and this one did — `codex-review-2` died
 * with `worker_error exit=1` three steps from the end of a run carrying 55
 * reused steps.
 *
 * cursor-agent serves the same GPT-5.x Codex models under a separate account,
 * so routing the "codex" roles through it preserves the property the review
 * rounds exist for: a Codex-family model reviewing what Claude wrote, and the
 * reverse. Substituting Claude on both sides would leave the steps attesting
 * something they never independently checked.
 *
 * ## The contract, as the SDK implements it
 *
 * Identity probe (`packages/sdk/src/adapters/wrapper.ts`):
 *   `<cli> --relayflows-adapter-v1` prints exactly `relayflows-agent-cli-v1`
 *   and exits 0 within 10s. stdout carries nothing else on that path.
 *
 * Auth probe: `<cli> auth status` exits 0 when usable.
 * Model probe: the same, with `RELAYFLOW_MODEL=<model>` in the environment.
 *
 * Execution (`packages/sdk/src/wrapper-session.ts`): the same argv, but the SDK
 *   holds stdin open, reads the identity line, writes one JSON request line
 *   (`{protocol, instruction, model?, wakeContext?}`) and closes stdin. The
 *   wrapper acknowledges with `relayflows-agent-cli-v1-execute`, then streams
 *   the agent's output. Identity and execution share one argv and are told
 *   apart by whether a request arrives before stdin ends.
 *
 * ## Credentials
 *
 * `cursor-agent login` stores under `~/.cursor`. HOME is on the SDK's execution
 * allowlist (`wrapperEnvironment`), so a logged-in install works on every path.
 * `CURSOR_API_KEY` does NOT: `flows check` probes with the full environment and
 * would report authenticated, while execution strips it and fails. `authStatus`
 * therefore asks `cursor-agent status`, which reads the store, rather than
 * trusting the environment — the probe answers the question execution will ask.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const IDENTIFY_ARG = '--relayflows-adapter-v1';
const IDENTIFY_TOKEN = 'relayflows-agent-cli-v1';
const EXECUTE_TOKEN = 'relayflows-agent-cli-v1-execute';
// Resolved from PATH deliberately, with no override env var: the SDK's
// allowlist would drop one, leaving a knob that silently did nothing.
const CURSOR = 'cursor-agent';
const IDENTITY_IDLE_MS = 5_000;

function run(args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(CURSOR, args, {
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
 * `cursor-agent status` exits non-zero when signed out, so unlike opencode's
 * `auth list` its exit status IS the answer. The declared model is then checked
 * against `--list-models`, because a model the account cannot reach fails at
 * execution rather than here.
 */
async function authStatus() {
  const status = await run(['status'], { capture: true });
  if (status.code !== 0) {
    process.stderr.write(
      'cursor-agent is not signed in. Relayflows strips CURSOR_API_KEY from the wrapper ' +
        'environment at execution, so an env-only key would pass this probe and then fail at ' +
        'run; use `cursor-agent login` so the credential is stored under HOME.\n'
    );
    return 1;
  }
  const model = process.env.RELAYFLOW_MODEL?.trim();
  if (!model) return 0;
  const models = await run(['--list-models'], { capture: true });
  if (models.code !== 0) {
    process.stderr.write('cursor-agent --list-models failed; cannot prove the model is ready\n');
    return 1;
  }
  // Lines read `<id> - <label>`; the bracketed-override form
  // (`model[context=1m,...]`) is accepted on its base id.
  const base = model.split('[')[0];
  const available = models.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+-\s+/)[0])
    .filter(Boolean);
  if (!available.includes(base)) {
    process.stderr.write(
      `cursor-agent does not list model ${JSON.stringify(base)}; available: ${available.join(', ')}\n`
    );
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
    // exit. Without this the wrapper blocks until the probe's own 10s timeout
    // and is reported unsupported.
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
  const args = [
    '--print',
    '--output-format',
    'text',
    // A workflow step is non-interactive by construction: a tool-approval or
    // workspace-trust prompt has no one to answer it and would hang until the
    // step's lease expires. Both are granted explicitly rather than left to
    // whatever the user's interactive config happens to say.
    '--force',
    '--trust',
  ];
  if (typeof request.model === 'string' && request.model.trim()) {
    args.push('--model', request.model.trim());
  }
  args.push(request.instruction);
  const { code } = await run(args);
  return code;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === IDENTIFY_ARG && args.length === 1) return adapterSession();
  if (args[0] === 'auth' && args[1] === 'status' && args.length === 2) return authStatus();
  process.stderr.write(
    `Usage: cursor-agent-cli.mjs ${IDENTIFY_ARG} | auth status\n` +
      'This is a Relayflows harness adapter, not a general cursor-agent entry point.\n'
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
