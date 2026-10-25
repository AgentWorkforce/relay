//! Title reconciliation and controls shared by session table redraws.
use super::*;
use crate::linux_app::ui::state::State;

pub(super) fn with_optimistic_title(state: &State, mut row: LocalSessionRow) -> LocalSessionRow {
    let title = state
        .session_titles
        .get(&row.key())
        .and_then(|edit| edit.optimistic.as_ref());
    if let Some(title) = title {
        if let Some(upload) = row.upload.as_mut() {
            upload.title = title.clone();
        }
        if let Some(local) = row.relay.as_mut() {
            local.title = title.clone();
        }
    }
    row
}

impl App {
    pub(super) fn reconcile_native_session_titles(&self) {
        // Reconcile against native snapshots before applying display overlays.
        self.update_state(|state| {
            if !state.session_titles.is_empty() {
                for row in merge_local_sessions(&state.sessions, &state.local_sessions) {
                    if let Some(edit) = state.session_titles.get_mut(&row.key()) {
                        edit.observed(&row.title());
                    }
                }
            }
        });
    }
}

impl App {
    pub(super) fn connect_session_pagination(&self, adjustment: &gtk::Adjustment) {
        let weak = self.downgrade();
        adjustment.connect_value_changed(move |_| {
            if let Some(app) = weak.upgrade() {
                app.load_more_sessions_if_needed();
            }
        });
        let weak = self.downgrade();
        adjustment.connect_changed(move |_| {
            if let Some(app) = weak.upgrade() {
                app.load_more_sessions_if_needed();
            }
        });
    }
}
