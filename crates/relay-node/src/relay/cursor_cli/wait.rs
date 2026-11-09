//! Cursor's `stop` hook waiting at the end of a turn, so a message for a
//! conversation that has finished its turn wakes it, in the Cursor editor
//! and in an interactive Cursor CLI session alike.
//!
//! A conversation idle in its window or at its CLI prompt runs no hook
//! until its person starts a turn. So Agent Relay's `stop` entry
//! (`cursor-hook --wait`) does not answer at once when a completed turn has
//! nothing pending. Cursor has already marked the turn completed, so the
//! chat is idle and its person can type; the hook stays until a message is
//! staged for the conversation and answers it as `followup_message`, which
//! Cursor submits as the next user turn. When that turn ends Cursor runs
//! the hook again. `cursor-agent -p` runs no `stop` hook, so nothing waits
//! there.
//!
//! A follow-up a hook of an older turn gives once a newer turn owns the
//! chat starts a turn nobody asked for, and nobody reads the answer of a
//! hook whose window reloaded or whose `cursor-agent` quit. So a waiting
//! hook takes a message only while
//! - its parent is still the process that started it, under the
//!   conversation's holder (`Holder`), which still runs with the same pid
//!   and start time;
//! - it is its conversation's newest waiting hook, which
//!   `<inbox>/waiting/<id>.wait` names, and waits after the conversation's
//!   current turn, which `<id>.turn` names: `beforeSubmitPrompt` writes it
//!   as a turn starts (a turn that runs none, a CLI follow-up's or one the
//!   editor started itself, is named by its `stop` once the turn before it
//!   ended: `stop_seen`), and every run of Agent Relay's hook first retires
//!   a waiting hook when either belongs to another turn (`turn_seen`). A
//!   `stop` hook of an older turn run late neither claims nor waits, and
//!   while `<id>.turn` is missing, corrupt or of another version, no hook
//!   does, until the next turn starts;
//! - that holder still runs the conversation: the editor's record still
//!   gives it to that host and a hook of it ran within `editor::IDLE`, or
//!   that `cursor-agent` is still the one process holding its store open;
//!   and this build's waiting entry is still in `~/.cursor/hooks.json`.
//!
//! It checks again, claims and answers under one lock per conversation,
//! which taking over and retiring take too, so a message is claimed by one
//! hook and answered by it, or put back. A message already pending when
//! the turn ends is answered at once, under the same lock, while the window
//! still holds the conversation. The window between a person
//! submitting a prompt and Cursor running its `beforeSubmitPrompt` hooks is
//! Cursor's own and cannot be closed from a hook.

use super::inbox::{drain, hook_answer, pending, unclaim};
use super::{editor, payload_session, CursorConfig};
use crate::relay::existing_session::platform;
use crate::relay::process::ProcessTable;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// The flag Agent Relay's `stop` entry runs its hook with.
pub const WAIT_FLAG: &str = "--wait";

/// Cursor's timeout for that entry, in seconds: an hour, the longest
/// Cursor takes without warning that a hook is very long.
pub(super) const WAIT_TIMEOUT: u64 = 60 * 60;

/// How long a hook waits. It stops a minute before Cursor's timeout would
/// end it, so it is never ended between a claim and its answer.
pub const WAIT: Duration = Duration::from_secs(WAIT_TIMEOUT - 60);

/// How often a waiting hook looks for a message.
pub const POLL: Duration = Duration::from_secs(1);

/// How many polls apart it reads `hooks.json` again.
const SETTINGS_EVERY: u32 = 15;

const WAITING_DIR: &str = "waiting";

/// The newest waiting hook of a conversation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Waiter {
    pid: i32,
    /// Unique to that run of the hook.
    nonce: String,
    /// The turn it waits after: its `stop` payload's `generation_id`.
    generation: String,
}

fn dir(config: &CursorConfig) -> PathBuf {
    config.inbox().join(WAITING_DIR)
}

fn waiter_file(config: &CursorConfig, session: &str) -> PathBuf {
    dir(config).join(format!("{session}.wait"))
}

fn generation(payload: &Value) -> Option<&str> {
    payload["generation_id"]
        .as_str()
        .map(str::trim)
        .filter(|generation| !generation.is_empty())
}

/// Runs `run` holding the conversation's waiting lock; `None` when the
/// lock cannot be taken.
fn locked<T>(config: &CursorConfig, session: &str, run: impl FnOnce() -> T) -> Option<T> {
    let dir = dir(config);
    std::fs::create_dir_all(&dir).ok()?;
    let _ = platform::set_mode(&config.inbox(), 0o700);
    let _ = platform::set_mode(&dir, 0o700);
    use platform::OpenOptionsExt;
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(dir.join(format!(".{session}.lock")))
        .ok()?;
    fs2::FileExt::lock_exclusive(&lock).ok()?;
    let result = run();
    let _ = fs2::FileExt::unlock(&lock);
    Some(result)
}

fn read(config: &CursorConfig, session: &str) -> Option<Waiter> {
    serde_json::from_slice(&std::fs::read(waiter_file(config, session)).ok()?).ok()
}

/// Names `waiter` the conversation's waiting hook.
fn store(config: &CursorConfig, session: &str, waiter: &Waiter) -> bool {
    serde_json::to_vec(waiter)
        .is_ok_and(|bytes| replace(config, &waiter_file(config, session), &bytes))
}

/// Writes `bytes` to `path` in the waiting directory, beside it and
/// renamed into place.
fn replace(config: &CursorConfig, path: &Path, bytes: &[u8]) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let staging = dir(config).join(format!(".{name}.{}.tmp", nonce(std::process::id() as i32)));
    use platform::OpenOptionsExt;
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&staging)
        .and_then(|mut file| file.write_all(bytes));
    if written.is_err() || std::fs::rename(&staging, path).is_err() {
        let _ = std::fs::remove_file(&staging);
        return false;
    }
    true
}

/// The format of `<id>.turn`. A file of any other version reads as no turn.
const TURN_VERSION: u32 = 1;

/// The turn a conversation started last, as `<id>.turn` holds it.
/// `beforeSubmitPrompt` names it: Cursor runs that before a turn's other
/// hooks, in the editor a `stop` follow-up's turn included, but not for a
/// turn the editor starts itself, such as the one telling the agent a
/// background task finished, nor for a CLI follow-up's turn. Such a turn's
/// `stop` names it (`stop_seen`).
#[derive(Serialize, Deserialize)]
struct CurrentTurn {
    version: u32,
    generation: String,
    /// Whether its `stop` ran. Cursor starts a turn only once the one
    /// before it ended, so a turn not named yet whose `stop` runs after
    /// this is newer (`stop_seen`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    ended: bool,
    /// The turns before it, oldest first (`EARLIER_TURNS`): a hook of one
    /// is late, where a hook of an id not here may be a newer turn's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    earlier: Vec<String>,
}

/// How many earlier turns `CurrentTurn` keeps.
const EARLIER_TURNS: usize = 8;

fn turn_file(config: &CursorConfig, session: &str) -> PathBuf {
    dir(config).join(format!("{session}.turn"))
}

/// The conversation's current turn. `None` when its file is missing,
/// unreadable, corrupt or of another version: then no hook waits after a
/// turn or claims for one until the next turn starts and writes it again.
fn current_turn(config: &CursorConfig, session: &str) -> Option<String> {
    read_turn(config, session).map(|turn| turn.generation)
}

fn read_turn(config: &CursorConfig, session: &str) -> Option<CurrentTurn> {
    let turn: CurrentTurn =
        serde_json::from_slice(&std::fs::read(turn_file(config, session)).ok()?).ok()?;
    (turn.version == TURN_VERSION).then_some(turn)
}

fn write_turn(config: &CursorConfig, session: &str, turn: &CurrentTurn) -> bool {
    serde_json::to_vec(turn).is_ok_and(|bytes| replace(config, &turn_file(config, session), &bytes))
}

/// Names `generation`, when there is one, the turn that just started, or
/// with `ended` the one whose `stop` just ran. When it cannot be written
/// the current turn is forgotten instead, so an older one is never taken
/// for the newest.
fn start_turn(
    config: &CursorConfig,
    session: &str,
    generation: Option<&str>,
    ended: bool,
) -> Option<String> {
    let mut earlier = Vec::new();
    if let Some(turn) = read_turn(config, session) {
        earlier = turn.earlier;
        if Some(turn.generation.as_str()) != generation {
            earlier.push(turn.generation);
        }
        earlier.drain(..earlier.len().saturating_sub(EARLIER_TURNS));
    }
    let written = generation.filter(|generation| {
        let turn = CurrentTurn {
            version: TURN_VERSION,
            generation: generation.to_string(),
            ended,
            earlier: earlier.clone(),
        };
        write_turn(config, session, &turn)
    });
    if written.is_none() {
        let _ = std::fs::remove_file(turn_file(config, session));
    }
    written.map(str::to_string)
}

fn nonce(pid: i32) -> String {
    static RUNS: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{pid}-{now}-{}", RUNS.fetch_add(1, Ordering::Relaxed))
}

/// Notes a turn starting (`beforeSubmitPrompt`) as the conversation's
/// current one, and retires the conversation's waiting hook unless both it
/// and `payload`'s hook belong to the current turn: Cursor would drop its
/// follow-up once a newer turn owns the chat, and a hook of an unknown turn
/// may be that. Only a hook of a turn recorded as earlier leaves it waiting:
/// that one is late. Every run of Agent Relay's hook calls this first. It needs no proof of its caller: retiring and forgetting the turn
/// only leave the conversation's messages for its next hooks.
pub fn turn_seen(config: &CursorConfig, payload: &Value) {
    let Some(session) = payload_session(payload) else {
        return;
    };
    let starts = payload["hook_event_name"] == "beforeSubmitPrompt";
    if !starts && !waiter_file(config, session).exists() {
        return;
    }
    let generation = generation(payload);
    locked(config, session, || {
        let current = if starts {
            start_turn(config, session, generation, false)
        } else {
            current_turn(config, session)
        };
        let late = generation.is_some_and(|generation| {
            read_turn(config, session)
                .is_some_and(|turn| turn.earlier.iter().any(|earlier| earlier == generation))
        });
        let retired = read(config, session).is_some_and(|waiter| {
            Some(waiter.generation.as_str()) != current.as_deref()
                || (!late && Some(waiter.generation.as_str()) != generation)
        });
        if retired {
            let _ = std::fs::remove_file(waiter_file(config, session));
        }
    });
}

/// Notes that the turn whose `stop` `payload` is has ended (`CurrentTurn`).
/// A turn `<id>.turn` knows neither as the current one nor as an earlier
/// one ran no `beforeSubmitPrompt`: a CLI follow-up's, or one the editor
/// started itself. It becomes the current turn once the current one has
/// ended, as Cursor started it after that; without this its `stop` would
/// not wait and the idle chat would take no message until its person
/// typed. A current turn that has not ended may be newer than the one this
/// `stop` ends (its prompt submitted before this hook ran), and one that
/// cannot be read may be anything: either is left as it is. Only for a
/// hook proved to run under the conversation's holder.
pub fn stop_seen(config: &CursorConfig, payload: &Value) {
    let (Some(session), Some(generation)) = (payload_session(payload), generation(payload)) else {
        return;
    };
    if payload["hook_event_name"] != "stop" {
        return;
    }
    locked(config, session, || {
        let Some(turn) = read_turn(config, session) else {
            return;
        };
        if turn.generation == generation {
            if !turn.ended {
                let _ = write_turn(
                    config,
                    session,
                    &CurrentTurn {
                        ended: true,
                        ..turn
                    },
                );
            }
        } else if turn.ended && !turn.earlier.iter().any(|earlier| earlier == generation) {
            start_turn(config, session, Some(generation), true);
        }
    });
}

/// Whether `payload` is a turn a hook waits after: a `stop` whose turn
/// completed, with the turn's id.
pub fn waits_after(payload: &Value) -> bool {
    payload["hook_event_name"] == "stop"
        && payload["status"] == "completed"
        && payload_session(payload).is_some()
        && generation(payload).is_some()
}

/// What a waiting hook checks besides its conversation's inbox.
pub struct Watch<'a> {
    /// The waiting hook's own pid.
    pub pid: i32,
    /// When it stops waiting.
    pub until: Instant,
    pub poll: Duration,
    /// Whether it was asked to stop.
    pub stopping: &'a dyn Fn() -> bool,
    /// Whether this build's waiting entry is still in `hooks.json`.
    pub installed: &'a dyn Fn() -> bool,
    /// Runs a claim while that entry is there, and keeps it there until the
    /// claim is answered (`CursorSettings::while_waiting`); `Removed` when
    /// it is not.
    pub claiming: &'a Claiming<'a>,
}

/// `Watch::claiming`.
pub type Claiming<'a> = dyn Fn(&mut dyn FnMut() -> Option<Ended>) -> Option<Ended> + 'a;

/// How a waiting hook ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    /// It answered with the conversation's messages.
    Answered,
    /// The wait ran out.
    TimedOut,
    /// Its parent or the conversation's holder is gone: the window
    /// reloaded or closed, or the `cursor-agent` quit.
    Orphaned,
    /// A newer waiting hook or a hook of a newer turn took over.
    Retired,
    /// The holder no longer runs the conversation: the record no longer
    /// gives it to that host, or no hook of it ran within `editor::IDLE`,
    /// or the `cursor-agent` no longer holds its store or another one holds
    /// it too.
    Moved,
    /// This build's waiting entry left `hooks.json`.
    Removed,
    /// It was asked to stop.
    Stopped,
    /// Its answer could not be written, so its claims went back, or its
    /// lock could not be taken.
    Failed,
}

/// What runs the conversation a waiting hook waits in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Holder {
    /// A Cursor window's extension host.
    Editor { host: i32 },
    /// The `cursor-agent` holding the conversation's store.
    Cli { agent: i32 },
}

impl Holder {
    fn pid(self) -> i32 {
        match self {
            Holder::Editor { host } => host,
            Holder::Cli { agent } => agent,
        }
    }
}

/// Answers the completed turn of the `stop` payload `payload`, whose hook
/// runs under `holder`, through `write`, which says whether the answer was
/// written in full. It answers at once when messages are pending,
/// otherwise as soon as one is staged while this hook may still take it
/// (module docs).
pub fn wait(
    config: &CursorConfig,
    table: &dyn ProcessTable,
    holder: Holder,
    payload: &Value,
    watch: &Watch<'_>,
    write: &mut dyn FnMut(&Value) -> bool,
) -> Ended {
    let waiting = match Waiting::new(config, table, holder, payload, watch.pid) {
        Ok(waiting) => waiting,
        Err(ended) => return ended,
    };
    // While the window still holds the conversation and its turn is the
    // current one, this hook takes over from an older one before it claims,
    // so the older one takes nothing more, then answers what is pending now
    // at once. Past `watch.until` it takes nothing.
    let first = locked(config, waiting.session, || {
        interrupted(watch)
            .or_else(|| waiting.lost())
            .or_else(|| waiting.shared())
            .or_else(|| waiting.stale().then_some(Ended::Retired))
            .or_else(|| {
                (watch.claiming)(&mut || {
                    (!store(config, waiting.session, &waiting.me))
                        .then_some(Ended::Failed)
                        .or_else(|| answer(config, payload, write))
                })
            })
    });
    let ended = match first {
        None => return Ended::Failed,
        Some(Some(ended)) => ended,
        Some(None) => waiting.poll(payload, watch, write),
    };
    locked(config, waiting.session, || {
        if waiting.mine() {
            let _ = std::fs::remove_file(waiter_file(config, waiting.session));
        }
    });
    ended
}

/// Hands the conversation's pending messages over through `write`: claims
/// are tombstoned once the answer was written and put back if not. `None`
/// when nothing could be claimed.
fn answer(
    config: &CursorConfig,
    payload: &Value,
    write: &mut dyn FnMut(&Value) -> bool,
) -> Option<Ended> {
    let answer = hook_answer(config, payload)?;
    Some(if write(&answer.output) {
        drain(&answer.claimed);
        Ended::Answered
    } else {
        unclaim(config, &answer.claimed);
        Ended::Failed
    })
}

/// One waiting hook: what it waits after, and the holder it waits under.
struct Waiting<'a> {
    config: &'a CursorConfig,
    table: &'a dyn ProcessTable,
    session: &'a str,
    me: Waiter,
    /// The hook's parent when it started.
    parent: i32,
    holder: Holder,
    host: i32,
    host_start: u64,
}

impl<'a> Waiting<'a> {
    fn new(
        config: &'a CursorConfig,
        table: &'a dyn ProcessTable,
        holder: Holder,
        payload: &'a Value,
        pid: i32,
    ) -> Result<Waiting<'a>, Ended> {
        let host = holder.pid();
        let (Some(session), Some(generation), true) = (
            payload_session(payload),
            generation(payload),
            waits_after(payload),
        ) else {
            return Err(Ended::Failed);
        };
        let parent = table.process(pid).map(|process| process.parent);
        let host_start = table.process(host).map(|process| process.start);
        let (Some(parent), Some(host_start)) = (parent, host_start) else {
            return Err(Ended::Orphaned);
        };
        if !reaches(table, parent, host) {
            return Err(Ended::Orphaned);
        }
        Ok(Waiting {
            config,
            table,
            session,
            me: Waiter {
                pid,
                nonce: nonce(pid),
                generation: generation.to_string(),
            },
            parent,
            holder,
            host,
            host_start,
        })
    }

    /// Looks for a message every `watch.poll` until it answers one or may
    /// no longer take one.
    fn poll(
        &self,
        payload: &Value,
        watch: &Watch<'_>,
        write: &mut dyn FnMut(&Value) -> bool,
    ) -> Ended {
        let mut polls = 0u32;
        loop {
            let settings = polls.is_multiple_of(SETTINGS_EVERY);
            if let Some(ended) = interrupted(watch)
                .or_else(|| self.gone())
                .or_else(|| settings.then(|| uninstalled(watch)).flatten())
            {
                return ended;
            }
            if !pending(self.config, self.session).is_empty() {
                let taken = locked(self.config, self.session, || {
                    self.gone()
                        .or_else(|| self.shared())
                        .or_else(|| (watch.claiming)(&mut || answer(self.config, payload, write)))
                });
                match taken {
                    None => return Ended::Failed,
                    Some(Some(ended)) => return ended,
                    Some(None) => {}
                }
            }
            polls = polls.wrapping_add(1);
            std::thread::sleep(watch.poll);
        }
    }

    /// Why this hook may no longer take a message, if it may not.
    fn gone(&self) -> Option<Ended> {
        self.lost()
            .or_else(|| (!self.mine() || self.stale()).then_some(Ended::Retired))
    }

    /// Whether its holder no longer runs the conversation, and how.
    fn lost(&self) -> Option<Ended> {
        if !self.alive() {
            Some(Ended::Orphaned)
        } else if !self.holds() {
            Some(Ended::Moved)
        } else {
            None
        }
    }

    fn holds(&self) -> bool {
        match self.holder {
            Holder::Editor { .. } => {
                editor::holds(self.config, self.session, self.host, self.host_start)
            }
            Holder::Cli { agent } => {
                super::held_session(self.config, self.table, agent).as_deref() == Some(self.session)
            }
        }
    }

    /// Whether a second `cursor-agent` resumed its CLI conversation beside
    /// its own, which leaves whose turn a hook ends unknowable, so a hook
    /// starting now takes nothing either (`super::hook_caller`). Checked only
    /// as it claims, since it reads every process.
    fn shared(&self) -> Option<Ended> {
        let Holder::Cli { agent } = self.holder else {
            return None;
        };
        let uid = crate::relay::peer::current_uid();
        let alone = super::held(self.config, self.table, uid, self.session)
            .is_some_and(|held| held.pid == agent);
        (!alone).then_some(Ended::Moved)
    }

    /// Whether its parent and its holder are the ones it started under, the
    /// one still under the other.
    fn alive(&self) -> bool {
        self.table
            .process(self.me.pid)
            .map(|process| process.parent)
            == Some(self.parent)
            && reaches(self.table, self.parent, self.host)
            && self
                .table
                .process(self.host)
                .is_some_and(|process| process.start == self.host_start)
            && !self.table.zombie(self.host)
    }

    /// Whether it is still the conversation's newest waiting hook.
    fn mine(&self) -> bool {
        read(self.config, self.session).as_ref() == Some(&self.me)
    }

    /// Whether the turn it waits after is not the conversation's current
    /// one, or which that is cannot be read.
    fn stale(&self) -> bool {
        current_turn(self.config, self.session).as_deref() != Some(self.me.generation.as_str())
    }
}

/// Whether `pid` is `host` or runs under it. A hook whose launcher exited
/// was handed to another parent, so it no longer does.
fn reaches(table: &dyn ProcessTable, mut pid: i32, host: i32) -> bool {
    for _ in 0..crate::relay::process::MAX_ANCESTRY {
        if pid == host {
            return true;
        }
        if pid <= 1 {
            return false;
        }
        let Some(process) = table.process(pid) else {
            return false;
        };
        pid = process.parent;
    }
    false
}

/// Whether the waiting `stop` entry is gone from `hooks.json`, read every
/// `SETTINGS_EVERY` polls while there is nothing to claim; a claim checks
/// it through `Watch::claiming`.
fn uninstalled(watch: &Watch<'_>) -> Option<Ended> {
    (!(watch.installed)()).then_some(Ended::Removed)
}

/// Whether the hook was asked to stop or its wait ran out.
fn interrupted(watch: &Watch<'_>) -> Option<Ended> {
    if (watch.stopping)() {
        Some(Ended::Stopped)
    } else if Instant::now() >= watch.until {
        Some(Ended::TimedOut)
    } else {
        None
    }
}

/// SIGTERM, SIGINT and SIGHUP, which ask a waiting hook to stop: it then
/// takes nothing more and ends at its next poll, instead of being ended
/// between a claim and its answer. Windows has no hook that waits.
pub struct Interrupts {
    stop: Arc<AtomicBool>,
}

impl Interrupts {
    pub fn install() -> Interrupts {
        let stop = Arc::new(AtomicBool::new(false));
        #[cfg(unix)]
        for signal in [
            signal_hook::consts::SIGTERM,
            signal_hook::consts::SIGINT,
            signal_hook::consts::SIGHUP,
        ] {
            let _ = signal_hook::flag::register(signal, stop.clone());
        }
        Interrupts { stop }
    }

    pub fn requested(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
#[path = "wait_tests.rs"]
mod tests;
