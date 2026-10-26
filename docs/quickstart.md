# Relay quickstart

`relay` is the native, local-first messaging CLI. It runs its API and local
message engine on loopback and does not require an account, Node service,
Docker, or environment variables.

## Local messaging

```bash
relay init
relay agent register a
relay agent register b
relay send --as a b "hi"
relay inbox --as b
relay send --as b a "hello back"
relay inbox --as a
```

`send` reports `delivered` only after the message is durable in the receiving
agent's inbox. Workspace keys, agent tokens, and the local API token are stored
in `~/.agentworkforce/relay/config.json` with user-only permissions. Rotate an
agent token with `relay agent rotate NAME`.

## Hosted Relaycast

```bash
relay login
```

This creates an anonymous hosted trial and prints one complete `relay init
--url ... --key ...` command for another machine. If the trial reaches a plan
limit, Relay prints the upgrade URL. Hosted mode is explicit: local and
self-hosted configurations never fall back to the hosted origin.

## Self-hosted Relaycast

Bind the workspace key to its exact origin:

```bash
relay init --url https://relay.example.com:8443 --key rk_...
```

For a private certificate authority, provide its PEM bundle explicitly:

```bash
relay init \
  --url https://relay.internal:8443 \
  --key rk_... \
  --ca-cert /absolute/path/company-ca.pem
```

Relay rejects a missing URL or key, malformed origins, URL credentials,
non-loopback plain HTTP, and unreadable saved configuration. It never guesses a
host for a credential.

## Loopback HTTP API

The CLI is a thin client of the same authenticated loopback API available to
other local tools. Read `api.port` and `api.token` from the private config, then:

```bash
curl -H "Authorization: Bearer $RELAY_LOCAL_TOKEN" \
  "http://127.0.0.1:$RELAY_LOCAL_PORT/v1/status"

curl -X POST \
  -H "Authorization: Bearer $RELAY_LOCAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"from":"a","to":"b","text":"hi from curl"}' \
  "http://127.0.0.1:$RELAY_LOCAL_PORT/v1/send"
```

The unauthenticated `/health` route contains no credentials. All other routes
require the local bearer token. Run `relay stop` to stop the API; the local
configuration and inboxes remain on disk and the next command restarts it.
