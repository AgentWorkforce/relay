//! The route a message takes into a Codex thread.
//!
//! A message is delivered when the thread's rollout records it, or when a
//! host that has the thread open confirms the turn: the shared app-server
//! (when it has the thread loaded) or a Codex app window (when one owns
//! it). These hosts receive a new turn only after the current turn ends. A live
//! terminal Codex gets every message through its own queue, even while its
//! current turn runs: that queue is first in, first out, so a message never
//! overtakes an earlier handoff still waiting there. The exception is an idle
//! terminal the shared app-server hosts, with no relay message in its queue:
//! it takes the hidden app-server turn instead. That handoff is not
//! delivery and stays accepted until the rollout records it; while the
//! thread runs a turn it is waiting for that turn. A handoff is given 45
//! seconds to be recorded before it is looked at again.

use super::app_server::{self, TurnError};
use super::compact::Held;
use super::hidden_order::HiddenOrder;
use super::runner::{CodexRunner, RunOutcome, SystemRunner};
use super::stop_hook::{self, StopHookInbox};
use super::{ipc, processes, queue, rollout, CodexConfig};
use crate::relay::delivery::policy::MessageRef;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

mod hidden_turn;
mod hosts;
mod native;
mod stalls;
mod system;
mod turn_hook;
pub use hosts::window_turn;

/// Why `codex queue` did not take a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueueError {
    /// No `codex` with the `queue` command here.
    NotInstalled,
    /// Codex ran and refused; nothing was queued.
    Failed(String),
    /// It did not finish in time; whether it queued is unknown until the
    /// queue or the rollout is checked.
    TimedOut,
}

impl std::fmt::Display for QueueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QueueError::NotInstalled => f.write_str("the codex command line is not installed"),
            QueueError::Failed(reason) => f.write_str(reason),
            QueueError::TimedOut => f.write_str("codex did not answer in time"),
        }
    }
}

/// The routes into a thread and what the router reads about it.
pub trait CodexRoutes: Send + Sync {
    /// An exact live desktop-window client, never merely a loaded thread.
    fn native_window_owner(&self, _thread: &str) -> Option<String> {
        None
    }
    /// Exact native client message ID in the existing thread's rollout.
    fn native_recorded(&self, _thread: &str, _message_id: &str) -> bool {
        false
    }
    /// Private native delivery receipts scoped to this Codex installation.
    fn native_receipts(&self) -> Option<PathBuf> {
        None
    }
    fn native_window(
        &self,
        _thread: &str,
        _text: &str,
        _message_id: &str,
        _owner: &str,
        _admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<bool, TurnError> {
        Ok(false)
    }
    /// Whether the rollout records a turn for the message carrying
    /// `message_ref`.
    fn recorded(&self, thread: &str, message_ref: &str) -> bool;
    /// Whether a hidden delivery of it is in the thread's history, waiting
    /// for its turn (`rollout::hidden_waiting`).
    fn hidden_waiting(&self, _thread: &str, _message_ref: &str) -> bool {
        false
    }
    /// The references of every hidden delivery in the thread's history
    /// still waiting for its turn (`RolloutSummary::hidden_refs`).
    fn hidden_refs(&self, _thread: &str) -> Vec<String> {
        Vec::new()
    }
    /// Whether the relay's queue item for it is still waiting; `None` when
    /// the queue cannot be read.
    fn queue_waiting(&self, thread: &str, message_ref: &str) -> Option<bool>;
    /// Whether any relay message is still waiting in the thread's queue;
    /// `None` when the queue cannot be read.
    fn relay_waiting(&self, thread: &str) -> Option<bool>;
    /// Whether no turn is running.
    fn idle(&self, thread: &str) -> bool;
    /// Positive evidence of an active turn and its latest progress. Missing
    /// evidence cannot authorize recovery.
    fn progress(&self, _thread: &str) -> Option<crate::relay::codex::stall::Progress> {
        None
    }
    /// `steer` is `None` when steering would show a hidden relay message.
    fn recover_stalled(
        &self,
        _thread: &str,
        _turn: &str,
        _steer: Option<&str>,
        _message_id: &str,
        _interrupt: bool,
    ) -> Result<app_server::recovery::Recovery, TurnError> {
        Ok(app_server::recovery::Recovery::Unavailable)
    }
    /// A turn through the shared app-server: `Ok(false)` when it does not
    /// have the thread loaded.
    fn app_server(&self, thread: &str, text: &str, message_id: &str) -> Result<bool, TurnError>;
    /// A registered native spawn may resume its unloaded thread.
    fn app_server_spawned(
        &self,
        thread: &str,
        text: &str,
        message_id: &str,
    ) -> Result<bool, TurnError> {
        self.app_server(thread, text, message_id)
    }
    /// `app_server` as a hidden turn only: `Ok(false)`, with no turn
    /// started, when the message would go whole.
    fn app_server_hidden(
        &self,
        thread: &str,
        text: &str,
        message_id: &str,
    ) -> Result<bool, TurnError> {
        self.app_server(thread, text, message_id)
    }
    /// A turn through the Codex app window that owns the thread:
    /// `Ok(false)` when none does.
    fn window(&self, thread: &str, text: &str, message_id: &str) -> Result<bool, TurnError>;
    /// Whether a terminal Codex that drains the queue runs the thread.
    fn terminal_live(&self, thread: &str) -> bool;
    /// Whether any live Codex runs the thread, and so its turns' hooks
    /// (`processes::thread_is_live`).
    fn thread_live(&self, _thread: &str) -> bool {
        false
    }
    /// Hands the message to Codex's queue.
    fn queue_send(&self, thread: &str, text: &str) -> Result<(), QueueError>;
    /// Removes the relay's queue copy of a message that arrived otherwise.
    fn cleanup(&self, thread: &str, message_ref: &str);
    /// Whether Conductor's app-server for one of its chats holds the thread
    /// (`processes::is_conductor_codex`): Conductor shows only the turns it
    /// starts there, so a relayed message should arrive inside one.
    fn conductor_owned(&self, _thread: &str) -> bool {
        false
    }
}

pub const NOT_RUNNING: &str = "Waiting — session not running";
pub const NOT_CONSUMED: &str = "Waiting — terminal session has not consumed the message";
pub const BEHIND_TURN: &str = "Waiting — queued behind the session's active turn";
pub const HANDED_NOT_RUNNING: &str = "Waiting — handed off; session not running";
pub const RECORDING: &str = "Waiting — Codex is recording the message";
pub const BUSY: &str = "Waiting — session busy";
pub const QUEUE_UNREADABLE: &str = "Waiting — Codex queue state is unavailable";
pub const HIDDEN_TURN_PENDING: &str =
    "Waiting — the session holds the message; its turn starts when the session is idle";
pub const BEHIND_HIDDEN: &str = "Waiting — behind an earlier relay message the session holds";

/// How long a handoff is given to show up in the rollout.
const HANDOFF_GRACE: Duration = Duration::from_secs(45);
/// How long a handoff is remembered at all.
const HANDOFF_MEMORY: Duration = Duration::from_secs(60 * 60);

/// Delivers into Codex threads, remembering its handoffs.
pub struct CodexRouter {
    routes: Arc<dyn CodexRoutes>,
    handed_off: Mutex<HashMap<String, Instant>>,
    now: Box<dyn Fn() -> Instant + Send + Sync>,
    /// Messages for Conductor chats, handed over by Agent Relay's Codex Stop
    /// hook as a turn Conductor shows ends (`stop_hook`).
    stop_hook: Option<Arc<StopHookInbox>>,
    /// Later messages wait behind one whose copy waits in the history.
    hidden: HiddenOrder,
    stalls: Mutex<HashMap<String, super::stall::Watch>>,
    stall_timing: super::stall::Timing,
}

impl CodexRouter {
    pub fn new(routes: Arc<dyn CodexRoutes>) -> CodexRouter {
        CodexRouter {
            routes,
            handed_off: Mutex::default(),
            now: Box::new(Instant::now),
            stop_hook: None,
            hidden: HiddenOrder::default(),
            stalls: Mutex::default(),
            stall_timing: super::stall::Timing::from_env(&|key| std::env::var(key).ok()),
        }
    }

    pub fn with_stop_hook(mut self, inbox: Arc<StopHookInbox>) -> CodexRouter {
        self.stop_hook = Some(inbox);
        self
    }

    /// The Stop-hook route into a Conductor chat, or `None` to go on to the
    /// queue. A chat that is working gets the message as its turn ends,
    /// inside a turn Conductor shows; an idle one is not held, as no turn
    /// may come. A message still held when its turn ended without the hook
    /// taking it (the hook did not run) goes back to the queue, unless the
    /// hook took it meanwhile.
    fn stop_hook_route(&self, thread: &str, message_id: &str, text: &str) -> Option<InjectOutcome> {
        let inbox = self.stop_hook.as_ref()?;
        if let Some(at) = inbox.taken_at(message_id) {
            if at.elapsed() < HANDOFF_GRACE {
                return Some(InjectOutcome::Accepted(RECORDING.into()));
            }
            inbox.forget(message_id);
            return Some(InjectOutcome::InDoubt(
                "Agent Relay's Codex hook handed this over, but Codex did not record it".into(),
            ));
        }
        // Never ahead of a relay message already in the thread's queue:
        // Codex runs those first, after this turn.
        let holds = inbox.is_ready()
            && self.routes.conductor_owned(thread)
            && !self.routes.idle(thread)
            && self.routes.relay_waiting(thread) == Some(false);
        if !holds {
            if inbox.is_held(message_id) && !inbox.withdraw(message_id) {
                return Some(InjectOutcome::Accepted(RECORDING.into()));
            }
            return None;
        }
        inbox.hold(thread, message_id, text);
        Some(InjectOutcome::Accepted(stop_hook::HELD.into()))
    }

    /// Notes that the message was in Codex's hands just now: the grace
    /// runs from the last time it was seen queued or handed over, since it
    /// can only be consumed after that.
    fn remember(&self, message_id: &str) {
        let now = (self.now)();
        let mut handed_off = self.handed_off.lock().unwrap();
        handed_off.insert(message_id.to_string(), now);
        handed_off.retain(|_, at| now.saturating_duration_since(*at) < HANDOFF_MEMORY);
    }

    fn remember_once(&self, message_id: &str) {
        let now = (self.now)();
        let mut handed_off = self.handed_off.lock().unwrap();
        handed_off.entry(message_id.to_string()).or_insert(now);
        handed_off.retain(|_, at| now.saturating_duration_since(*at) < HANDOFF_MEMORY);
    }

    fn recently_handed_off(&self, message_id: &str) -> bool {
        let now = (self.now)();
        self.handed_off
            .lock()
            .unwrap()
            .get(message_id)
            .is_some_and(|at| now.saturating_duration_since(*at) < HANDOFF_GRACE)
    }

    fn missing_handoff_outcome(&self, message_id: &str) -> InjectOutcome {
        let now = (self.now)();
        let mut handed_off = self.handed_off.lock().unwrap();
        match handed_off.get(message_id).copied() {
            Some(at) if now.saturating_duration_since(at) >= HANDOFF_GRACE => {
                handed_off.remove(message_id);
                InjectOutcome::InDoubt(
                    "Codex accepted this handoff, but it is no longer queued and was not recorded"
                        .into(),
                )
            }
            Some(_) => InjectOutcome::Accepted(RECORDING.into()),
            None => {
                handed_off.insert(message_id.to_string(), now);
                handed_off.retain(|_, at| now.saturating_duration_since(*at) < HANDOFF_MEMORY);
                InjectOutcome::Accepted(RECORDING.into())
            }
        }
    }

    fn forget(&self, message_id: &str) {
        self.handed_off.lock().unwrap().remove(message_id);
    }

    fn delivered(&self, thread: &str, message_id: &str, message_ref: &str) -> InjectOutcome {
        self.forget_waiting(thread, message_id);
        self.forget(message_id);
        self.settle_turn_hook(message_id);
        self.hidden.delivered(thread, message_id);
        self.routes.cleanup(thread, message_ref);
        InjectOutcome::Delivered
    }

    /// A handoff in the thread's queue: waiting for the running turn of a
    /// live terminal to end, or for a terminal to take it. A rollout whose
    /// last turn never ended, with no terminal running the thread, is a
    /// stopped session, not a busy one.
    fn handed(&self, thread: &str, message_id: &str) -> InjectOutcome {
        self.remember(message_id);
        if !self.routes.terminal_live(thread) {
            InjectOutcome::Accepted(HANDED_NOT_RUNNING.into())
        } else if self.routes.idle(thread) {
            InjectOutcome::Accepted(NOT_CONSUMED.into())
        } else {
            InjectOutcome::WaitingForTurn(BEHIND_TURN.into())
        }
    }

    /// Observes an exact queue handoff that a prior attempt already proved
    /// accepted. This path never writes another queue item: after a restart
    /// the queue can be consumed before the rollout becomes readable, and a
    /// resend in that gap would duplicate the user's message.
    pub fn observe(&self, thread: &str, message_id: &str) -> InjectOutcome {
        if !queue::is_thread_id(thread) {
            return InjectOutcome::Refused("not a Codex thread id".into());
        }
        if let Some(outcome) = self.previous_native(thread, message_id) {
            return outcome;
        }
        let message_ref = MessageRef::of(message_id);
        if self.routes.recorded(thread, &message_ref) {
            return self.delivered(thread, message_id, &message_ref);
        }
        match self.routes.queue_waiting(thread, &message_ref) {
            Some(true) => return self.handed(thread, message_id),
            Some(false) => return self.missing_handoff_outcome(message_id),
            None => {}
        }
        // An unreadable queue cannot prove the accepted handoff vanished.
        // Retain its original observation time so a later readable absence
        // can cross the bounded recording grace without ever resending.
        self.remember_once(message_id);
        InjectOutcome::Accepted(QUEUE_UNREADABLE.into())
    }

    /// Puts `text` into `thread`, never through a running turn's hook:
    /// Relay Connect observes an accepted handoff only through the queue
    /// and the rollout (`observe`). Blocking.
    pub fn inject(&self, thread: &str, message_id: &str, text: &str) -> InjectOutcome {
        self.inject_using(thread, message_id, text, &|| None, false, false)
    }

    /// `inject` for a registered agent, which a running turn's hook may
    /// also take (`turn_hook_route`), handing a terminal's queue the
    /// pointer `pointer` makes (`message_pointer`) in place of `text`, when
    /// it makes one. It is asked only at that handoff; other hosts get
    /// `text`.
    pub fn inject_with(
        &self,
        thread: &str,
        message_id: &str,
        text: &str,
        pointer: &dyn Fn() -> Option<String>,
    ) -> InjectOutcome {
        self.inject_using(thread, message_id, text, pointer, false, true)
    }

    /// Only the registered native-spawn path grants permission to resume.
    pub fn inject_spawned(&self, thread: &str, message_id: &str, text: &str) -> InjectOutcome {
        self.inject_using(thread, message_id, text, &|| None, true, true)
    }

    fn inject_using(
        &self,
        thread: &str,
        message_id: &str,
        text: &str,
        pointer: &dyn Fn() -> Option<String>,
        spawned: bool,
        hooks: bool,
    ) -> InjectOutcome {
        if !queue::is_thread_id(thread) {
            return InjectOutcome::Refused("not a Codex thread id".into());
        }
        if let Some(outcome) = self.previous_native(thread, message_id) {
            return outcome;
        }
        let message_ref = MessageRef::of(message_id);
        let routes = &self.routes;
        // A message whose whole text the thread's history already holds goes
        // on as its line alone, by whichever route takes it; after a restart
        // the rollout says so.
        super::compact::recover(
            thread,
            message_id,
            routes.hidden_waiting(thread, &message_ref),
        );
        let text = &super::compact::after_injection(thread, message_id, text);
        self.hidden.refresh(thread, message_id, (self.now)());
        if routes.recorded(thread, &message_ref) {
            // Idle deliveries were noted for the recap when queued; one the
            // hook handed over was shown and is never noted, even after a
            // restart forgot it was the hook's.
            if let Some(inbox) = &self.stop_hook {
                inbox.forget(message_id);
            }
            return self.delivered(thread, message_id, &message_ref);
        }
        let queued = routes.queue_waiting(thread, &message_ref);
        if queued == Some(true) {
            return self.handed(thread, message_id);
        }
        if self.recently_handed_off(message_id) {
            return InjectOutcome::Accepted(RECORDING.into());
        }
        if let Some(outcome) = self.hook_routes(thread, message_id, text, queued, hooks) {
            return outcome;
        }
        // A live TUI owns its turn scheduling. Hand it the message now
        // rather than waiting for a possibly long-running turn to end, and
        // only through its queue: Codex runs that queue in order, one turn
        // at a time, so another host could overtake an earlier handoff.
        if self.behind_hidden(thread, message_id) {
            return InjectOutcome::Waiting(BEHIND_HIDDEN.into());
        }
        if routes.terminal_live(thread) {
            if let Some(outcome) = self.hidden_terminal_turn(thread, message_id, text, queued) {
                return outcome;
            }
            return self.handoff_to_terminal(thread, message_id, text, pointer, queued);
        }
        // A turn through another host would overtake relay messages still
        // in the queue, which whichever host next has the thread runs
        // first: join that queue behind them instead. It is an accepted
        // handoff, so it is never age-expired while they wait.
        match routes.relay_waiting(thread) {
            Some(false) => {}
            Some(true) => {
                return self.handoff_to_terminal(thread, message_id, text, pointer, queued)
            }
            None => return InjectOutcome::Waiting(QUEUE_UNREADABLE.into()),
        }
        // turn/start on a busy host can steer the existing turn. Keep the
        // message pending so it gets a turn of its own after that turn ends.
        // Check again before the window fallback: host discovery can take time.
        let app_server = if spawned {
            CodexRoutes::app_server_spawned
        } else {
            CodexRoutes::app_server
        };
        for route in [app_server, CodexRoutes::window] {
            if let Some(outcome) = self.host_turn(route, thread, message_id, text, spawned) {
                return outcome;
            }
        }
        InjectOutcome::Waiting(NOT_RUNNING.into())
    }

    /// A turn through one host while the thread is idle, claimed first for
    /// a route other than the hook; `None` when the host does not have it.
    /// A busy thread waits for its turn (`wait_for_turn`).
    fn host_turn(
        &self,
        route: fn(&(dyn CodexRoutes + 'static), &str, &str, &str) -> Result<bool, TurnError>,
        thread: &str,
        message_id: &str,
        text: &str,
        spawned: bool,
    ) -> Option<InjectOutcome> {
        if !self.routes.idle(thread) {
            return Some(self.wait_for_turn(thread, message_id, text, spawned));
        }
        if let Err(outcome) = self.leave_turn_hook(message_id) {
            return Some(outcome);
        }
        match route(self.routes.as_ref(), thread, text, message_id) {
            Ok(true) => Some(self.delivered(thread, message_id, &MessageRef::of(message_id))),
            Ok(false) => None,
            Err(TurnError::Refused(reason)) => Some(self.refused_turn(thread, message_id, reason)),
            Err(TurnError::InDoubt(reason)) => Some(InjectOutcome::InDoubt(reason)),
        }
    }

    fn handoff_to_terminal(
        &self,
        thread: &str,
        message_id: &str,
        text: &str,
        pointer: &dyn Fn() -> Option<String>,
        queued: Option<bool>,
    ) -> InjectOutcome {
        let routes = &self.routes;
        let message_ref = &MessageRef::of(message_id);
        // The queue cannot say whether an earlier handoff is still there:
        // another one could run the message twice.
        if queued.is_none() {
            return InjectOutcome::Waiting(QUEUE_UNREADABLE.into());
        }
        // Once the thread may hold the message, a pointer would have it read
        // twice: `text` is then its line (injected) or the whole message
        // (uncertain), as `after_injection` made it.
        let pointer = super::compact::held(thread, message_id)
            .is_none()
            .then(pointer)
            .flatten();
        if let Err(outcome) = self.leave_turn_hook(message_id) {
            return outcome;
        }
        match routes.queue_send(thread, pointer.as_deref().unwrap_or(text)) {
            Ok(()) => {
                // A queued turn of its own, which Conductor does not show:
                // the chat's next turn that it shows recaps it, once Codex
                // records the agent's answer.
                if let Some(inbox) = &self.stop_hook {
                    if inbox.is_ready() && routes.conductor_owned(thread) {
                        inbox.note_unseen(thread, message_id, text);
                    }
                }
                self.handed(thread, message_id)
            }
            Err(QueueError::TimedOut) => {
                if routes.queue_waiting(thread, message_ref) == Some(true) {
                    self.handed(thread, message_id)
                } else {
                    InjectOutcome::InDoubt("Codex queue did not answer in time".into())
                }
            }
            // A message the history already holds waits under the same
            // message instead: a failed channel batch is dropped and its
            // posts come back under another id, behind this one's hold.
            Err(error) if super::compact::held(thread, message_id) == Some(Held::Injected) => {
                InjectOutcome::Waiting(format!("{HIDDEN_TURN_PENDING} ({error})"))
            }
            Err(error) => InjectOutcome::Retry(error.to_string()),
        }
    }

    /// Removes this relay-owned terminal-queue handoff, if it is still
    /// waiting. App-server and app-window routes deliver synchronously and
    /// therefore leave no cancellable copy.
    pub fn cancel(&self, thread: &str, message_id: &str) {
        if !queue::is_thread_id(thread) {
            return;
        }
        self.forget(message_id);
        self.forget_waiting(thread, message_id);
        // Only a message whose whole text may be in the history leaves a
        // copy there to give up on.
        if super::compact::held(thread, message_id).is_some() {
            self.hidden.abandon(thread, message_id);
        } else {
            self.hidden.release(thread, message_id);
        }
        if let Some(inbox) = &self.stop_hook {
            inbox.cancel(message_id);
        }
        self.settle_turn_hook(message_id);
        self.routes.cleanup(thread, &MessageRef::of(message_id));
    }
}

/// How long `codex queue` is given.
const QUEUE_TIMEOUT: Duration = Duration::from_secs(20);
/// How long `codex queue --help` is given.
const SUPPORT_TIMEOUT: Duration = Duration::from_secs(10);

/// The routes on this computer.
pub struct SystemCodexRoutes {
    config: CodexConfig,
    table: Arc<dyn ProcessTable>,
    uid: u32,
    runner: Arc<dyn CodexRunner>,
    /// Whether each executable has the `queue` command, by path and
    /// modification time so an updated binary is asked again.
    queue_support: Mutex<HashMap<(PathBuf, Option<SystemTime>), bool>>,
}

impl SystemCodexRoutes {
    pub fn new(config: CodexConfig, table: Arc<dyn ProcessTable>, uid: u32) -> SystemCodexRoutes {
        SystemCodexRoutes::with_runner(config, table, uid, Arc::new(SystemRunner))
    }

    pub fn with_runner(
        config: CodexConfig,
        table: Arc<dyn ProcessTable>,
        uid: u32,
        runner: Arc<dyn CodexRunner>,
    ) -> SystemCodexRoutes {
        SystemCodexRoutes {
            config,
            table,
            uid,
            runner,
            queue_support: Mutex::default(),
        }
    }

    /// The thread id as Codex's own database spells it: targets hold it
    /// lowercased, and Codex's app and queue are asked in Codex's spelling.
    fn spelled(&self, thread: &str) -> String {
        crate::relay::codex::threads::read_one(&self.config, thread)
            .map(|found| found.id)
            .unwrap_or_else(|| thread.to_string())
    }

    /// Asks the binary itself (`codex queue --help`), once per build. Only
    /// its own answer is remembered: one that would not start or answer in
    /// time is asked again next time.
    fn supports_queue(&self, executable: &Path) -> bool {
        let modified = std::fs::metadata(executable)
            .and_then(|m| m.modified())
            .ok();
        let key = (executable.to_path_buf(), modified);
        if let Some(known) = self.queue_support.lock().unwrap().get(&key) {
            return *known;
        }
        let arguments = ["queue".to_string(), "--help".to_string()];
        let RunOutcome::Exited { code, .. } = self.runner.run_in_home(
            executable,
            &arguments,
            SUPPORT_TIMEOUT,
            &self.config.home,
            &self.config.sqlite_home,
        ) else {
            return false;
        };
        self.queue_support.lock().unwrap().insert(key, code == 0);
        code == 0
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    mod live_turn_hook;
    mod spawned;
    mod stalls;
    mod turn_hook;
    use super::*;
    use crate::relay::codex::app_server::tests::FakeAppServer;
    use crate::relay::codex::compact;
    #[cfg(unix)]
    use crate::relay::codex::ipc::tests::FakeRouter;
    use crate::relay::codex::processes::tests::{codex, codex_process, trusted_table, UID};
    use crate::relay::codex::runner::tests::FakeRunner;
    use crate::relay::codex::threads::tests::config;
    use crate::relay::process::FakeProcess;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    const THREAD: &str = "01a0f207-6743-7f12-ac70-f791c2c01c64";

    /// Routes whose answers the test sets and whose sends it counts.
    #[derive(Default)]
    struct Fake {
        recorded: AtomicBool,
        queued: Mutex<Option<bool>>,
        busy: AtomicBool,
        app_server: Mutex<Option<Result<bool, TurnError>>>,
        window: Mutex<Option<Result<bool, TurnError>>>,
        terminal_live: AtomicBool,
        queue_result: Mutex<Option<Result<(), QueueError>>>,
        queue_marks_waiting: AtomicBool,
        app_sends: AtomicUsize,
        spawn_sends: AtomicUsize,
        window_sends: AtomicUsize,
        queue_sends: AtomicUsize,
        queue_texts: Mutex<Vec<String>>,
        hidden_waiting: AtomicBool,
        hidden_refs: Mutex<Vec<String>>,
        cleanups: AtomicUsize,
        conductor: AtomicBool,
        live: AtomicBool,
        /// `relay_waiting` when set, else `queued`.
        relay_ahead: Mutex<Option<Option<bool>>>,
        progress: Mutex<Option<super::super::stall::Progress>>,
        recoveries: Mutex<Vec<bool>>,
        steers: Mutex<Vec<Option<String>>>,
        recovery: Mutex<Option<Result<app_server::recovery::Recovery, TurnError>>>,
    }

    impl Fake {
        fn new() -> Arc<Fake> {
            let fake = Fake::default();
            *fake.queued.lock().unwrap() = Some(false);
            Arc::new(fake)
        }
    }

    impl CodexRoutes for Fake {
        fn progress(&self, _: &str) -> Option<super::super::stall::Progress> {
            self.progress.lock().unwrap().clone()
        }
        fn recover_stalled(
            &self,
            _: &str,
            _: &str,
            steer: Option<&str>,
            _: &str,
            interrupt: bool,
        ) -> Result<app_server::recovery::Recovery, TurnError> {
            self.recoveries.lock().unwrap().push(interrupt);
            self.steers.lock().unwrap().push(steer.map(str::to_string));
            self.recovery
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(Ok(app_server::recovery::Recovery::Unsupported))
        }
        fn recorded(&self, _: &str, _: &str) -> bool {
            self.recorded.load(Ordering::SeqCst)
        }
        fn hidden_waiting(&self, _: &str, _: &str) -> bool {
            self.hidden_waiting.load(Ordering::SeqCst)
        }
        fn hidden_refs(&self, _: &str) -> Vec<String> {
            self.hidden_refs.lock().unwrap().clone()
        }
        fn queue_waiting(&self, _: &str, _: &str) -> Option<bool> {
            *self.queued.lock().unwrap()
        }
        fn relay_waiting(&self, _: &str) -> Option<bool> {
            self.relay_ahead
                .lock()
                .unwrap()
                .unwrap_or(*self.queued.lock().unwrap())
        }
        fn idle(&self, _: &str) -> bool {
            !self.busy.load(Ordering::SeqCst)
        }
        fn app_server(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            self.app_sends.fetch_add(1, Ordering::SeqCst);
            self.app_server.lock().unwrap().clone().unwrap_or(Ok(false))
        }
        fn app_server_spawned(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            self.spawn_sends.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        }
        fn window(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            self.window_sends.fetch_add(1, Ordering::SeqCst);
            self.window.lock().unwrap().clone().unwrap_or(Ok(false))
        }
        fn terminal_live(&self, _: &str) -> bool {
            self.terminal_live.load(Ordering::SeqCst)
        }
        fn queue_send(&self, _: &str, text: &str) -> Result<(), QueueError> {
            self.queue_sends.fetch_add(1, Ordering::SeqCst);
            self.queue_texts.lock().unwrap().push(text.to_string());
            if self.queue_marks_waiting.load(Ordering::SeqCst) {
                *self.queued.lock().unwrap() = Some(true);
            }
            self.queue_result.lock().unwrap().clone().unwrap_or(Ok(()))
        }
        fn cleanup(&self, _: &str, _: &str) {
            self.cleanups.fetch_add(1, Ordering::SeqCst);
        }
        fn conductor_owned(&self, _: &str) -> bool {
            self.conductor.load(Ordering::SeqCst)
        }
        fn thread_live(&self, _: &str) -> bool {
            self.live.load(Ordering::SeqCst)
        }
    }

    // A Conductor chat that is working gets the message from Agent Relay's
    // Stop hook as its turn ends; an idle one through the queue, noted for
    // its next turn; one the hook never took goes back to the queue.
    #[test]
    fn a_working_conductor_chat_gets_the_message_from_the_stop_hook() {
        let fake = Fake::new();
        fake.conductor.store(true, Ordering::SeqCst);
        fake.terminal_live.store(true, Ordering::SeqCst);
        fake.busy.store(true, Ordering::SeqCst);
        let inbox = Arc::new(StopHookInbox::default());
        inbox.set_ready(true);
        let router = CodexRouter::new(fake.clone()).with_stop_hook(inbox.clone());
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";

        assert_eq!(
            router.inject(THREAD, "m1", text),
            InjectOutcome::Accepted(stop_hook::HELD.into())
        );
        assert!(inbox.is_held("m1"));
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 0, "not queued");
        // The hook hands it over; until Codex records it, it is recording.
        assert_eq!(
            inbox.answer(THREAD, false, true, &|_| false, &|_| None)["decision"],
            "block"
        );
        assert_eq!(
            router.inject(THREAD, "m1", text),
            InjectOutcome::Accepted(RECORDING.into())
        );
        // Even once the chat is idle, a taken message is never queued.
        fake.busy.store(false, Ordering::SeqCst);
        assert_eq!(
            router.inject(THREAD, "m1", text),
            InjectOutcome::Accepted(RECORDING.into())
        );
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 0);
        fake.recorded.store(true, Ordering::SeqCst);
        assert_eq!(router.inject(THREAD, "m1", text), InjectOutcome::Delivered);
        assert_eq!(
            inbox.answer(THREAD, false, true, &|_| false, &|_| None),
            serde_json::json!({}),
            "not recapped"
        );
        fake.recorded.store(false, Ordering::SeqCst);

        // Held, but the turn ended and the hook did not take it: queued.
        fake.busy.store(true, Ordering::SeqCst);
        router.inject(THREAD, "m2", text);
        assert!(inbox.is_held("m2"));
        fake.busy.store(false, Ordering::SeqCst);
        fake.queue_marks_waiting.store(true, Ordering::SeqCst);
        router.inject(THREAD, "m2", text);
        assert!(!inbox.is_held("m2"));
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 1);

        // Delivered through the queue while idle: recapped at the next turn.
        fake.recorded.store(true, Ordering::SeqCst);
        assert_eq!(router.inject(THREAD, "m2", text), InjectOutcome::Delivered);
        let recap = inbox.answer(THREAD, false, true, &|_| false, &|_| Some("done".into()));
        assert!(recap["reason"]
            .as_str()
            .unwrap()
            .contains("while this chat was idle"));
    }

    // Review on #385: a message never goes ahead of a relay message already
    // in the thread's queue, and a cancelled one leaves nothing behind.
    #[test]
    fn a_held_message_never_overtakes_the_queue_and_cancel_drops_it() {
        let fake = Fake::new();
        fake.conductor.store(true, Ordering::SeqCst);
        fake.terminal_live.store(true, Ordering::SeqCst);
        fake.busy.store(true, Ordering::SeqCst);
        let inbox = Arc::new(StopHookInbox::default());
        inbox.set_ready(true);
        let router = CodexRouter::new(fake.clone()).with_stop_hook(inbox.clone());
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";
        router.inject(THREAD, "m1", text);
        assert!(inbox.is_held("m1"));
        router.cancel(THREAD, "m1");
        assert!(!inbox.is_held("m1"));
        assert_eq!(
            inbox.answer(THREAD, false, true, &|_| false, &|_| None),
            serde_json::json!({})
        );
        // Another relay message waits in Codex's queue: this one joins it.
        struct Waiting(Arc<Fake>);
        impl CodexRoutes for Waiting {
            fn recorded(&self, t: &str, r: &str) -> bool {
                self.0.recorded(t, r)
            }
            fn queue_waiting(&self, t: &str, r: &str) -> Option<bool> {
                self.0.queue_waiting(t, r)
            }
            fn relay_waiting(&self, _: &str) -> Option<bool> {
                Some(true)
            }
            fn idle(&self, t: &str) -> bool {
                self.0.idle(t)
            }
            fn app_server(&self, t: &str, x: &str, m: &str) -> Result<bool, TurnError> {
                self.0.app_server(t, x, m)
            }
            fn window(&self, t: &str, x: &str, m: &str) -> Result<bool, TurnError> {
                self.0.window(t, x, m)
            }
            fn terminal_live(&self, t: &str) -> bool {
                self.0.terminal_live(t)
            }
            fn queue_send(&self, t: &str, x: &str) -> Result<(), QueueError> {
                self.0.queue_send(t, x)
            }
            fn cleanup(&self, t: &str, r: &str) {
                self.0.cleanup(t, r)
            }
            fn conductor_owned(&self, t: &str) -> bool {
                self.0.conductor_owned(t)
            }
        }
        let router =
            CodexRouter::new(Arc::new(Waiting(fake.clone()))).with_stop_hook(inbox.clone());
        router.inject(THREAD, "m2", text);
        assert!(!inbox.is_held("m2"));
        assert_eq!(
            fake.queue_sends.load(Ordering::SeqCst),
            1,
            "queued behind the earlier one"
        );
    }

    #[test]
    fn nothing_is_held_without_a_ready_hook_or_outside_conductor() {
        let fake = Fake::new();
        fake.terminal_live.store(true, Ordering::SeqCst);
        fake.busy.store(true, Ordering::SeqCst);
        fake.queue_marks_waiting.store(true, Ordering::SeqCst);
        let inbox = Arc::new(StopHookInbox::default());
        inbox.set_ready(true);
        let router = CodexRouter::new(fake.clone()).with_stop_hook(inbox.clone());
        // A terminal Codex, not Conductor's: queued as before.
        router.inject(THREAD, "m1", "[via Agent Relay — ref 0123456789ab]\n\nhi");
        assert!(!inbox.is_held("m1"));
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 1);
        // Conductor's, but the hook is not installed or trusted.
        fake.conductor.store(true, Ordering::SeqCst);
        inbox.set_ready(false);
        *fake.queued.lock().unwrap() = Some(false);
        router.inject(THREAD, "m3", "[via Agent Relay — ref 0123456789ac]\n\nhi");
        assert!(!inbox.is_held("m3"));
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 2);
    }

    /// A terminal Codex thread as its queue and rollout show it: the queue
    /// is first in, first out, and an idle thread takes its head as the
    /// next turn, one turn at a time.
    #[derive(Default)]
    struct Terminal {
        queue: Mutex<std::collections::VecDeque<String>>,
        recorded: Mutex<Vec<String>>,
        turn: AtomicBool,
        stopped: AtomicBool,
        queue_sends: AtomicUsize,
        host_sends: AtomicUsize,
    }

    impl Terminal {
        /// The running turn ends; Codex takes the next queued message, if
        /// any, as a new turn and records it.
        fn end_turn(&self) {
            let next = self.queue.lock().unwrap().pop_front();
            self.turn.store(next.is_some(), Ordering::SeqCst);
            if let Some(next) = next {
                self.recorded.lock().unwrap().push(next);
            }
        }
    }

    impl CodexRoutes for Terminal {
        fn recorded(&self, _: &str, message_ref: &str) -> bool {
            self.recorded
                .lock()
                .unwrap()
                .iter()
                .any(|r| r == message_ref)
        }
        fn queue_waiting(&self, _: &str, message_ref: &str) -> Option<bool> {
            Some(self.queue.lock().unwrap().iter().any(|r| r == message_ref))
        }
        fn relay_waiting(&self, _: &str) -> Option<bool> {
            Some(!self.queue.lock().unwrap().is_empty())
        }
        fn idle(&self, _: &str) -> bool {
            !self.turn.load(Ordering::SeqCst)
        }
        fn app_server(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            // A live one runs its own server (`-c`): the shared app-server
            // does not have its thread.
            if !self.stopped.load(Ordering::SeqCst) {
                return Ok(false);
            }
            self.host_sends.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        }
        fn window(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            self.host_sends.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        }
        fn terminal_live(&self, _: &str) -> bool {
            !self.stopped.load(Ordering::SeqCst)
        }
        fn queue_send(&self, _: &str, text: &str) -> Result<(), QueueError> {
            self.queue_sends.fetch_add(1, Ordering::SeqCst);
            let message_ref = MessageRef::in_text(text).expect("an attributed message");
            self.queue.lock().unwrap().push_back(message_ref);
            Ok(())
        }
        fn cleanup(&self, _: &str, message_ref: &str) {
            self.queue.lock().unwrap().retain(|r| r != message_ref);
        }
    }

    fn attributed(message_id: &str) -> String {
        format!(
            "[Relay Connect — from host · ref {}]\n\n{message_id}",
            MessageRef::of(message_id)
        )
    }

    // Issue #238: messages arriving during a long terminal turn enter the
    // queue at once, in order, exactly once, wait for the turn, then become
    // visible one turn at a time.
    #[test]
    fn messages_during_a_long_turn_are_queued_at_once_and_settle_in_order() {
        let terminal = Arc::new(Terminal::default());
        terminal.turn.store(true, Ordering::SeqCst);
        let router = CodexRouter::new(terminal.clone());
        let messages = ["m1", "m2", "m3"];
        for id in messages {
            assert_eq!(
                router.inject(THREAD, id, &attributed(id)),
                InjectOutcome::WaitingForTurn(BEHIND_TURN.into())
            );
        }
        let order: Vec<_> = messages.iter().map(|id| MessageRef::of(id)).collect();
        assert_eq!(
            Vec::from(terminal.queue.lock().unwrap().clone()),
            order,
            "inserted immediately, in arrival order"
        );
        for id in messages {
            assert_eq!(
                router.inject(THREAD, id, &attributed(id)),
                InjectOutcome::WaitingForTurn(BEHIND_TURN.into()),
                "a retried handoff is observed, not inserted again"
            );
            assert_eq!(
                router.observe(THREAD, id),
                InjectOutcome::WaitingForTurn(BEHIND_TURN.into())
            );
        }
        assert_eq!(count(&terminal.queue_sends), 3);
        assert_eq!(count(&terminal.host_sends), 0);

        terminal.end_turn();
        assert_eq!(router.observe(THREAD, "m1"), InjectOutcome::Delivered);
        assert_eq!(
            router.observe(THREAD, "m2"),
            InjectOutcome::WaitingForTurn(BEHIND_TURN.into()),
            "the turn for m1 now runs ahead of m2"
        );
        terminal.end_turn();
        terminal.end_turn();
        for id in messages {
            assert_eq!(router.observe(THREAD, id), InjectOutcome::Delivered);
        }
        terminal.end_turn();
        assert!(router.routes.idle(THREAD));
        assert_eq!(*terminal.recorded.lock().unwrap(), order);
        assert_eq!(count(&terminal.queue_sends), 3);
    }

    // Review of #296: the terminal exits mid-turn and the thread opens in
    // a host that has it loaded. A later message joins the queue behind
    // the queued ones instead of overtaking them through the host, and the
    // dangling turn in the rollout is not reported as an active turn.
    #[test]
    fn a_later_message_never_overtakes_queued_handoffs_through_another_host() {
        let terminal = Arc::new(Terminal::default());
        terminal.turn.store(true, Ordering::SeqCst);
        let router = CodexRouter::new(terminal.clone());
        for id in ["m1", "m2"] {
            assert_eq!(
                router.inject(THREAD, id, &attributed(id)),
                InjectOutcome::WaitingForTurn(BEHIND_TURN.into())
            );
        }
        // Killed mid-turn: the rollout's last turn never ends.
        terminal.stopped.store(true, Ordering::SeqCst);
        assert_eq!(
            router.observe(THREAD, "m1"),
            InjectOutcome::Accepted(HANDED_NOT_RUNNING.into())
        );
        assert_eq!(
            router.inject(THREAD, "m3", &attributed("m3")),
            InjectOutcome::Accepted(HANDED_NOT_RUNNING.into())
        );
        assert_eq!(count(&terminal.host_sends), 0);
        assert_eq!(
            Vec::from(terminal.queue.lock().unwrap().clone()),
            ["m1", "m2", "m3"].map(MessageRef::of),
            "queued behind the earlier handoffs, in order"
        );
        // An empty queue alone does not prove the host's turn ended.
        terminal.queue.lock().unwrap().clear();
        assert_eq!(
            router.inject(THREAD, "m4", &attributed("m4")),
            InjectOutcome::Waiting(BUSY.into())
        );
        assert_eq!(count(&terminal.host_sends), 0);
        terminal.turn.store(false, Ordering::SeqCst);
        assert_eq!(
            router.inject(THREAD, "m4", &attributed("m4")),
            InjectOutcome::Delivered
        );
        assert_eq!(count(&terminal.host_sends), 1);
    }

    // Another probe sharing the queue: its relay item, unknown to this
    // router, keeps a later message in the queue rather than a host turn;
    // an unreadable queue starts no host turn either.
    #[test]
    fn another_probes_queued_handoff_keeps_later_messages_in_the_queue() {
        let shared = Arc::new(SharedQueue::default());
        shared.foreign.store(true, Ordering::SeqCst);
        let router = CodexRouter::new(shared.clone());
        assert_eq!(
            router.inject(THREAD, "m2", "hello"),
            InjectOutcome::Accepted(HANDED_NOT_RUNNING.into())
        );
        assert_eq!(count(&shared.queue_sends), 1);
        shared.unreadable.store(true, Ordering::SeqCst);
        assert_eq!(
            router.inject(THREAD, "m3", "hello"),
            InjectOutcome::Waiting(QUEUE_UNREADABLE.into())
        );
        assert_eq!(count(&shared.host_sends), 0);
    }

    // With relay messages hidden, a terminal's queue gets the pointer,
    // made only at that handoff; a host turn gets the whole text.
    #[test]
    fn only_a_terminal_queue_is_handed_the_pointer() {
        let texts = Arc::new(Texts::default());
        let router = CodexRouter::new(texts.clone());
        let made = AtomicUsize::new(0);
        let pointer = |id: &str| {
            made.fetch_add(1, Ordering::SeqCst);
            Some(format!(
                "[via Agent Relay — ref {}]\n[read the message: x]",
                MessageRef::of(id)
            ))
        };
        let hosted = router.inject_with(THREAD, "m1", &attributed("m1"), &|| pointer("m1"));
        assert_eq!(hosted, InjectOutcome::Delivered);
        assert_eq!(*texts.hosted.lock().unwrap(), [attributed("m1")]);
        assert_eq!(count(&made), 0, "no pointer is made for a host turn");
        texts.live.store(true, Ordering::SeqCst);
        router.inject_with(THREAD, "m2", &attributed("m2"), &|| pointer("m2"));
        assert_eq!(*texts.queued.lock().unwrap(), [pointer("m2").unwrap()]);
        let queued = texts.queued.lock().unwrap()[0].clone();
        assert_eq!(MessageRef::in_text(&queued), Some(MessageRef::of("m2")));
        router.inject(THREAD, "m3", &attributed("m3"));
        assert_eq!(
            texts.queued.lock().unwrap()[1],
            attributed("m3"),
            "off sends it whole"
        );
    }

    // A compact turn that failed after its hidden copy went into this
    // thread's history is retried through the queue as its line alone, and
    // one whose injection is uncertain as the whole message: never a
    // pointer the agent would follow to read the message again.
    #[test]
    fn a_message_the_thread_may_hold_is_never_a_pointer() {
        use super::super::compact::{remember, visible_line, Held};
        let texts = Arc::new(Texts::default());
        texts.live.store(true, Ordering::SeqCst);
        let router = CodexRouter::new(texts.clone());
        let made = AtomicUsize::new(0);
        let pointer = || {
            made.fetch_add(1, Ordering::SeqCst);
            Some("pointer".to_string())
        };
        let (injected, uncertain) = ("terminal-retry-injected", "terminal-retry-uncertain");
        remember(THREAD, injected, Held::Injected);
        remember(THREAD, uncertain, Held::Uncertain);
        router.inject_with(THREAD, injected, &attributed(injected), &pointer);
        // Its own router: the injected one, until recorded, holds later
        // messages for this thread back.
        CodexRouter::new(texts.clone()).inject_with(
            THREAD,
            uncertain,
            &attributed(uncertain),
            &pointer,
        );
        assert_eq!(
            *texts.queued.lock().unwrap(),
            [
                visible_line(&attributed(injected)).unwrap(),
                attributed(uncertain)
            ]
        );
        assert_eq!(count(&made), 0);
    }

    // Bugbot #512: with the terminal closed but earlier relay items waiting,
    // a later message joins the queue as a pointer too, not whole.
    #[test]
    fn a_message_queued_behind_others_while_the_terminal_is_closed_is_a_pointer() {
        let texts = Arc::new(Texts::default());
        texts.waiting.store(true, Ordering::SeqCst);
        let router = CodexRouter::new(texts.clone());
        let id = "queued-behind-closed-terminal";
        let pointer = || {
            Some(format!(
                "[via Agent Relay — ref {}]\n[read]",
                MessageRef::of(id)
            ))
        };
        router.inject_with(THREAD, id, &attributed(id), &pointer);
        assert_eq!(*texts.queued.lock().unwrap(), [pointer().unwrap()]);
        assert!(texts.hosted.lock().unwrap().is_empty());
    }

    /// Records the text each host is handed.
    #[derive(Default)]
    struct Texts {
        live: AtomicBool,
        /// Earlier relay items wait in the queue.
        waiting: AtomicBool,
        queued: Mutex<Vec<String>>,
        hosted: Mutex<Vec<String>>,
    }

    impl CodexRoutes for Texts {
        fn recorded(&self, _: &str, _: &str) -> bool {
            false
        }
        fn queue_waiting(&self, _: &str, _: &str) -> Option<bool> {
            Some(false)
        }
        fn relay_waiting(&self, _: &str) -> Option<bool> {
            Some(self.waiting.load(Ordering::SeqCst))
        }
        fn idle(&self, _: &str) -> bool {
            true
        }
        fn app_server(&self, _: &str, text: &str, _: &str) -> Result<bool, TurnError> {
            // A live terminal here runs its own server (`-c`).
            if self.live.load(Ordering::SeqCst) {
                return Ok(false);
            }
            self.hosted.lock().unwrap().push(text.to_string());
            Ok(true)
        }
        fn window(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            Ok(false)
        }
        fn terminal_live(&self, _: &str) -> bool {
            self.live.load(Ordering::SeqCst)
        }
        fn queue_send(&self, _: &str, text: &str) -> Result<(), QueueError> {
            self.queued.lock().unwrap().push(text.to_string());
            Ok(())
        }
        fn cleanup(&self, _: &str, _: &str) {}
    }

    /// A queue shared with another probe: this message is not in it, but
    /// another probe's relay item may be.
    #[derive(Default)]
    struct SharedQueue {
        foreign: AtomicBool,
        unreadable: AtomicBool,
        host_sends: AtomicUsize,
        queue_sends: AtomicUsize,
    }

    impl CodexRoutes for SharedQueue {
        fn recorded(&self, _: &str, _: &str) -> bool {
            false
        }
        fn queue_waiting(&self, _: &str, _: &str) -> Option<bool> {
            Some(false)
        }
        fn relay_waiting(&self, _: &str) -> Option<bool> {
            (!self.unreadable.load(Ordering::SeqCst)).then(|| self.foreign.load(Ordering::SeqCst))
        }
        fn idle(&self, _: &str) -> bool {
            true
        }
        fn app_server(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            self.host_sends.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        }
        fn window(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
            self.host_sends.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        }
        fn terminal_live(&self, _: &str) -> bool {
            false
        }
        fn queue_send(&self, _: &str, _: &str) -> Result<(), QueueError> {
            self.queue_sends.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn cleanup(&self, _: &str, _: &str) {}
    }

    // An idle live terminal still takes a later message through its queue,
    // so a host that has the thread loaded cannot overtake a handoff that
    // has not been taken yet.
    #[test]
    fn a_live_terminal_takes_every_message_through_its_queue() {
        let terminal = Arc::new(Terminal::default());
        let router = CodexRouter::new(terminal.clone());
        assert_eq!(
            router.inject(THREAD, "m1", &attributed("m1")),
            InjectOutcome::Accepted(NOT_CONSUMED.into())
        );
        assert_eq!(
            router.inject(THREAD, "m2", &attributed("m2")),
            InjectOutcome::Accepted(NOT_CONSUMED.into())
        );
        assert_eq!(count(&terminal.host_sends), 0);
        terminal.end_turn();
        terminal.end_turn();
        assert_eq!(
            *terminal.recorded.lock().unwrap(),
            [MessageRef::of("m1"), MessageRef::of("m2")]
        );
    }

    fn router(fake: &Arc<Fake>) -> CodexRouter {
        CodexRouter::new(fake.clone())
    }

    fn count(counter: &AtomicUsize) -> usize {
        counter.load(Ordering::SeqCst)
    }

    // CodexIncomingRouterTests.testLoadedAppServerReceivesWithoutTerminalQueue
    // and test_app_server_delivery_does_not_queue.
    #[test]
    fn a_loaded_app_server_receives_without_the_terminal_queue() {
        let fake = Fake::new();
        *fake.app_server.lock().unwrap() = Some(Ok(true));
        assert_eq!(
            router(&fake).inject(THREAD, "m1", "hello"),
            InjectOutcome::Delivered
        );
        assert_eq!(count(&fake.app_sends), 1);
        assert_eq!(count(&fake.window_sends), 0);
        assert_eq!(count(&fake.queue_sends), 0);
        assert_eq!(count(&fake.cleanups), 1);
    }

    // CodexIncomingRouterTests.testStoppedThreadWaitsThenResumesInAppServer
    // and test_stopped_thread_waits_and_delivers_after_resume.
    #[test]
    fn a_stopped_thread_waits_then_resumes_in_the_app_server() {
        let fake = Fake::new();
        let router = router(&fake);
        assert_eq!(
            router.inject(THREAD, "m1", "hello"),
            InjectOutcome::Waiting(NOT_RUNNING.into())
        );
        assert_eq!(count(&fake.queue_sends), 0);
        *fake.app_server.lock().unwrap() = Some(Ok(true));
        assert_eq!(
            router.inject(THREAD, "m1", "hello"),
            InjectOutcome::Delivered
        );
    }

    // CodexIncomingRouterTests.testTerminalQueueIsNotAcknowledgedUntilRolloutRecordsIt
    // and test_terminal_handoff_is_not_delivery.
    #[test]
    fn a_terminal_handoff_is_not_delivered_until_the_rollout_records_it() {
        let fake = Fake::new();
        fake.terminal_live.store(true, Ordering::SeqCst);
        fake.queue_marks_waiting.store(true, Ordering::SeqCst);
        let router = router(&fake);
        let text = format!(
            "[Relay Connect — from host · ref {}]\n\nhello",
            MessageRef::of("m1")
        );
        assert_eq!(
            router.inject(THREAD, "m1", &text),
            InjectOutcome::Accepted(NOT_CONSUMED.into())
        );
        assert_eq!(
            router.inject(THREAD, "m1", &text),
            InjectOutcome::Accepted(NOT_CONSUMED.into())
        );
        assert_eq!(
            count(&fake.queue_sends),
            1,
            "rechecking an accepted handoff observes the first queue item instead of requeueing it"
        );
        fake.recorded.store(true, Ordering::SeqCst);
        assert_eq!(router.inject(THREAD, "m1", &text), InjectOutcome::Delivered);
        assert_eq!(count(&fake.cleanups), 1);
    }

    #[test]
    fn observing_an_accepted_handoff_never_resends_and_missing_evidence_becomes_in_doubt() {
        let fake = Fake::new();
        fake.terminal_live.store(true, Ordering::SeqCst);
        let start = Instant::now();
        let elapsed = Arc::new(Mutex::new(Duration::ZERO));
        let mut router = router(&fake);
        let clock = elapsed.clone();
        router.now = Box::new(move || start + *clock.lock().unwrap());

        assert_eq!(
            router.observe(THREAD, "accepted-message"),
            InjectOutcome::Accepted(RECORDING.into())
        );
        assert_eq!(count(&fake.app_sends), 0);
        assert_eq!(count(&fake.window_sends), 0);
        assert_eq!(count(&fake.queue_sends), 0);

        *elapsed.lock().unwrap() = HANDOFF_GRACE - Duration::from_secs(1);
        assert_eq!(
            router.observe(THREAD, "accepted-message"),
            InjectOutcome::Accepted(RECORDING.into())
        );
        *elapsed.lock().unwrap() = HANDOFF_GRACE + Duration::from_secs(1);
        assert!(matches!(
            router.observe(THREAD, "accepted-message"),
            InjectOutcome::InDoubt(reason) if reason.contains("no longer queued")
        ));
        assert_eq!(count(&fake.queue_sends), 0);

        fake.recorded.store(true, Ordering::SeqCst);
        assert_eq!(
            router.observe(THREAD, "accepted-message"),
            InjectOutcome::Delivered
        );
        assert_eq!(count(&fake.cleanups), 1);
    }

    // CodexIncomingRouter.inject: the handoff memory (45 s to record it).
    #[test]
    fn a_consumed_handoff_is_given_time_to_be_recorded() {
        let fake = Fake::new();
        fake.terminal_live.store(true, Ordering::SeqCst);
        let start = Instant::now();
        let elapsed = Arc::new(Mutex::new(Duration::ZERO));
        let mut router = router(&fake);
        let clock = elapsed.clone();
        router.now = Box::new(move || start + *clock.lock().unwrap());
        assert_eq!(
            router.inject(THREAD, "m1", "hello"),
            InjectOutcome::Accepted(NOT_CONSUMED.into())
        );
        // The TUI took it from the queue; the rollout has not caught up.
        *elapsed.lock().unwrap() = Duration::from_secs(44);
        assert_eq!(
            router.inject(THREAD, "m1", "hello"),
            InjectOutcome::Accepted(RECORDING.into())
        );
        assert_eq!(
            count(&fake.app_sends),
            0,
            "a live terminal is reached only through its queue"
        );
        // Not recorded after the grace: it is offered again.
        *elapsed.lock().unwrap() = Duration::from_secs(46);
        assert_eq!(
            router.inject(THREAD, "m1", "hello"),
            InjectOutcome::Accepted(NOT_CONSUMED.into())
        );
        assert_eq!(count(&fake.queue_sends), 2);
        // The grace runs from the latest handoff.
        *elapsed.lock().unwrap() = Duration::from_secs(90);
        assert_eq!(
            router.inject(THREAD, "m1", "hello"),
            InjectOutcome::Accepted(RECORDING.into())
        );
        assert_eq!(count(&fake.queue_sends), 2);
        // Another message is not held back by this one.
        *elapsed.lock().unwrap() = Duration::from_secs(47);
        assert_eq!(
            router.inject(THREAD, "m2", "hi"),
            InjectOutcome::Accepted(NOT_CONSUMED.into())
        );
    }

    // A terminal's own queue takes messages during a running turn.
    #[test]
    fn a_busy_terminal_queues_without_starting_another_turn() {
        let fake = Fake::new();
        fake.busy.store(true, Ordering::SeqCst);
        fake.terminal_live.store(true, Ordering::SeqCst);
        fake.queue_marks_waiting.store(true, Ordering::SeqCst);
        *fake.app_server.lock().unwrap() = Some(Ok(true));
        let router = router(&fake);
        assert_eq!(
            router.inject(THREAD, "m1", "hello"),
            InjectOutcome::WaitingForTurn(BEHIND_TURN.into())
        );
        assert_eq!(count(&fake.app_sends), 0);
        assert_eq!(count(&fake.queue_sends), 1);
        assert_eq!(
            router.inject(THREAD, "m1", "hello"),
            InjectOutcome::WaitingForTurn(BEHIND_TURN.into())
        );
        assert_eq!(count(&fake.queue_sends), 1);
        assert_eq!(
            router.inject("not-a-thread", "m1", "hello"),
            InjectOutcome::Refused("not a Codex thread id".into())
        );
    }

    #[test]
    fn a_busy_nonterminal_waits_and_an_unreadable_terminal_queue_is_not_sent_to() {
        let fake = Fake::new();
        fake.busy.store(true, Ordering::SeqCst);
        assert_eq!(
            router(&fake).inject(THREAD, "m1", "hello"),
            InjectOutcome::Waiting(BUSY.into())
        );
        fake.terminal_live.store(true, Ordering::SeqCst);
        *fake.queued.lock().unwrap() = None;
        assert_eq!(
            router(&fake).inject(THREAD, "m1", "hello"),
            InjectOutcome::Waiting(QUEUE_UNREADABLE.into())
        );
        assert_eq!(count(&fake.queue_sends), 0);
    }

    #[test]
    fn busy_hosts_wait_until_the_turn_finishes_without_duplicate_delivery() {
        for window in [false, true] {
            let fake = Fake::new();
            fake.busy.store(true, Ordering::SeqCst);
            if window {
                *fake.window.lock().unwrap() = Some(Ok(true));
            } else {
                *fake.app_server.lock().unwrap() = Some(Ok(true));
            }
            let router = router(&fake);
            for _ in 0..3 {
                assert_eq!(
                    router.inject(THREAD, "m1", "hello"),
                    InjectOutcome::Waiting(BUSY.into())
                );
            }
            assert_eq!(count(&fake.app_sends), 0);
            assert_eq!(count(&fake.window_sends), 0);
            assert_eq!(count(&fake.queue_sends), 0);

            fake.busy.store(false, Ordering::SeqCst);
            assert_eq!(
                router.inject(THREAD, "m1", "hello"),
                InjectOutcome::Delivered
            );
            assert_eq!(count(&fake.app_sends), 1);
            assert_eq!(count(&fake.window_sends), usize::from(window));

            // Reconciliation of an already recorded message is still allowed
            // while its new turn is running; it must never send it again.
            fake.recorded.store(true, Ordering::SeqCst);
            fake.busy.store(true, Ordering::SeqCst);
            assert_eq!(
                router.inject(THREAD, "m1", "hello"),
                InjectOutcome::Delivered
            );
            assert_eq!(count(&fake.app_sends), 1);
            assert_eq!(count(&fake.window_sends), usize::from(window));
            assert_eq!(count(&fake.queue_sends), 0);
        }
    }

    // CodexIncomingRouter.inject: refusals retry, anything else after a
    // turn was asked for is in doubt; the window is the second host.
    #[test]
    fn host_failures_map_to_retry_or_in_doubt() {
        let fake = Fake::new();
        *fake.app_server.lock().unwrap() = Some(Err(TurnError::Refused("busy".into())));
        assert_eq!(
            router(&fake).inject(THREAD, "m1", "hello"),
            InjectOutcome::Retry("busy".into())
        );
        *fake.app_server.lock().unwrap() = Some(Err(TurnError::InDoubt("lost".into())));
        assert_eq!(
            router(&fake).inject(THREAD, "m1", "hello"),
            InjectOutcome::InDoubt("lost".into())
        );
        *fake.app_server.lock().unwrap() = Some(Ok(false));
        *fake.window.lock().unwrap() = Some(Ok(true));
        assert_eq!(
            router(&fake).inject(THREAD, "m1", "hello"),
            InjectOutcome::Delivered
        );
        *fake.window.lock().unwrap() = Some(Err(TurnError::Refused("no".into())));
        assert_eq!(
            router(&fake).inject(THREAD, "m1", "hello"),
            InjectOutcome::Retry("no".into())
        );
        *fake.window.lock().unwrap() = Some(Err(TurnError::InDoubt("gone".into())));
        assert_eq!(
            router(&fake).inject(THREAD, "m1", "hello"),
            InjectOutcome::InDoubt("gone".into())
        );
        assert_eq!(count(&fake.queue_sends), 0);
    }

    // inject_codex: an unreadable queue is never handed another copy.
    #[test]
    fn an_unreadable_queue_is_not_sent_to() {
        let fake = Fake::new();
        *fake.queued.lock().unwrap() = None;
        fake.terminal_live.store(true, Ordering::SeqCst);
        assert_eq!(
            router(&fake).inject(THREAD, "m1", "hello"),
            InjectOutcome::Waiting(QUEUE_UNREADABLE.into())
        );
        assert_eq!(count(&fake.queue_sends), 0);
        // Nor is another host: it could overtake an earlier queued handoff.
        assert_eq!(count(&fake.app_sends), 0);
    }

    // CodexIncomingRouter.inject (CodexQueueError.timedOut) and the
    // ClaudeTerminalInDoubt branch of inject_codex.
    #[test]
    fn a_queue_timeout_is_settled_by_the_queue() {
        let fake = Fake::new();
        fake.terminal_live.store(true, Ordering::SeqCst);
        *fake.queue_result.lock().unwrap() = Some(Err(QueueError::TimedOut));
        assert_eq!(
            router(&fake).inject(THREAD, "m1", "hello"),
            InjectOutcome::InDoubt("Codex queue did not answer in time".into())
        );
        fake.queue_marks_waiting.store(true, Ordering::SeqCst);
        assert_eq!(
            router(&fake).inject(THREAD, "m2", "hello"),
            InjectOutcome::Accepted(NOT_CONSUMED.into())
        );
        *fake.queued.lock().unwrap() = Some(false);
        fake.queue_marks_waiting.store(false, Ordering::SeqCst);
        *fake.queue_result.lock().unwrap() =
            Some(Err(QueueError::Failed("no session found".into())));
        assert_eq!(
            router(&fake).inject(THREAD, "m3", "hello"),
            InjectOutcome::Retry("no session found".into())
        );
        *fake.queue_result.lock().unwrap() = Some(Err(QueueError::NotInstalled));
        assert_eq!(
            router(&fake).inject(THREAD, "m4", "hello"),
            InjectOutcome::Retry("the codex command line is not installed".into())
        );
    }

    fn system(
        home: &Path,
        runner: Arc<FakeRunner>,
        table: crate::relay::process::FakeProcesses,
    ) -> SystemCodexRoutes {
        let mut config = config(home);
        let executable = home.join("bin/codex");
        config.executable = Some(executable);
        SystemCodexRoutes::with_runner(config, Arc::new(table), UID, runner)
    }

    // Review: Codex's app and queue are asked in the database's spelling of
    // a thread, while targets hold it lowercased.
    #[test]
    fn codex_is_asked_in_its_own_spelling() {
        let home = tempfile::tempdir().unwrap();
        let routes = system(
            home.path(),
            Arc::new(FakeRunner::default()),
            crate::relay::process::FakeProcesses::default(),
        );
        assert_eq!(
            routes.spelled(THREAD),
            THREAD,
            "unknown threads keep theirs"
        );
        let db = rusqlite::Connection::open(home.path().join("state_5.sqlite")).unwrap();
        db.execute_batch(&format!(
            "create table threads (id text, title text, cwd text, archived integer, source text);
             insert into threads values ('{}', 't', '/p', 0, 'cli');",
            THREAD.to_uppercase()
        ))
        .unwrap();
        assert_eq!(
            routes.spelled(&THREAD.to_lowercase()),
            THREAD.to_uppercase()
        );
    }

    // CodexQueueBridge.enqueue / supportsQueue and
    // test_codex_queue_validates_thread_and_uses_message_as_one_argument.
    #[test]
    fn the_queue_route_asks_once_then_queues_one_argument() {
        let home = tempfile::tempdir().unwrap();
        let confirmed = RunOutcome::Exited {
            code: 0,
            stdout: format!("Queued message q1 for thread {THREAD}.\n"),
            stderr: String::new(),
        };
        let help = RunOutcome::Exited {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        };
        let runner = Arc::new(FakeRunner::answering([help, confirmed.clone(), confirmed]));
        let routes = system(home.path(), runner.clone(), trusted_table());
        assert_eq!(
            routes.queue_send(THREAD, "--hostile leading option"),
            Ok(())
        );
        assert_eq!(routes.queue_send(THREAD, "again"), Ok(()));
        let runs = runner.runs.lock().unwrap().clone();
        let executable = home.path().join("bin/codex");
        assert_eq!(runs.len(), 3, "queue --help is asked once per build");
        assert_eq!(runs[0].0, executable);
        assert_eq!(runs[0].1, ["queue", "--help"]);
        assert_eq!(
            runs[1].1,
            [
                "queue",
                "--thread",
                THREAD,
                "--message=--hostile leading option"
            ]
        );
        assert_eq!(runs[1].2, QUEUE_TIMEOUT);
        assert_eq!(
            *runner.run_homes.lock().unwrap(),
            vec![home.path().to_path_buf(); 3],
            "support probing and every queue write use the owning Codex home"
        );
        assert_eq!(
            *runner.run_sqlite_homes.lock().unwrap(),
            vec![home.path().to_path_buf(); 3],
            "support probing and every queue write bind the owning SQLite home"
        );
        assert_eq!(
            routes.queue_send("not-a-thread", "hello"),
            Err(QueueError::Failed("not a Codex thread id".into()))
        );
        assert_eq!(runner.runs.lock().unwrap().len(), 3);
    }

    // Review on #379: a Conductor session's thread is queued with
    // Conductor's own Codex, even when no other Codex is installed.
    #[test]
    fn a_conductor_thread_is_queued_with_conductors_codex() {
        use crate::relay::codex::processes::tests::{lock, process};
        let home = tempfile::tempdir().unwrap();
        let runtime = std::path::PathBuf::from(
            "/Users/test/Library/Application Support/com.conductor.app/bin/.internal/conductor-runtime",
        );
        let table = trusted_table();
        table.insert(
            501,
            FakeProcess {
                executable: Some(runtime.clone()),
                arguments: vec![runtime.display().to_string(), "sidecar".into()],
                ..process(1, 6)
            },
        );
        table.insert(
            600,
            FakeProcess {
                parent: 501,
                open_files: vec![lock(THREAD)],
                ..codex_process(10, &["codex", "app-server", "--listen", "stdio://"])
            },
        );
        let ok = || RunOutcome::Exited {
            code: 0,
            stdout: format!("Queued message q1 for thread {THREAD}.\n"),
            stderr: String::new(),
        };
        let runner = Arc::new(FakeRunner::answering([ok(), ok()]));
        let mut config = config(home.path());
        config.executable = None;
        let routes = SystemCodexRoutes::with_runner(config, Arc::new(table), UID, runner.clone());
        assert!(routes.terminal_live(THREAD));
        assert_eq!(routes.queue_send(THREAD, "hello"), Ok(()));
        let runs = runner.runs.lock().unwrap().clone();
        assert_eq!(runs.len(), 2);
        assert!(runs.iter().all(|run| run.0 == codex()));
        assert_eq!(runs[0].1, ["queue", "--help"]);
    }

    // CodexQueueBridge: an older Codex without `queue`, a slow one, a
    // missing one, and Codex's refusal.
    #[test]
    fn the_queue_route_fails_without_a_queue_command() {
        let home = tempfile::tempdir().unwrap();
        let exited = |code: i32, stderr: &str| RunOutcome::Exited {
            code,
            stdout: String::new(),
            stderr: stderr.into(),
        };
        let runner = Arc::new(FakeRunner::answering([RunOutcome::TimedOut, exited(2, "")]));
        let routes = system(home.path(), runner.clone(), trusted_table());
        // A help that did not answer is asked again; a "no" is remembered.
        assert_eq!(
            routes.queue_send(THREAD, "hello"),
            Err(QueueError::NotInstalled)
        );
        assert_eq!(
            routes.queue_send(THREAD, "hello"),
            Err(QueueError::NotInstalled)
        );
        assert_eq!(
            routes.queue_send(THREAD, "hello"),
            Err(QueueError::NotInstalled)
        );
        assert_eq!(runner.runs.lock().unwrap().len(), 2);

        let runner = Arc::new(FakeRunner::answering([
            exited(0, ""),
            exited(1, "error: no session found"),
            RunOutcome::TimedOut,
        ]));
        let routes = system(home.path(), runner, trusted_table());
        assert_eq!(
            routes.queue_send(THREAD, "hello"),
            Err(QueueError::Failed("error: no session found".into()))
        );
        assert_eq!(
            routes.queue_send(THREAD, "hello"),
            Err(QueueError::TimedOut)
        );

        let mut config = config(home.path());
        config.executable = None;
        let runner = Arc::new(FakeRunner::default());
        let routes =
            SystemCodexRoutes::with_runner(config, Arc::new(trusted_table()), UID, runner.clone());
        assert_eq!(
            routes.queue_send(THREAD, "hello"),
            Err(QueueError::NotInstalled)
        );
        assert!(runner.runs.lock().unwrap().is_empty());
    }

    // CodexAppServerBridge.sendIfLoaded: only a running trusted Codex's
    // executable runs the proxy.
    #[test]
    fn the_app_server_route_runs_the_live_codex_proxy() {
        let home = tempfile::tempdir().unwrap();
        let runner = Arc::new(FakeRunner::default());
        let routes = system(home.path(), runner.clone(), trusted_table());
        assert_eq!(routes.app_server(THREAD, "hello", "m1"), Ok(false));
        assert!(
            runner.proxies.lock().unwrap().is_empty(),
            "no Codex runs: no proxy"
        );

        let table = trusted_table();
        table.insert(600, codex_process(10, &["codex", "app-server"]));
        let runner = Arc::new(FakeRunner::default());
        runner
            .streams
            .lock()
            .unwrap()
            .push_back(Box::new(FakeAppServer::hosting(
                &[THREAD],
                Some(json!({"id": 3, "result": {"turn": {"id": "t"}}})),
            )));
        let routes = system(home.path(), runner.clone(), table);
        assert_eq!(routes.app_server(THREAD, "hello", "m1"), Ok(true));
        assert_eq!(*runner.proxies.lock().unwrap(), [codex()]);
        assert_eq!(
            *runner.proxy_homes.lock().unwrap(),
            [home.path().to_path_buf()]
        );
        // A proxy that cannot start is not hosting the thread.
        assert_eq!(routes.app_server(THREAD, "hello", "m1"), Ok(false));
    }

    fn relayed(message_id: &str) -> String {
        format!(
            "[via Agent Relay — from @alice (alice@host-1) to @codex-a · message 7 · ref {}]\n\
             [reply: send_relay_message to=\"alice@host-1\"]\n\nPlease check CI.",
            MessageRef::of(message_id)
        )
    }

    // A window that takes hidden input shows nothing; the peer note and the
    // whole message, reply instructions included, go into the model's
    // history in the same request.
    #[cfg(unix)]
    #[test]
    fn the_window_route_hides_the_whole_message() {
        let _flag = crate::relay::codex::compact::FLAG_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::relay::codex::compact::set_enabled(true);
        let home = tempfile::tempdir().unwrap();
        let socket = home.path().join("ipc.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let started = Arc::new(Mutex::new(Vec::new()));
        let router = FakeRouter {
            owned: vec![THREAD.into()],
            refuse: None,
            started: started.clone(),
        };
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            router.serve(stream);
        });
        let text = relayed("window-hidden-1");
        assert_eq!(
            window_turn(&socket, THREAD, &text, "window-hidden-1"),
            Ok(true)
        );
        server.join().unwrap();
        let turn = started.lock().unwrap()[0]["params"]["turnStart"].clone();
        assert_eq!(turn["request"]["input"], json!([]), "nothing shows");
        let hidden = &turn["context"]["responseItems"];
        assert_eq!(*hidden, crate::relay::codex::compact::hidden_items(&text));
        assert_eq!(hidden[0]["role"], "developer");
        let whole = hidden[1]["content"][0]["text"].as_str().unwrap();
        assert!(whole.contains("[reply: send_relay_message to=\"alice@host-1\"]"));
    }

    // Bugbot #510: once the app-server holds the whole message, a retry that
    // takes the terminal queue hands over the line alone.
    #[test]
    fn an_injected_message_reaches_the_terminal_queue_as_its_line() {
        let fake = Arc::new(Fake::default());
        fake.terminal_live.store(true, Ordering::SeqCst);
        *fake.queued.lock().unwrap() = Some(false);
        let router = CodexRouter::new(fake.clone());
        let text = relayed("terminal-after-inject-1");
        crate::relay::codex::compact::remember(
            THREAD,
            "terminal-after-inject-1",
            crate::relay::codex::compact::Held::Injected,
        );
        router.inject(THREAD, "terminal-after-inject-1", &text);
        assert_eq!(
            fake.queue_texts.lock().unwrap().as_slice(),
            [crate::relay::codex::compact::visible_line(&text).unwrap()]
        );
    }

    // Greptile #510: after a restart the rollout shows a hidden injection
    // still waiting for its turn; the message is remembered as injected and
    // never handed over whole again.
    #[test]
    fn a_restart_recovers_an_injection_from_the_rollout() {
        let fake = Arc::new(Fake::default());
        fake.terminal_live.store(true, Ordering::SeqCst);
        fake.hidden_waiting.store(true, Ordering::SeqCst);
        *fake.queued.lock().unwrap() = Some(false);
        let router = CodexRouter::new(fake.clone());
        let text = relayed("restart-recover-1");
        router.inject(THREAD, "restart-recover-1", &text);
        assert_eq!(
            crate::relay::codex::compact::held(THREAD, "restart-recover-1"),
            Some(crate::relay::codex::compact::Held::Injected)
        );
        assert_eq!(
            fake.queue_texts.lock().unwrap().as_slice(),
            [crate::relay::codex::compact::visible_line(&text).unwrap()]
        );
    }

    // CodexIncomingRoutes.window against an in-process Codex app router.
    #[cfg(unix)]
    #[test]
    fn the_window_route_starts_a_turn_in_the_owning_window() {
        let home = tempfile::tempdir().unwrap();
        let socket = home.path().join("ipc.sock");
        assert_eq!(
            window_turn(&socket, THREAD, "hello", "m1"),
            Ok(false),
            "no app"
        );
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let started = Arc::new(Mutex::new(Vec::new()));
        let routers = [
            FakeRouter {
                owned: vec![],
                refuse: None,
                started: started.clone(),
            },
            FakeRouter {
                owned: vec![THREAD.into()],
                refuse: None,
                started: started.clone(),
            },
            FakeRouter {
                owned: vec![THREAD.into()],
                refuse: Some("thread is busy".into()),
                started: started.clone(),
            },
        ];
        let server = std::thread::spawn(move || {
            for router in routers {
                let (stream, _) = listener.accept().unwrap();
                router.serve(stream);
            }
        });
        assert_eq!(
            window_turn(&socket, THREAD, "hello", "m1"),
            Ok(false),
            "no window owns it"
        );
        assert_eq!(window_turn(&socket, THREAD, "hello", "m1"), Ok(true));
        assert_eq!(
            window_turn(&socket, THREAD, "hello", "m1"),
            Err(TurnError::Refused("thread is busy".into()))
        );
        server.join().unwrap();
        assert_eq!(started.lock().unwrap().len(), 2);
    }

    // The system routes read the queue, rollout and processes from config.
    #[test]
    fn the_system_routes_read_codex_home() {
        let home = tempfile::tempdir().unwrap();
        let table = trusted_table();
        table.insert(
            600,
            FakeProcess {
                ..codex_process(10, &["codex", "resume", THREAD])
            },
        );
        let routes = system(home.path(), Arc::new(FakeRunner::default()), table);
        let message_ref = MessageRef::of("m1");
        assert!(!routes.recorded(THREAD, &message_ref));
        assert!(routes.idle(THREAD));
        assert_eq!(routes.queue_waiting(THREAD, &message_ref), Some(false));
        assert!(routes.terminal_live(THREAD));
        assert_eq!(routes.window(THREAD, "hello", "m1"), Ok(false));
        let db = rusqlite::Connection::open(home.path().join("queue_1.sqlite")).unwrap();
        db.execute_batch("create table queued_items (id text, thread_id text, payload_json text, created_at_ms integer)").unwrap();
        db.execute(
            "insert into queued_items values ('a', ?1, ?2, 1)",
            (
                THREAD,
                format!("[via Agent Relay — ref {message_ref}]\n\nhello"),
            ),
        )
        .unwrap();
        assert_eq!(routes.queue_waiting(THREAD, &message_ref), Some(true));
        assert_eq!(routes.relay_waiting(THREAD), Some(true));
        routes.cleanup(THREAD, &message_ref);
        assert_eq!(routes.queue_waiting(THREAD, &message_ref), Some(false));
        db.execute(
            "insert into queued_items values ('b', ?1, 'my own prompt', 1)",
            [THREAD],
        )
        .unwrap();
        assert_eq!(
            routes.relay_waiting(THREAD),
            Some(false),
            "the person's own queue items never hold a relay message back"
        );
    }

    /// A live terminal Codex on the shared app-server (`thread/loaded/list`
    /// holds its thread), with relay messages hidden.
    fn daemon_terminal() -> (Arc<Fake>, CodexRouter) {
        let fake = Fake::new();
        fake.terminal_live.store(true, Ordering::SeqCst);
        *fake.app_server.lock().unwrap() = Some(Ok(true));
        (fake.clone(), CodexRouter::new(fake))
    }

    fn pointer() -> Option<String> {
        Some("[via Agent Relay — from @alice · ref 0123456789ab]\n[read: relay read]".into())
    }

    // A plain `codex` TUI runs on the shared app-server, so an idle one gets
    // the app's hidden turn: nothing of the message shows, no pointer.
    #[test]
    fn an_idle_terminal_on_the_shared_app_server_gets_the_hidden_turn() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, router) = daemon_terminal();
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";
        assert_eq!(
            router.inject_with(THREAD, "term-hidden-1", text, &pointer),
            InjectOutcome::Delivered
        );
        assert_eq!(fake.app_sends.load(Ordering::SeqCst), 1);
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 0, "no pointer");
    }

    /// Injects through `routes` and returns what reached the queue and how
    /// many hidden turns were tried.
    fn handed_to_queue(fake: &Arc<Fake>, routes: Arc<dyn CodexRoutes>, id: &str) -> Vec<String> {
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";
        CodexRouter::new(routes).inject_with(THREAD, id, text, &pointer);
        fake.queue_texts.lock().unwrap().clone()
    }

    // Busy, behind a relay message in the queue, not loaded by the shared
    // app-server (a TUI started with `-c` runs its own), or showing relay
    // messages: the pointer (or the message) through the queue, as before.
    #[test]
    fn a_busy_terminal_gets_the_pointer() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, _) = daemon_terminal();
        fake.busy.store(true, Ordering::SeqCst);
        assert_eq!(
            handed_to_queue(&fake, fake.clone(), "term-busy"),
            [pointer().unwrap()]
        );
        assert_eq!(fake.app_sends.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_terminal_with_a_relay_message_ahead_gets_the_pointer() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, _) = daemon_terminal();
        let routes = Arc::new(RelayAhead(fake.clone()));
        assert_eq!(
            handed_to_queue(&fake, routes, "term-ahead"),
            [pointer().unwrap()]
        );
        assert_eq!(
            fake.app_sends.load(Ordering::SeqCst),
            0,
            "never overtakes it"
        );
    }

    #[test]
    fn a_terminal_running_its_own_server_gets_the_pointer() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, _) = daemon_terminal();
        *fake.app_server.lock().unwrap() = Some(Ok(false));
        assert_eq!(
            handed_to_queue(&fake, fake.clone(), "term-embedded"),
            [pointer().unwrap()]
        );
        assert_eq!(
            fake.app_sends.load(Ordering::SeqCst),
            1,
            "asked, not loaded"
        );
    }

    #[test]
    fn a_terminal_showing_relay_messages_keeps_the_queue() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(false);
        let (fake, _) = daemon_terminal();
        assert_eq!(handed_to_queue(&fake, fake.clone(), "term-shown").len(), 1);
        assert_eq!(fake.app_sends.load(Ordering::SeqCst), 0);
        compact::set_enabled(true);
    }

    /// `Fake` with an earlier relay message still in the thread's queue.
    struct RelayAhead(Arc<Fake>);

    impl CodexRoutes for RelayAhead {
        fn recorded(&self, t: &str, r: &str) -> bool {
            self.0.recorded(t, r)
        }
        fn queue_waiting(&self, t: &str, r: &str) -> Option<bool> {
            self.0.queue_waiting(t, r)
        }
        fn relay_waiting(&self, _: &str) -> Option<bool> {
            Some(true)
        }
        fn idle(&self, t: &str) -> bool {
            self.0.idle(t)
        }
        fn app_server(&self, t: &str, x: &str, m: &str) -> Result<bool, TurnError> {
            self.0.app_server(t, x, m)
        }
        fn window(&self, t: &str, x: &str, m: &str) -> Result<bool, TurnError> {
            self.0.window(t, x, m)
        }
        fn terminal_live(&self, t: &str) -> bool {
            self.0.terminal_live(t)
        }
        fn queue_send(&self, t: &str, x: &str) -> Result<(), QueueError> {
            self.0.queue_send(t, x)
        }
        fn cleanup(&self, t: &str, r: &str) {
            self.0.cleanup(t, r)
        }
    }

    // The history took the message but its empty turn was refused (the
    // person started a turn in between): it waits for the next idle moment
    // and starts the empty turn again, never queuing a visible copy.
    #[test]
    fn a_message_the_history_holds_waits_for_idle_to_start_its_turn() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, router) = daemon_terminal();
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";
        let id = "term-held-1";
        *fake.app_server.lock().unwrap() = Some(Err(TurnError::Refused("EmptyInput".into())));
        compact::remember(THREAD, id, compact::Held::Injected);
        assert_eq!(
            router.inject_with(THREAD, id, text, &pointer),
            InjectOutcome::Waiting(HIDDEN_TURN_PENDING.into()),
            "kept under the same message, never failed and re-batched"
        );
        fake.busy.store(true, Ordering::SeqCst);
        assert_eq!(
            router.inject_with(THREAD, id, text, &pointer),
            InjectOutcome::Waiting(BUSY.into())
        );
        assert_eq!(
            fake.queue_sends.load(Ordering::SeqCst),
            0,
            "no visible copy"
        );
        fake.busy.store(false, Ordering::SeqCst);
        *fake.app_server.lock().unwrap() = Some(Ok(true));
        assert_eq!(
            router.inject_with(THREAD, id, text, &pointer),
            InjectOutcome::Delivered
        );
        assert_eq!(fake.app_sends.load(Ordering::SeqCst), 2);
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn an_app_server_batch_stays_pending_after_history_accepted_it() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, router) = daemon_terminal();
        fake.terminal_live.store(false, Ordering::SeqCst);
        let id = "app-held-batch";
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";
        compact::remember(THREAD, id, compact::Held::Injected);
        *fake.app_server.lock().unwrap() = Some(Err(TurnError::Refused("EmptyInput".into())));
        assert_eq!(
            router.inject(THREAD, id, text),
            InjectOutcome::Waiting(HIDDEN_TURN_PENDING.into())
        );
        assert_eq!(fake.window_sends.load(Ordering::SeqCst), 0);
        *fake.app_server.lock().unwrap() = Some(Ok(true));
        assert_eq!(router.inject(THREAD, id, text), InjectOutcome::Delivered);
        assert_eq!(fake.app_sends.load(Ordering::SeqCst), 2);
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_window_batch_stays_pending_after_history_accepted_it() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, router) = daemon_terminal();
        fake.terminal_live.store(false, Ordering::SeqCst);
        let id = "window-held-batch";
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";
        compact::remember(THREAD, id, compact::Held::Injected);
        *fake.app_server.lock().unwrap() = Some(Ok(false));
        *fake.window.lock().unwrap() = Some(Err(TurnError::Refused("EmptyInput".into())));
        assert_eq!(
            router.inject(THREAD, id, text),
            InjectOutcome::Waiting(HIDDEN_TURN_PENDING.into())
        );
        assert_eq!(fake.window_sends.load(Ordering::SeqCst), 1);
        *fake.window.lock().unwrap() = Some(Ok(true));
        assert_eq!(router.inject(THREAD, id, text), InjectOutcome::Delivered);
        assert_eq!(fake.window_sends.load(Ordering::SeqCst), 2);
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 0);
    }

    // Bugbot on #515: a later message never overtakes one whose whole text
    // the history already holds, by the queue or by its own hidden turn.
    #[test]
    fn a_later_message_waits_behind_a_held_hidden_message() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, router) = daemon_terminal();
        let first = "[via Agent Relay — from @alice · ref 0123456789ab]\n\none";
        let second = "[via Agent Relay — from @alice · ref 0123456789ac]\n\ntwo";
        compact::remember(THREAD, "order-1", compact::Held::Injected);
        fake.busy.store(true, Ordering::SeqCst);
        assert_eq!(
            router.inject_with(THREAD, "order-1", first, &pointer),
            InjectOutcome::Waiting(BUSY.into())
        );
        assert_eq!(
            router.inject_with(THREAD, "order-2", second, &pointer),
            InjectOutcome::Waiting(BEHIND_HIDDEN.into()),
            "not queued ahead of it"
        );
        fake.busy.store(false, Ordering::SeqCst);
        assert_eq!(
            router.inject_with(THREAD, "order-2", second, &pointer),
            InjectOutcome::Waiting(BEHIND_HIDDEN.into()),
            "not started ahead of it either"
        );
        assert_eq!(fake.app_sends.load(Ordering::SeqCst), 0);
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 0);
        assert_eq!(
            router.inject_with(THREAD, "order-1", first, &pointer),
            InjectOutcome::Delivered
        );
        assert_eq!(
            router.inject_with(THREAD, "order-2", second, &pointer),
            InjectOutcome::Delivered,
            "then the next one goes"
        );
        assert_eq!(fake.app_sends.load(Ordering::SeqCst), 2);
        assert_eq!(fake.queue_sends.load(Ordering::SeqCst), 0);
    }

    // A held message the runtime stops offering (cancelled, or gone quiet
    // past the handoff memory) never blocks the thread.
    #[test]
    fn a_cancelled_or_forgotten_held_message_blocks_nothing() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let fake = Fake::new();
        fake.terminal_live.store(true, Ordering::SeqCst);
        *fake.app_server.lock().unwrap() = Some(Ok(true));
        let start = Instant::now();
        let elapsed = Arc::new(Mutex::new(Duration::ZERO));
        let mut router = CodexRouter::new(fake.clone());
        let clock = elapsed.clone();
        router.now = Box::new(move || start + *clock.lock().unwrap());
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";
        fake.busy.store(true, Ordering::SeqCst);
        compact::remember(THREAD, "gone-1", compact::Held::Injected);
        router.inject_with(THREAD, "gone-1", text, &pointer);
        router.cancel(THREAD, "gone-1");
        // Codex history keeps its copy; it never becomes a blocker again.
        *fake.hidden_refs.lock().unwrap() = vec![MessageRef::of("gone-1")];
        fake.busy.store(false, Ordering::SeqCst);
        assert_eq!(
            router.inject_with(THREAD, "gone-2", text, &pointer),
            InjectOutcome::Delivered
        );

        fake.busy.store(true, Ordering::SeqCst);
        compact::remember(THREAD, "gone-3", compact::Held::Injected);
        router.inject_with(THREAD, "gone-3", text, &pointer);
        *elapsed.lock().unwrap() = crate::relay::codex::hidden_order::GRACE;
        fake.busy.store(false, Ordering::SeqCst);
        assert_eq!(
            router.inject_with(THREAD, "gone-4", text, &pointer),
            InjectOutcome::Delivered
        );
    }

    /// A router over `fake` on a clock the test moves.
    fn clocked(fake: &Arc<Fake>) -> (CodexRouter, Arc<Mutex<Duration>>) {
        let start = Instant::now();
        let elapsed = Arc::new(Mutex::new(Duration::ZERO));
        let mut router = CodexRouter::new(fake.clone());
        let clock = elapsed.clone();
        router.now = Box::new(move || start + *clock.lock().unwrap());
        (router, elapsed)
    }

    // Bugbot on #515: after a restart the router's memory is empty, but the
    // rollout still shows an earlier hidden message waiting for its turn; a
    // later message waits behind it. One nobody offers again stops blocking.
    #[test]
    fn after_a_restart_the_rollout_holds_later_messages_back() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, _) = daemon_terminal();
        let (router, elapsed) = clocked(&fake);
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";
        *fake.hidden_refs.lock().unwrap() = vec![MessageRef::of("restart-1")];
        assert_eq!(
            router.inject_with(THREAD, "restart-2", text, &pointer),
            InjectOutcome::Waiting(BEHIND_HIDDEN.into())
        );
        compact::remember(THREAD, "restart-1", compact::Held::Injected);
        assert_eq!(
            router.inject_with(THREAD, "restart-1", text, &pointer),
            InjectOutcome::Delivered
        );
        fake.hidden_refs.lock().unwrap().clear();
        assert_eq!(
            router.inject_with(THREAD, "restart-2", text, &pointer),
            InjectOutcome::Delivered
        );

        // Never offered again: given up on after the grace, for good.
        *fake.hidden_refs.lock().unwrap() = vec![MessageRef::of("restart-gone")];
        assert_eq!(
            router.inject_with(THREAD, "restart-3", text, &pointer),
            InjectOutcome::Waiting(BEHIND_HIDDEN.into())
        );
        *elapsed.lock().unwrap() = crate::relay::codex::hidden_order::GRACE;
        assert_eq!(
            router.inject_with(THREAD, "restart-3", text, &pointer),
            InjectOutcome::Delivered
        );
        assert_eq!(
            router.inject_with(THREAD, "restart-4", text, &pointer),
            InjectOutcome::Delivered,
            "not taken up again from the rollout"
        );
    }

    // Bugbot on #515: a held message the shared app-server no longer hosts
    // goes to the queue, and keeps later messages back even if that queue
    // write fails.
    #[test]
    fn a_held_message_keeps_its_place_when_its_queue_write_fails() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, _) = daemon_terminal();
        *fake.app_server.lock().unwrap() = Some(Ok(false));
        *fake.queue_result.lock().unwrap() = Some(Err(QueueError::Failed("busy".into())));
        let router = CodexRouter::new(fake.clone());
        let first = "[via Agent Relay — from @alice · ref 0123456789ab]\n\none";
        let second = "[via Agent Relay — from @alice · ref 0123456789ac]\n\ntwo";
        compact::remember(THREAD, "fallback-1", compact::Held::Injected);
        assert_eq!(
            router.inject_with(THREAD, "fallback-1", first, &pointer),
            InjectOutcome::Waiting(format!("{HIDDEN_TURN_PENDING} (busy)")),
            "kept under the same message, never failed and re-batched"
        );
        assert_eq!(
            router.inject_with(THREAD, "fallback-2", second, &pointer),
            InjectOutcome::Waiting(BEHIND_HIDDEN.into())
        );
    }

    // Bugbot on #515: after a restart, a message whose own copy waits in the
    // history starts its turn even when the rollout also lists a leftover
    // (cancelled before the restart) ahead of it.
    #[test]
    fn a_waiting_message_is_not_held_back_by_a_leftover_after_a_restart() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, router) = daemon_terminal();
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";
        *fake.hidden_refs.lock().unwrap() =
            vec![MessageRef::of("leftover-1"), MessageRef::of("live-1")];
        compact::remember(THREAD, "live-1", compact::Held::Injected);
        assert_eq!(
            router.inject_with(THREAD, "live-1", text, &pointer),
            InjectOutcome::Delivered
        );
        // A message not in the history still waits behind the leftover,
        // until the grace gives it up.
        *fake.hidden_refs.lock().unwrap() = vec![MessageRef::of("leftover-1")];
        assert_eq!(
            router.inject_with(THREAD, "live-2", text, &pointer),
            InjectOutcome::Waiting(BEHIND_HIDDEN.into())
        );
    }

    // Greptile on #515: a message just delivered, still listed in the
    // history until the rollout records its turn, never holds the next one;
    // one taken up from the rollout holds until its turn is recorded.
    #[test]
    fn a_finished_or_unlisted_message_holds_nothing() {
        let _flag = compact::FLAG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        compact::set_enabled(true);
        let (fake, router) = daemon_terminal();
        let text = "[via Agent Relay — from @alice · ref 0123456789ab]\n\nhi";
        assert_eq!(
            router.inject_with(THREAD, "done-1", text, &pointer),
            InjectOutcome::Delivered
        );
        *fake.hidden_refs.lock().unwrap() = vec![MessageRef::of("done-1")];
        assert_eq!(
            router.inject_with(THREAD, "done-2", text, &pointer),
            InjectOutcome::Delivered,
            "not held behind a delivered message"
        );

        *fake.hidden_refs.lock().unwrap() = vec![MessageRef::of("other-1")];
        assert_eq!(
            router.inject_with(THREAD, "done-3", text, &pointer),
            InjectOutcome::Waiting(BEHIND_HIDDEN.into())
        );
        fake.hidden_refs.lock().unwrap().clear();
        assert_eq!(
            router.inject_with(THREAD, "done-3", text, &pointer),
            InjectOutcome::Waiting(BEHIND_HIDDEN.into()),
            "unlisted while a turn the person started runs: still held"
        );
    }
}
