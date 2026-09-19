# PR proof for #1801

A second `node up` on one machine used to adopt the machine-global enrollment
and register under the same node id a live local broker already served. The
engine hands the node's Cloud delivery socket to whichever registered last, so
the first broker kept running and reporting healthy while its deliveries
silently stopped — observed live when a test node stole a production node's
socket twice and deliveries queued but never injected.

This case proves the operator-facing half of the fix: `node up` refuses to
start while a machine-global claim names a live broker pid, before any broker
is spawned.

## How

The probe registers the real `node` command group and invokes `node up` with:

- a claim generation file (`node-claims/node_abc.000001.json`) written under a
  scratch `AGENT_RELAY_HOME`, naming this test process's live pid as holder —
  the same layout `nodeClaimPath()` writes;
- a stubbed enrollment resolving to `node_abc`;
- `broker-lifecycle.js` mocked only at `runUpCommand`, so "the broker would
  have spawned" is observable without spawning anything.

On base there is no claim check: `runNodeUp` resolves the enrollment and calls
`runUpCommand` — the bug. On head `guardEnrolledNodeIdentity` reads the held
claim, prints the refusal (holder pid, state dir, `node down` / distinct
enrollment / `--force` remedies) and exits 1 before `runUpCommand`.

The deeper ownership machinery this PR adds — exclusive generation creation,
tombstones, inherited hold-descriptor fencing across the spawn→`connection.json`
window, recycled-pid and launcher-script classification — is covered by the
branch's unit suites with real processes (`node-claim.test.ts`,
`broker-lifecycle.test.ts`, `broker-process.test.ts`), not by this probe:
`node-claim.ts` does not exist on the base, so those paths cannot be exercised
on both arms.

Run from the checkout containing this case, with an absolute target checkout:

```sh
RELAY_PR_PROOF_ARM=base \
RELAY_PR_PROOF_TARGET_DIR=/absolute/path/to/pre-1801-checkout \
RELAY_PR_PROOF_RESULT_PATH=/tmp/1801-base.json \
node tests/relayflows/cases/1801-node-up-enrollment-guard/run.mjs

RELAY_PR_PROOF_ARM=head \
RELAY_PR_PROOF_TARGET_DIR=/absolute/path/to/current-checkout \
RELAY_PR_PROOF_RESULT_PATH=/tmp/1801-head.json \
node tests/relayflows/cases/1801-node-up-enrollment-guard/run.mjs
```

Both correct arms exit 0 and write their observation; swapping the arms fails
the probe and produces no observation.
