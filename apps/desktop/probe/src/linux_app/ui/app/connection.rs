//! Changes to the app when its core connection comes or goes.

use super::*;

impl App {
    pub(super) fn forget_account_view(&self) {
        self.update_state(|state| {
            state.forget_account_view();
            state.claude_delivery = None;
            state.claude_delivery_pending.clear();
            state.claude_delivery_error = None;
        });
        self.inner.in_flight.borrow_mut().clear();
        self.inner.rerun.borrow_mut().clear();
        self.inner.incoming_changes.set(0);
        self.inner.claude_delivery_changes.set(0);
        if let Some(shell) = self.inner.shell.borrow_mut().take() {
            shell.pages.messages.close_all();
        }
    }

    /// The event connection came up or went down.
    pub fn on_connection(&self, connected: bool, error: Option<String>) {
        let incoming_interrupted = !connected && self.inner.incoming_changes.replace(0) > 0;
        let claude_interrupted = !connected && self.inner.claude_delivery_changes.replace(0) > 0;
        let (changed, resumed) = self.update_state(|state| {
            let resumed = connected && !state.core_connected && state.view == Some(View::Connected);
            state.core_connected = connected;
            if connected {
                state.core_error = None;
                return (false, resumed);
            }
            state.connection_interrupted();
            if incoming_interrupted {
                state.incoming_error = Some(CoreError::interrupted().message);
                state.incoming_pending.interrupted();
                state.sync_incoming();
            }
            if claude_interrupted {
                state.claude_delivery_error = Some(CoreError::interrupted().message);
                state.claude_delivery_pending.interrupted();
                state.sync_claude_delivery();
            }
            state.core_error = error;
            // Keep the last account and workspace in the connected shell.
            // Other screens must await a fresh snapshot to settle sign-in.
            if state.view != Some(View::Connected) {
                state.snapshot = None;
            }
            // The core that took a sign-in or answered a sign-out is gone;
            // the next one's snapshot says where the account stands.
            state.starting_sign_in = false;
            if state.sign_out_answered {
                state.signing_out = false;
            }
            (true, false)
        });
        if changed {
            self.inner.in_flight.borrow_mut().clear();
            self.inner.rerun.borrow_mut().clear();
        }
        if resumed {
            self.refresh_all();
            self.preload_session_titles();
        }
        if changed {
            self.render();
            if self.with_state(State::connected) {
                self.render_chrome();
                self.refresh_session_title_cells();
                if self.page() == Page::Settings(Pane::Relay) {
                    self.render_settings();
                }
            }
        }
    }
}
