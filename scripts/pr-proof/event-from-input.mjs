#!/usr/bin/env node

/**
 * Normalise a Relayflows run input into the event payload `prepare.mjs` reads.
 *
 * The v1 dispatcher handed `prepare.mjs` the GitHub Actions event file. A
 * deployed v2 flow is launched by Cloud's hosted listener instead, which
 * passes `{ approver, issue, event }` as run input, so there is no event file
 * on disk and the listener's envelope shape is not the Actions one.
 *
 * This deliberately extracts the pull request NUMBER and nothing else, then
 * writes `{ inputs: { pr_number } }`. That is the `workflow_dispatch` shape
 * `prepare.mjs` already supports, and it forces `prepare.mjs` to resolve the
 * authoritative pull request from the GitHub API. Listener-supplied SHAs,
 * titles, and bodies therefore never reach the proof contract: a listener that
 * lied about the head SHA would be overwritten by the live snapshot, which is
 * the same fail-closed posture the dispatcher had.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Decode the run input the flow body passed as base64.
 *
 * base64 is used rather than raw JSON because the flow lowers this call into a
 * shell command, and pull request titles and bodies are attacker-controlled
 * text. A base64 argument has no shell metacharacters to escape.
 */
export function decodeInput(encoded) {
  if (typeof encoded !== 'string' || !encoded || !BASE64.test(encoded)) {
    throw new Error('--input-base64 must be a base64-encoded JSON run input');
  }
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    throw new Error(`Run input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const input = record(parsed);
  if (!input) throw new Error('Run input must be a JSON object');
  return input;
}

/**
 * The actions the proof runs for, the same set the GitHub Actions dispatcher
 * this replaced declared (`types: [opened, synchronize, reopened, edited,
 * ready_for_review]`). Cloud delivers every pull_request event, so an action
 * outside this set — `labeled`, `closed`, `assigned` — is a normal delivery to
 * ignore, not a failure: each one would otherwise start a 110-minute proof.
 */
export const PROOF_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review']);

/** `pull_request.synchronize` -> `pull_request`; `pull_request` -> `pull_request`. */
function eventKind(type) {
  return type.split('.', 1)[0];
}

/**
 * The action this delivery carries, from the event name Cloud sends
 * (`pull_request.synchronize`) or from the webhook payload's own field.
 * `null` when neither says, which is treated as proof-worthy: the Actions
 * dispatcher only ever received events it had subscribed to.
 */
export function pullRequestAction(input) {
  const event = record(input.event) ?? {};
  const payload = record(event.payload) ?? {};
  const type = event.type ?? event.eventType;
  if (typeof type === 'string') {
    const [, action] = type.split('.');
    if (action) return action;
  }
  return typeof payload.action === 'string' ? payload.action : null;
}

/**
 * The pull request number carried by the listener envelope.
 *
 * The candidate list is deliberately broad: Cloud's envelope is versioned
 * separately from this repository, and a shape change must refuse loudly
 * rather than silently proving the wrong pull request.
 */
export function pullRequestNumber(input) {
  const event = record(input.event) ?? {};
  const payload = record(event.payload) ?? {};
  const issue = record(input.issue) ?? {};
  // A non-pull_request event reaching a pull-request proof is a deployment
  // misconfiguration, not something to guess a number out of. Cloud's listener
  // names the event `pull_request.<action>` (the Actions dispatcher this
  // replaced got `pull_request` with the action in a separate field), so
  // compare the kind, not the whole string: requiring an exact `pull_request`
  // rejected every real delivery at the proof's first step.
  const type = event.type ?? event.eventType;
  if (typeof type === 'string' && eventKind(type) !== 'pull_request') {
    throw new Error(`This flow proves pull requests; the listener delivered a "${type}" event`);
  }
  const candidates = [
    record(payload.pull_request)?.number,
    payload.number,
    record(event.pull_request)?.number,
    event.number,
    record(issue.pullRequest)?.number,
    record(issue.pull_request)?.number,
    issue.number,
    record(input.pull_request)?.number,
    input.pullRequest,
    input.pr_number,
  ];
  // Safe, not merely integral: JSON.parse rounds values past 2^53, so
  // Number.isInteger would accept a rounded id and prove the wrong pull request.
  const number = candidates.find((value) => Number.isSafeInteger(value) && value > 0);
  if (number === undefined) {
    throw new Error(
      'The listener event does not carry a pull request number; ' +
        `inspected keys: ${Object.keys(input).join(', ') || 'none'}`
    );
  }
  return number;
}

export async function main() {
  const input = decodeInput(option('--input-base64'));
  const outputPath = option('--out', '.relayflow/pr-proof-event.json');
  const action = pullRequestAction(input);
  if (action !== null && !PROOF_ACTIONS.has(action)) {
    // Nothing is written: the flow reads this line and ends the run as a
    // success without proving anything.
    console.log(`PR_PROOF_EVENT_SKIPPED action=${action}`);
    return;
  }
  const number = pullRequestNumber(input);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ inputs: { pr_number: number } }, null, 2)}\n`);
  console.log(`PR_PROOF_EVENT_READY pr=${number}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
