//! The waiting branch of app-server routing, including bounded recovery.

use super::*;
use crate::relay::claude::inbox::InboxStall;
use app_server::recovery::Recovery;

impl CodexRouter {
    /// Whether any relay message is waiting on this thread: cheap, and
    /// without reading the session.
    pub(crate) fn watching(&self, thread: &str) -> bool {
        self.stalls.lock().unwrap_or_else(|p| p.into_inner()).contains_key(thread)
    }

    pub fn inbox_stall(&self, thread: &str) -> Option<InboxStall> {
        if !self.watching(thread) {
            return None;
        }
        let progress = self.routes.progress(thread);
        let now = (self.now)();
        let mut stalls = self.stalls.lock().unwrap_or_else(|p| p.into_inner());
        let watch = stalls.get_mut(thread)?;
        watch.refresh(progress, now);
        let report = watch.report(now, self.stall_timing.stall);
        if watch.finished() {
            stalls.remove(thread);
        }
        report
    }

    pub(crate) fn forget_waiting(&self, thread: &str, message_id: &str) {
        let mut stalls = self.stalls.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(watch) = stalls.get_mut(thread) {
            watch.forget(message_id);
            if watch.finished() {
                stalls.remove(thread);
            }
        }
    }

    pub(crate) fn wait_for_turn(
        &self,
        thread: &str,
        message_id: &str,
        text: &str,
        spawned: bool,
    ) -> InjectOutcome {
        let waiting = || InjectOutcome::Waiting(BUSY.into());
        let progress = self.routes.progress(thread);
        let now = (self.now)();
        let (turn, interrupt) = {
            let mut stalls = self.stalls.lock().unwrap_or_else(|p| p.into_inner());
            let watch = stalls.entry(thread.into()).or_default();
            watch.refresh(progress.clone(), now);
            watch.waiting(message_id, now);
            if watch.recovering
                || watch.interrupted
                || watch.in_doubt
                || watch.report(now, self.stall_timing.stall).is_none()
            {
                return waiting();
            }
            let Some(turn) = watch.turn().map(str::to_string) else {
                return waiting();
            };
            let interrupt = spawned && watch.report(now, self.stall_timing.interrupt).is_some();
            watch.recovering = true;
            (turn, interrupt)
        };
        // Progress or a turn transition while preparing recovery revokes it.
        let result = if self.routes.progress(thread) == progress
            && !self.routes.terminal_live(thread)
            && self.routes.relay_waiting(thread) == Some(false)
            && super::super::compact::held(thread, message_id).is_none()
            && !self.behind_hidden(thread, message_id)
        {
            // Steered input shows in the chat; a hidden message stays queued.
            let steer = (!super::super::compact::enabled()).then_some(text);
            // A steer hands the message over, so it is claimed from the
            // turn hook first, as every other route does.
            match steer.map_or(Ok(()), |_| self.leave_turn_hook(message_id)) {
                Ok(()) => self
                    .routes
                    .recover_stalled(thread, &turn, steer, message_id, interrupt),
                Err(outcome) => {
                    self.end_recovery(thread, &Ok(Recovery::Unavailable));
                    return outcome;
                }
            }
        } else {
            Ok(Recovery::Unavailable)
        };
        self.end_recovery(thread, &result);
        match result {
            Ok(Recovery::Steered) => {
                self.delivered(thread, message_id, &MessageRef::of(message_id))
            }
            Err(TurnError::InDoubt(reason)) => {
                self.forget_waiting(thread, message_id);
                InjectOutcome::InDoubt(reason)
            }
            _ => waiting(),
        }
    }

    fn end_recovery(&self, thread: &str, result: &Result<Recovery, TurnError>) {
        let mut stalls = self.stalls.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(watch) = stalls.get_mut(thread) {
            watch.recovering = false;
            if *result == Ok(Recovery::Interrupted) {
                watch.interrupted = true;
            }
            watch.in_doubt |= matches!(result, Err(TurnError::InDoubt(_)));
        }
    }
}
