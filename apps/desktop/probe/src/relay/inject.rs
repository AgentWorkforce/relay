//! How a message gets into a local session.
//!
//! The delivery runtime decides what to inject and settles it with
//! Relaycast; an `Injector` owns the session-specific route (Codex queue,
//! IPC or app-server; Claude Code inbox or CLI) and the session's own
//! transcript. The daemon is built with one; until the session bridges are
//! in, `NoInjector` leaves every delivery waiting in Relaycast's queue.

use crate::relay::outbound;
use crate::relay::store::{Registration, Target};
use std::path::PathBuf;

/// What happened to one injection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InjectOutcome {
    /// The session's own route confirmed it has the message: acknowledge.
    Delivered,
    /// It certainly did not arrive; safe to try again after a backoff.
    Retry(String),
    /// Nothing can take it now (the session is not running, or a host has
    /// not consumed it yet): leave it queued, look again shortly.
    Waiting(String),
    /// The provider durably accepted the exact message into its own queue,
    /// but has not recorded it in the session yet. Keep observing that queue
    /// and transcript; an age limit must not cancel a message that will run
    /// when the current turn ends.
    Accepted(String),
    /// As `Accepted`, while the session runs a turn: the provider takes the
    /// message only once that turn ends, so it is not yet visible there.
    WaitingForTurn(String),
    /// It may have arrived: never send it again, and report it failed.
    InDoubt(String),
    /// It certainly did not arrive, and the session's route refused it in a
    /// way no retry can change (an archived Claude app session, an id that
    /// names no session): fail it permanently, never acknowledge it.
    Refused(String),
}

/// Who a delivery is from and where it was posted, for routes that keep a
/// session per conversation (OpenClaw) rather than one per agent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DeliveryRoute<'a> {
    pub delivery_id: &'a str,
    pub message_id: &'a str,
    /// `dm`, `mention`, `thread-reply` or `message`.
    pub reason: Option<&'a str>,
    pub channel_id: Option<&'a str>,
    pub sender: Option<&'a str>,
    pub sender_address: Option<&'a str>,
    /// From the machine's verified owner, by a direct message: the text is
    /// theirs alone, for a spawned agent's own user turn
    /// (`spawn::launch::Message::native`).
    pub native: bool,
}

impl<'a> DeliveryRoute<'a> {
    pub fn of(delivery: &'a crate::relay::delivery::policy::Delivery) -> DeliveryRoute<'a> {
        DeliveryRoute {
            delivery_id: &delivery.id,
            message_id: &delivery.message_id,
            reason: delivery.reason.as_deref(),
            channel_id: delivery.channel_id.as_deref(),
            sender: delivery.sender.as_deref(),
            sender_address: delivery.sender_address.as_deref(),
            native: false,
        }
    }

    /// The same route, as a native turn or not.
    pub fn native(self, native: bool) -> DeliveryRoute<'a> {
        DeliveryRoute { native, ..self }
    }
}

/// The session side of delivery, implemented per session kind.
///
/// Every method may block (process spawns, socket I/O, transcript reads);
/// the runtime calls them on a blocking thread, one delivery at a time per
/// agent.
pub trait Injector: Send + Sync + 'static {
    /// Puts `text` into the session through the session's own route.
    fn inject(&self, target: &Target, message_id: &str, text: &str) -> InjectOutcome;

    /// Relay Connect may target a broker-owned provider session that is
    /// intentionally absent from the normal injectable-agent store. Other
    /// injectors inherit the ordinary route; the local injector resolves the
    /// exact fleet-owned process and isolated provider home here.
    fn inject_connect(&self, target: &Target, message_id: &str, text: &str) -> InjectOutcome {
        self.inject(target, message_id, text)
    }

    /// Observes a Connect handoff the provider already accepted. The
    /// default route is unchanged, while Codex overrides this to prohibit a
    /// second queue write after restart or loss of its fleet binding cache.
    fn observe_connect(&self, target: &Target, message_id: &str, text: &str) -> InjectOutcome {
        self.inject_connect(target, message_id, text)
    }

    /// Registration-aware delivery for routes whose immutable authority is
    /// captured at registration time. Existing routes retain the simpler
    /// target-only implementation.
    fn inject_registered(
        &self,
        registration: &Registration,
        _delivery_id: &str,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        self.inject(&registration.target, message_id, text)
    }

    /// As `inject_registered`, for routes that also need who sent the
    /// message and where (`DeliveryRoute`).
    fn inject_routed(
        &self,
        registration: &Registration,
        route: &DeliveryRoute<'_>,
        text: &str,
    ) -> InjectOutcome {
        self.inject_registered(registration, route.delivery_id, route.message_id, text)
    }

    /// Cancels a session-side handoff that has not yet become a turn. Most
    /// routes deliver immediately and have nothing to cancel; Codex's
    /// terminal queue removes the relay-owned item with this message id.
    fn cancel(&self, _target: &Target, _message_id: &str) {}

    /// Cancels the Connect-specific handoff route when it differs from the
    /// normal registered-agent route.
    fn cancel_connect(&self, target: &Target, message_id: &str) {
        self.cancel(target, message_id)
    }

    /// The lines telling the session how to answer through the relay-send
    /// socket, when the socket is serving and this session's process could
    /// be identified on it; `None` otherwise, so a session is never handed a
    /// command that always fails. `to` (a name) or `address` names the
    /// recipient; `reply_to` is the message being answered.
    fn reply_hint(
        &self,
        target: &Target,
        to: Option<&str>,
        address: Option<&str>,
        reply_to: &str,
    ) -> Option<String> {
        let (socket, needs_probe) = self.relay_socket(target)?;
        outbound::reply_hint(&socket, to, address, reply_to, target.kind, needs_probe)
    }

    /// The command this session can run to fetch attachment `file_id`
    /// later through the session socket, under the same conditions as
    /// [`Injector::reply_hint`]; `None` by default.
    fn fetch_hint(&self, target: &Target, file_id: &str) -> Option<String> {
        let (socket, needs_probe) = self.relay_socket(target)?;
        outbound::fetch_hint(&socket, file_id, target.kind, needs_probe)
    }

    /// The session socket this session can use, and whether it must use the
    /// probe client rather than curl, when the socket is serving and this
    /// session's process can be identified on it; `None` otherwise, so a
    /// session is never handed a command that always fails.
    fn relay_socket(&self, _target: &Target) -> Option<(PathBuf, bool)> {
        None
    }

    /// A line asking the session to show the relayed message to the person,
    /// when the app it runs in does not display it (a Claude Code session in
    /// Conductor, which shows the reply but not the message); `None`
    /// otherwise.
    fn host_note(&self, _target: &Target) -> Option<String> {
        None
    }

    /// Whether the Codex thread `target` has recorded the relayed message
    /// carrying `message_ref`, in a turn of its own or one it went on.
    fn codex_recorded(&self, _target: &Target, _message_ref: &str) -> bool {
        false
    }

    /// Whether a relayed message started `turn` of the Codex thread
    /// `target`, as a `codex queue` delivery does: a turn Conductor does not
    /// show, so Agent Relay's Stop hook hands nothing over at its end.
    fn relay_started_turn(&self, _target: &Target, _turn: &str) -> bool {
        false
    }

    /// The session's final answer to the turn whose prompt carried
    /// `message_ref`, once that turn is over; `None` while it runs or when
    /// the transcript cannot say (see `delivery::final_answer`).
    fn final_answer(&self, target: &Target, message_ref: &str) -> Option<String>;

    fn final_answer_registered(
        &self,
        registration: &Registration,
        message_ref: &str,
    ) -> Option<String> {
        self.final_answer(&registration.target, message_ref)
    }

    /// The last `max` bytes of a terminal Claude Code session's transcript,
    /// and whether they begin past the file's start, for the inbox check
    /// (`claude::inbox`). `None` for any other session, or a transcript
    /// that is missing or unreadable.
    fn inbox_transcript_tail(&self, _target: &Target, _max: u64) -> Option<(Vec<u8>, bool)> {
        None
    }
}

/// No session bridges: deliveries wait in Relaycast's queue.
pub struct NoInjector;

impl Injector for NoInjector {
    fn inject(&self, _: &Target, _: &str, _: &str) -> InjectOutcome {
        InjectOutcome::Waiting("No route into this kind of session on this computer.".into())
    }

    fn reply_hint(&self, _: &Target, _: Option<&str>, _: Option<&str>, _: &str) -> Option<String> {
        None
    }

    fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
        None
    }
}
