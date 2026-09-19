#!/usr/bin/env node

/**
 * Reconcile this repository's hosted Relayflows listeners with what is on main.
 *
 * `flows deploy` creates a listener; it does not update one. Each call POSTs a
 * fresh `handoffId`, and `flows deployments` reports no source digest, so
 * neither this script nor the CLI can tell a stale listener from a current one
 * by content. The reconcile is therefore name-based: for each managed flow,
 * remove the listeners already deployed under its name, then deploy the file
 * at its current commit. The workflow's `paths:` filter is what makes this
 * idempotent — it only runs when a managed flow's source actually changed.
 *
 * Order is deliberate: undeploy first, then deploy.
 *
 * Deploying first would briefly leave two listeners on the same repository and
 * trigger, so a pull request opened in that window would start two proofs that
 * both publish the same status context — and the one that finishes last, which
 * may be running the OLD source, would win. Undeploying first means a pull
 * request in that window gets no proof at all: no status is published, branch
 * protection keeps blocking, and a human re-runs it. For a security gate the
 * fail-closed hole is the safer of the two.
 *
 * Credential: a "Flows Cloud token" (Dashboard -> Settings -> Tokens) minted
 * after AgentWorkforce/cloud#3829, which added `flows:listeners:write` to that
 * purpose. The deploy/list/undeploy routes require it; an older token passes
 * `whoami` and then 403s with `insufficient_scope`. Recreate rather than reuse.
 *
 * Usage:
 *   FLOWS_CLOUD_TOKEN=… RELAY_PR_PROOF_APPROVER=… node scripts/flows/deploy-listeners.mjs [--dry-run]
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Only flows that are hosted listeners belong here. The verification and audit
 * flows are generated specs invoked by npm scripts and CI; they are not
 * deployed and must not be added.
 */
const MANAGED = [
  {
    path: 'flows/ci/pr-proof.flow.ts',
    // Must equal the name the flow declares; the reconcile matches on it.
    name: 'relay.ci.pr-proof',
    repo: 'AgentWorkforce/relay',
    on: ['github:events=pull_request'],
    agents: 'claude',
  },
];

const DRY_RUN = process.argv.includes('--dry-run');

function flows(args, { expectJson = true } = {}) {
  const { status, stdout, stderr } = spawnSync('npx', ['flows', ...args], {
    encoding: 'utf8',
    env: process.env,
  });
  if (stderr?.trim()) process.stderr.write(`${stderr.trim()}\n`);
  if (status !== 0) {
    throw new Error(`flows ${args.join(' ')} exited ${status ?? 'null'}`);
  }
  if (!expectJson) return undefined;
  const line = (stdout ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error(`flows ${args.join(' ')} produced no JSON output`);
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`flows ${args.join(' ')} output was not JSON: ${error.message}`);
  }
}

/**
 * The name a flow file declares, read from its `flow(...)` call and nowhere
 * else. Matching the raw source would accept the managed name in a comment or
 * an unrelated literal after the declaration itself was renamed, and every run
 * would then deploy one more listener under the new name that no reconcile
 * removes. Comments are stripped first, and the file must declare exactly one
 * flow, so the name compared is the one the listener will be created under.
 */
export function declaredFlowName(flowPath) {
  const source = readFileSync(flowPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // `flow('name'` or `flow<Input>('name'`; the generic never contains parens.
  const declarations = [...source.matchAll(/\bflow\s*(?:<[^()]*>)?\s*\(\s*(['"`])([^'"`\n]+)\1/g)];
  if (declarations.length !== 1) {
    throw new Error(`${flowPath} must declare exactly one flow(...); found ${declarations.length}`);
  }
  return declarations[0][2];
}

/** Listeners already deployed for this flow name against this repository. */
function existingFor(deployments, flow) {
  const [owner, name] = flow.repo.split('/');
  return deployments.filter((deployment) => {
    if (deployment.name !== flow.name) return false;
    // A deployment with no repository is still ours by name; leaving it would
    // keep an unattributable listener running.
    if (!deployment.repository) return true;
    return deployment.repository.owner === owner && deployment.repository.name === name;
  });
}

function approver() {
  const value = process.env.RELAY_PR_PROOF_APPROVER?.trim();
  if (!value) {
    throw new Error(
      'RELAY_PR_PROOF_APPROVER is required: every launched run receives it as input.approver for f.human.'
    );
  }
  return value;
}

function main() {
  if (!process.env.FLOWS_CLOUD_TOKEN?.trim() && !DRY_RUN) {
    throw new Error('FLOWS_CLOUD_TOKEN is required to reconcile hosted listeners.');
  }
  const who = approver();
  const listed = flows(['deployments', '--json']);
  const deployments = Array.isArray(listed?.deployments) ? listed.deployments : [];

  for (const flow of MANAGED) {
    // Fail before touching anything if the file no longer declares this name;
    // a renamed flow would otherwise leave its old listener running forever.
    const declared = declaredFlowName(flow.path);
    if (declared !== flow.name) {
      throw new Error(
        `${flow.path} declares flow ${JSON.stringify(declared)}, not the managed name ${JSON.stringify(flow.name)}`
      );
    }

    const stale = existingFor(deployments, flow);
    console.log(`${flow.name}: ${stale.length} existing listener(s)`);
    for (const deployment of stale) {
      console.log(`  undeploy ${deployment.agentId} (${deployment.status})`);
      if (!DRY_RUN) flows(['undeploy', '--json', deployment.agentId]);
    }

    const args = [
      'deploy',
      flow.path,
      '--repo',
      flow.repo,
      '--approver',
      who,
      '--agents',
      flow.agents,
      '--no-connect',
      '--json',
    ];
    for (const source of flow.on) args.push('--on', source);
    console.log(`  deploy ${flow.path}`);
    if (DRY_RUN) {
      console.log(`  would run: flows ${args.join(' ')}`);
      continue;
    }
    const deployed = flows(args);
    if (!deployed?.agentId) throw new Error(`deploy of ${flow.name} returned no deployment id`);
    console.log(
      `  DEPLOYED ${deployed.agentId} ${deployed.status} sha256 ${String(deployed.sourceSha256).slice(0, 12)}`
    );

    // A leftover duplicate would double-run every pull request, so prove the
    // reconcile converged rather than assuming the undeploys landed.
    const after = existingFor(flows(['deployments', '--json'])?.deployments ?? [], flow);
    if (after.length !== 1 || after[0].agentId !== deployed.agentId) {
      throw new Error(
        `${flow.name} did not converge to exactly the new listener; found ${
          after.map((entry) => entry.agentId).join(', ') || 'none'
        }`
      );
    }
  }
  console.log('Relayflows listeners reconciled.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`[deploy-listeners] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
