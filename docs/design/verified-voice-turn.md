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

Staged lookup (Cloud has a held offline PR; no hosted route yet):

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

The uncalled node adapter uses the signed-in account's validated Cloud origin,
the recipient Relaycast token, and the exact current delivery binding. It sends
no `senderUserId` claim, accepts only a 200 with all matching fields and a
fresh 60-second expiry, and returns false on any denial, mismatch or network
failure. The native owner-delivery and ordinary proxy paths still need to
derive that binding from their current registration and connect this lookup
only after hosted issuance is verified, then recheck account, registration,
owner and workspace at the actual turn submission. Cloud#6802 has an offline
durable post-send issuance row and forged-marker refusal test, but no hosted
readback.

## Both delivery routes

The registered Skip Codex thread is also driven by the layered agent's
`headless.py` process over its shared Unix app-server. Relay can send an owner
DM by the ordinary app-server proxy path or by native continuation through
the exact window owner and `thread-follower-start-turn`. The live Skip
registration has no spawn, which makes native continuation eligible, but the
host's current claim and window-owner capability have not been verified.
Both paths therefore stage an explicit, uncalled Fast option and keep normal
turns unchanged. The native route places `serviceTierForTurn` in
`turnStart.request`, which the exact window owner must forward to Codex; an
installed-host readback must establish that it does before this route is
enabled. The native receipt still enforces at-most-once submission and an
exact owner window.

## Compatibility and rollout

The current patch stages both seams only. The Cloud route and issuance must
pass a forged-metadata refusal test before any live caller is connected.
Normal turns omit the Fast field. On the app-server proxy path, an explicit
`-32602` invalid-params response naming
`serviceTierForTurn` permits one retry without the field and with the same
`clientUserMessageId`. Timeouts and ambiguous errors never retry. The fast
path must stay uncalled until the authorized Cloud lookup and exact-binding
tests land. The native window path currently treats any explicit rejection
as a refusal, without an automatic retry. Even after authorization, a busy
Codex thread can queue the request before turn start; this setting alone does
not solve pre-turn starvation or stream answer text.
