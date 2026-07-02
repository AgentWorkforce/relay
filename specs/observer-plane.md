# Observer Plane — Durable Workspace Event Log and Cursor Protocol

**Status**: Draft
**Date**: 2026-07-02
**Author**: Design session (Will + Claude)

---

## 1. Problem

Relaycast v5 made participant delivery durable — every agent receives through
its node's `deliveries` mailbox with replay on reconnect — but everything that
_watches_ a workspace still rides fire-and-forget transports. That split
produces one recurring class of bug: **any consumer that is not a delivery
recipient has no way to observe the workspace reliably.**

Concrete instances:

- **The workspace stream loses events on reconnect.** The `/v1/ws` observer
  stream is fan-out only: a dropped socket loses every event emitted while the
  client was away, and there is no way to ask for the gap. In-memory resync
  rings help with short blips but are bounded and per-connection, not durable.
- **Pear falls back to polling reconciliation.** Because the stream can't be
  trusted across reconnects, UIs like Pear re-fetch rosters and message
  histories on a timer and diff them against local state — expensive, laggy,
  and still racy between polls.
- **The broker's `relay_inbound` only sees local recipients' deliveries.**
  A broker observes workspace traffic through the delivery frames of the
  agents it hosts. Channel messages whose recipients are all remote (or whose
  only local "recipient" is an identity that never drains) are invisible to it.
- **Dashboard-identity deliveries queue forever.** Watch-only identities (the
  broker-self agent, dashboard/console identities) get registered as agents so
  something fans events at them — but they live on permanently-offline
  implicit direct nodes, so every channel message writes a delivery row that
  sits queued until TTL expiry. The mailbox becomes a dead-letter queue and
  the sweeps churn.

All four are the same defect: observation is being emulated with participant
machinery (agent identities + deliveries) or with a lossy stream, because
there is no first-class read path.

## 2. The frame: two planes

The fix is to make watching a workspace a separate plane with its own
contract, instead of a degenerate form of participating.

| Plane           | Who                          | Credential                                    | Transport                            | Durability                          |
| --------------- | ---------------------------- | --------------------------------------------- | ------------------------------------ | ----------------------------------- |
| **Participant** | agents                       | agent token (via node registration)           | `/v1/node/ws` deliver frames         | per-recipient `deliveries` mailbox  |
| **Observer**    | UIs, SDK listeners, auditors | observer token (`ot_live_...`, `stream:read`) | `/v1/ws` live stream + REST backfill | per-workspace append-only event log |

**Participant plane — unchanged.** v5 node deliveries stay exactly as they
are: agents register through a node, sends are stateless REST, inbound is a
durable per-recipient mailbox drained over the node socket with replay on
reconnect. Nothing in this spec touches message delivery semantics.

**Observer plane — new.** A durable, append-only, per-workspace event log
plus a client cursor protocol. Observers never hold agent identities, never
receive deliveries, and never appear in the roster. Reading the workspace
cannot create server-side per-reader state beyond the shared log.

## 3. Observer plane contract

### 3.1 The event log

The engine appends every workspace-visible server event (the same
client-shaped JSON the WS delivers: `message.created`, `thread.reply`,
`message.reacted`, membership/presence/channel events, ...) to a
per-workspace log table:

| column       | meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| `seq`        | per-workspace monotonic sequence number (assigned on append) |
| `type`       | dotted server event type                                     |
| `channel_id` | channel the event belongs to, when applicable                |
| `payload`    | the client-shaped event JSON, verbatim                       |
| `created_at` | append time                                                  |

`seq` semantics:

- Monotonic and unique **per workspace**; it totally orders the log.
- Stamped onto the corresponding live WS frame as a top-level `seq` field, so
  the stream and the log speak the same coordinate system.
- A live frame **may lack `seq`** when the server-side log append failed. Such
  frames are live-only: observers pass them through but cannot dedupe or
  replay them. Append failure must never block event fan-out.

The log is retention-bounded (age and/or row cap per workspace); a cursor
older than retention backfills from the oldest retained event.

### 3.2 Backfill: `GET /v1/workspace/events`

```
GET {baseUrl}/v1/workspace/events?since=<seq>&limit=<n>   (n <= 500)
Authorization: Bearer <observer token>
```

Response:

```json
{
  "ok": true,
  "data": {
    "events": [
      { "seq": 41, "type": "message.created", "channel_id": "c1", "payload": { ... }, "created_at": "..." }
    ],
    "latest_seq": 57
  }
}
```

- `events` are ordered by `seq` ascending, strictly greater than `since`.
- `payload` is the same client-shaped event JSON the WS delivers, so one
  normalization path serves both legs.
- Auth: observer tokens with `stream:read`. Workspace keys and agent tokens
  are rejected, mirroring the live `/v1/ws` endpoint.
- Older engines without the log 404 this route; clients must degrade to
  live-only streaming.

### 3.3 Live stream

Unchanged endpoint, upgraded frames: `WS /v1/ws?token=<ot_live_...>` accepts
observer tokens with `stream:read` (rejects workspace keys and agent tokens)
and delivers the standard server event shapes, now carrying `seq` when the
log append succeeded.

### 3.4 Client cursor protocol

The client owns exactly one piece of state: the highest `seq` it has emitted
(the **cursor**). Persisting it is the caller's job. The connect sequence:

1. **Connect live and buffer.** Open `/v1/ws` with the observer token; hold
   incoming frames in memory without emitting.
2. **Backfill from the cursor.** Page `GET /v1/workspace/events?since=<cursor>`
   until `latest_seq` is reached, emitting each event and advancing the
   cursor.
3. **Merge and go live.** Flush the buffer — drop frames with `seq <=` cursor
   (already emitted via backfill), emit the rest ordered by `seq`, pass
   seq-less frames through — then emit live frames directly, deduping against
   the cursor.

Properties: no event in the log is dropped across reconnects (the buffer
covers the backfill window; the backfill covers the disconnected window),
no seq-stamped event is emitted twice, and a persisted cursor resumes a
stream across process restarts. A 404 backfill degrades to live-only; the
cursor still advances from live `seq` so persistence keeps working.

## 4. Per-component changes

- **Engine (relaycast)** — owns the plane: the event log table + append hook
  in event fan-out, `seq` stamping on `/v1/ws` frames, the
  `GET /v1/workspace/events` route, observer-token auth on both, and log
  retention sweeps. (Being built in parallel; §3 is the contract.)
- **Cloud (relaycast-cloud)** — copies the new D1 migrations from the engine,
  routes the new REST path through the existing engine app, and keeps the
  workspace-stream KV gating in lockstep on any new publish path.
- **Relay SDK (`@agent-relay/sdk`)** — observer mode:
  `new AgentRelay({ observerToken, baseUrl, sinceSeq, onCursor })` streams
  `relay.addListener(...)` from a new observer event source
  (`packages/sdk/src/messaging/observer-source.ts`) implementing §3.4 —
  live leg via a `RelayCast` client on the observer token, backfill via REST,
  both normalized through the existing `normalizeMessagingEvent` path. The
  source is the fan-in's sole source in observer mode; `workspace.register()`
  / `reconnect()` throw (observer tokens are read-only). Cursor persistence
  stays with the caller via `sinceSeq`/`onCursor`.
- **Broker (`agent-relay-broker`)** — self-mute: after joining default/extra
  channels, the broker mutes them for the broker-self agent
  (`crates/broker/src/relaycast/ws.rs`). The engine's channel fan-out skips
  muted members, so channel messages stop writing delivery rows to
  broker-self's permanently-offline implicit direct node. Best-effort; when
  the broker needs full workspace visibility it should hold an observer
  cursor instead of a phantom recipient.
- **Pear** — replace polling reconciliation with an observer-token stream +
  persisted cursor: hydrate from REST once, then apply §3.4. Polling remains
  only as a fallback against pre-log engines (the 404 path).

## 5. Migration order

1. **Engine**: event log + `seq` stamping + backfill route ship behind the
   existing observer-token auth. Pure addition; old clients ignore `seq`.
2. **Cloud**: bump the engine, copy migrations, deploy. The route 404s until
   this lands — which clients already tolerate.
3. **Relay SDK**: observer mode (this repo). Works live-only against
   pre-log engines, gapless once 1–2 are deployed.
4. **Broker**: self-mute lands independently (it needs only the
   long-shipped channel mute endpoint) and stops the dead-letter churn
   immediately.
5. **Pear**: move to the cursor protocol once 1–3 are stable, then retire
   polling reconciliation.
6. **Cleanup** (later): drop watch-only agent identities (dashboard/console
   registrations) in favor of observer tokens; consider broker workspace
   visibility via an observer cursor.

## 6. Open questions

- Retention policy defaults (age vs row cap) and whether `latest_seq` should
  expose the oldest retained seq so clients can detect truncated backfills.
- Whether channel-scoped observer tokens should filter both the stream and
  the backfill (today the plane is workspace-wide).
- Whether the broker should adopt an observer cursor for `relay_inbound`
  (fixing remote-recipient blindness) before or after Pear migrates.
