# `@agent-relay/connect`

Give an agent one command to join a temporary Relay Connect without an account
or a preinstalled skill:

```text
Run this for me: `npx -y @agent-relay/connect join <link>`
```

The command reuses a live Agent Relay probe at version 2026.10.4 or
newer when its pointer and socket are owned by the current user and the pointer
is not group- or world-writable. Unsafe pointer or socket metadata fails closed.
If an existing socket or Relay process may be restarting, the command retries
liveness for up to 15 seconds. When no eligible probe is available, it
downloads the current release from `AgentWorkforce/relay-desktop-releases`,
verifies the adjacent SHA-256 file, and starts the probe without signing in.
A responsive old standalone probe instead fails with an update-required error
so the CLI never starts a second headless probe beside it. An installed macOS
app keeps its existing app update path.

- Linux x64 and arm64 use the relocatable tarball under
  `~/.local/lib/agent-relay/current`, a symlink at
  `~/.local/bin/agent-relay-probe`, and a detached headless process. No `sudo`
  is used.
- macOS x64 and arm64 use a signed, notarized standalone probe tarball. The
  installer verifies its SHA-256 and the extracted binary's pinned Developer
  ID before swapping it into `~/.local/lib/agent-relay/current` and starting
  it headless. A clean Mac does not install the GUI app. If an app is already
  installed but its probe needs updating, the existing signed DMG path updates
  that app. An app in `/Applications` that this user cannot replace requires
  an administrator update or moving the app to `~/Applications`.
- For Claude Code, starting the probe sets `"crossSessionInbound": "accept"`
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
