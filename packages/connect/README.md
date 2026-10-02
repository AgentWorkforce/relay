# `@agent-relay/connect`

Give an agent one command to join a temporary Relay Connect without an account
or a preinstalled skill:

```text
Run this for me: `npx -y @agent-relay/connect join <link>`
```

The command reuses a live Agent Relay Desktop probe when one is available. If
there is no live probe, it downloads the current release from
`AgentWorkforce/relay-desktop-releases`, verifies the adjacent SHA-256 file,
and starts the probe without signing in.

- Linux x64 and arm64 use the relocatable tarball under
  `~/.local/lib/agent-relay/current`, a symlink at
  `~/.local/bin/agent-relay-probe`, and a detached headless process. No `sudo`
  is used.
- macOS x64 and arm64 use the signed DMG. The app is staged, verified with
  `codesign --verify --deep --strict`, and installed in `/Applications` when
  writable. `~/Applications` is an explicitly untested fallback.
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

On Linux, stop the `agent-relay-probe` process, then remove only
`~/.local/bin/agent-relay-probe` and `~/.local/lib/agent-relay/current`. Remove
the pointer under `~/.agentworkforce/desktop/relay-socket` only after the probe
has stopped. On macOS, quit Agent Relay and move the installed app from
`/Applications` (or `~/Applications`) to Trash. The CLI never removes Relay
account data, keys, or other Relay installations.
