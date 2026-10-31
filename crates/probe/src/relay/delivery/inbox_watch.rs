//! Watching whether terminal Claude Code sessions read the relay messages
//! delivered to their inbox (`claude::inbox`). A message stays delivered
//! either way; a session that holds one without progress past the threshold
//! is reported stalled in `agents.list`, the session socket's `GET /agents`
//! and the activity log, and the report clears once it reads them.

use super::{DeliverySettlement, DeliveryState};
use crate::relay::claude::inbox::{self, InboxStall, Injection};
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::Delivery;
use crate::relay::people::MessageState;
use crate::relay::delivery::policy::MessageRef;
use crate::relay::state::{now_ms, Level, Listing};
use crate::relay::store::{Registration, SessionKind};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, MutexGuard, PoisonError};
use std::time::Instant;

/// How many held messages are remembered for their senders.
const HELD_KEPT: usize = 1_000;

impl Core {
    /// Records in the activity log a message just written to a session's
    /// inbox: no note, and visible, unless the session's route holds it for
    /// the person's approval (Claude Code's `crossSessionInbound`), which it
    /// says. A held message is remembered so its sender learns it too
    /// (`was_held`). It is still delivered: Claude Code has it.
    pub(super) async fn record_handed_over(&self, registration: &Registration, delivery: &Delivery) {
        let (detail, settlement) = self.handed_over(registration, delivery).await;
        self.record_settled(
            registration,
            delivery,
            super::DeliveryOutcome::Injected,
            detail,
            Some(settlement),
        );
    }

    async fn handed_over(
        &self,
        registration: &Registration,
        delivery: &Delivery,
    ) -> (Option<String>, DeliverySettlement) {
        let injector = self.plugins.injector.clone();
        let target = registration.target.clone();
        let held = tokio::task::spawn_blocking(move || injector.held_for_approval(&target))
            .await
            .ok()
            .flatten();
        let Some(detail) = held else {
            return (None, DeliverySettlement::Visible);
        };
        // Kept under the registered name, which the inbox check reads, even
        // when the message came through an alias.
        let owner = self
            .store
            .read(|s| s.reply_owner(registration).name.clone());
        let mut state = self.inbox_state();
        if state.held.len() >= HELD_KEPT {
            state.held.pop_front();
        }
        state
            .held
            .push_back((owner, delivery.message_id.clone()));
        (Some(detail), DeliverySettlement::HeldForApproval)
    }

    /// What a person's sent message reads as: picked up, unless Claude Code
    /// holds it for approval, as predicted when it was handed over and until
    /// the session's transcript shows it reached Claude.
    pub(crate) fn held_state(
        &self,
        message_id: &str,
        state: Option<MessageState>,
    ) -> Option<MessageState> {
        match state {
            Some(MessageState::PickedUp)
                if self.inbox_state().held.iter().any(|(_, id)| id == message_id) =>
            {
                Some(MessageState::HeldForApproval)
            }
            state => state,
        }
    }

    /// Forgets the held messages of `name` its session's transcript tail
    /// shows reached Claude: the person approved them.
    fn approved(&self, name: &str, tail: &[u8], truncated: bool) {
        let mut state = self.inbox_state();
        let refs: Vec<String> = (state.held.iter())
            .filter(|(agent, _)| agent == name)
            .map(|(_, id)| MessageRef::of(id))
            .collect();
        if refs.is_empty() {
            return;
        }
        let reached = inbox::reached(tail, truncated, &refs);
        state
            .held
            .retain(|(agent, id)| agent != name || !reached.contains(&MessageRef::of(id)));
    }

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
        let state = self.inbox_state();
        state
            .inbox
            .iter()
            .filter_map(|(name, watch)| Some((name.clone(), watch.report(now)?)))
            .chain(
                state
                    .codex_inbox
                    .iter()
                    .map(|(name, stall)| (name.clone(), stall.clone())),
            )
            .collect()
    }

    /// One pass over the watched inboxes that are due: each reads the end of
    /// its session's transcript, off the async runtime.
    pub(super) async fn check_inboxes(self: &Arc<Core>) {
        self.check_codex_inboxes().await;
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
                    self.approved(&name, &bytes, truncated);
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

    async fn check_codex_inboxes(self: &Arc<Core>) {
        let targets: Vec<_> = self.store.read(|s| {
            s.registrations
                .iter()
                .filter(|r| r.target.kind == SessionKind::Codex && r.missing_since.is_none() && r.archived_at.is_none())
                .map(|r| (r.name.clone(), r.target.clone()))
                .collect()
        });
        let injector = self.plugins.injector.clone();
        let reports = tokio::task::spawn_blocking(move || {
            targets
                .into_iter()
                .filter_map(|(name, target)| Some((name, injector.codex_inbox_stall(&target)?)))
                .collect::<HashMap<_, _>>()
        })
        .await
        .unwrap_or_default();
        let before = {
            let mut state = self.inbox_state();
            std::mem::replace(&mut state.codex_inbox, reports.clone())
        };
        for (name, stall) in &reports {
            if !before.contains_key(name) {
                let count = stall.undrained_count;
                let messages = if count == 1 { "message" } else { "messages" };
                self.hub.activity(Level::Warning, format!(
                    "@{name} has {count} relay {messages} waiting behind a stalled Codex turn; the oldest has waited {} min. No turn progress was observed. Check the session.",
                    stall.oldest_undrained_age_ms / 60_000));
            }
        }
        for name in before.keys().filter(|name| !reports.contains_key(*name)) {
            self.hub.activity(
                Level::Info,
                format!("@{name}'s Codex relay queue is no longer stalled."),
            );
        }
        if shown_changed(&before, &reports) {
            self.hub.invalidated(Listing::Agents);
            self.hub.invalidated(Listing::Sessions);
        }
    }

    /// Marks the rows of a `GET /agents` answer for this computer's agents
    /// whose Codex or Claude Code session holds relay messages it is not reading,
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
        stamp_stalls(&mut rows, &stalled);
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
            self.hub.invalidated(Listing::Sessions);
        }
    }
}

fn stamp_stalls(rows: &mut [Value], stalled: &HashMap<String, InboxStall>) {
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
}

/// Whether stalls changed in what the rows show: who is stalled, how many
/// messages wait, and the whole minutes the oldest has waited. The age in
/// milliseconds moves on every pass and must not refresh both lists.
fn shown_changed(
    before: &HashMap<String, InboxStall>,
    after: &HashMap<String, InboxStall>,
) -> bool {
    let shown = |stalls: &HashMap<String, InboxStall>| {
        stalls
            .iter()
            .map(|(name, s)| (name.clone(), (s.undrained_count, s.oldest_undrained_age_ms / 60_000)))
            .collect::<HashMap<_, _>>()
    };
    shown(before) != shown(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_socket_stamps_only_local_agents_and_omits_cleared_marks() {
        let make_rows = || {
            vec![
                json!({"name": "worker", "where": "this_computer"}),
                json!({"name": "worker", "where": "other_desktop"}),
            ]
        };
        let mut rows = make_rows();
        let stalls = HashMap::from([(
            "worker".into(),
            InboxStall {
                undrained_count: 3,
                oldest_undrained_age_ms: 600_000,
            },
        )]);
        stamp_stalls(&mut rows, &stalls);
        assert_eq!(rows[0]["inbox_stalled"], true);
        assert_eq!(rows[0]["undrained_count"], 3);
        assert_eq!(rows[0]["oldest_undrained_age_ms"], 600_000);
        assert!(rows[1].get("inbox_stalled").is_none());
        let mut rows = make_rows();
        stamp_stalls(&mut rows, &HashMap::new());
        assert!(rows[0].get("inbox_stalled").is_none());
    }

    #[test]
    fn a_stall_refreshes_the_lists_only_when_what_they_show_changes() {
        let stall = |count, ms| InboxStall { undrained_count: count, oldest_undrained_age_ms: ms };
        let of = |s| HashMap::from([("worker".to_string(), s)]);
        // The same minute and count, three seconds later: no refresh.
        assert!(!shown_changed(&of(stall(2, 600_000)), &of(stall(2, 603_000))));
        // A new minute, another count, a new or cleared stall: refresh.
        assert!(shown_changed(&of(stall(2, 659_000)), &of(stall(2, 660_000))));
        assert!(shown_changed(&of(stall(2, 600_000)), &of(stall(3, 600_000))));
        assert!(shown_changed(&HashMap::new(), &of(stall(1, 600_000))));
        assert!(shown_changed(&of(stall(1, 600_000)), &HashMap::new()));
    }
}
