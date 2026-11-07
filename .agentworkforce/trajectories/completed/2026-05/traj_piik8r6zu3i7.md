# Trajectory: Issue 867: RelayEventListener

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** May 17, 2026 at 09:56 PM
> **Completed:** May 17, 2026 at 10:01 PM

---

## Summary

Replaced hand-rolled TerminalQueryParser with alacritty RelayEventListener. Listener owns a std::sync::mpsc::Sender; alacritty's send_event(Event::PtyWrite) pushes query responses (DSR/DA1/DA2/CPR) onto the channel, drained by a dedicated thread that writes to the PTY. CPR responses now reflect real cursor position instead of hardcoded 1;1. Deleted the parser and call sites in pty_worker.rs, wrap.rs, and main.rs; made Snapshot::from_term generic over EventListener. All 615 tests pass; clippy clean.

**Approach:** Standard approach

---

## Key Decisions

### Drain writeback channel from a dedicated std::thread, not tokio task

- **Chose:** Drain writeback channel from a dedicated std::thread, not tokio task
- **Reasoning:** The reader thread is a std::thread (not tokio) and it's the only place that calls processor.advance which fires send_event. Keeping the drainer as a std::thread that takes self.writer.lock() (parking_lot Mutex) avoids importing the tokio runtime into PtySession::spawn and matches the existing reader thread shape. Also avoids holding any async tasks at spawn time when no runtime is guaranteed.

### Use std::sync::mpsc::Sender (sync, unbounded-ish) for writeback channel

- **Chose:** Use std::sync::mpsc::Sender (sync, unbounded-ish) for writeback channel
- **Reasoning:** send_event must be non-blocking (called while holding processor+term locks). std mpsc Sender::send never blocks. A dedicated std::thread drains the receiver and writes to the PTY writer, decoupling potential write_all blocking from the parser's hot path. Avoids tokio runtime requirement in PtySession::spawn.

### Made Snapshot::from_term generic over EventListener

- **Chose:** Made Snapshot::from_term generic over EventListener
- **Reasoning:** Changing PtySession's term field from Term<VoidListener> to Term<RelayEventListener> broke Snapshot::capture which calls pty.with_term(Self::from_term). Generic over L: EventListener keeps offline tests on VoidListener and live capture on RelayEventListener without an extra wrapper.

### Also removed parser call sites in wrap.rs and main.rs (not just pty_worker.rs)

- **Chose:** Also removed parser call sites in wrap.rs and main.rs (not just pty_worker.rs)
- **Reasoning:** Issue scope said pty_worker.rs, but TerminalQueryParser was also used by run_wrap (wrap.rs) and exported via helpers + asserted in main.rs tests. Both used the same PtySession, so the listener now handles them. Leaving them would have broken the import-removal in main.rs.

---

## Chapters

### 1. Work

_Agent: default_

- Drain writeback channel from a dedicated std::thread, not tokio task: Drain writeback channel from a dedicated std::thread, not tokio task
- Use std::sync::mpsc::Sender (sync, unbounded-ish) for writeback channel: Use std::sync::mpsc::Sender (sync, unbounded-ish) for writeback channel
- Made Snapshot::from_term generic over EventListener: Made Snapshot::from_term generic over EventListener
- Also removed parser call sites in wrap.rs and main.rs (not just pty_worker.rs): Also removed parser call sites in wrap.rs and main.rs (not just pty_worker.rs)
