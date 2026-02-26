# Trajectory: Broker migration: fix agent communication + execute Waves 1-3

> **Status:** ✅ Completed
> **Task:** broker-migration
> **Confidence:** 90%
> **Started:** February 16, 2026 at 12:56 PM
> **Completed:** February 16, 2026 at 01:13 PM

---

## Summary

Implemented Wave 2 verified PTY delivery: echo verification for both pty_worker and wrap modes with retry logic and new protocol types

**Approach:** Standard approach

---

## Key Decisions

### Fixed agent identity: removed hardcoded RELAY_AGENT_NAME from .mcp.json so agents register as themselves, not as broker

- **Chose:** Fixed agent identity: removed hardcoded RELAY_AGENT_NAME from .mcp.json so agents register as themselves, not as broker
- **Reasoning:** All agents inherited broker's name via .mcp.json, self-echo filter dropped their messages

### Added onWorkerOutput PTY scanning + idle timeout as belt-and-suspenders completion detection

- **Chose:** Added onWorkerOutput PTY scanning + idle timeout as belt-and-suspenders completion detection
- **Reasoning:** Relaycast round-trip unreliable for completion signals; PTY output always flows via worker_stream events

### Wave 2 and 3 agents not producing code — likely Codex --full-auto doesn't process PTY-injected relay messages as tasks

- **Chose:** Wave 2 and 3 agents not producing code — likely Codex --full-auto doesn't process PTY-injected relay messages as tasks
- **Reasoning:** Agents run but create no files. The broker injects 'Relay message from Orchestrator [id]: ...' into PTY, but Codex may not parse this as actionable input. Lead (Claude) also seems inactive. Need to investigate whether PTY injection actually reaches agent input or just appears in terminal output.

### Root cause found: PTY injection echoes the prompt text, completion scanner matches DONE/REVIEW keywords in the echo

- **Chose:** Root cause found: PTY injection echoes the prompt text, completion scanner matches DONE/REVIEW keywords in the echo
- **Reasoning:** The orchestrator sends a prompt containing 'Post REVIEW:PASS or REVIEW:FAIL'. The PTY echoes this text. onWorkerOutput scanner sees REVIEW:PASS in the echo and declares the agent done. Agents never actually work.

### Fix: echo grace period + line-start keyword matching to prevent false-positive completion detection

- **Chose:** Fix: echo grace period + line-start keyword matching to prevent false-positive completion detection
- **Reasoning:** 30s grace period after PTY injection prevents matching keywords in echoed prompt text. Line-start matching avoids matching 'Post DONE:' in instructions.

### Implemented echo verification with rolling 16KB buffer for output matching

- **Chose:** Implemented echo verification with rolling 16KB buffer for output matching
- **Reasoning:** Large enough to catch echoes even with interleaved output, small enough to avoid memory issues

### Wrap mode uses tracing events for verification (no worker protocol)

- **Chose:** Wrap mode uses tracing events for verification (no worker protocol)
- **Reasoning:** Wrap mode doesn't use the broker protocol, so verification emits tracing events and retries internally

---

## Chapters

### 1. Work

_Agent: default_

- Fixed agent identity: removed hardcoded RELAY_AGENT_NAME from .mcp.json so agents register as themselves, not as broker: Fixed agent identity: removed hardcoded RELAY_AGENT_NAME from .mcp.json so agents register as themselves, not as broker
- Added onWorkerOutput PTY scanning + idle timeout as belt-and-suspenders completion detection: Added onWorkerOutput PTY scanning + idle timeout as belt-and-suspenders completion detection
- Wave 2 and 3 agents not producing code — likely Codex --full-auto doesn't process PTY-injected relay messages as tasks: Wave 2 and 3 agents not producing code — likely Codex --full-auto doesn't process PTY-injected relay messages as tasks
- Root cause found: PTY injection echoes the prompt text, completion scanner matches DONE/REVIEW keywords in the echo: Root cause found: PTY injection echoes the prompt text, completion scanner matches DONE/REVIEW keywords in the echo
- Fix: echo grace period + line-start keyword matching to prevent false-positive completion detection: Fix: echo grace period + line-start keyword matching to prevent false-positive completion detection
- Implemented echo verification with rolling 16KB buffer for output matching: Implemented echo verification with rolling 16KB buffer for output matching
- Wrap mode uses tracing events for verification (no worker protocol): Wrap mode uses tracing events for verification (no worker protocol)
