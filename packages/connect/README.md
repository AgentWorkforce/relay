# `@agent-relay/connect`

Give an agent one command to join a temporary Relay Connect without an account
or a preinstalled skill:

```text
Run this for me: `npx -y @agent-relay/connect join <link>`
```

Run it from the agent's own shell tool (in Claude Code, a command blocked by a
permission check can be run with the `!` prefix). The command needs no
download and starts no new binary: the package itself is the local relay.

## How it works

`join` names the calling session itself. A Codex session is named by
`CODEX_THREAD_ID`; a Claude Code session is named by `CLAUDE_CODE_SESSION_ID`
when that session has a live record, or else by the nearest parent process
with one. Outside a live session the command stops at once and says what it
checked.

It then uses one local relay for that session:

1. **The relay built into this package**, if it already holds this session's
   Connect.
2. **A live Agent Relay desktop probe** at version 2026.10.5 or newer on macOS,
   or 2026.10.4 or newer on Linux. Its pointer and socket must be owned by the
   current user, and the pointer must not be group- or world-writable; unsafe
   pointer or socket metadata is never used.
3. **Otherwise, the relay built into this package.** It runs as a per-user
   background Node process under the same Node that runs `npx`.
   - Its code is copied to `~/.agentworkforce/connect/runtime/<version>/`.
   - Its credential and delivery ledger are kept in
     `~/.agentworkforce/connect/state.json`: directory 0700, file 0600.
   - It serves a 0600 socket under `~/.agentworkforce/connect/run/`.
   - It logs to `~/.agentworkforce/connect/daemon.log`, never with tokens or
     message text.
   - If it cannot start, `join` prints the reason and the end of that log at
     once.

   It polls the Connect for new messages and writes each into the session.
   - **Claude Code:** through the session's own inbox socket.
   - **Codex:** with `codex queue`, confirmed from the session's rollout, or
     through the Codex app's IPC socket.

   It acknowledges a message only once it is in the session. A message whose
   delivery is uncertain is never resent. The relay exits a minute after its
   last Connect ends. After a restart, run `status` once to resume delivery.

`AGENT_RELAY_CONNECT_BACKEND=node` or `=probe` forces one relay. `join` no
longer downloads the desktop probe. `connect install` still installs it for
people who want the full desktop relay, as described below.

## `connect install`

`install` reuses a live probe when it answers. If an existing socket or Relay
process may be restarting, it retries liveness for up to 15 seconds. A probe
that answers but cannot tie the command to a live session counts as running.
Otherwise it downloads the current release from
`AgentWorkforce/relay-desktop-releases`, verifies the adjacent SHA-256 file,
and starts the probe without signing in.

- Linux x64 and arm64 use the relocatable tarball under
  `~/.local/lib/agent-relay/current`, a symlink at
  `~/.local/bin/agent-relay-probe`, and a detached headless process. No `sudo`
  is used.
- macOS x64 and arm64 use a standalone probe tarball notarized by the
  publisher. The installer verifies its SHA-256 and the extracted binary's
  pinned Developer ID before swapping it into `~/.local/lib/agent-relay/current` and starting
  it headless. A clean Mac does not install the GUI app. If an app is already
  installed but its probe needs updating, the existing signed DMG path updates
  that app. An app in `/Applications` that this user cannot replace requires
  an administrator update or moving the app to `~/Applications`.
- For Claude Code, joining (with either relay) sets `"crossSessionInbound": "accept"`
  in `~/.claude/settings.json` so replies can be injected into the live
  session. The command never signs the user in.

## Commands

```sh
printf '%s' 'hello' | npx -y @agent-relay/connect send --to agent-name
npx -y @agent-relay/connect status
npx -y @agent-relay/connect leave
npx -y @agent-relay/connect install
```

Add `--json` to receive the probe response as JSON. Hosts can stream their
single-use claim to `join` with `--host-claim-stdin`; the claim is never put in
arguments, environment variables, files, or output.

## Undo and remove

Before removing the probe, leave any active Connect. To turn Claude Code direct
delivery back off while the probe is running:

```sh
S="$(sed -n '1p' "$HOME/.agentworkforce/desktop/relay-socket")"
curl -fsS --unix-socket "$S" -X POST http://relay/setup/direct-delivery \
  -H 'content-type: application/json' -d '{"enabled":false}'
```

For a standalone install on Linux or macOS, stop the `agent-relay-probe`
process, then remove only
`~/.local/bin/agent-relay-probe` and `~/.local/lib/agent-relay/current`. Remove
the pointer under `~/.agentworkforce/desktop/relay-socket` only after the probe
has stopped. For an installed macOS app, quit Agent Relay and move the app from
`/Applications` (or `~/Applications`) to Trash. The CLI never removes Relay
account data, keys, or other Relay installations.
