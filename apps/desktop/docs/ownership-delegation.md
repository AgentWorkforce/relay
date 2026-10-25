# Ownership and native session input

## Authority

The permission principal is a human Cloud user in one Cloud workspace. A
Relaycast agent id identifies the actor; it does not grant that actor human
permissions. A name, machine address, title, task, message body, and Relaycast
`metadata.cloud_user_id` or `owner_hash` are display or routing data only.

For a desktop registration, the signed-in Cloud account at registration time
is stored against the immutable Relaycast agent id. Cloud accepts the desktop
identity only through an authenticated request and proof of that exact agent's
token and id. Account switching cannot relabel an existing registration.
Older desktop-session registrations have no stored owner and remain **unknown**
locally; there is no historical inference or backfill. Unknown is not a reason
to withhold a desktop session from Cloud: the desktop identity sync sends it,
and Cloud decides (see below). A native spawned registration is not a desktop
session identity and is never sent through that sync; its Cloud authority comes
only from the audited spawn invocation and journal described next.
Cloud resolves its owner from a unique `ready` hosted spawn journal row keyed
by immutable worker id and Relaycast workspace id. The journal records the
authenticated human and verifies invocation caller id, node id, name, and
worker id at readiness. A single ready audit event must also record Relaycast's
server-derived `origin_node_id` matching the journal node id. A missing or
mismatched origin keeps the spawn usable but peer-only. Other spawn routes have
no such row and stay peer-only.
Reconnect, status updates, and agent renames must preserve identity continuity;
name reuse must not transfer the row.

## Delivery decision

Relaycast derives a message's originating `agent_id` from the sender's token.
The desktop must use that id and the message id from the Relaycast delivery,
never an id or an approval claim in message text. Before an owned native
Codex/Claude session receives a user turn, Cloud must resolve the message id
in the same Relaycast workspace, identify the sender's current authenticated
human binding, verify the target's binding, and evaluate the human's current
workspace/project and contractor grants where applicable. The initial resolver
accepts only a sender bound to the same human as the recipient; cross-owner
allowlists wait for the full grant evaluator. A locally allowed sender is an
additional narrowing choice, not a grant of Cloud rights. Both the agent id
and authorizing human id must be recorded with the decision and exposed to the
session. A failed lookup, stale binding, revoked membership, or mismatched
workspace yields peer delivery only. Do not cache a positive decision across
revocation; check again before handoff.

Peer delivery retains the vendor's peer messaging guardrails. In particular,
the relay must not turn a peer message or text such as `human_id=...` or
`approved` into an owner turn. Owner input is eligible only for sessions the
desktop itself launched through the native Codex app-server or Claude
stream-json path. The harness's own sandbox and permission rules still apply.

## Current implementation boundaries

- Desktop `agents.rs` formerly credited every registration to each newly
  attached account. It now records only forward registrations locally and
  leaves unknown registrations unknown. Desktop identity sync withholds only
  agents whose stored owner is a different user or workspace; agents with no
  stored owner are sent, as before v2026.10.43, so updating never drops an
  existing agent's Cloud identity.
- Cloud `desktop-identities.ts` verifies token/id/address under an authenticated
  Cloud request and stores rows only for that caller. It skips (`not_owned`)
  any agent whose `owner_hash` is not the caller's, and `join_relay` refuses
  the same mismatch (`relay-service.ts`). That hash is mutable Relaycast
  metadata, so it narrows what can be linked but is not proof of ownership:
  the binding is the authenticated caller plus the agent token.
- Relaycast already stores a server-derived sender agent id on messages and
  exposes it in delivery queue records. Its agent metadata remains mutable and
  cannot be used as the authorization source.
- The Cloud spawn journal has authenticated `userId`, `workspaceId`,
  `actorId`, `invocationId`, `nodeId`, and the verified `workerId` when ready.
  Cloud resolves that exact id at delivery time. The node cannot establish a
  human owner from a Relaycast capacity invocation, which has no human caller.
- A Relaycast pending-delivery read uses the recipient's own agent token and
  message id. Unknown, not addressed, expired, and acknowledged messages all
  produce the same 404. Cloud treats errors and timeouts as peer routing. The
  read must happen before the desktop acknowledges the delivery.

## Desktop sign-in evidence for the resolver route

Cloud's browser desktop sign-in has a server-verifiable marker: the PKCE
handoff is consumed and the operator token is issued in the same token family
(`packages/web/lib/auth/api-token-store.ts`). The resolver requires both the
current bearer and that consumed handoff family, rechecking revocation on
each call.

Headless setup defaults to device approval (`probe/src/relay/setup.rs:802-828`),
and the probe can reuse an official CLI login (`probe/src/relay/account.rs:366-395,
999-1020`). Device approval creates an ordinary CLI token session and links
the consumed device grant to its token row (`packages/web/lib/auth/device-authorization.ts:365-407`).
The device start `client_name` is supplied by the unauthenticated caller and
exists only for the approval screen (`packages/web/app/api/v1/auth/device/start/route.ts:48-58`).
It cannot prove that the client is Relay Desktop. A reused CLI login has no
desktop marker either. Neither credential may call a native owner resolver on
the basis of subject type, scope, label, or client name alone.

Forward desktop device sign-in now creates a fresh 32-byte verifier in
`DeviceLogin::begin` and sends only its S256 challenge and this machine's host
name to `/auth/device/start`. The browser approval page says it authorizes
**Agent Relay Desktop on <host>**. The desktop supplies the verifier when it
polls `/auth/device/token`; Cloud writes `desktop_verified_at` in the same
transaction that consumes the grant and creates its token session. A copied
device code or public challenge cannot complete that grant. A device grant
without a challenge keeps the old behavior, with no desktop marker. A reused
ordinary CLI login remains peer-only. This is a binding to the installation
that held the verifier, **not software attestation**: another client can
initiate its own challenge and ask a person to approve it, so the host-named
consent screen remains essential.

The native-authority route requires the exact live bearer and its server-held
desktop evidence: either the consumed, verified device grant linked to the
current token row, or a consumed browser handoff in that token family. It
refuses ordinary CLI and dashboard MCP tokens, rechecks token validity after
network resolution, and returns only routing provenance. It does not approve
harness actions. The desktop has not yet integrated this route into the
pre-ack delivery path; owned native user turns remain fail-closed until that
integration is complete. No historical device token is retroactively marked.
