# Native Copilot outer-route proof

The exact-head Node runner builds the same `fixture.rs` as an external Rust
consumer of `RELAY_PR_PROOF_TARGET_DIR/crates/relay-node`, with default features
disabled. It seeds the consumer lockfile from that target and never edits the
target. This is the production core library, not the legacy broker artifact or
a test that exists only on head. Cargo and Rust must be available in the proof
sandbox; a missing compiler or build error fails the proof.

The fixture supplies explicit private `Config.home` and `app_data_dir` paths,
an empty core environment and a fake account plugin. It calls the public
`Outbound::handle` directly. It does not start a daemon, connect a socket,
initialize MCP, discover a provider or change the process HOME. Dependencies may
be fetched during compilation. No provider or Relay credentials enter children.

The observed base must return `404/not_found` for native MCP initialization,
without invoking the account. The observed head must preserve the initialize
request ID and return the fake managed account's result. Wrong UID and PID must
reach the fake account unchanged and receive its `403` refusal. No-account and
explicitly declining accounts must receive `409/copilot_dispatch_unavailable`,
even with a non-JSON body; GET remains `404`. The existing Claude attestation
route must return `409/attestation_unavailable` in both arms as a router control.
The Rust program contains no arm-dependent expectations. Node accepts only the
complete closed response matrix, and errors are never converted to bug data.

The wrapper supplies all standard proof variables. For a local run, set those
variables to the exact base/head checkouts and commit IDs. An optional
`RELAY_PR_PROOF_CARGO_TARGET_DIR` lets the two local builds reuse one dedicated
Cargo target directory outside both the target and harness checkouts. The runner resolves existing and dangling symlink ancestors before creating scratch/build output, refusing a destination inside either checkout. Without it, all build output and consumer storage stay
in one temporary directory that the runner removes. Both child duration and
output are bounded through the trusted `scripts/pr-proof/process-runner.mjs` process-tree runner, so Cargo/compiler descendants are terminated on timeout. The runner verifies checkout identities and rejects dirty consumed target crate or head-harness inputs before and after compilation/runtime. Tracked, staged, untracked and ignored source additions are checked; unrelated wrapper staging of `.relayflow/pr-proof-input.json` is allowed. The result path also stays outside both checkouts.

This proves the public routing fix. It does not claim that private account
attestation, hosted MCP delivery, Copilot wake or session upload has completed
end to end.

Run the guard regressions without building the production fixture:

```sh
node --test tests/relayflows/cases/2100-copilot-native-mcp-route/guards.test.mjs
```

These test output-path refusal before writes/Cargo, source integrity in both phases, sanitized child environment and timeout cleanup of a parent/compiler-shaped process tree. The actual-runner negative tests use a mock compiler only to reach the post-runtime refusal; they must never publish a result receipt and are not routing proof. The accepted base/head observations still require the real Rust consumer above.
