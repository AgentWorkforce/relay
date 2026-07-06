//! Harness-agnostic PTY wrapping for agent CLIs (Claude Code, Codex,
//! Gemini, opencode, …): spawn a CLI inside a pseudo-terminal, mirror its
//! output into a real terminal grid, and answer questions like "is the
//! prompt ready for input?", "is the agent working or idle?", and "is it
//! stuck on a trust/permission prompt?".
//!
//! Module map:
//! - [`pty`] — [`pty::PtySession`]: child spawn via `portable-pty`, an
//!   alacritty-backed terminal grid, and a single write-drainer thread
//!   that serializes all writes to the child (user input, injections,
//!   and replies to terminal query sequences).
//! - [`snapshot`] — render the grid to plain text or replayable ANSI.
//! - [`wait`] — composable conditions for awaiting terminal states
//!   (text appears, output goes idle, cursor position, child exit).
//! - [`readiness`] — per-CLI "prompt is ready" detection on top of `wait`.
//! - [`terminal`] — per-CLI trust/permission/menu prompt detectors.
//! - [`detection`] — working/idle activity inference from output.
//! - [`ansi`], [`utf8_stream`] — ANSI stripping and chunk-safe UTF-8
//!   decoding for raw PTY output.
//! - [`codex_session`] — pre-create a resumable Codex thread via
//!   `codex app-server` so a spawned CLI can resume it across restarts.
//!
//! Alongside the PTY kernel, the crate carries runtime-agnostic session
//! primitives — generic over caller-supplied types so they serve any agent
//! runtime, terminal-backed or headless:
//! - [`queue`] — bounded multi-level priority queue for pending work,
//!   generic over the caller's priority scheme.
//! - [`inject`] — retry loop for delivering a payload into a session,
//!   reporting per-attempt status and a final result to an observer.
//! - [`supervisor`] — restart-policy state machine for crashed agents,
//!   generic over an opaque respawn payload.
//! - [`crash_insights`] — exit-code/signal crash classification, bounded
//!   history, and health scoring.
//!
//! This crate deliberately knows about terminals and agent-CLI behavior
//! only — never about relay messaging, channels, or delivery semantics.
//! Higher layers (the broker) build message delivery and injection on top
//! of these primitives; nothing here may depend on them.

pub mod ansi;
pub mod codex_session;
pub mod crash_insights;
pub mod detection;
pub mod inject;
pub mod pty;
pub mod queue;
pub mod readiness;
pub mod snapshot;
pub mod supervisor;
pub mod terminal;
pub mod utf8_stream;
pub mod wait;
