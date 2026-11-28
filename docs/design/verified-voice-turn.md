# Verified voice turns (staged contract)

The Relay node can ask Codex for Fast service on **one turn** with
`serviceTierForTurn: "fast"`. The installed stable app-server schema includes
this field. `serviceTier` and `effort` change later turns, so this path must
not set either one. There is no safe per-turn effort override in the current
schema.

## Authorization boundary

`data.voice`, a text marker, and a caller-supplied request ID are hints, not
proof. Relaycast assigns the message ID only after send, so an assertion in
the original DM cannot bind it. Before selecting Fast, the node needs a
post-send authorization lookup from Cloud using the signed-in Desktop session
and the recipient agent token, as it already does for owner delegation.

Proposed lookup (Cloud owner is building this offline; no hosted route yet):

```text
POST /api/v1/workspaces/{workspaceId}/messaging/voice-attestation
Authorization: Bearer <recipient Relaycast agent token>
{messageId, requestId, recipientAgentId, recipientSessionId, senderAgentId}

200 {authorized:true, workspaceId, senderAgentId, senderUserId, recipientAgentId,
     recipientSessionId, messageId, requestId, expiresAt}
```

Cloud must validate the bearer token as the exact recipient agent and session,
read the message as that agent, match `senderAgentId` to the stored DM's
`agent_id`, resolve that ID to a current person, verify a durable **Cloud-issued**
voice intent bound to the exact post-send `messageId`, and recheck current
workspace membership. Relaycast message metadata is sender-asserted; its
`cloud_voice_request_id` field is not proof even when it has that name. The node must
verify the authenticated HTTPS response inside its Cloud client and compare
the sender agent ID and every available returned claim to the exact
delivery/current registration. Cloud alone can verify and report its internal
`senderUserId`; the node requires it to be present but cannot supply it. It must
require `authorized: true` and a future `expiresAt` no more than 60 seconds
away. A missing, expired, revoked, mismatched, or unreachable answer means
normal service. No message is dropped because Fast authorization failed.
Replays must not start a second turn. A raw Relaycast metadata field is never
sufficient.

## Compatibility and rollout

The current patch stages the app-server seam only. The Cloud route and issuance
must pass a forged-metadata refusal test before any live caller is connected.
Normal turns omit the Fast
field. An explicit `-32602` invalid-params response naming
`serviceTierForTurn` permits one retry without the field and with the same
`clientUserMessageId`. Timeouts and ambiguous errors never retry. The fast
path must stay uncalled until the authorized Cloud lookup and exact-binding
tests land. Even after that, a busy Codex thread can queue the request before
turn start; this setting alone does not solve pre-turn starvation or stream
answer text.
