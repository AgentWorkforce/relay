# Fix Relay v11.2 CLI demo visuals and Relay-driven coordination

**Status:** Completed
**Confidence:** 90%
**Date:** 2026-07-25

## Summary

Fixed `attach --mode drive|passthrough` terminal corruption by reserving a
non-wrapping local status row, clipping its label, preserving the child
application's ANSI boundary, scroll-region, origin-mode, and alternate-screen
state, and reconciling terminal resizes before and during setup. Predictive echo
now updates boundary state only after its actual terminal writes.

Published Relay-first coordination rules through MCP initialize instructions so
interactive Codex sessions contact existing named Relay participants instead of
substituting provider-native subagents. Added a credential-gated real Codex E2E
that requires a relevant message to the named participant and rejects the
native-subagent wait flow.

## Decisions

- Reserve a dedicated terminal row and spare autowrap column for Relay's attach
  status, with dynamic handling for degenerate and resized terminals.
- Track terminal controls with a streaming ANSI state machine so Relay repaints
  restore the child's exact DECSTBM/DECOM/buffer state without interpreting
  control-looking bytes inside OSC/DCS payloads.
- Deliver named-participant routing guidance as MCP server instructions because
  interactive CLI sessions may start without a task-prefix prompt.

## Validation

- Full CLI suite: 816 passed, 11 skipped.
- Focused attach/MCP suite: 211 passed.
- CLI build, broker integration TypeScript build, lint (zero errors), and
  `git diff --check` passed.
- Independent Codex fresh-context review approved the final state.
- Claude review and the credentialed live Codex E2E were unavailable because
  Claude was not authenticated and external credential egress was not approved.
