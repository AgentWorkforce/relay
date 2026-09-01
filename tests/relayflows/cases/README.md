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

The same runner from the exact PR head is executed against both target SHAs.
The wrapper supplies:

- `RELAY_PR_PROOF_ARM`: `base` or `head`
- `RELAY_PR_PROOF_TARGET_DIR`: checkout of the target SHA
- `RELAY_PR_PROOF_HARNESS_DIR`: checkout of the exact head SHA
- `RELAY_PR_PROOF_RESULT_PATH`: destination for the observation JSON
- `RELAY_PR_PROOF_BASE_SHA` and `RELAY_PR_PROOF_HEAD_SHA`

Rust broker behavior cases can declare `"requirements": ["broker-linux-x64"]`.
The trusted dispatcher then resolves Linux broker artifacts built from the exact
base and head SHAs, verifies their source-SHA manifests and SHA-256 digests,
and supplies the selected executable as `RELAY_PR_PROOF_BROKER_BINARY`. The
runner should invoke that binary directly instead of rebuilding it in Cloud.
Cases without this requirement receive no broker binary.

The broker producer deliberately performs a cold Rust build: it never restores
or saves a Cargo build cache. Cargo and PR-authored build scripts run under a
fresh dedicated OS user with no supplemental groups or capabilities, an empty
environment, `no_new_privs`, empty inheritable, permitted, effective, bounding,
and ambient capability sets, a read-only checkout, and isolated writable Cargo
home, target, home, and temporary build directories delegated beneath a
runner-owned private root. GitHub Actions cache/runtime credentials and
the workflow command files (`GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT`, and
`GITHUB_STEP_SUMMARY`) are not exposed, and stdout workflow commands are
suspended around the build. Cleanup kills processes matching either the
builder's effective or real UID and verifies none remain, including on build
failure. Workflow-command parsing is restored only after that zero-process
proof succeeds. Each process probe must return exactly the documented
no-matches status. The trusted runner performs those probes as root so a
`hidepid` mount cannot conceal builder-owned processes, maps match/no-match/error
to distinct sentinel statuses, and accepts only two no-match sentinels. The root
probe is non-interactive and runs with a clean, fixed environment and executable
path. Probe or privilege-escalation errors therefore fail closed rather than
masquerading as an empty process set. A reap failure keeps parsing suspended and
takes precedence over the original build status. Only after successful cleanup
does the trusted runner copy the final regular broker file into runner-owned
staging for packaging. The 30-minute producer deadline includes this cold-build
cost; the dispatcher resolver adds separate queue and build headroom.

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
characters. Put verbose diagnostics in runner stdout/stderr; the wrapper keeps
bounded tails of both streams in the evidence record.

Cases should exercise public/production behavior. A unit test added only on the
head cannot prove the base is broken because “test not found” is not a valid
observation. Prefer an external harness that builds the target checkout and
drives its CLI, broker, protocol, or API.

The wrapper independently attests the exact harness and target checkouts, the
runner process exit, structured observation, handoff nonce, and Cloud sandbox
identity. The case program and its semantic assertion are still PR-authored
test code. As with any new test in a pull request, a reviewer must inspect the
runner and confirm that it actually drives `RELAY_PR_PROOF_TARGET_DIR` and that
its red/green signatures express the claimed behavior. No generic runner can
prove the honesty of arbitrary test code; this check supplies reproducible
review evidence and is not a replacement for required code review.

For broker cases, the wrapper's additional guarantee ends at artifact
provenance and executable immutability. It copies the verified bytes to a
stable private path, closes every broker file descriptor, and launches the case
under a fail-closed Landlock policy that denies writes, truncation, removal,
replacement, renames, and hard links outside the case's explicit writable
directories. The stable path means broker self-spawns through
`current_exe()` keep working. The wrapper verifies the broker's link count,
mode, size, and digest again after the runner exits. Landlock does not mediate
`chmod`; a runner can change the mode and make its own proof fail, but cannot
use that mode change to bypass the content and path-mutation policy.

The PR-authored runner still chooses whether and how to launch that executable,
including its arguments and environment. Reviewers must therefore confirm that
the case invokes the supplied path directly with a neutral dynamic-loader
environment and that the asserted behavior comes from that process. The Cloud
sandbox must provide `/usr/bin/python3`, Landlock ABI 3 or newer, and no
effective `CAP_SYS_PTRACE` or `CAP_SYS_ADMIN`; the wrapper fails closed when
those prerequisites are absent.

Broker artifacts are retained for 90 days. A PR that remains on the same base
and head longer than that must be updated or rebased onto current `main`, then
receive a refreshed head push before rerunning the proof. The trusted producer
does not accept arbitrary historical SHAs for rebuild; push and scheduled
builds keep current `main`, and same-repository PR events keep current heads,
recoverable without widening the workflow's artifact provenance boundary.

## Execution and security

The `pull_request_target` workflow checks out only the trusted base. It fetches
and validates the case manifest as data, then submits the trusted
`workflows/pr-proof.ts` RelayFlow. PR code runs only in the two Cloud agent
sandboxes. Each prover uploads structured evidence through the run-scoped Cloud
storage API; the case runner never receives Cloud credentials. A cryptographic
nonce generated by the trusted dispatcher binds both handoffs to the current
run. The base proof must pass its deterministic evidence gate before the head
sandbox is launched, and the final gate rejects a stale nonce, identical
sandbox IDs, or incorrect commit provenance.

The RelayFlow is explicitly fail-fast with zero retries. Automatic repair
agents are disabled: a rejected observation is evidence to report, never an
invitation to edit the harness or artifacts until the gate passes.

The action temporarily adds the generated `.relayflow/pr-proof-input.json` and,
when requested, the verified exact-SHA broker binaries to the runner's git
index because Cloud code sync uploads git-known paths. It does not commit or
push the generated files.

Fork PRs do not receive Cloud credentials. A maintainer must reproduce the
change and its case on a same-repository branch before merge. Non-functional
fork PRs can still complete the stable status without entering a
credential-bearing step.

## Enabling the required check

The repository needs a dedicated non-refreshing Cloud API key in these GitHub
secrets:

- `CLOUD_API_URL`
- `RELAYFLOW_PR_PROOF_CLOUD_API_KEY`

Use a workspace-scoped, least-privilege credential that can prepare, invoke,
read, and cancel workflow runs. Do not copy a human laptop session into CI.
The dispatcher passes one API key to every CLI subprocess and removes any
legacy refreshable-auth environment variables. API-key auth never refreshes or
opens an interactive login; Cloud enforces its workspace binding, scopes,
expiry, and revocation server-side. A `401` fails the proof and requires an
operator to rotate the dedicated key.

`pull_request_target` itself is attached to the base SHA, so the dispatcher
publishes a separate stable commit-status context named `RelayFlow PR proof` on
the exact PR head SHA. Require that context—not the dispatcher job name—on
`main` branch protection.

GitHub loads `pull_request_target` workflow code from the default branch. Merge
this infrastructure PR and publish the resulting Agent Relay package before
running the live canary on a subsequent feature or bug-fix PR. The published
CLI emits an opt-in prepared-run marker so the dispatcher can cancel remote
work even if submission is interrupted before its final JSON response. Require
the status context only after that canary proves the credential, Cloud handoff,
submission cancellation, and red/green case end to end.

The final status step also runs during cancellation. Each run attempt gets a
distinct owner URL. Before publishing a terminal state, it verifies that the
current attempt still owns the latest pending `RelayFlow PR proof` context.
The workflow-level PR concurrency group serializes that compare-and-write with
the replacement's start step, so a cancelled predecessor cannot overwrite a
replacement run.
