# MCP Events — Positioning and Plan

**Status**: Draft
**Date**: 2026-11-23
**Author**: Design session (Khaliq + Claude)

---

## 1. What MCP Events is

`io.modelcontextprotocol/events` (SEP-3415 Final, extension in Beta, protocol `2026-07-28`+) lets an MCP server
tell a client that something happened upstream. It defines:

- `events/list`: typed event names with `inputSchema` and `payloadSchema`.
- Three delivery modes:
  - `events/poll`: pull, with an opaque cursor.
  - `events/stream`: push over SSE or stdio.
  - `events/subscribe` / `events/unsubscribe`: webhooks with a TTL lease, Standard Webhooks HMAC (`whsec_`
    secret), endpoint verification and SSRF rules.
- Opaque, server-defined cursors. `null` means "from now". `truncated: true` is the only signal that events
  were missed. Replay never goes back before the moment of subscription.
- **Client-owned state.** The server keeps no list of subscriptions, and the client holds every cursor.

What it leaves out (from the SEP's own scope section and open questions):

- How an event reaches the model. Open question 1: injected context, a special message type or a callback.
  The host decides.
- Waking an idle or closed session. Push and poll only work while the client process runs, and webhooks need
  a public HTTPS endpoint that a laptop CLI does not have.
- Agent-to-agent messaging, cross-server routing ("no mechanism for one server's events to trigger another
  server's tools"), durable subscriptions, guaranteed delivery, and queue bindings. For queues the SEP
  recommends "an MCP proxy".
- More than one event name under one cursor (open question 3).
- Flow control, and a bound on the backlog when a push stream reconnects.

The spec's own diagram for clients without a callback endpoint is
`Upstream → MCP Server → webhook → Forward Proxy ← Client (poll/push)`.

### SEP-2495 (Event-Driven Tool Invocation): the "event → model" step

SEP-2495 ("Server-Push to LLM Re-entry", Heiko Friedrich, created 2026-03-29) is the proposal that would
standardize how an event re-enters the model. As of 2026-11-23 it is not on track:

- PR #2495 is an open draft with no sponsor. The SEP file holds only Abstract, Motivation and a workarounds
  table. There is no specification, wire format, security section or implementation.
- On 2026-11-06 a maintainer moved it back to draft with `wg-support-needed`: it needs the Tasks & Events WG
  to take it on.
- On 2026-11-17 a WG lead asked whether SEP-3415 already covers it, and called the only gap (delivery back to
  the model) host behaviour, and therefore non-normative.
- SEP-3415 lists it only as complementary related work.

Implication: the step from event to model (waking an idle session, starting a turn, choosing which session)
is likely to stay host behaviour without a normative spec. Each host will do it differently, which keeps a
cross-harness wake layer valuable, and it makes non-normative client guidance (section 7) the place to
influence. Watch for the WG adopting SEP-2495 or publishing SDK guidance for SEP-3415's open question 1. That
would be the signal that native wake behaviour is converging.

## 2. Exposure

| Asset                                                                                    | Exposure                | Why                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `events-shim` per-CLI wake paths (Stop hooks, `asyncRewake`, `decision: block`, plugins) | High, over 12–24 months | Native host support for Events makes them a fallback.                                                                           |
| relayfile as the "provider webhook → agent" path                                         | Medium                  | First-party provider MCP servers with Events replace "subscribe to a PR". The VFS, writeback and dedupe value stays.            |
| Relaycast messaging                                                                      | Low directly            | Events makes inbound delivery a commodity, so our moat is the fabric: identity, routing, durability, team semantics and policy. |

## 3. Position: be the forward proxy, and be an Events server

1. **Relay as an Events server.** Every host that implements Events becomes a Relay client without hooks.
2. **Relay as the hosted forward proxy.** We receive upstream Events webhooks durably and re-serve them by
   poll, push or wake, so a session can die without losing its subscription.
3. **relayfile as an Events aggregator.** Any provider MCP server that offers Events becomes an integration
   without per-provider webhook code.
4. **Team dispatch.** An event is claimed once per workspace, then routed (auto-routing), placed
   (spawn-placement), and the agent is spawned or woken. The spec fans the same `eventId` out to every
   subscriber; we make "five teammates' agents all react to one PR comment" impossible.
5. **Shape the standard while it is Beta.** Our evidence across 11 harnesses on how events reach agents is
   the best available input for open question 1.

## 4. Phase 1: shipped in `@agent-relay/events-shim`

The inbox's MCP endpoint (`/t/<token>/mcp`) is now an Events server:

- **Advertisement.** `initialize` advertises `capabilities.extensions["io.modelcontextprotocol/events"]`.
  `server/discover` waits for an MCP SDK that speaks `2026-07-28`; the `events/*` methods answer regardless of
  the negotiated version.
- **One event type, `webhook.received`.** It has optional `event_type` (exact, or a prefix ending in `*`) and
  `mode` arguments.
- **`events/poll`:**
  - The cursor is `seq_<n>_<scope>` over the inbox feed; the scope ties it to one inbox, so a cursor from a
    replaced inbox is refused (`truncated`) even when its seq exists in the new one.
  - `truncated: true` when posts after the cursor were pruned, the `maxAgeMs` floor skipped matching posts, or
    the cursor is not one the inbox issued.
  - `maxEvents`, `hasMore` and `nextPollMs` are supported.
  - `maxAgeMs` bounds a cursor replay and is ignored with a `null` cursor, as SEP-3415 requires.
- **`events/stream`:**
  - An SSE response that replays the backlog, then follows the feed.
  - `active`, `event`, `heartbeat`, `error` and `terminated` notifications carry `_meta.subscriptionId`.
  - `active` carries the position before the replay, never past posts not yet sent.
  - The heartbeat is clamped to 5–60 s.
  - The stream closes with a final result after `maxStreamMs` (5 min by default; hosts tune it with
    `eventsStream`). When posts left the feed between reads it sends a fresh `active` with `truncated: true`
    and continues. A failed store read is a recoverable `error`; `terminated` is only for an inbox that is gone.
- **`events/subscribe` / `events/unsubscribe`** answer `Unsupported` (`-32026`), because the type offers poll
  and push only.
- **Events reads are observer reads.** They never change a post's delivery state, so they never compete with
  a relay wake link or a hook listener.

The inbox also receives upstream Events webhooks on a new `mcp` URL mode (`/h/<token>/mcp`):

- `PUT /shims/current/secrets/mcp` with `{}` generates a `whsec_` secret, returned once. The client passes it
  as `delivery.secret` in `events/subscribe`.
- **Signatures.** `webhook-signature` (space-separated `v1,` entries, any one matching) is checked over
  `webhook-id.webhook-timestamp.body`, with a 5-minute window. Retries are deduplicated by `webhook-id`.
- **Envelopes:**
  - A signed `{"type":"verification","challenge":…}` is answered with `{"challenge":…}` and is neither stored
    nor forwarded.
  - `gap` and `terminated` envelopes are stored and woken as posts (`mcp.events.gap`,
    `mcp.events.terminated`), with a line telling the agent what happened.
- **Well-known document.** Hosts may publish `/.well-known/mcp-webhook-receiver.json` by setting
  `mcpWebhookReceivers`.

Host note: `VerificationMode` and `SecretMode` gain `mcp`. A host that stores modes in a constrained column
must allow it.

## 5. Phase 2: cross-repo, next 90 days

These need repos other than this one. Each needs an owner on Agent Relay before work starts.

| Item                                                                                                                                                                            | Where                  | Notes                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relaycast event types (`relay.dm.received`, `relay.channel.message`, `relay.mention`, `relay.task.assigned`, `relay.integration.event`) backed by the observer-plane cursor log | relaycast              | `specs/observer-plane.md` is already a cursor protocol; Events poll and stream is a thin facade over it.                                                                                 |
| Subscription custody: Relay subscribes upstream with the workspace principal, persists cursors and TTLs, and re-serves the events                                               | relaycast + cloud      | The events-shim `mcp` mode is the receiving half. The subscribing half (calling `events/subscribe`, refreshing before `refreshBefore`, persisting cursors) belongs in the control plane. |
| relayfile Events ingest: map Events occurrences to path and revision                                                                                                            | relayfile              | One adapter replaces per-provider webhook wiring for Events-capable servers. `path_glob` already answers "many names, one cursor".                                                       |
| Team dispatch: claim once per workspace, then route, place, and spawn or wake                                                                                                   | relaycast + relay-node | Builds on leases (`claim_token`), `auto-routing.md` and `spawn-placement`.                                                                                                               |
| Cloud host: allow `mcp` mode in the Drizzle store, and publish the well-known receiver document                                                                                 | cloud                  | Required before the `mcp` URL works in production.                                                                                                                                       |

## 6. Policy: freeze new per-CLI hook wake work

Keep the existing hook wake paths working and fix their bugs. Do not add a new CLI through a hook hack unless
that host is clearly far from native Events support. Prefer: ship the Events facade, then ask the host to
implement Events. Review this each quarter against the extension client matrix.

## 7. Draft comments for the Tasks & Events WG

Not posted. To be posted by a CODEOWNER, in the ext-events repository, after review.

**On open question 1 (how hosts surface events to agents).** Agent Relay delivers external events into
sessions of 11 agent CLIs today. Three findings from that work:

- **An idle session is the common case, not the edge case.** Delivery that only works during an active turn
  misses most events. Hosts need a "wake" semantic: start a turn when idle, queue when busy. They also need
  to say which one happened.
- **One subscription should wake exactly one session.** When several sessions of the same host share
  configuration, a host needs a rule for which session owns a subscription. The most recently started
  session works well in practice.
- **Event bodies are untrusted input.** Hosts should frame them as data, never as instructions. A
  pointer-style payload ("task 42 changed; read it with tool X") keeps sensitive data behind the server's own
  authorization.

We would propose these as SHOULDs in client SDK guidance.

**On open question 3 (multiple event names under one cursor).** We back relayfile subscriptions with path
globs (`/github/repos/o/r/pulls/**`) under one cursor. In practice consumers subscribe to a resource, not an
event name. We would favour an additive option: a server-defined "event group" name listed in `events/list`
that expands to several types, which avoids changing `name`'s type on the wire.

**On push reconnect backlog.** Leased batches (claim, then ack or release, with the lease expiring back to
pending) bounded our reconnect bursts. An optional `maxEvents` on `events/stream`, limiting the replay before
live events, would mirror poll's paging.

**On SEP-2495 (PR #2495, `wg-support-needed`).** Comment there: the remaining gap is delivery to the
model. We propose non-normative host guidance under SEP-3415 (wake when idle, queue when busy, one owning session
per subscription, payloads framed as untrusted data), drawn from the findings above, rather than new wire
protocol.

**Offer.** Agent Relay can contribute conformance scenarios for a forward-proxy receiver: verification echo,
`gap` and `terminated` forwarding, and `webhook-id` deduplication.
