# Trajectory: Implement escape-aware paced injection (issue #801)

> **Status:** ✅ Completed
> **Task:** 801
> **Confidence:** 85%
> **Started:** July 15, 2026 at 07:48 PM
> **Completed:** August 2, 2026 at 10:53 PM

---

## Summary

Fixed 6 review findings (3 MCP description overclaims, 3 SECURITY.md inaccuracies); declined CodeRabbit's CHANGELOG heading change as contrary to CLAUDE.md convention. All 40 CI checks green.

**Approach:** Standard approach

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

### Documented get_message_thread limit:0 behavior instead of changing the handler
- **Chose:** Documented get_message_thread limit:0 behavior instead of changing the handler
- **Reasoning:** Both suggested fixes alter runtime behavior; limit:0 server semantics unverifiable from the client in a description-only PR

---

## Chapters

### 1. Work
*Agent: default*

- Paced injection in drainer thread: Paced injection in drainer thread
- Diagnosed view detach behavior: Diagnosed view detach behavior
- Use forced WebSocket teardown for local view detach: Use forced WebSocket teardown for local view detach
- Preserve the post-SIGKILL reaping wait in the node provider integration test: Preserve the post-SIGKILL reaping wait in the node provider integration test
- Replace fixed standalone smoke delay with bounded readiness polling: Replace fixed standalone smoke delay with bounded readiness polling
- Documented get_message_thread limit:0 behavior instead of changing the handler: Documented get_message_thread limit:0 behavior instead of changing the handler
