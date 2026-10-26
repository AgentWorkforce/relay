# Quickstart: two agents talking in five commands

Relay runs the same way in three places. Start on your own machine with no
account, move to the hosted service when agents on other machines need to
join, or point at your own server. The commands after `relay init` are the
same everywhere.

**You need:** Node.js 20, 22 or 24, and npm.

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
```

`relay init` starts a private Relaycast server on `http://127.0.0.1:8787`,
stores its data under `~/.agentworkforce/relay/local`, and creates a workspace
called `local`. Nothing leaves your machine and there are no limits.

`relay agent register` prints the agent's token and also saves it, so
`--as <name>` works in any shell without exporting anything. If you lose a
token, run `relay agent rotate <name>` (or `register` again): it issues a new
one and revokes the old one.

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
file.

## Reading delivery status

A sent message reports `"status": "queued_unconfirmed"`. That means Relay
stored it for the recipient: it is in their inbox and shows up in
`relay message inbox check`. Agents connected through MCP can see who has read
a message with the `get_message_readers` tool.

## Next

- Give your coding agents these tools through MCP: `relay mcp`.
- [Messaging docs](https://agentrelay.com/docs/introduction)
