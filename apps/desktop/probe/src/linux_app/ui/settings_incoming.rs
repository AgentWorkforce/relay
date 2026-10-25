//! The outcome of an Incoming change stays visible across a core restart.

use super::app::App;
use super::state::{Page, Pane};
use crate::relay::contract::incoming::IncomingStatus;
use crate::relay::contract::Method;

impl App {
    /// `refused` is shown when the core answers that it did not make the
    /// change. The list shows `optimistic` at once, over every read until
    /// the core has taken the change and listed it; a refusal takes it
    /// away again and says why.
    pub(super) fn incoming_change<M>(
        &self,
        params: M::Params,
        refused: String,
        done: fn(&M::Result) -> bool,
        optimistic: impl Fn(IncomingStatus) -> IncomingStatus + 'static,
    ) where
        M: Method + 'static,
        M::Params: Send + 'static,
        M::Result: Send + 'static,
    {
        self.inner
            .incoming_changes
            .set(self.inner.incoming_changes.get() + 1);
        let token = self.update_state(|state| {
            state.incoming_error = None;
            let token = state.incoming_pending.begin(optimistic);
            state.sync_incoming();
            token
        });
        if self.page() == Page::Settings(Pane::Relay) {
            self.render_settings();
        }
        self.view_call::<M>(params, move |app, result| {
            let pending = &app.inner.incoming_changes;
            pending.set(pending.get().saturating_sub(1));
            let error = match result {
                Err(error) => Some(error.message),
                Ok(answer) if !done(&answer) => Some(refused),
                Ok(_) => None,
            };
            app.update_state(|state| {
                state.incoming_pending.answered(token, error.is_none());
                state.sync_incoming();
                state.incoming_error = error;
            });
            if app.page() == Page::Settings(Pane::Relay) {
                app.render_settings();
            }
            app.refresh_incoming();
        });
    }
}
