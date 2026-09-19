# PR proof: layered `workspace_busy` retry ownership

relaycast SDK 8.0.1 retries a workspace-admission denial itself, sleeping the
server's `Retry-After` between its attempts, and reports `attempts` and
`retry_after_ms` on the terminal error. The broker already had its own
`workspace_busy` retry loops on top. Bumping the SDK without changing those
loops stacked the two layers: the broker slept a fixed second between rounds
whatever the server had asked for, capped _rounds_ rather than requests, and
reported its round count as `attempts` — a number the server never saw.

This PR gives each layer what only it can see: the SDK owns pacing (it reads
the headers), the broker owns the budget (it knows the handshake deadline).
The broker sleeps the SDK-reported `Retry-After` between rounds, never less
than the one-second admission minimum, caps total requests, and reports the
true total.

## How

The probe runs the compiled broker's `init` against a stand-in Relaycast that
answers `POST /v1/agents` with `429 workspace_busy` and `Retry-After: 2`,
recording when each registration request arrives:

- `busy-success`: only the first request is denied. Both arms complete the
  handshake on the second request; the gap between them shows whether the
  cooldown was honoured.
- `busy-exhaustion`: every request is denied until the broker's startup
  budget is spent. Both arms fail with the typed `workspace_busy` diagnostic;
  the gaps show the cadence and `attempts: N` is compared against the number
  of requests the server actually received.

On base (relaycast 8.0.0, no SDK retry) the broker cannot see `Retry-After`
and re-sends after its fixed one-second minimum — inside the advertised
cooldown — which is the bug signature. On head no retry arrives inside the
cooldown, `attempts` equals the server's request count, and the total stays
under the startup request cap.

Run from the checkout containing this case:

```sh
RELAY_PR_PROOF_ARM=base \
RELAY_PR_PROOF_TARGET_DIR=/absolute/path/to/base-checkout \
RELAY_PR_PROOF_HARNESS_DIR=/absolute/path/to/head-checkout \
RELAY_PR_PROOF_BROKER_BINARY=/absolute/path/to/base/agent-relay-broker \
RELAY_PR_PROOF_BASE_SHA=<base sha> \
RELAY_PR_PROOF_RESULT_PATH=/tmp/pacing-base.json \
node tests/relayflows/cases/workspace-busy-layered-retry-ownership/run.mjs
```

and again with `RELAY_PR_PROOF_ARM=head`, the head checkout, binary and SHA.
