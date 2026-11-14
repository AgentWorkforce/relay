# Agent Relay node (`agent-relay-node`)

`crates/relay-node` is the Agent Relay **core**: the native Rust daemon that
discovers the coding-agent sessions running on a computer (Claude Code, Codex,
Devin, OpenCode, Grok, Pi, Cursor CLI, OpenClaw, Hermes, Muse, …), puts them
on the relay, and injects Relay messages into them through each harness's own
native route (hooks, app servers, plugins and sockets, not a PTY). It provides
messaging and native agent spawning. It builds one binary, `agent-relay-node`,
which runs as one long-lived process per user:

```sh
agent-relay-node serve [--socket PATH] [--app-data-dir PATH] [--headless]
```

`relay init` installs and runs it headless. The desktop apps (macOS,
Linux/Windows GTK and iPad, in the relay-desktop repository) are clients of the
daemon over its JSON bridge, and build their own binary on this crate's library
with what they add through its plugins.

- [`docs/relay-core.md`](docs/relay-core.md): the daemon, its bridge
  contract, delivery and the relay-send socket.

For a headless server joining the same Cloud workspace as Desktop, use the
[account-aware Linux service setup](../../docs/headless-server.md). The
standalone core has no account sign-in plugin: `serve --headless` alone does
not turn a CLI Cloud enrollment into a live Desktop spawn target.

## Layout

This crate is its **own Cargo workspace** with its own `Cargo.lock`. It is not
a member of the repository's root workspace (the broker): the two pin
different `relaycast`, `nix` and `portable-pty` versions.

| Path                                | Owns                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/cli/`                          | The `agent-relay-node` command line: the node's commands and `connect …`                                                                                                 |
| `src/relay/`                        | The daemon (`serve`): workspace, Relaycast, delivery and injection per harness, harness setup (hooks/plugins), spawning, the bridge and its contract (`relay::contract`) |
| `src/bin/relay-contract-codegen.rs` | Generates the Swift bridge contract the apps consume                                                                                                                     |
| `contract/CoreContract.swift`       | The checked-in generated contract; CI fails on drift                                                                                                                     |
| `scripts/`                          | `generate-contract.sh`, `check-open-source.sh`                                                                                                                           |
| `tests/`                            | Integration tests, with in-process fakes of Cloud and Relaycast (`tests/support`)                                                                                        |

## What a build adds

The core runs with `daemon::Plugins`, each of which defaults to doing
nothing. A build such as relay-desktop's `desktop-core` adds:

| Seam                                       | What it is                                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Plugins.account` (`AccountPlugin`)        | Sign-in and Cloud maintenance                                                                                                           |
| `Plugins.session_policy` (`SessionPolicy`) | Which sessions join the relay by themselves, may be asked to join, and publish their activity                                           |
| `Plugins.settings` (`SettingsExtension`)   | Extra settings, such as `history_retention_days`                                                                                        |
| `Plugins.extensions` (`MethodExtension`)   | Extra bridge methods                                                                                                                    |
| `Plugins.history_version`                  | The session-history library release `status.get` reports                                                                                |
| `PluginBuilder.session_sources`            | `session_sources::SessionSources`: remote sessions (Devin Cloud, Claude Code on the web) it lists and delivers into, and Hermes's homes |

Without them the core is the whole messaging runtime: `agent-relay-node serve`
(discovery, native delivery and injection into running sessions, harness
setup and hooks, Relaycast and the workspace, spawning, the bridge and its
contract), `call`, the harness hooks and `connect`. The account methods
answer `method_not_found`, and the core uses the workspace the `agent-relay`
CLI selects (`src/relay/workspace/cli.rs`), with no sign-in needed.

## Register the calling session

After the person authorizes joining, a native chat can use the exact probe and
session socket provided by its core:

```sh
agent-relay-node register --socket /path/to/relay.sock --name review-bot --description 'Reviews releases'
```

The core identifies the native chat from the connecting process, not a supplied
session ID. Its self-registration setting and ownership checks still apply.
`--mcp agent-relay-sessions` or `--mcp none` optionally declares whether that
chat has the hosted session tools. Registration takes no raw JSON or stdin.
Codex's generated allow rule permits this typed command only on the core's own
socket; generic `socket-request` remains outside those rules.

## Claude mobile continuation

On macOS and Linux, Claude Code terminal sessions can receive the verified owner's
mobile messages as native user turns through Relay's plugin. Agent SDK,
`claude --print` and pipe-driven sessions, including app-hosted chats, keep their
ordinary peer inbox instead: their host owns the input and interrupt lifecycle. Turning mobile continuation on does not
replace that inbox. A native submission refused after Stop or by a host limit
is reported without automatic replay; unknown outcomes are never resubmitted.
Native mobile continuation is unavailable on Windows.

## Build and test

```sh
cargo build --manifest-path crates/relay-node/Cargo.toml --locked
cargo build --manifest-path crates/relay-node/Cargo.toml --locked --release --bin agent-relay-node
# Tests read and write under HOME: use an empty one, keeping the toolchain
# (rustup and cargo) where it was installed under the real HOME.
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}" CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
HOME="$(mktemp -d)" cargo test --manifest-path crates/relay-node/Cargo.toml --locked
```

`.github/workflows/relay-node-ci.yml` builds and tests on Linux x64 and macOS
arm64, builds on Windows x64, checks the generated contract for drift and runs
`scripts/check-open-source.sh`.

### Releasing the CLI and node

`.github/workflows/publish.yml` versions the CLI and node together. It builds
`agent-relay-node` for Linux x64/ARM64, macOS x64/ARM64 and Windows x64, stamps
the CLI version into each binary, and verifies the native builds report it.
The `v<version>` GitHub release contains
`agent-relay-node-<version>-<os>-<arch>[.exe]` and a `.sha256` sidecar for each
binary. All five binaries and their checksums must be available, and broker
smoke tests must pass, before any npm package is published. The release stays
off GitHub's latest release until npm publication and post-publish verification
succeed; only then can the workflow advance the release branch and promote a
stable release. Dry runs build and check the artifacts without creating a
release or publishing packages.

Retries reuse a release only when its tag records the same source commit and
package mode. Use a new version when switching from `sdk` or `cli-prerelease`
mode to `all` or `main`. The `sdk` and `cli-prerelease` modes do not replace
GitHub's latest release or advance the release branches.

`relay init` downloads the node from its own CLI version's release. There is
no independently selected node version or separate node release workflow.

### Version stamping

`build.rs` stamps `agent_relay_node::VERSION` (what the daemon reports in its
bridge handshake, telemetry and Relaycast `origin_version`):

| Build                                                              | `VERSION`                                                                                                                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_RELAY_PROBE_VERSION=X` set                                  | `X` exactly: a relay release passes the relay version, relay-desktop passes its CalVer (`2026.10.58`)                                                                              |
| unset, `AGENT_RELAY_PROBE_BASE_VERSION=B` set                      | `B-dev+<git revision>`: development cores still order below the builder's next release                                                                                             |
| unset, no `B`, `AGENT_RELAY_PROBE_CHANGELOG=P` (absolute path) set | `<newest non-empty "## v" heading of P>-dev+<git revision>`: relay-desktop sets this from `.cargo/config.toml`; an unreadable `P`, or one with no release heading, fails the build |
| none of these                                                      | `<crate version>-dev+<git revision>`                                                                                                                                               |

The revision comes from the builder's checkout when `AGENT_RELAY_PROBE_GIT_DIR`
names one (relay-desktop's, from `.cargo/config.toml`), else from this crate's.
The internal Cargo package version is never reported as a release on its
own. On Windows, `AGENT_RELAY_WINDOWS_ICON` additionally embeds an icon and
version resource.

### The bridge contract

The bridge's methods, events and types are declared once in Rust
(`src/relay/contract`). `relay-contract-codegen` turns the registry into
Swift:

```sh
crates/relay-node/scripts/generate-contract.sh                        # crates/relay-node/contract/CoreContract.swift
crates/relay-node/scripts/generate-contract.sh --app-root ../relay-desktop  # relay-desktop's macos/Sources/RelayDesktopCore/CoreContract.swift
crates/relay-node/scripts/generate-contract.sh --out /tmp/CoreContract.swift
```

## How relay-desktop consumes the core

- **Rust:** relay-desktop's `desktop-core` and GTK app depend on
  `agent-relay-node` as a library (a git dependency pinned to a relay commit,
  `default-features = false`). `desktop-core` adds the account, session
  history and its own binary through the seams above.
  When adopting a Relay release, pin both desktop Cargo manifests to the
  commit resolved by its `v<version>` tag, refresh both lockfiles, and regenerate
  the Swift contract. This uses the same core source as the CLI's node;
  the desktop still stamps its own application version.
- **Swift (macOS/iPad):** `CoreContract.swift` comes from
  `contract/CoreContract.swift` (or `generate-contract.sh --app-root`).

One core runs per machine: whichever installed it (the relay CLI or a desktop
app), the apps attach to the running daemon's socket.
