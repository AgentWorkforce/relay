# Native Relay Connect

Relay Connect puts two agents in a temporary, expiring room so they can work on
one problem together. A guest joins from a link and does not need to sign in.

The probe exposes `connect create`, `join`, `send`, `status`, `leave`, and `end`.
The website installs a private copy at `~/.local/lib/agent-relay/connect/agent-relay-probe`; it requires no
Node, npm, desktop GUI, or user-configured MCP connection. The installer creates
no PATH alias: `relay` and `agent-relay` belong to the sibling orchestration CLI,
and the desktop-managed `~/.local/bin/agent-relay-probe` is left alone.

```sh
~/.local/lib/agent-relay/connect/agent-relay-probe connect create --task 'Review our integration' --expires-in-minutes 60 --json
~/.local/lib/agent-relay/connect/agent-relay-probe connect join https://agentrelay.com/connect/INVITE --json
printf '%s' 'Here is the result' | ~/.local/lib/agent-relay/connect/agent-relay-probe connect send --to teammate --json
~/.local/lib/agent-relay/connect/agent-relay-probe connect status --json
~/.local/lib/agent-relay/connect/agent-relay-probe connect leave --json
~/.local/lib/agent-relay/connect/agent-relay-probe connect end --json
```

Run from the live Codex or Claude Code agent shell. The socket identifies the
calling session through existing peer credentials and process ancestry. Output
is JSON; approval instructions go to stderr. Hosts use the existing Cloud device
authorization flow and existing authenticated Connect service over HTTP.
Guests never sign in. Host state is separate from the desktop account, under
`~/.agentworkforce/connect-cli`, protected by private files and a per-session
lock. Refresh tokens are not borrowed from any other client.

Create persists its request and session identifiers before making the Cloud
call, and saves the private host claim before joining locally. Retry the same
command after a network interruption. An ambiguous join retries the exact
claim; a definitive invalid-claim response permits recovery of a fresh claim.
End retains host authority until the service confirms termination. No host
claim, account token, or private session identifier is emitted in normal output.

Every Connect send gets a fresh idempotency key that remains stable across the
Relay SDK's bounded retries. Relay accepts that keyed message at most once and
replays the original receipt if a response is lost. If all retries end in an
ambiguous server or transport failure, the socket error returns the generated
key; repeat the exact request with that value in an `Idempotency-Key` header to
reconcile the original send without duplicating it. Even an explicit final
admission refusal remains unknown: an earlier bounded attempt may have been
accepted before its response was lost, so recovery always reuses the key.
The native `connect send` command prints the same recovery key and accepts it
through `--idempotency-key` when the exact send is repeated.

Recovery is only safe for **24 hours**. Relay replays a keyed message's
receipt for that long; after it, the same key is accepted as a new message,
so an expired key must not be treated as a safe replay. Check whether the
recipient already has the message before resending it. A broadcast (no `to`)
replayed within that window reaches only the participants it was first sent
to, even if others have joined the room since; the desktop remembers those
recipients until it restarts.

An existing healthy core is reused and is never killed or updated. When no core
is available, the CLI starts its own
`agent-relay-probe relay serve --headless --connect-ephemeral`.
That core preserves desktop autostart, allows 15 minutes for initial sign-in,
and stops after all rooms are idle for 60 seconds. In-flight socket requests
hold retirement open. A desktop bridge client, signed-in account, or ordinary
relay registration adopts the core and prevents automatic retirement. The
binary remains installed. Existing Claude Code direct-delivery setup behavior
also remains; the website explains the setting change before installation.

## Release order

1. Merge this probe change and have a human publish the normal signed/notarized
   release, including the four standalone probe archives and their checksums.
2. Verify each archive exposes `connect create --help`, `connect join --help`,
   and `connect end --help`.
3. Deploy the website `/connect` guide and `/connect/install.sh`, including the
   apex router exception for the installer.
4. Deploy Cloud's native-first invite guidance.

The website installer fails before replacing an existing executable if the
published release does not support the native commands. Do not switch the
public guidance before the compatible release is available. Existing npm and
MCP integrations continue to work.
