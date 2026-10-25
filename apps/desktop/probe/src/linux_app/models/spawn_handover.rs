//! What the app offers for a session Agent Relay spawned here, from what the
//! core reports on its registration (`SessionSpawn`): joining it (its live
//! transcript with a message box that sends into the running agent through
//! the relay) and taking it over (stopping it headless and handing its
//! session to the person, so exactly one process runs it). The Mac's
//! `SpawnHandover` is the reference; the wording matches it word for word.
//! Claude Desktop does not take over a session on Linux, so a take over
//! always opens Terminal.

use super::SessionOpening;
use crate::relay::contract::agents::{LocalAgent, LocalSession};
use crate::relay::contract::transcript::{LocalTranscriptCursor, LocalTranscriptPage};
use crate::relay::state::WorkState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnHandover {
    /// Agent Relay runs it and it cannot be taken over: its harness's own app
    /// opens it live where it has one (a spawned Codex thread, on the shared
    /// app server: "Open in Codex" only); it is never resumed in Terminal.
    OpenLive,
    /// Agent Relay runs it headless: join it here, or take it over.
    TakeOver,
    /// Taken over: the person's session now, opened like any other.
    TakenOver,
}

impl SpawnHandover {
    pub fn of(session: Option<&LocalSession>) -> Option<SpawnHandover> {
        let spawn = session?.registration.as_ref()?.spawn.as_ref()?;
        Some(if spawn.taken_over {
            SpawnHandover::TakenOver
        } else if spawn.can_take_over {
            SpawnHandover::TakeOver
        } else {
            SpawnHandover::OpenLive
        })
    }

    /// The agent whose own output is its transcript (`agents.transcript`);
    /// `None` when the session's transcript is read (`sessions.transcript`).
    pub fn transcript_agent(session: Option<&LocalSession>) -> Option<String> {
        (Self::of(session) == Some(SpawnHandover::TakeOver))
            .then(|| session?.registration.as_ref().map(|r| r.name.clone()))
            .flatten()
    }

    /// Whether the transcript is followed live with a message box under it:
    /// a spawned agent Agent Relay still runs.
    pub fn joins(session: Option<&LocalSession>) -> bool {
        matches!(
            Self::of(session),
            Some(SpawnHandover::TakeOver | SpawnHandover::OpenLive)
        )
    }

    /// Where following continues after the last page of a read that asked
    /// for `requested`: where the page says what is written next starts, else
    /// that page again (its entries are told apart by id).
    pub fn follow_cursor(
        requested: Option<&LocalTranscriptCursor>,
        page: &LocalTranscriptPage,
    ) -> Option<LocalTranscriptCursor> {
        page.follow_cursor.clone().or_else(|| requested.cloned())
    }

    /// The note beside the open button of a session Agent Relay runs that is
    /// not taken over: Codex's when it opens live in Codex (`opening`), else
    /// why it has no open button.
    pub fn hosted_note(
        session: Option<&LocalSession>,
        opening: Option<&SessionOpening>,
    ) -> Option<&'static str> {
        (Self::of(session) == Some(SpawnHandover::OpenLive)).then(|| {
            match opening.is_some_and(|opening| opening.live_only) {
                true => SPAWN_CODEX_HOSTED,
                false => SPAWN_HOSTED,
            }
        })
    }

    /// Whether it is in the middle of a turn: taking it over then waits for the turn.
    pub fn is_working(agent: Option<&LocalAgent>) -> bool {
        agent
            .and_then(|agent| agent.spawn.as_ref())
            .is_some_and(|spawn| spawn.work.state == WorkState::Working)
    }
}

pub const SPAWN_JOIN_TITLE: &str = "Join";
pub const SPAWN_JOIN_HELP: &str = "Follow its transcript here and message it.";
pub const SPAWN_FOLLOWING: &str = "Live: new output appears as the agent writes it.";
pub const SPAWN_COMPOSER_NOTE: &str =
    "Sent through Agent Relay into the running agent, like any message to it.";
pub const SPAWN_SEND: &str = "Send";
pub const SPAWN_CODEX_HOSTED: &str = "Agent Relay’s Codex app server runs this thread. Open it in Codex to watch or steer it live; it is not resumed in Terminal while Agent Relay hosts it.";
pub const SPAWN_CODEX_MISSING: &str = "Install the Codex app to open this thread. Agent Relay’s Codex app server runs it, so it is not resumed in Terminal.";
pub const SPAWN_HOSTED: &str = "Agent Relay runs this session. Follow it and message it here; it is not resumed in Terminal while Agent Relay runs it.";
/// Linux takes over in Terminal: the Mac's `takeOverTitle(desktop: false)`.
pub const SPAWN_TAKE_OVER_TITLE: &str = "Take over in Terminal";
pub const SPAWN_TAKE_OVER_HELP: &str = "Stop the headless agent and continue its session yourself. It keeps its name, so messages keep arriving.";
pub const SPAWN_TAKE_OVER_BUTTON: &str = "Take Over";
pub const SPAWN_AFTER_TURN: &str = "Take Over After This Turn";
pub const SPAWN_INTERRUPT: &str = "Interrupt and Take Over";
pub const SPAWN_CANCEL: &str = "Cancel";
pub const SPAWN_INTERRUPT_NOW: &str = "Interrupt Now";
pub const SPAWN_INTERRUPT_MESSAGE: &str =
    "The turn it is running stops where it is. The session you open has everything up to there.";
pub const SPAWN_STOPPING: &str = "Stopping the headless agent…";
pub const SPAWN_TAKE_OVER_FAILED: &str = "Couldn’t take over";

/// `Message @name`.
pub fn spawn_composer_placeholder(name: &str) -> String {
    format!("Message @{name}")
}

/// `Take over @name?`
pub fn spawn_confirm_title(name: &str) -> String {
    format!("Take over @{name}?")
}

/// What taking over does; it opens Terminal on Linux.
pub fn spawn_confirm_message(name: &str) -> String {
    format!("Agent Relay stops its headless Claude, then opens the session in Terminal. @{name} keeps its name, so messages to it reach the session you open.")
}

pub fn spawn_working_message(name: &str) -> String {
    format!("@{name} is in the middle of a turn. Agent Relay can wait for the turn to end, or interrupt it now.")
}

/// `Interrupt @name now?`
pub fn spawn_interrupt_title(name: &str) -> String {
    format!("Interrupt @{name} now?")
}

pub fn spawn_waiting(name: &str) -> String {
    format!("Waiting for @{name} to finish its turn…")
}

pub fn spawn_taken_over(name: &str) -> String {
    format!("Taken over: this session is yours now. Messages to @{name} reach it while it runs.")
}

/// The session's folder is unknown, so it cannot be opened for the person.
pub fn spawn_no_folder(id: &str) -> String {
    format!("Agent Relay stopped the headless agent, but its folder is unknown. Resume it yourself with claude --resume {id}.")
}

#[cfg(test)]
mod tests;
