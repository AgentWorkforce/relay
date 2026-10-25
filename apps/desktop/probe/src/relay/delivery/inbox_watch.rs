//! Watching whether terminal Claude Code sessions read the relay messages
//! delivered to their inbox (`claude::inbox`). A message stays delivered
//! either way; a session that holds one without progress past the threshold
//! is reported stalled in `agents.list`, the session socket's `GET /agents`
//! and the activity log, and the report clears once it reads them.

use super::DeliveryState;
use crate::relay::claude::inbox::{self, InboxStall, Injection};
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::MessageRef;
use crate::relay::state::{now_ms, Level, Listing};
use crate::relay::store::{Registration, SessionKind};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, MutexGuard, PoisonError};
use std::time::Instant;

impl Core {
    /// The delivery state, still usable after a thread panicked holding it:
    /// the watch only ever reports, so a half-made change cannot mislead
    /// delivery.
    fn inbox_state(&self) -> MutexGuard<'_, DeliveryState> {
        self.delivery.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records a message just written to a terminal Claude Code session's
    /// inbox, to be checked on the next pass.
    pub(super) fn watch_inbox(&self, registration: &Registration, message_id: &str) {
        if registration.target.kind != SessionKind::ClaudeTerminal {
            return;
        }
        self.inbox_state()
            .inbox
            .entry(registration.name.clone())
            .or_default()
            .injected(
                &registration.target.id,
                Injection {
                    reference: MessageRef::of(message_id),
                    injected_at_ms: now_ms(),
                },
            );
    }

    /// Every stalled agent's report, by registered name.
    pub(crate) fn inbox_stalls(&self) -> HashMap<String, InboxStall> {
        let now = now_ms();
        self.inbox_state()
            .inbox
            .iter()
            .filter_map(|(name, watch)| Some((name.clone(), watch.report(now)?)))
            .collect()
    }

    /// One pass over the watched inboxes that are due: each reads the end of
    /// its session's transcript, off the async runtime.
    pub(super) async fn check_inboxes(self: &Arc<Core>) {
        let every = self.config.delivery_timing.inbox_check;
        let threshold = self.config.delivery_timing.inbox_stall;
        let due: Vec<(String, String, Vec<Injection>)> = {
            let mut state = self.inbox_state();
            state
                .inbox
                .iter_mut()
                .filter(|(_, w)| w.due || w.checked_at.is_none_or(|at| at.elapsed() >= every))
                .map(|(name, w)| {
                    w.due = false;
                    w.checked_at = Some(Instant::now());
                    (name.clone(), w.session_id.clone(), w.pending.clone())
                })
                .collect()
        };
        for (name, session_id, pending) in due {
            // Only while the agent still runs that session.
            let target = self.store.read(|s| {
                s.registrations
                    .iter()
                    .find(|r| r.name == name && r.missing_since.is_none())
                    .map(|r| r.target.clone())
                    .filter(|t| t.kind == SessionKind::ClaudeTerminal && t.id == session_id)
            });
            let Some(target) = target else {
                let removed = self.inbox_state().inbox.remove(&name);
                if removed.is_some_and(|w| w.stall.is_some()) {
                    self.hub.invalidated(Listing::Agents);
                }
                continue;
            };
            let injector = self.plugins.injector.clone();
            let tail = tokio::task::spawn_blocking(move || {
                injector.inbox_transcript_tail(&target, inbox::TAIL_BYTES)
            })
            .await
            .ok()
            .flatten();
            let now = now_ms();
            // A transcript that cannot be read says nothing: not stalled,
            // and nothing is dropped.
            let (undrained, stall) = match tail {
                Some((bytes, truncated)) => {
                    let assessment = inbox::assess(&bytes, truncated, &pending);
                    let stall = inbox::evaluate(&assessment, now, threshold);
                    (assessment.undrained, stall)
                }
                None => (pending.clone(), None),
            };
            let (before, after) = {
                let mut state = self.inbox_state();
                let Some(watch) = state.inbox.get_mut(&name) else {
                    continue;
                };
                if watch.session_id != session_id {
                    continue;
                }
                let changed = watch.settle(&pending, &undrained, stall, now);
                if watch.pending.is_empty() && watch.stall.is_none() {
                    state.inbox.remove(&name);
                }
                changed
            };
            self.report_inbox(&name, before, after);
        }
    }

    /// Marks the rows of a `GET /agents` answer for this computer's agents
    /// whose Claude Code session holds relay messages it is not reading,
    /// under every name that reaches them. Other rows are left as they are.
    pub(crate) fn mark_inbox_stalls(&self, mut rows: Vec<Value>) -> Vec<Value> {
        let stalls = self.inbox_stalls();
        if stalls.is_empty() {
            return rows;
        }
        let stalled: HashMap<String, InboxStall> = self.store.read(|store| {
            store
                .registrations
                .iter()
                .filter_map(|r| Some((r, stalls.get(&r.name)?)))
                .flat_map(|(r, stall)| r.names().into_iter().map(|n| (n, stall.clone())))
                .collect()
        });
        for row in rows.iter_mut().filter_map(Value::as_object_mut) {
            if row.get("where").and_then(Value::as_str) != Some("this_computer") {
                continue;
            }
            let name = row.get("name").and_then(Value::as_str);
            let Some(stall) = name.and_then(|n| stalled.get(n)) else {
                continue;
            };
            row.insert("inbox_stalled".into(), json!(true));
            row.insert("undrained_count".into(), json!(stall.undrained_count));
            let age = json!(stall.oldest_undrained_age_ms);
            row.insert("oldest_undrained_age_ms".into(), age);
        }
        rows
    }

    fn report_inbox(&self, name: &str, before: Option<InboxStall>, after: Option<InboxStall>) {
        match (&before, &after) {
            (None, Some(stall)) => {
                let minutes = stall.oldest_undrained_age_ms / 60_000;
                let count = stall.undrained_count;
                let messages = if count == 1 { "message" } else { "messages" };
                self.hub.activity(
                    Level::Warning,
                    format!(
                        "@{name} has not read {count} relay {messages} delivered to its Claude Code \
                         session; the oldest has waited {minutes} min. Its current turn may be \
                         stuck: check the session."
                    ),
                );
            }
            (Some(_), None) => self.hub.activity(
                Level::Info,
                format!("@{name} is reading its relay messages again."),
            ),
            _ => {}
        }
        let count = |s: &Option<InboxStall>| s.as_ref().map(|s| s.undrained_count);
        if count(&before) != count(&after) {
            self.hub.invalidated(Listing::Agents);
        }
    }
}
