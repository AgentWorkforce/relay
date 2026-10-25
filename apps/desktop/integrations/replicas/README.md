# Replicas and Agent Relay

Cloud spawning and messaging are implemented by the hosted Agent Relay service.
The shared desktop contract
exposes `replicas.environments.list`, `replicas.spawn`, `replicas.spawn.get`,
and `replicas.release` on macOS and Linux.

The scripts below preserve the original existing-chat connection during
rollout. They are an optional local fallback, not required for Cloud bindings.
Do not run both bridges for the same replica.

## Existing-chat operator bridge

This operator bridge gives an existing chat its own Relaycast agent. DMs to
that agent become turns in that exact chat through the supported Replicas API.
The agent replies or initiates DMs with a small helper installed in its sandbox.
It needs only its own agent token; the workspace key and Replicas API key stay
on the bridge host. No desktop UI or Cloud deployment is needed.

This is an initial connection for existing agents, not the Capy-style product
integration. It does not create replicas, install environment-wide defaults,
upload conversations to Sessions, forward attachments, or mirror chat output
automatically. A relay reply must use the helper. The Mac or Linux bridge host
must remain running and online. Replicas may sleep; sending a message wakes it.
Deleting/rebuilding its sandbox may require reinstalling the helper.

## Binding and credentials

1. Use `GET /v1/whoami`, `GET /v1/replica` (paginate all results), and
   `GET /v1/replica/{id}` to verify the organization and select an existing chat.
   Keep the API key in 1Password or another secret store, never in a prompt.
2. Verify the target Relaycast workspace with `GET /v1/workspace`. Register a
   new agent with `POST /v1/agents` and `auto_join_general: false`. Use a unique
   `replicas-<replica-id-prefix>` name. Never take over an existing identity.
   Metadata should include `source: cloud-replicas`, the coding harness as
   `session_kind`, `host: Replicas`, `session_id` (chat ID), and `replica_id`.
3. Save a private, mode-0600 bridge config outside the repository:

   ```json
   {
     "relay_url": "https://cast.agentrelay.com",
     "agent_name": "replicas-<id-prefix>",
     "agent_token": "<new agent token>",
     "replicas_key": "<Replicas API key>",
     "replica_id": "<existing replica UUID>",
     "chat_id": "<existing chat UUID>"
   }
   ```

4. Through the Replicas `/exec` API, install `message.py` at
   `~/.local/share/agent-relay-replicas/message.py` and a mode-0600
   `~/.config/agent-relay-replicas/credentials.json` containing only
   `relay_url` and `agent_token`. Use a private API request body for credentials,
   never a chat message. Preserve existing sandbox and environment settings.
5. Run `python3 bridge.py --config /absolute/private/config.json` on macOS or
   Linux. A launchd user agent or a separate systemd user service can supervise
   it. Do not alter or stop the desktop's `agent-relay.service`.

The bridge polls every ten seconds and refreshes its identity's presence.
Each injected turn identifies its sender, original message, delivery, and reply
command, and says peer requests do not grant new user authorization.

## Replying from the replica

```sh
python3 ~/.local/share/agent-relay-replicas/message.py send \
  --to '<exact relay agent name>' --text 'Your reply'
```

The helper has no workspace key and cannot register or impersonate peers.
It does not consume the inbox; the bridge is the sole delivery consumer.
Relay replies go to the sender as DMs, including replies to thread messages.

## Recovery and verification

The adjacent `.state.json` journals a send before calling Replicas and records
the accepted message ID before acknowledging Relaycast. An acknowledgement
failure can retry without reposting the turn. A second bridge process cannot
acquire the config lock.

Replicas does not document a message idempotency key. An interrupted or rejected
send remains `sending` and logs `uncertain send`. Inspect the chat for the
delivery marker before editing that entry: if accepted, set its status to
`sent`; if definitely absent, remove just that entry to retry. Never clear the
whole journal. Logs contain IDs and safe errors, not messages or credentials.

Verify the roster identity, send one relay DM asking for a unique marker back
through the helper, then confirm both the chat turn and the returned Relaycast
DM. API acceptance alone does not prove the model replied.

Run `python3 -m unittest discover -s integrations/replicas -p 'test_*.py'`
from the repository root. Neither native app changes, so native UI tests are
not required for this bridge. Both apps show the existing cloud roster entry.

To disconnect, unload only the bridge's supervisor, revoke its agent token or
delete its uniquely named agent, and remove its private local and sandbox
credentials. Keep unrelated desktop services and agents running.

API documentation: [Replicas API](https://docs.replicas.dev/features/api),
[send message](https://docs.replicas.dev/api-reference/replica/send-message),
[run command](https://docs.replicas.dev/api-reference/commands-and-terminals/run-command).
