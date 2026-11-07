# Retrospective proof for #1779

This case exercises production Commander dispatch for `local agent attach` and
`local agent message flush|hold|auto`, using a real temporary `connection.json`
and injected health/Fleet responses. It checks that healthy local discovery
prevents the persisted-session/no-placement error, while refused, unhealthy,
and hung brokers still allow Fleet attach. Fake timers verify the 750 ms abort.
It does not contact a real broker or Fleet service.

The historical base is `b1a3777e0` (the parent of #1779's merge commit
`00c5b9d38`). The fix and its health-check review follow-up were squashed into
that merge. The initial verified head is `4340084e6`, which also includes #1755.
This fixture-only follow-up is non-functional: its own PR base already has the
fix, so that base must not be presented as reproducing the historical bug.

Run from the checkout containing this case, with an absolute target checkout:

```sh
RELAY_PR_PROOF_ARM=base \
RELAY_PR_PROOF_TARGET_DIR=/absolute/path/to/pre-1779-checkout \
RELAY_PR_PROOF_RESULT_PATH=/tmp/1779-base.json \
node tests/relayflows/cases/1779-attach-local-broker-fallback/run.mjs

RELAY_PR_PROOF_ARM=head \
RELAY_PR_PROOF_TARGET_DIR=/absolute/path/to/current-checkout \
RELAY_PR_PROOF_RESULT_PATH=/tmp/1779-head.json \
node tests/relayflows/cases/1779-attach-local-broker-fallback/run.mjs
```

The runner installs dependencies if absent, copies the probe into the target,
uses that target's workspace source aliases, and writes an observation only
after all seven assertions pass. Generated probe/config files are removed and
any previous result is cleared before execution. Both correct arms should exit
0; swapping the arms should exit 1 and produce no observation. These commands
run the case locally, not the cloud proof orchestration/evidence upload.
