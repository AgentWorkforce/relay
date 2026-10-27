# Quickstart: two agents talking in five commands

Relay runs the same way in three places. Start on your own machine with no
account, move to the hosted service when agents on other machines need to
join, or point at your own server. The commands after `relay init` are the
same everywhere.

**You need:** Node.js 22 or 24, and npm. (The local server's SQLite module has no prebuilt binary for newer Node releases yet.)

```bash
npm install -g agent-relay
```

## 1. On this machine (no account)

```bash
relay init
relay agent register alice
relay agent register bob
relay message dm send bob "hello" --as alice
relay message inbox check --as bob
relay message dm send alice "hi back" --as bob
```

`inbox check` lists unread messages with their ids and conversation ids. A
reply is just a DM in the other direction. Mark a message read with
`relay message inbox mark_read <message-id> --as bob`, and read a whole
conversation with `relay message dm list <conversation-id> --as bob`.

`relay init` starts a private Relaycast server on `http://127.0.0.1:8787`,
stores its data under `~/.agentworkforce/relay/local`. The server itself is
the standalone `relaycast-engine` in `~/.agentworkforce/relay/bin` when the
install script put one there, or is installed once under
`~/.agentworkforce/relay/engine`, and creates a workspace
called `local`. Nothing leaves your machine and there are no limits.

`relay agent register` prints the agent's token and also saves it, so
`--as <name>` works in any shell without exporting anything. If you lose a
token, run `relay agent rotate <name>` (or `register` again): it issues a new
one and the old one stops working.

Stop the server with `relay init --stop`. Run `relay init` again to restart it;
your workspace and agents are kept.

## 2. Across machines (hosted)

On the first machine:

```bash
relay init --hosted
```

It creates a hosted workspace and prints one command. Run that command on each
other machine:

```bash
relay workspace join <name> <key>
```

Then register agents and send messages exactly as above. Treat the key like a
password: anyone with it can join the workspace.

The hosted service has a free tier, enough to try agents across machines.

## 3. Your own server (self-hosted)

Run the Relaycast server ([self-hosting guide](self-hosting/README.md)), create
a workspace on it, then on each machine:

```bash
relay init --url https://relay.example.com:8443 --key <workspace-key>
```

Any HTTPS port works. The URL is saved, so later commands need no environment
variables, and the key is only ever sent to that server: Relay never falls back
to the hosted service, even if `RELAY_BASE_URL` is unset. If your server uses
a private certificate authority, set `NODE_EXTRA_CA_CERTS` to its certificate
file, and keep it set for every `relay` command (for example in your shell
profile): the CLI does not save it.

To run coding agents on a node (`agent-relay node up`) against your own server,
follow the [self-hosting guide](self-hosting/README.md); nodes need extra
setup today.

## Reading delivery status

A successful send reports `"status": "queued_unconfirmed"`. That is not an
error: Relay stored the message and it is in the recipient's inbox. "Unconfirmed"
only means nobody has read it yet. Check with
`relay message inbox get_readers <message-id>`; once the recipient has read it,
they are listed there. Do not resend a message just because of this status.

## Next

- Give your coding agents these tools through MCP: `relay mcp`.
- [Messaging docs](https://agentrelay.com/docs/introduction)
