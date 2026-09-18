/**
 * relay.ci.pr-proof — PR-specific Cloud red/green proof.
 *
 * v2 port of `workflows/pr-proof.ts`. The v1 flow was only the inner four
 * steps; `.github/workflows/relayflow-pr-proof.yml` did the classification,
 * broker staging, and status reporting around it. A deployed v2 flow has no
 * dispatcher, so the preparation the dispatcher did is journaled here as
 * deterministic steps — which makes it inspectable and resumable instead of
 * living in YAML.
 *
 * Deploy it as a hosted listener:
 *
 *   flows deploy flows/ci/pr-proof.flow.ts \
 *     --repo AgentWorkforce/relay \
 *     --on github:events=pull_request \
 *     --approver <github-handle> \
 *     --agents claude
 *
 * Order is deliberate and unchanged from v1:
 *   1. base-prover observes the exact bug/capability absence on the base SHA;
 *   2. run-scoped Cloud storage hands nonce-bound evidence to a deterministic
 *      gate, which rejects crashes, skips, and wrong signatures;
 *   3. head-verifier observes the declared fixed behavior on the head SHA;
 *   4. a deterministic gate verifies exact SHAs and distinct sandbox IDs.
 *
 * Proof failures are evidence, not repair assignments. v1 said this with
 * `.onError('fail-fast')` and `retries: 0`. v2 has no repair agents, and the
 * TypeScript surface exposes no retry knob at all — the kernel's retry bound
 * (`maxIterations`) is a spec-only field — so the property holds by
 * construction: a failed step fails the run and no agent gets a second look at
 * the harness or the artifacts.
 */

import { flow } from '@relayflows/surface';

/** What Cloud's hosted listener passes to every launched run. */
export interface PrProofInput {
  /** The `f.human` approver handle; unused here — this flow asks nothing. */
  approver?: string;
  /** The ticket that woke the listener. */
  issue?: unknown;
  /** The provider event envelope. */
  event?: unknown;
}

const INPUT_PATH = '.relayflow/pr-proof-input.json';
const EVENT_PATH = '.relayflow/pr-proof-event.json';
const OUTPUTS_PATH = '.relayflow/pr-proof-outputs.env';
const BINARIES = '.relayflow/pr-proof-binaries';

/** Pull request text is attacker-controlled; base64 has nothing to escape. */
function encodeInput(input: PrProofInput): string {
  return Buffer.from(JSON.stringify(input ?? {}), 'utf8').toString('base64');
}

const armTask = (arm: 'base' | 'head', forbidden: string): string =>
  [
    'This is a deterministic verification assignment. Do not edit any files.',
    `Run exactly: node scripts/pr-proof/run-arm.mjs ${arm} ${INPUT_PATH}`,
    'Wait for it to finish. If it succeeds, print its PR_PROOF_ARM_COMPLETE line and then print DONE.',
    `If it fails, preserve the failure and exit non-zero. ${forbidden}`,
  ].join('\n');

export default flow<PrProofInput>(
  'relay.ci.pr-proof',
  // This is the dispatcher's 110-minute deadline, not v1's 45-minute inner
  // `.timeout(2_700_000)`. Broker resolution used to run in the GitHub job
  // *around* the flow; here it is a step *inside* it, so the budget must cover
  // the resolver's own worst case (30m producer + 10m Actions queue headroom +
  // poll slack) on top of the 45m proof itself. Budgeting only the proof would
  // fail a PR whose broker artifact is still building by the clock rather than
  // judging it on evidence. `.maxConcurrency(1)` needs no equivalent: an
  // awaited body is sequential by construction.
  { budget: { wallclock: '110m' } },
  async (f, input) => {
    // The listener hands the event as run input, not as a file on disk. This
    // extracts only the pull request number, so `prepare.mjs` resolves the
    // authoritative pull request from the API and no listener-supplied SHA,
    // title, or body can reach the proof contract.
    await f.run(
      `node scripts/pr-proof/event-from-input.mjs --input-base64 ${encodeInput(input)} --out ${EVENT_PATH}`
    );

    // Classify the PR and validate the declared case. Fails closed: an
    // unreadable diff, a fork head, or a PR that does not touch exactly its one
    // declared case exits non-zero here, before any agent step is journaled.
    await f.run(
      `node scripts/pr-proof/prepare.mjs --event ${EVENT_PATH} --output ${INPUT_PATH}` +
        ` --github-output ${OUTPUTS_PATH}`
    );

    // `prepare.mjs` reports the verdict through the GitHub-output file it
    // already writes, so the classification rules stay in one place.
    const required = await f.run(
      `grep -qx 'required=true' ${OUTPUTS_PATH} && echo PROOF_REQUIRED || echo PROOF_EXEMPT`
    );
    if (required.trim() !== 'PROOF_REQUIRED') {
      f.done('success');
      return;
    }

    // Exact broker binaries travel through authenticated Actions run storage,
    // never through the workspace seed. v1 used actions/download-artifact; the
    // flow has no marketplace actions, so it asks `gh` for the same artifacts.
    const brokerRequired = await f.run(
      `grep -qx 'broker_artifacts_required=true' ${OUTPUTS_PATH} && echo BROKER || echo NO_BROKER`
    );
    if (brokerRequired.trim() === 'BROKER') {
      await f.run(
        `node scripts/pr-proof/resolve-broker-artifacts.mjs --input ${INPUT_PATH}` +
          ` --github-output ${OUTPUTS_PATH}`
      );
      for (const arm of ['base', 'head'] as const) {
        await f.run(
          `set -eu; . ${OUTPUTS_PATH};` +
            ` gh run download "$${arm}_run_id" --repo "$GITHUB_REPOSITORY"` +
            ` --name "$${arm}_name" --dir ${BINARIES}/${arm}`
        );
      }
      await f.run(`node scripts/pr-proof/stage-broker-artifacts.mjs --input ${INPUT_PATH}`);
    }

    // Each arm's agent only runs one trusted command and reports its output; the
    // deterministic gates decide the verdict. So the agent CLI is interchangeable
    // and does not weaken the proof. Claude runs the arms because the Cloud Codex
    // credential can be usage-exhausted, and an exhausted agent fails every PR's
    // proof before its arm ever runs.
    await f
      .agent('base-prover', {
        task: armTask('base', 'Do not reinterpret a crash as bug reproduction.'),
        cli: 'claude',
      })
      .gate({ type: 'regex_match', pattern: 'PR_PROOF_ARM_COMPLETE arm=base', in_output_at: ['summary'] });

    await f.run(`node scripts/pr-proof/verify-evidence.mjs --source cloud --arm base --input ${INPUT_PATH}`);

    await f
      .agent('head-verifier', {
        task: armTask('head', 'Do not manufacture or alter evidence.'),
        cli: 'claude',
      })
      .gate({ type: 'regex_match', pattern: 'PR_PROOF_ARM_COMPLETE arm=head', in_output_at: ['summary'] });

    // Verifies exact SHAs, nonce-bound signatures, and distinct sandbox IDs
    // across both arms, then writes the PASS verdict.
    await f.run(`node scripts/pr-proof/verify-evidence.mjs --source cloud --arm both --input ${INPUT_PATH}`);

    f.done('success');
  }
);
