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
//!
//! This crate deliberately knows about terminals and agent-CLI behavior
//! only — never about relay messaging, channels, or delivery semantics.
//! Higher layers (the broker) build message delivery and injection on top
//! of these primitives; nothing here may depend on them.

pub mod ansi;
pub mod detection;
pub mod pty;
pub mod readiness;
pub mod snapshot;
pub mod terminal;
pub mod utf8_stream;
pub mod wait;
