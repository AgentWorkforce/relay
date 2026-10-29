//! The durable journal of why auto-activation keeps a session off the
//! relay: a failed registration attempt, or the write pause or rate
//! window that kept the pass from attempting it at all. Diagnostics
//! only — cleared when the session registers by any path, kept for
//! sessions that left while blocked, and bounded.

use super::merge_helpers::merge_maps;
use super::*;

/// Why a session could not be put on the relay at `at`: the registration
/// error, or the pause that skipped the attempt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivationFailure {
    pub message: String,
    pub at: String,
}

/// The auto-activation failure journal keeps only this many sessions; the
/// most recent blockers are the ones that matter.
pub const AUTO_ACTIVATION_FAILURES_KEPT: usize = 20;

/// The journal in its mirrored form: `None` when no session is blocked.
/// The activation pass carries the copy it last confirmed on Relaycast,
/// so a failed patch or a cleared journal stays dirty until republished.
pub type PublishedJournal = Option<BTreeMap<String, ActivationFailure>>;

impl Store {
    /// One auto-activation pass's outcome per session: `cleared` targets
    /// registered, `blocked` targets name what kept them off. A blocker that
    /// repeats keeps its first `at`, so a stalled session shows when the
    /// stall began rather than when it was last seen.
    pub fn note_activation_outcomes(
        &mut self,
        cleared: &[String],
        blocked: &BTreeMap<String, String>,
        now: &str,
    ) {
        let failures = self
            .auto_activation_failures
            .get_or_insert_with(BTreeMap::new);
        for key in cleared {
            failures.remove(key);
        }
        for (key, message) in blocked {
            if let Some(entry) = failures.get_mut(key) {
                if entry.message != *message {
                    entry.message = message.clone();
                    entry.at = now.to_string();
                }
                continue;
            }
            // Full: a newcomer only takes the place of an entry this pass
            // no longer blocks. When more sessions are blocked than the
            // journal keeps, the ones already in it stay, so a stable set
            // of blockers leaves the journal unchanged instead of
            // rotating through it on every pass.
            if failures.len() >= AUTO_ACTIVATION_FAILURES_KEPT {
                let stale = failures
                    .iter()
                    .filter(|(kept, _)| !blocked.contains_key(*kept))
                    .min_by(|(_, a), (_, b)| a.at.cmp(&b.at))
                    .map(|(kept, _)| kept.clone());
                match stale {
                    Some(stale) => failures.remove(&stale),
                    None => continue,
                };
            }
            failures.insert(
                key.clone(),
                ActivationFailure {
                    message: message.clone(),
                    at: now.to_string(),
                },
            );
        }
        self.tidy_activation_failures();
    }

    /// A session registered by any path is not blocked, so `add` can drop
    /// its journal entry without the pass having to run again.
    pub(super) fn forget_activation_blocker(&mut self, key: &str) {
        if let Some(failures) = self.auto_activation_failures.as_mut() {
            failures.remove(key);
        }
    }

    /// A registered session is not blocked, however it was added, and the
    /// journal stays bounded — after a merge can grow past the cap, too.
    /// An emptied journal stays `Some`: `None` is a writer that never
    /// journaled, so clearing to `None` would hide the clear from merges.
    pub(super) fn tidy_activation_failures(&mut self) {
        if let Some(failures) = self.auto_activation_failures.as_mut() {
            let registered: HashSet<String> = self
                .registrations
                .iter()
                .map(|registration| registration.target.key())
                .collect();
            failures.retain(|key, _| !registered.contains(key));
            while failures.len() > AUTO_ACTIVATION_FAILURES_KEPT {
                let Some(oldest) = failures
                    .iter()
                    .min_by(|(_, a), (_, b)| a.at.cmp(&b.at))
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                failures.remove(&oldest);
            }
        }
    }
}

/// The union of both sides' journals minus blockers either side already
/// cleared; `merged` tidies the result, so a register on one writer beats
/// a stale blocker on the other. A side whose store lacks the field at
/// all — a writer that never journaled — is unchanged since `base`, not
/// a clear, or it would wipe every blocker it did not see. `None` only
/// when neither side journaled; an empty map is a real, publishable clear.
pub(super) fn merge_activation_failures(
    base: &Store,
    ours: &Store,
    theirs: &Store,
) -> Option<BTreeMap<String, ActivationFailure>> {
    if ours.auto_activation_failures.is_none() && theirs.auto_activation_failures.is_none() {
        return None;
    }
    let base_map = base.auto_activation_failures.clone().unwrap_or_default();
    let merged = merge_maps(
        &base_map,
        ours.auto_activation_failures.as_ref().unwrap_or(&base_map),
        theirs
            .auto_activation_failures
            .as_ref()
            .unwrap_or(&base_map),
    );
    Some(merged)
}
