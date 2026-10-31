//! The local effects the delivery passes call, behind traits so the Codex
//! and Claude bridges plug in from outside and tests run against fakes.

use super::OutboxError;
use std::collections::{HashMap, HashSet};
use std::fmt;

pub use crate::relay::codex::{
    compact,
    rollout::{RolloutSummary, TurnOutcome},
};

/// Why `codex queue` did not take a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexQueueError {
    /// No `codex` with the `queue` command on this computer.
    CodexNotInstalled,
    /// Codex ran and refused; nothing was queued.
    Failed(String),
    /// The command did not finish in time; whether it queued is unknown
    /// until the queue or the session file is checked.
    TimedOut,
}

impl fmt::Display for CodexQueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CodexQueueError::CodexNotInstalled => {
                f.write_str("the codex command line is not installed")
            }
            CodexQueueError::Failed(reason) => f.write_str(reason),
            CodexQueueError::TimedOut => f.write_str("codex did not answer in time"),
        }
    }
}

/// Why the managed app-server did not take a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexAppServerError {
    /// The app-server answered and refused.
    Refused(String),
    /// Whether the message landed is unknown; the session file settles it.
    InDoubt(String),
}

/// Why the Codex app's window socket did not take a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodexBridgeError {
    CodexNotRunning,
    ThreadNotOpen,
    TimedOut,
    Rejected(String),
    Io(String),
}

impl fmt::Display for CodexBridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CodexBridgeError::CodexNotRunning => f.write_str("The Codex app is not running."),
            CodexBridgeError::ThreadNotOpen => {
                f.write_str("That thread is not open in the Codex app. Open it there first.")
            }
            CodexBridgeError::TimedOut => f.write_str("The Codex app did not answer in time."),
            CodexBridgeError::Rejected(reason) => {
                write!(f, "The Codex app refused the message: {reason}")
            }
            CodexBridgeError::Io(reason) => write!(f, "Could not talk to the Codex app: {reason}"),
        }
    }
}

/// How a window-socket session ended early: the bridge failed, or the
/// outbox did while the session was open.
#[derive(Debug)]
pub enum WindowSessionError {
    Bridge(CodexBridgeError),
    Store(OutboxError),
}

impl From<CodexBridgeError> for WindowSessionError {
    fn from(error: CodexBridgeError) -> Self {
        WindowSessionError::Bridge(error)
    }
}

impl From<OutboxError> for WindowSessionError {
    fn from(error: OutboxError) -> Self {
        WindowSessionError::Store(error)
    }
}

/// One open session on the Codex app's window socket.
pub trait CodexWindowDelivering {
    /// The window that owns each thread open in the app, by thread id.
    fn owners(
        &mut self,
        thread_ids: &[String],
    ) -> Result<HashMap<String, String>, CodexBridgeError>;
    /// Starts a turn with `text`, recorded under `message_id`; returns the
    /// turn's id when the app reports one.
    fn start_turn(
        &mut self,
        thread_id: &str,
        text: &str,
        message_id: &str,
        owner: &str,
    ) -> Result<Option<String>, CodexBridgeError>;
}

/// Everything `CodexDelivery` does outside its own store.
pub trait CodexDeliveryEffects: Send + Sync {
    /// Whether a `codex` with the `queue` command is installed.
    fn queue_available(&self) -> bool;
    /// Hands `text` to Codex's own queue for `thread_id`.
    fn queue_send(&self, thread_id: &str, text: &str) -> Result<(), CodexQueueError>;
    /// Whether the message with `reference` still waits in Codex's queue;
    /// `None` when the queue cannot be read.
    fn queue_waiting(&self, thread_id: &str, reference: &str) -> Option<bool>;
    /// Removes this app's queued copy of a message delivered another way.
    fn queue_cleanup(&self, thread_id: &str, reference: &str);
    /// Threads the managed app-server has loaded.
    fn app_server_loaded(&self) -> HashSet<String>;
    /// Sends through the app-server if it has the thread loaded; `false`
    /// when it does not (nothing was sent).
    fn app_server_send(
        &self,
        thread_id: &str,
        text: &str,
        message_id: &str,
    ) -> Result<bool, CodexAppServerError>;
    /// Whether a terminal Codex TUI (which drains `codex queue`) has the
    /// thread open.
    fn terminal_live(&self, thread_id: &str) -> bool;
    /// The thread's session file, summarized; `None` when there is none or
    /// it cannot be read.
    fn rollout(&self, thread_id: &str) -> Option<RolloutSummary>;
    /// Whether the thread is safe to start a turn on. Fails closed: a
    /// session file that exists but cannot be read is busy; a thread with
    /// none yet is idle.
    fn idle(&self, thread_id: &str) -> bool;
    /// Whether the thread's session file can be read, so that a message's
    /// absence from it is evidence.
    fn rollout_readable(&self, thread_id: &str) -> bool;
    /// Opens a window-socket session and runs `body` in it, passing the
    /// body's error through unchanged.
    fn with_window_session(
        &self,
        body: &mut dyn FnMut(&mut dyn CodexWindowDelivering) -> Result<(), WindowSessionError>,
    ) -> Result<(), WindowSessionError>;
}

/// Why `claude --print --cloud` did not take a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaudeBridgeError {
    /// No `claude` command line on this computer.
    ClaudeNotInstalled,
    /// Claude answered and refused; retrying cannot help.
    Refused(String),
    /// Claude reported a failure that may pass.
    Failed(String),
    /// The command was stopped before it finished; whether the message
    /// reached the session is unknown.
    TimedOut,
}

impl fmt::Display for ClaudeBridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClaudeBridgeError::ClaudeNotInstalled => {
                f.write_str("the claude command line is not installed")
            }
            ClaudeBridgeError::Refused(reason) | ClaudeBridgeError::Failed(reason) => {
                f.write_str(reason)
            }
            ClaudeBridgeError::TimedOut => f.write_str("claude did not answer in time"),
        }
    }
}

/// Everything `ClaudeDelivery` does outside its own store.
pub trait ClaudeDeliveryEffects: Send + Sync {
    /// Whether the Claude command line is installed.
    fn is_available(&self) -> bool;
    /// Hands one message to the Claude session `session_id`, already
    /// validated as a `session_…`/`cse_…` id.
    fn send(&self, session_id: &str, text: &str) -> Result<(), ClaudeBridgeError>;
}
