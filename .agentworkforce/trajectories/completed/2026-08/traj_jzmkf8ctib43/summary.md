# Trajectory: Implement physical fleet cross-node attach using barry Chief as proof

> **Status:** ✅ Completed
> **Task:** relay#1449
> **Confidence:** 96%
> **Started:** August 11, 2026 at 06:30 PM
> **Completed:** August 11, 2026 at 06:45 PM

---

## Summary

Added SSH-backed --node physical-fleet attach, protected broker credentials, covered input validation and CLI routing, and proved live view/drive against Chief on Barry.

**Approach:** Reproduced the live gap, proved the existing terminal protocol through a secure forward, then encapsulated target-local attach behind an injection-safe SSH transport and verified the exact built CLI.

---

## Key Decisions

### Use SSH remote execution for the physical-node P0 behind --node
- **Chose:** Use SSH remote execution for the physical-node P0 behind --node
- **Reasoning:** Live view and drive both succeeded against Barry through SSH while the broker stayed loopback-only. Running the existing attach command on the target keeps broker credentials off the wire, preserves all three attach modes, requires no new terminal protocol, and works with the currently installed remote CLI. Cloud/Daytona ticket routing can remain a later transport behind the same flag.

---

## Chapters

### 1. Work
*Agent: default*

- Use SSH remote execution for the physical-node P0 behind --node: Use SSH remote execution for the physical-node P0 behind --node
- Physical-node cross-node attach is viable without a new PTY transport: local --node delegates over SSH to the target's existing attach command, leaving the loopback broker and API key on-host. Barry live proof passed for view and drive (NODE_DRIVE_OK); 226 attach tests, lint, format, and full workspace/CLI builds passed.
