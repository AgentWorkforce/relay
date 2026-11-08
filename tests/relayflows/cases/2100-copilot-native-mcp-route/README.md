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

The verify-features wrapper supplies the existing case variables. Its head-only corpus run sets base and head to the same current SHA; that is accepted only for the head arm. A base arm still requires distinct revisions. Manifests and observations are validated through `scripts/verify-features/case-contract.mjs`, which is included in the consumed harness inputs. For a local run, set those
variables to the exact base/head checkouts and commit IDs. An optional
`RELAY_PR_PROOF_CARGO_TARGET_DIR` lets the two local builds reuse one dedicated
Cargo target directory outside both the target and harness checkouts. The runner resolves existing and dangling symlink ancestors before creating scratch/build output, refusing a destination inside either checkout. Without it, all build output and consumer storage stay
in one temporary directory that the runner removes. Both child duration and
output are bounded through the trusted `scripts/verify-features/process-runner.mjs` process-tree runner, so Cargo/compiler descendants are terminated on timeout. The runner verifies checkout identities and rejects dirty consumed target crate or head-harness inputs before and after compilation/runtime. Tracked, staged, untracked and ignored source additions are checked; assume-unchanged and skip-worktree index flags on consumed files are refused even if Git status hides the dirty bytes; unrelated wrapper staging of `.relayflow/pr-proof-input.json` is allowed. The result path also stays outside both checkouts.

This proves the public routing fix. It does not claim that private account
attestation, hosted MCP delivery, Copilot wake or session upload has completed
end to end.

Run the guard regressions without building the production fixture:

```sh
node --test tests/relayflows/cases/2100-copilot-native-mcp-route/guards.test.mjs
```

These test output-path refusal before writes/Cargo, source integrity in both phases (including real Git index-flag regressions), sanitized child environment and timeout cleanup of a parent/compiler-shaped process tree. The actual-runner negative tests use a mock compiler only to reach the post-runtime refusal; they must never publish a result receipt and are not routing proof. The accepted base/head observations still require the real Rust consumer above.

Cleanup verification requires a successful live-self `ps` canary before interpreting a child no-match. Spawn errors, signals, timeouts, stderr, unexpected exit codes and malformed/missing states fail the test; unavailable `ps` never counts as a stopped child. The parent/compiler timeout test uses a five-second startup budget inside its fifteen-second test limit; production case subprocess deadlines are unchanged.

The canonical `TMPDIR`/scratch parent must be outside both checkouts before
`mkdtemp` creates anything; the created scratch path is checked again. This
keeps the external consumer from inheriting an uncommitted checkout-local
`.cargo/config.toml` through its working-directory ancestors.

Receipt output reserves a fresh, exclusive file handle before compilation and
revalidates its parent/file identity before and after writing through that
handle. Existing receipts or source files are never opened for truncation. A
local rerun must use a fresh result filename. A failed run may leave an empty
reserved placeholder: it is not JSON evidence, and the shared wrapper refuses
a nonzero runner before reading the observation.

The wrapper supplies a fresh private output directory with one trusted writer;
local runs require the same single-writer boundary on a local filesystem. The
handle and observed-path checks do not claim absolute immunity from a hostile
same-UID process mutating the filesystem between every operation. Parent-swap
negative tests preserve the tracked checkout victim and publish no observation;
their mock compiler is never accepted as real routing evidence.

Runner `SIGTERM` and `SIGINT` are forwarded through an AbortSignal to the trusted
process-tree runner. Listeners remain installed until the child settles, are then
removed, and interruption fails the proof while closing its reserved receipt.
Real helper/parent/compiler regressions cover both signals; they publish no
observation and use the same strict process-state verification.

The case defaults to a one-second inner termination grace, below the shared
wrapper's five-second hard-kill grace, so an ignoring Cargo/compiler group is
killed before the wrapper can kill the case runner. Both signal regressions
exercise that default with parent and compiler processes that ignore TERM.

All provenance Git queries disable `core.fsmonitor` for that command without
changing checkout settings. A stale monitor can otherwise keep ordinary `H`
index tags while hiding changed working bytes. Real stale-hook regressions
cover both target and harness checks before and after runtime.
