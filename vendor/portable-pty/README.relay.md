# Vendored `portable-pty`

This directory contains the crates.io release `portable-pty` 0.8.1, published
from upstream Git commit `4afedd626dadd15d9c2929bab0e2063b54f61393`.
The original package metadata is retained in `Cargo.toml.orig` and
`.cargo_vcs_info.json`. The code remains covered by the upstream MIT license in
`LICENSE.md`.

Crates.io source checksum:
`806ee80c2a03dbe1a9fb9534f8d19e4c0546b790cde8fd1fea9d6390644cb0be`.

## Relay delta

The Windows ConPTY output channel alone uses a private, UUID-named, local-only,
non-inheritable byte pipe whose server/read end is opened with `PIPE_NOWAIT`.
The reader preserves `ERROR_NO_DATA` as `WouldBlock`, allowing Relay to order a
completed physical PTY read against verified input admission without blocking
on an idle `ReadFile`. ConPTY input retains upstream's synchronous anonymous
pipe.

The package also includes one Windows-only primitive regression covering prompt
idle reads, cloned-reader behavior, output round-trip, EOF, and handle
noninheritability. `uuid` is the only added dependency; the empty
`cargo-clippy` feature declares the compatibility cfg already present in the
upstream source for modern Cargo check-cfg.

Because this vendored crate is intentionally excluded from the root workspace,
its committed `Cargo.lock` pins the standalone primitive-test dependency graph.
CI invokes that manifest with `--locked`; product builds continue to use the
root lockfile and its path-patched `portable-pty` entry.
