//! Delivery into a running Codex turn through Agent Relay's Codex hook.
//!
//! `codex queue` hands a message over only once the thread's turn ends,
//! however long it runs. Codex runs a PostToolUse hook after each tool call
//! and a Stop hook as a turn is about to end, and both can add text to the
//! turn under way: `hookSpecificOutput.additionalContext` from PostToolUse,
//! which Codex writes into the turn as a developer message, and
//! `{"decision": "block", "reason": …}` from Stop, which it records as a
//! `HookPrompt` and goes on with (verified with Codex 0.159). Both keep the
//! text as given, so the message's `ref` settles it from the rollout like
//! any other delivery (`rollout::RolloutSummary`).
//!
//! While a live Codex runs a turn of the thread, the router offers a message
//! here (`offer`) instead of the queue, and the hook takes it (`take`) at the
//! turn's next tool call or stop. A turn that ends with no hook taking it
//! (interrupted, failed) leaves it offered; the router's next pass, within
//! seconds, sends it by the usual routes. Each message is claimed by exactly
//! one route: the claim is written to disk before the hook is given the
//! message (`Route::Hook`) and before any other route is (`Route::Elsewhere`),
//! and neither ever turns into the other. A message the hook took that Codex
//! does not record is in doubt and never sent again.

use crate::relay::codex::compact::PEER_AUTHORITY_NOTE;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// What a message offered to the hook says about the session it is for.
pub const WAITING: &str =
    "Waiting — handed over at the session's next tool call or as its turn ends";

/// The record's file name in the app's data directory.
pub const RECORD: &str = "codex-turn-hook.json";

/// How long a claim is kept: Relaycast's delivery lifetime.
const LIFETIME_MS: i64 = 24 * 60 * 60 * 1_000;

/// How long an offer stays takeable without delivery offering it again:
/// delivery looks at a waiting message every few seconds, so one it no
/// longer offers (expired, its agent gone) soon has nothing to hand over.
const FRESH_MS: i64 = 60 * 1_000;

/// Which route a message is claimed by.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    /// Waiting for the running turn's next hook; nothing has it yet.
    Offered,
    /// The hook handed it to Codex.
    Hook,
    /// Another route (the queue, the app-server, a window) may have it.
    Elsewhere,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Claim {
    thread: String,
    route: Route,
    /// When the claim last changed, in Unix milliseconds.
    at_ms: i64,
    /// Offer order, so a thread's messages are taken first in, first out.
    order: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Journal {
    claims: BTreeMap<String, Claim>,
    next: u64,
}

/// An offered message's text, kept in memory only: after a restart, or
/// once delivery stops offering it (it expired, or its agent left the
/// relay), the hook has nothing to hand over.
struct Offer {
    text: String,
    /// When the router last offered it.
    seen_ms: i64,
}

/// What the claims say about one message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Claimed {
    /// No route has claimed it.
    Free,
    Offered,
    /// The hook handed it over at `at_ms`.
    Hook {
        at_ms: i64,
    },
    Elsewhere,
    /// The record cannot be read: any route may have it.
    Unknown,
}

/// Why another route may not take a message (`TurnInbox::leave`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Taken {
    /// The hook handed it over at `at_ms`.
    Hook { at_ms: i64 },
    /// The claim could not be written, so nothing may hand it over yet.
    Unrecorded,
}

/// The messages waiting for a running Codex turn's hook, and every route
/// claim since, kept in a journal file. Each change reads the file under
/// its lock and writes it back before anything is handed out, so cores
/// sharing it never lose each other's claims.
pub struct TurnInbox {
    /// `None` keeps nothing on disk, so nothing is offered.
    path: Option<PathBuf>,
    offers: Mutex<HashMap<String, Offer>>,
    now_ms: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl Default for TurnInbox {
    fn default() -> TurnInbox {
        TurnInbox {
            path: None,
            offers: Mutex::default(),
            now_ms: Box::new(crate::relay::state::now_ms),
        }
    }
}

impl TurnInbox {
    /// The inbox whose claims are kept at `path`.
    pub fn open(path: PathBuf) -> TurnInbox {
        TurnInbox {
            path: Some(path),
            ..TurnInbox::default()
        }
    }

    #[cfg(test)]
    pub(crate) fn with_clock(mut self, now_ms: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        self.now_ms = Box::new(now_ms);
        self
    }

    /// Whether claims are kept on disk at all: without a record nothing is
    /// offered and nothing needs claiming.
    pub fn configured(&self) -> bool {
        self.path.is_some()
    }

    /// Whether messages can be offered: the record can be read.
    pub fn keeps_claims(&self) -> bool {
        self.edit(|_, _| ((), false)).is_ok()
    }

    /// How long ago `at_ms` was, by this inbox's clock.
    pub fn since(&self, at_ms: i64) -> std::time::Duration {
        let elapsed = (self.now_ms)().saturating_sub(at_ms).max(0);
        std::time::Duration::from_millis(elapsed as u64)
    }

    /// The offers delivery still makes; stale ones are dropped, texts and
    /// all, so an abandoned message is not kept in memory.
    fn offers(&self) -> std::sync::MutexGuard<'_, HashMap<String, Offer>> {
        let now = (self.now_ms)();
        let mut offers = self
            .offers
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        offers.retain(|_, offer| now.saturating_sub(offer.seen_ms) < FRESH_MS);
        offers
    }

    /// Applies `change` to the record as it is on disk, under its lock,
    /// dropping claims past their lifetime, and writes it back when
    /// anything changed. A record that cannot be read is never
    /// overwritten.
    fn edit<R>(&self, change: impl FnOnce(&mut Journal, i64) -> (R, bool)) -> std::io::Result<R> {
        let path = self
            .path
            .as_deref()
            .ok_or_else(|| std::io::Error::other("no Codex hook record"))?;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path.with_extension("lock"))?;
        fs2::FileExt::lock_exclusive(&lock)?;
        let mut journal = match std::fs::read(path) {
            Ok(bytes) => {
                serde_json::from_slice::<Journal>(&bytes).map_err(std::io::Error::other)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Journal::default(),
            Err(error) => return Err(error),
        };
        let now = (self.now_ms)();
        let before = journal.claims.len();
        journal
            .claims
            .retain(|_, claim| now.saturating_sub(claim.at_ms) < LIFETIME_MS);
        let (result, changed) = change(&mut journal, now);
        if changed || journal.claims.len() != before {
            let bytes = serde_json::to_vec(&journal).map_err(std::io::Error::other)?;
            write(path, &bytes)?;
        }
        Ok(result)
    }

    pub fn claimed(&self, message_id: &str) -> Claimed {
        if !self.configured() {
            return Claimed::Free;
        }
        let Ok(claim) = self.edit(|journal, _| (journal.claims.get(message_id).cloned(), false))
        else {
            return Claimed::Unknown;
        };
        match claim {
            None => Claimed::Free,
            Some(claim) => match claim.route {
                Route::Offered => Claimed::Offered,
                Route::Hook => Claimed::Hook { at_ms: claim.at_ms },
                Route::Elsewhere => Claimed::Elsewhere,
            },
        }
    }

    /// Offers `text` to `thread`'s hook, or keeps the offer with its current
    /// text. Only a message no route has claimed, or one already offered.
    pub fn offer(&self, thread: &str, message_id: &str, text: &str) -> std::io::Result<()> {
        let offered = self.edit(|journal, now| {
            match journal.claims.get(message_id).map(|claim| claim.route) {
                Some(Route::Offered) => (true, false),
                Some(_) => (false, false),
                None => {
                    let order = journal.next;
                    journal.next += 1;
                    journal.claims.insert(
                        message_id.to_string(),
                        Claim {
                            thread: thread.to_lowercase(),
                            route: Route::Offered,
                            at_ms: now,
                            order,
                        },
                    );
                    (true, true)
                }
            }
        })?;
        if !offered {
            return Err(std::io::Error::other(
                "another route already claimed this message",
            ));
        }
        self.offers().insert(
            message_id.to_string(),
            Offer {
                text: text.to_string(),
                seen_ms: (self.now_ms)(),
            },
        );
        Ok(())
    }

    /// Claims a message for a route other than the hook, before that route
    /// is given it. `Err` when the hook already has it, or the claim could
    /// not be written.
    pub fn leave(&self, message_id: &str) -> Result<(), Taken> {
        let left = self.edit(|journal, now| {
            let before = journal.claims.get(message_id).cloned();
            match before.as_ref().map(|claim| claim.route) {
                Some(Route::Elsewhere) => return (Ok(()), false),
                Some(Route::Hook) => {
                    let at_ms = before.map_or(0, |claim| claim.at_ms);
                    return (Err(Taken::Hook { at_ms }), false);
                }
                Some(Route::Offered) | None => {}
            }
            let claim = Claim {
                thread: before
                    .as_ref()
                    .map(|claim| claim.thread.clone())
                    .unwrap_or_default(),
                route: Route::Elsewhere,
                at_ms: now,
                order: before.as_ref().map_or(journal.next, |claim| claim.order),
            };
            journal.claims.insert(message_id.to_string(), claim);
            (Ok(()), true)
        });
        match left {
            Ok(Ok(())) => {
                self.offers().remove(message_id);
                Ok(())
            }
            Ok(Err(taken)) => Err(taken),
            Err(_) => Err(Taken::Unrecorded),
        }
    }

    /// Whether a message waits for `thread`'s hook. Read before the caller
    /// is verified, so a hook with nothing to take answers at once.
    pub fn has_offered(&self, thread: &str) -> bool {
        let fresh: Vec<String> = self.offers().keys().cloned().collect();
        if fresh.is_empty() {
            return false;
        }
        let thread = thread.to_lowercase();
        self.edit(|journal, _| {
            let waiting = fresh.iter().any(|id| {
                journal
                    .claims
                    .get(id)
                    .is_some_and(|claim| claim.route == Route::Offered && claim.thread == thread)
            });
            (waiting, false)
        })
        .unwrap_or(false)
    }

    /// Hands the hook `thread`'s first offered message that delivery still
    /// offers, once its claim is on disk; `None` when nothing waits or the
    /// claim cannot be written.
    fn take(&self, thread: &str) -> Option<String> {
        let thread = thread.to_lowercase();
        let mut offers = self.offers();
        let taken = self
            .edit(|journal, now| {
                let first = journal
                    .claims
                    .iter()
                    .filter(|(id, claim)| {
                        claim.route == Route::Offered
                            && claim.thread == thread
                            && offers.contains_key(*id)
                    })
                    .min_by_key(|(_, claim)| claim.order)
                    .map(|(id, _)| id.clone());
                let Some(id) = first else {
                    return (None, false);
                };
                if let Some(claim) = journal.claims.get_mut(&id) {
                    claim.route = Route::Hook;
                    claim.at_ms = now;
                }
                (Some(id), true)
            })
            .ok()
            .flatten()?;
        offers.remove(&taken).map(|offer| offer.text)
    }

    /// Takes back an offer the hook has not taken; `true` when it was still
    /// only offered and is now claimed by no route.
    pub fn withdraw(&self, message_id: &str) -> bool {
        let withdrawn = self
            .edit(|journal, _| {
                let offered = journal
                    .claims
                    .get(message_id)
                    .is_some_and(|claim| claim.route == Route::Offered);
                if offered {
                    journal.claims.remove(message_id);
                }
                (offered, offered)
            })
            .unwrap_or(false);
        if withdrawn {
            self.offers().remove(message_id);
        }
        withdrawn
    }

    /// Forgets a message that is settled: recorded or cancelled.
    pub fn settle(&self, message_id: &str) {
        // A claim left behind only keeps a settled message from routes it
        // no longer takes.
        let _ = self.edit(|journal, _| {
            let removed = journal.claims.remove(message_id).is_some();
            ((), removed)
        });
        self.offers().remove(message_id);
    }

    /// The hook's answer for `thread` at `event`: its next message as
    /// PostToolUse context or a Stop continuation, else `{}`.
    pub fn answer(&self, thread: &str, event: HookEvent) -> Value {
        match self.take(thread) {
            Some(text) => output(event, &framed(&text)),
            None => json!({}),
        }
    }
}

/// The Codex hook events that can carry a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookEvent {
    PostToolUse,
    Stop,
}

impl HookEvent {
    /// The event Codex names in the hook's input (`hook_event_name`). An
    /// older hook command sends none, and was installed for Stop only.
    pub fn named(name: Option<&str>) -> Option<HookEvent> {
        match name {
            None | Some("Stop") => Some(HookEvent::Stop),
            Some("PostToolUse") => Some(HookEvent::PostToolUse),
            Some(_) => None,
        }
    }
}

fn output(event: HookEvent, text: &str) -> Value {
    match event {
        HookEvent::PostToolUse => json!({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": text,
        }}),
        HookEvent::Stop => json!({"decision": "block", "reason": text}),
    }
}

/// `text` with the peer authority note after its header lines: PostToolUse
/// context reaches the model as a developer message, which must not lend a
/// peer's request more weight than the person's own.
fn framed(text: &str) -> String {
    if text.contains(PEER_AUTHORITY_NOTE) {
        return text.to_string();
    }
    let mut lines: Vec<&str> = text.lines().collect();
    let header = lines
        .iter()
        .take_while(|line| line.starts_with('['))
        .count();
    lines.insert(header, PEER_AUTHORITY_NOTE);
    lines.join("\n")
}

fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    crate::relay::outbox::write_atomic(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::delivery::policy::MessageRef;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    const THREAD: &str = "01a17701-ee3f-73f3-ae09-e7f3a51a78f9";

    fn text(id: &str) -> String {
        format!(
            "[via Agent Relay — from @alice to @codex-api · message {id} · ref {}]\n[reply: curl relay]\n\nCan you check CI?",
            MessageRef::of(id)
        )
    }

    fn inbox(dir: &Path) -> (TurnInbox, Arc<AtomicI64>) {
        let clock = Arc::new(AtomicI64::new(1_000));
        let now = clock.clone();
        let inbox = TurnInbox::open(dir.join("codex-turn-hook.json"))
            .with_clock(move || now.load(Ordering::SeqCst));
        (inbox, clock)
    }

    #[test]
    fn an_offered_message_is_handed_to_the_hook_once_with_its_ref_first() {
        let dir = tempfile::tempdir().unwrap();
        let (inbox, _) = inbox(dir.path());
        inbox
            .offer(&THREAD.to_uppercase(), "m1", &text("m1"))
            .unwrap();
        inbox.offer(THREAD, "m1", &text("m1")).unwrap();
        assert!(inbox.has_offered(THREAD));
        assert_eq!(inbox.claimed("m1"), Claimed::Offered);
        let answer = inbox.answer(THREAD, HookEvent::PostToolUse);
        let context = answer["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert_eq!(answer["hookSpecificOutput"]["hookEventName"], "PostToolUse");
        assert_eq!(MessageRef::in_text(context), Some(MessageRef::of("m1")));
        let lines: Vec<&str> = context.lines().collect();
        assert_eq!(lines[1], "[reply: curl relay]");
        assert_eq!(lines[2], PEER_AUTHORITY_NOTE);
        assert!(context.ends_with("Can you check CI?"));
        assert_eq!(inbox.claimed("m1"), Claimed::Hook { at_ms: 1_000 });
        assert!(!inbox.has_offered(THREAD));
        assert_eq!(inbox.answer(THREAD, HookEvent::Stop), json!({}));
        // Never offered again, nor sent another way.
        assert!(inbox.offer(THREAD, "m1", &text("m1")).is_err());
        assert_eq!(inbox.leave("m1"), Err(Taken::Hook { at_ms: 1_000 }));
    }

    #[test]
    fn a_stop_continues_the_turn_with_the_next_message_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let (inbox, _) = inbox(dir.path());
        inbox.offer(THREAD, "m1", &text("m1")).unwrap();
        inbox.offer(THREAD, "m2", &text("m2")).unwrap();
        inbox
            .offer("11111111-2222-3333-4444-555555555555", "m3", &text("m3"))
            .unwrap();
        let first = inbox.answer(THREAD, HookEvent::Stop);
        assert_eq!(first["decision"], "block");
        assert_eq!(
            MessageRef::in_text(first["reason"].as_str().unwrap()),
            Some(MessageRef::of("m1"))
        );
        let second = inbox.answer(THREAD, HookEvent::Stop);
        assert_eq!(
            MessageRef::in_text(second["reason"].as_str().unwrap()),
            Some(MessageRef::of("m2"))
        );
        assert_eq!(
            inbox.answer(THREAD, HookEvent::Stop),
            json!({}),
            "m3 is another thread's"
        );
    }

    #[test]
    fn a_message_another_route_claimed_is_never_offered() {
        let dir = tempfile::tempdir().unwrap();
        let (inbox, _) = inbox(dir.path());
        inbox.offer(THREAD, "m1", &text("m1")).unwrap();
        // The turn ended without a hook: the queue takes it.
        assert_eq!(inbox.leave("m1"), Ok(()));
        assert_eq!(inbox.claimed("m1"), Claimed::Elsewhere);
        assert_eq!(inbox.answer(THREAD, HookEvent::PostToolUse), json!({}));
        assert!(inbox.offer(THREAD, "m1", &text("m1")).is_err());
        assert_eq!(inbox.leave("m2"), Ok(()));
        assert!(inbox.offer(THREAD, "m2", &text("m2")).is_err());
    }

    // Exactly once across a restart: the claim is on disk before the hook
    // or another route has the message; an offer's text is not.
    #[test]
    fn claims_outlive_a_restart_and_texts_do_not() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (inbox, _) = inbox(dir.path());
            inbox.offer(THREAD, "taken", &text("taken")).unwrap();
            assert!(inbox.answer(THREAD, HookEvent::PostToolUse).is_object());
            inbox.offer(THREAD, "offered", &text("offered")).unwrap();
            inbox.leave("queued").unwrap();
        }
        let on_disk = std::fs::read_to_string(dir.path().join("codex-turn-hook.json")).unwrap();
        assert!(!on_disk.contains("Can you check CI?"), "{on_disk}");
        let (inbox, _) = inbox(dir.path());
        assert_eq!(inbox.claimed("taken"), Claimed::Hook { at_ms: 1_000 });
        assert_eq!(inbox.claimed("queued"), Claimed::Elsewhere);
        assert_eq!(inbox.claimed("offered"), Claimed::Offered);
        // Its text comes back with the router's next offer.
        assert!(!inbox.has_offered(THREAD));
        assert_eq!(inbox.answer(THREAD, HookEvent::Stop), json!({}));
        inbox.offer(THREAD, "offered", &text("offered")).unwrap();
        assert!(inbox.has_offered(THREAD));
        inbox.settle("offered");
        inbox.settle("taken");
        assert_eq!(inbox.claimed("taken"), Claimed::Free);
        assert!(!inbox.has_offered(THREAD));
    }

    #[test]
    fn an_unreadable_record_claims_nothing_and_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codex-turn-hook.json");
        std::fs::write(&path, b"not json").unwrap();
        let inbox = TurnInbox::open(path.clone());
        assert!(!inbox.keeps_claims());
        assert!(inbox.offer(THREAD, "m1", &text("m1")).is_err());
        assert_eq!(inbox.leave("m1"), Err(Taken::Unrecorded));
        assert_eq!(inbox.claimed("m1"), Claimed::Unknown, "not free");
        assert_eq!(std::fs::read(&path).unwrap(), b"not json");
        // Nothing on disk at all keeps nothing either.
        let memory = TurnInbox::default();
        assert!(!memory.keeps_claims());
        assert!(memory.offer(THREAD, "m1", &text("m1")).is_err());
    }

    // A record that cannot be written leaves the message with no route,
    // never handed over without its claim.
    #[cfg(unix)]
    #[test]
    fn a_claim_that_cannot_be_written_hands_nothing_over() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (inbox, _) = inbox(dir.path());
        inbox.offer(THREAD, "m1", &text("m1")).unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let writable = std::fs::write(dir.path().join("probe"), b"x").is_ok();
        let answer = inbox.answer(THREAD, HookEvent::PostToolUse);
        let left = inbox.leave("m1");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        if writable {
            return; // Running as root: the folder cannot be locked.
        }
        assert_eq!(answer, json!({}));
        assert_eq!(left, Err(Taken::Unrecorded));
        assert_eq!(inbox.claimed("m1"), Claimed::Offered);
        assert!(inbox.has_offered(THREAD), "still waiting, with its text");
    }

    // A native turn may take a message only offered, never one the hook
    // took or another route may have.
    #[test]
    fn only_an_untaken_offer_is_withdrawn() {
        let dir = tempfile::tempdir().unwrap();
        let (inbox, _) = inbox(dir.path());
        inbox.offer(THREAD, "m1", &text("m1")).unwrap();
        assert!(inbox.withdraw("m1"));
        assert_eq!(inbox.claimed("m1"), Claimed::Free);
        assert_eq!(inbox.answer(THREAD, HookEvent::Stop), json!({}));
        assert!(!inbox.withdraw("m1"));
        inbox.offer(THREAD, "m2", &text("m2")).unwrap();
        inbox.answer(THREAD, HookEvent::Stop);
        assert!(!inbox.withdraw("m2"));
        inbox.leave("m3").unwrap();
        assert!(!inbox.withdraw("m3"));
    }

    // Review on #663: an offer delivery stopped making (the message
    // expired, or its agent left the relay) goes stale; offering it again
    // makes it takeable.
    #[test]
    fn an_offer_delivery_no_longer_makes_is_not_handed_over() {
        let dir = tempfile::tempdir().unwrap();
        let (inbox, clock) = inbox(dir.path());
        inbox.offer(THREAD, "m1", &text("m1")).unwrap();
        clock.store(1_000 + FRESH_MS, Ordering::SeqCst);
        assert!(!inbox.has_offered(THREAD));
        assert_eq!(inbox.answer(THREAD, HookEvent::PostToolUse), json!({}));
        assert_eq!(inbox.claimed("m1"), Claimed::Offered);
        assert!(inbox.offers().is_empty(), "its text is let go");
        inbox.offer(THREAD, "m1", &text("m1")).unwrap();
        assert!(inbox.answer(THREAD, HookEvent::PostToolUse)["hookSpecificOutput"].is_object());
    }

    // Review on #663: cores sharing the record each read it under its lock
    // before a change, so neither loses the other's claims.
    #[test]
    fn inboxes_sharing_a_record_keep_each_others_claims() {
        let dir = tempfile::tempdir().unwrap();
        let (first, _) = inbox(dir.path());
        let (second, _) = inbox(dir.path());
        first.offer(THREAD, "m1", &text("m1")).unwrap();
        second.leave("m2").unwrap();
        assert!(first.answer(THREAD, HookEvent::Stop)["reason"].is_string());
        second.leave("m3").unwrap();
        let (after, _) = inbox(dir.path());
        assert_eq!(after.claimed("m1"), Claimed::Hook { at_ms: 1_000 });
        assert_eq!(after.claimed("m2"), Claimed::Elsewhere);
        assert_eq!(after.claimed("m3"), Claimed::Elsewhere);
        assert_eq!(second.leave("m1"), Err(Taken::Hook { at_ms: 1_000 }));
    }

    #[test]
    fn claims_past_their_lifetime_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let (inbox, clock) = inbox(dir.path());
        inbox.leave("old").unwrap();
        clock.store(1_000 + LIFETIME_MS, Ordering::SeqCst);
        inbox.leave("new").unwrap();
        assert_eq!(inbox.claimed("old"), Claimed::Free);
        assert_eq!(inbox.claimed("new"), Claimed::Elsewhere);
    }

    #[test]
    fn only_codexs_hook_events_carry_a_message() {
        assert_eq!(HookEvent::named(None), Some(HookEvent::Stop));
        assert_eq!(HookEvent::named(Some("Stop")), Some(HookEvent::Stop));
        assert_eq!(
            HookEvent::named(Some("PostToolUse")),
            Some(HookEvent::PostToolUse)
        );
        assert_eq!(HookEvent::named(Some("SessionStart")), None);
    }
}
