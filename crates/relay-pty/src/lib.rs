//! Harness-agnostic PTY wrapping: session, terminal grid snapshots,
//! readiness/activity/prompt detection.

pub mod ansi;
pub mod detection;
pub mod pty;
pub mod readiness;
pub mod snapshot;
pub mod terminal;
pub mod utf8_stream;
pub mod wait;
