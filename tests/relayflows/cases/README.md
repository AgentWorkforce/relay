# PR-specific RelayFlow cases

Every Relay feature or bug-fix PR owns exactly one Cloud proof case in this
directory. The case is selected from the PR body and is the only expensive
Cloud scenario the PR check runs.

Every PR must explicitly classify itself in the PR template. Runtime-neutral
changes declare `non-functional` and `n/a`; missing classification fails the
check instead of being silently treated as runtime-neutral.

## Required files

Create `tests/relayflows/cases/<case-id>/case.json` plus the runner named by its
`runner.command`:

```json
{
  "version": 1,
  "id": "1591-application-ack-reconnect",
  "kind": "bugfix",
  "title": "Reconnect when application acknowledgements stop",
  "runner": {
    "command": ["node", "tests/relayflows/cases/1591-application-ack-reconnect/run.mjs"]
  },
  "timeoutSeconds": 900,
  "expected": {
    "base": {
      "outcome": "bug",
      "signature": "application_ack_stall_not_detected"
    },
    "head": {
      "outcome": "fixed",
      "signature": "application_ack_stall_reconnects"
    }
  }
}
```

Feature cases use `"absent"` for the base outcome and `"fixed"` for head.
Bug-fix cases use `"bug"` and `"fixed"`.

## Runner contract

The same runner from the exact PR head is executed against both target SHAs.
The wrapper supplies:

- `RELAY_PR_PROOF_ARM`: `base` or `head`
- `RELAY_PR_PROOF_TARGET_DIR`: checkout of the target SHA
- `RELAY_PR_PROOF_HARNESS_DIR`: checkout of the exact head SHA
- `RELAY_PR_PROOF_RESULT_PATH`: destination for the observation JSON
- `RELAY_PR_PROOF_BASE_SHA` and `RELAY_PR_PROOF_HEAD_SHA`

The runner must finish with exit code zero after observing behavior and write:

```json
{
  "version": 1,
  "caseId": "1591-application-ack-reconnect",
  "arm": "base",
  "outcome": "bug",
  "signature": "application_ack_stall_not_detected",
  "details": "WebSocket pongs continued but inventory.sync was never acknowledged."
}
```

Expected-red is data, not a failing process. A non-zero runner exit, missing
result, timeout, skipped test, missing test name, or build error is an
infrastructure failure and cannot prove the bug.

Cases should exercise public/production behavior. A unit test added only on the
head cannot prove the base is broken because “test not found” is not a valid
observation. Prefer an external harness that builds the target checkout and
drives its CLI, broker, protocol, or API.

## Execution and security

The `pull_request_target` workflow checks out only the trusted base. It fetches
and validates the case manifest as data, then submits the trusted
`workflows/pr-proof.ts` RelayFlow. PR code runs only in the two Cloud agent
sandboxes. The base proof must pass its deterministic evidence gate before the
head sandbox is launched, and the final gate rejects identical sandbox IDs or
incorrect commit provenance.

The RelayFlow is explicitly fail-fast with zero retries. Automatic repair
agents are disabled: a rejected observation is evidence to report, never an
invitation to edit the harness or artifacts until the gate passes.

The action temporarily adds the generated `.relayflow/pr-proof-input.json` to
the runner's git index because Cloud code sync uploads git-known paths. It does
not commit or push the generated file.

Fork PRs do not receive Cloud credentials. A maintainer must reproduce the
change and its case on a same-repository branch before merge.

## Enabling the required check

The repository needs a dedicated Cloud CLI session in these GitHub secrets:

- `CLOUD_API_URL`
- `RELAYFLOW_PR_PROOF_CLOUD_ACCESS_TOKEN`
- `RELAYFLOW_PR_PROOF_CLOUD_REFRESH_TOKEN`
- `RELAYFLOW_PR_PROOF_CLOUD_ACCESS_TOKEN_EXPIRES_AT`
- `RELAYFLOW_PR_PROOF_CLOUD_REFRESH_TOKEN_EXPIRES_AT` (optional until refresh)

Use a workspace-scoped, least-privilege credential that can prepare, invoke,
read, and cancel workflow runs. Do not copy a human laptop session into CI.
After a live canary PR proves the check, require the stable `RelayFlow PR proof`
job on `main` branch protection.
