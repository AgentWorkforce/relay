# RelayFlow regression cases

Each directory here is an end-to-end case that discriminates one feature or
bug fix: a `base` arm that reproduces the missing or broken behavior and a
`head` arm that observes the fixed behavior. The verify-features corpus tier
(`flows/verify/features.spec.ts`) re-runs every case head-only against the
current checkout, and the targeted runner
(`scripts/verify-features/targeted-relayflow-case.mjs`) runs a selected case.
Manifests and observations are validated by
`scripts/verify-features/case-contract.mjs`.

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
  "requirements": [],
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

The runner receives:

- `RELAY_PR_PROOF_ARM`: `base` or `head`
- `RELAY_PR_PROOF_TARGET_DIR`: checkout of the target SHA
- `RELAY_PR_PROOF_HARNESS_DIR`: checkout that contains the case runner
- `RELAY_PR_PROOF_RESULT_PATH`: destination for the observation JSON
- `RELAY_PR_PROOF_BASE_SHA` and `RELAY_PR_PROOF_HEAD_SHA`

The variable names predate this corpus and are kept so existing cases run
unchanged.

> The Rust broker was retired. The case contract still parses a legacy
> `broker-linux-x64` requirement so older case files load, but nothing can
> satisfy it any more. A new case must not declare it, and a case that does
> cannot run.

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

Keep the observation file below 64 KiB and `details` at or below 4,000
characters. Put verbose diagnostics in runner stdout/stderr.

Cases should exercise public/production behavior. A unit test added only on the
head cannot prove the base is broken because “test not found” is not a valid
observation. Prefer an external harness that builds the target checkout and
drives its CLI, broker, protocol, or API.
