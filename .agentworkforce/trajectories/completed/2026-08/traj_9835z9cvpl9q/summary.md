# Trajectory: Implement escape-aware paced injection (issue #801)

> **Status:** ❌ Abandoned
> **Task:** 801
> **Started:** July 15, 2026 at 09:48 PM
> **Completed:** August 12, 2026 at 11:48 PM

---

## Key Decisions

### Diagnosed view detach behavior

- **Chose:** Diagnosed view detach behavior
- **Reasoning:** PTY-backed view consumes Ctrl-C as raw stdin and resolves its session, but closes the WebSocket gracefully; if that close handshake leaves a live handle, the process stays alive until a second Ctrl-C is handled by Node's default signal behavior.

### Use forced WebSocket teardown for local view detach

- **Chose:** Use forced WebSocket teardown for local view detach
- **Reasoning:** A view session has no outbound state to preserve. Calling ws.terminate after requesting a normal close releases the live socket handle immediately, ensuring the first Ctrl-C exits the viewer without terminating the agent.

### Preserve the post-SIGKILL reaping wait in the node provider integration test

- **Chose:** Preserve the post-SIGKILL reaping wait in the node provider integration test
- **Reasoning:** The test's 50ms sleep shim shortened both the graceful shutdown timeout and the post-kill wait. Restricting it to the 5s graceful timeout prevents stop() from resolving before the OS reaps the real child.

### Replace fixed standalone smoke delay with bounded readiness polling

- **Chose:** Replace fixed standalone smoke delay with bounded readiness polling
- **Reasoning:** The scripts/ci-standalone-smoke.sh test was tearing down `agent-relay node up` after eight seconds even when a retried Relaycast handshake was still in progress. Polling for its `Broker started.` readiness line for up to thirty seconds prevents cleanup from creating a false startup failure while retaining deterministic timeout diagnostics.

### Add session_ref: Option<String> to CommitAttestation; extract from top-level action JSON in broker_payload_from_action; inject RELAY_ATTEST_SESSION_ID env; stamp Session-Id trailer in hook

- **Chose:** Add session_ref: Option<String> to CommitAttestation; extract from top-level action JSON in broker_payload_from_action; inject RELAY_ATTEST_SESSION_ID env; stamp Session-Id trailer in hook
- **Reasoning:** Fleet dispatch puts session_id at JSON top level; SpawnParams.metadata.attestation.session_ref needs explicit bridging; session_ref is optional so hook fires without it (backward-compatible)

---

## Chapters

### 1. Work

_Agent: default_

- Paced injection in drainer thread: Paced injection in drainer thread
- Diagnosed view detach behavior: Diagnosed view detach behavior
- Use forced WebSocket teardown for local view detach: Use forced WebSocket teardown for local view detach
- Preserve the post-SIGKILL reaping wait in the node provider integration test: Preserve the post-SIGKILL reaping wait in the node provider integration test
- Replace fixed standalone smoke delay with bounded readiness polling: Replace fixed standalone smoke delay with bounded readiness polling
- Add session_ref: Option<String> to CommitAttestation; extract from top-level action JSON in broker_payload_from_action; inject RELAY_ATTEST_SESSION_ID env; stamp Session-Id trailer in hook: Add session_ref: Option<String> to CommitAttestation; extract from top-level action JSON in broker_payload_from_action; inject RELAY_ATTEST_SESSION_ID env; stamp Session-Id trailer in hook
- Abandoned: Stale trajectory from 28 days ago, unrelated to current work
