//! The `uploader.status` answer Setup keeps for `/setup/status`, guarded
//! against a read overtaken by a sharing change: the change patches the
//! cache itself, so an answer that began before it must never land after.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

/// The last `uploader.status` answer and the sharing mode last chosen
/// through setup: `answer` is `None` before the first read lands and
/// `Some(None)` when it failed.
struct State {
    answer: Option<Option<Value>>,
    chosen: Option<String>,
}

pub(super) struct UploaderCache {
    state: Mutex<State>,
    /// Bumped by every sharing change, so a status read that began before
    /// one is overtaken when it lands.
    generation: AtomicU64,
}

impl UploaderCache {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                answer: None,
                chosen: None,
            }),
            generation: AtomicU64::new(0),
        }
    }

    /// The cache state, held across a poisoned lock: a panicked writer
    /// leaves the last answer still worth reporting.
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The cache as `/setup/status` reports it.
    pub(super) fn snapshot(&self) -> Option<Option<Value>> {
        self.state().answer.clone()
    }

    /// The sharing mode `/setup/status` reports: the cached answer's, or
    /// the chosen one when no answer has landed or the last read failed.
    pub(super) fn sharing_mode(&self) -> Option<String> {
        let state = self.state();
        state
            .answer
            .as_ref()
            .and_then(|answer| answer.as_ref())
            .and_then(|answer| answer["sharing_mode"].as_str().map(str::to_string))
            .or_else(|| state.chosen.clone())
    }

    /// Starts a status read: the generation it must still be at to land.
    pub(super) fn begin(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Keeps a read's answer. An overtaken answer is dropped, unless the
    /// sharing change it missed patched no cached answer: then the fresh
    /// answer lands with the chosen mode, so status neither falls back to
    /// the default mode nor reports a stopped uploader.
    pub(super) fn store(&self, generation: u64, answer: Option<Value>) {
        let mut state = self.state();
        if self.generation.load(Ordering::SeqCst) == generation {
            state.answer = Some(answer);
        } else if !matches!(state.answer, Some(Some(_))) {
            if let (Some(mut fresh), Some(mode)) = (answer, &state.chosen) {
                fresh["sharing_mode"] = json!(mode);
                state.answer = Some(Some(fresh));
            }
        }
    }

    /// Keeps an answer read under the sharing lock, which no sharing
    /// change can overtake.
    pub(super) fn replace(&self, answer: Option<Value>) {
        self.state().answer = Some(answer);
    }

    /// Records a sharing change: in-flight reads are overtaken, and the
    /// cached answer now reports the chosen mode.
    pub(super) fn patch_sharing(&self, mode: &str) {
        let mut state = self.state();
        self.generation.fetch_add(1, Ordering::SeqCst);
        state.chosen = Some(mode.to_string());
        if let Some(Some(answer)) = &mut state.answer {
            answer["sharing_mode"] = json!(mode);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(mode: &str) -> Option<Value> {
        Some(json!({"running": true, "sharing_mode": mode}))
    }

    #[test]
    fn an_overtaken_read_keeps_the_patched_cache() {
        let cache = UploaderCache::new();
        cache.replace(answer("all"));
        let began = cache.begin();
        cache.patch_sharing("selected");
        cache.store(
            began,
            Some(json!({"running": false, "sharing_mode": "all"})),
        );
        assert_eq!(cache.snapshot(), Some(answer("selected")));
    }

    #[test]
    fn an_overtaken_failed_read_keeps_the_patched_cache() {
        let cache = UploaderCache::new();
        cache.replace(answer("all"));
        let began = cache.begin();
        cache.patch_sharing("selected");
        cache.store(began, None);
        assert_eq!(cache.snapshot(), Some(answer("selected")));
    }

    #[test]
    fn an_overtaken_read_lands_with_the_chosen_mode_when_nothing_was_cached() {
        let cache = UploaderCache::new();
        let began = cache.begin();
        cache.patch_sharing("selected");
        cache.store(began, answer("all"));
        assert_eq!(cache.snapshot(), Some(answer("selected")));
    }

    #[test]
    fn the_chosen_mode_is_reported_until_an_answer_lands() {
        let cache = UploaderCache::new();
        assert_eq!(cache.sharing_mode(), None);
        cache.patch_sharing("all");
        assert_eq!(cache.sharing_mode(), Some("all".to_string()));
        cache.store(cache.begin(), None);
        assert_eq!(cache.sharing_mode(), Some("all".to_string()));
        cache.store(cache.begin(), answer("selected"));
        assert_eq!(cache.sharing_mode(), Some("selected".to_string()));
    }

    #[test]
    fn a_current_read_replaces_the_cache() {
        let cache = UploaderCache::new();
        cache.replace(answer("all"));
        let began = cache.begin();
        cache.store(began, answer("selected"));
        assert_eq!(cache.snapshot(), Some(answer("selected")));
    }
}
