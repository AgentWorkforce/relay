# relay-pty — Harness Kernel and the Runtime-Agnostic Session Contract

**Status**: Draft
**Date**: 2026-07-06
**Author**: Design session (Will + Claude)

---

## 1. Boundary rule

`crates/relay-pty` knows terminals and agent-CLI behavior — how to spawn a
CLI in a pseudo-terminal, read its screen, tell whether it is ready, working,
or stuck, and how specific harnesses (Claude Code, Codex, Gemini, opencode,
…) behave. It never knows relay messaging, channels, workspaces, or delivery
semantics. Where a primitive needs a caller-side concept (a priority scheme,
a request id, a respawn payload), the crate takes it as a generic parameter
or a small trait — relay types never cross the boundary. The broker layers
delivery and injection policy on top; nothing in relay-pty may depend on it.

## 2. Current contents

**PTY kernel** — the terminal-facing core:

| Module        | Responsibility                                                        |
| ------------- | --------------------------------------------------------------------- |
| `pty`         | child spawn via portable-pty, alacritty grid, serialized write drain  |
| `snapshot`    | render the grid to plain text or replayable ANSI                      |
| `wait`        | composable await-conditions (text, idle, cursor, exit)                |
| `readiness`   | per-CLI "prompt is ready" detection                                   |
| `terminal`    | per-CLI trust/permission/menu prompt detectors                        |
| `detection`   | working/idle activity inference from output                           |
| `ansi`, `utf8_stream` | ANSI stripping, chunk-safe UTF-8 decoding                     |
| `codex_session` | pre-create a resumable Codex thread via `codex app-server`          |

**Session primitives** — runtime-agnostic building blocks, generic over
caller-supplied types so they serve any agent runtime (terminal-backed or
headless):

| Module           | Responsibility                                                | Seam                                              |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| `queue`          | bounded multi-level priority queue for pending work           | `PriorityScheme` / `Prioritized` traits            |
| `inject`         | delivery retry loop with per-attempt status + final result    | `RequestId` trait, observer callback for results   |
| `supervisor`     | restart-policy state machine for crashed agents               | generic over an opaque respawn payload             |
| `crash_insights` | exit-code/signal classification, bounded history, health score | none needed — fully neutral                        |

The broker pins these to its own types in thin adapter modules:
`priorities.rs` (RelayPriority as the queue's scheme, InjectRequest as a
queueable/injectable item) and `supervisor.rs` (SupervisedAgent as the
respawn payload).

## 3. Target end state: one session contract, two runtimes

The end state is a single core session contract implemented by **both** the
PTY runtime and the headless runtime, so everything above it (delivery,
supervision, dashboards, fleet placement) is written once:

```rust
trait AgentSession {
    /// Spawn the agent (CLI-in-PTY or headless app-server/SDK process).
    async fn spawn(&mut self, ...) -> Result<()>;

    /// Deliver a payload and return a receipt confirming acceptance.
    async fn deliver(&mut self, payload: ...) -> Result<DeliveryReceipt>;

    /// Current observed state.
    fn state(&self) -> SessionState; // Ready | Working | Idle | Blocked | Exited

    /// Lifecycle event stream (state transitions, exit, restart).
    fn events(&self) -> ...;

    async fn shutdown(&mut self) -> Result<()>;

    /// Optional capability: live terminal visualization.
    fn terminal(&self) -> Option<&dyn TerminalView>;
}
```

Key decisions:

- **Terminal visualization is a capability, not part of the core.**
  `terminal() -> Option<&dyn TerminalView>` carries resize, snapshot, raw
  input, and live output. The headless runtime returns `None`. Dashboards
  light up the terminal pane only when the capability exists, and agent
  status can advertise `capabilities: ["terminal"]` on the wire so remote
  UIs know without probing.
- **Delivery verification is an implementation detail behind the receipt.**
  The PTY runtime verifies by echo-scanning the terminal grid; the headless
  runtime gets a protocol-level ack. Both surface as a `DeliveryReceipt`,
  with the mechanism reported as receipt metadata — callers never branch on
  runtime type.
- **The session primitives (§2) sit under both implementations** — the same
  queue, injector, supervisor, and crash insights drive a PTY session and a
  headless session identically.

## 4. Remaining phases

1. **Trait seams for the event loops.** `wrap.rs` and `pty_worker.rs` in the
   broker still hard-wire the PTY session into their select loops. Extract
   the loop's interaction surface into traits so a headless session can slot
   into the same loop.
2. **`protocol.rs` split.** Separate PTY/session types (specs, states,
   harness config) from relay messaging types; the session half can then
   live beside the session contract.
3. **Publishing.** relay-pty stays `publish = false` until a second consumer
   exists; the crate boundary is for architecture, not distribution.
