# Skip voice admission while the lead is busy

Status: design and safety baseline for [relay#2298](https://github.com/AgentWorkforce/relay/issues/2298). Nothing here enables priority delivery or changes the deployed router.

## Observed boundary

The registered Skip Codex thread is shared with its layered-agent lead. On a busy thread, `CodexRouter::host_turn` returns `wait_for_turn`; active progress resets the 600-second stall timer. A person DM can therefore remain queued indefinitely while the lead keeps working. `serviceTierForTurn: "fast"` from relay#2299 applies only after a new turn starts. It cannot shorten this wait.

The installed Codex CLI 0.167.0 experimental app-server schema exposes `turn/steer`, `turn/interrupt` and `thread/fork`. It exposes no safe `turn/yield`, suspend, or resume-active-turn request. Relay's `turn/steer` joins the existing turn, has no per-turn Fast setting, and gives no bound on when the lead will answer. `turn/interrupt` can stop active orchestration and is currently reserved for silent-stall recovery of registered spawns. Skip is registered as a nonspawn Codex session. `thread/fork` can copy a thread but does not establish a second Skip identity, current active-turn state, its tool/ledger permissions, or durable reply ownership. These gaps rule out an in-place priority patch or an unguarded fork as a production latency fix.

## Proposed first production slice: a read-only voice lane

The voice lane is a separate, long-lived Codex thread on the same host. It has Skip's human-facing charter and current read-only views of the task ledger, project/session evidence and roster. It cannot mutate the lead's ledger or send Relay messages directly. The lead remains the sole orchestrator and keeps its existing ordered queue. If the person asks for an action, the lane queues one durable command to the lead and immediately says that it is queued; it does not claim the action is complete. A status answer cites the snapshot generation and marks in-flight or missing data as such. The lane must refresh its context for each request; `thread/fork` history alone is insufficient.

The lane speaks as Skip only through a Relay-owned reply operation using the registered Skip agent's token, scoped to the verified incoming message and person. No token is handed to the model or the forked thread. The reply operation writes an idempotent outbox record before send and records the final Relay DM ID. Its answer is then available to the lead as a durable event, so the lead can update the ledger without replaying the person's request.

The existing lead path remains the fallback for unsupported questions, unavailable context or lane failure. It reports `queued` with the measured age; it never reports `responding` until a trusted `turn/start` was accepted. Refreshing the app cannot imply faster pickup.

## Admission and provenance

1. Cloud issues a durable voice intent after the person DM exists, bound to workspace, person, sender agent, recipient Skip agent and session, Relay message ID, request ID and expiry. A sender-supplied `data.voice` or Relaycast metadata marker is only a lookup hint. Cloud#6802 stages this offline; hosted issuance and revocation proof are pending.
2. The node calls Cloud's recipient-token attestation route and compares its response to the current delivery, registration and signed-in account. It rechecks those bindings at submission. Denial or timeout leaves the ordinary queue intact. Relay#2299 stages this lookup but does not connect it.
3. A node-local admission journal claims `(workspace, recipient session, Relay message ID, request ID)` once. Its states are `verified`, `lane_pending`, `turn_accepted`, `answer_ready`, `reply_pending`, `replied` and `in_doubt`. A replay observes the same claim; it cannot create a second turn or reply.
4. The host records the actual accepted `(threadId, turnId, clientUserMessageId = Relay message ID)` from the app-server or exact native window. It binds that receipt to the Cloud-issued intent. A publisher cannot accept a claimed turn ID from sender metadata, a model response or a mere recipient bearer token.
5. The host-to-Cloud delta ingress needs its own authenticated host/source credential plus that accepted-turn receipt. Cloud checks it against issuance and the current caller/workspace before opening or resuming the person's stream. Each delta carries a monotonic sequence number; reconnect replays only the same request's missing events. The terminal durable DM is separate from advisory deltas.

## Ordering and cancellation

The voice lane is outside the lead's ordered turn queue. It may answer read-only questions against its explicitly versioned snapshot. It must not execute a mutation ahead of earlier accepted lead work. A mutation is appended once to the existing lead queue and acknowledged as queued. If an earlier handoff or hidden message can change the requested status, the lane reports that the status is in flight rather than presenting a conflicting conclusion. A live terminal or a changed session removes lane eligibility; the request stays on the ordinary path.

Cancellation stops audio/deltas for that request and releases lane work only if no durable answer was committed. It never deletes an accepted lead handoff or a final DM already in the outbox. A late answer is still recorded once and can appear in chat without restarting speech. Account/workspace revocation closes the stream and blocks new lane output, including after replay.

## Required interfaces before implementation

| Owner      | Missing contract                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloud      | Hosted, caller-scoped post-send voice issuance and attestation with tested revocation; person-scoped stream and a host-authenticated ingress bound to the accepted turn. |
| Relay core | Exact accepted-turn receipt from proxy and native window; durable lane claim/outbox; read-only lane context snapshot and ordered lead-command handoff.                   |
| Skip lead  | A versioned read-only ledger/roster/session view for voice and a single-writer command intake; an explicit reconciliation event for the lead.                            |
| Mac client | `queued`, `accepted` and `responding` from the same pinned request/session; cancellation and replay; per-stage latency marks.                                            |

An alternative in-place solution needs a new Codex app-server operation that yields an exact active turn at a safe checkpoint, returns a resumable continuation, admits one separately identified Fast turn after earlier accepted work, and resumes the original turn without repeating tools or losing its pending approvals. The current protocol has no such operation. `turn/steer` and `turn/interrupt` cannot substitute for it.

## Acceptance evidence

Use a long-running, continuously progressing Skip lead turn. Show the voice lane's admitted answer and durable final DM are the same issued request while the lead remains intact; prove action requests wait behind earlier accepted work. Exercise wrong caller/workspace, revoked issuance, stale replay, changed turn, hidden message, live terminal, ambiguous start, lost delta publish, reconnect and cancellation. Show one turn and one final DM per request under retries. Report end-of-speech to host arrival, admission, first answer text and first audible speech separately at p50/p95, alongside queued fallback age. Installed Mac states and audible/visual output must cite the pinned request. Synthetic success alone is not a live latency claim.
