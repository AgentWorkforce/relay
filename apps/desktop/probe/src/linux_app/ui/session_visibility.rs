//! Local visibility preferences and the sharing shutdown required by hiding.
use super::app::App;
use crate::linux_app::models::{current_hidden_key, relay_session_for};
use crate::relay::contract::{account::SessionKeysParams, method};
use gtk4::glib;
use std::{collections::BTreeSet, time::Duration};

const HIDDEN: &str = "hiddenSessions.v1";
const SHOW: &str = "showHiddenSessions.v1";
impl App {
    pub fn hidden_sessions(&self) -> BTreeSet<String> {
        self.prefs()
            .get(HIDDEN)
            .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
            .unwrap_or_default()
            .iter()
            .map(|key| current_hidden_key(key))
            .collect()
    }
    pub fn session_hidden(&self, key: &str) -> bool {
        self.hidden_sessions().contains(key)
    }
    pub fn show_hidden_sessions(&self) -> bool {
        self.prefs()
            .get(SHOW)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
    pub fn set_show_hidden_sessions(&self, show: bool) {
        let _ = self.inner.prefs.borrow_mut().set(SHOW, show.into());
        if !show {
            let hidden = self.hidden_sessions();
            self.update_state(|state| state.session_selection.retain(|key| !hidden.contains(key)));
        }
        self.update_tray();
        self.render_sessions();
    }
    pub(super) fn reconcile_hidden_sessions(&self) {
        let hidden = self.hidden_sessions();
        let keys = self.with_state(|state| {
            crate::linux_app::models::merge_local_sessions(&state.sessions, &state.local_sessions)
                .into_iter()
                .filter(|row| {
                    hidden.contains(&row.key())
                        && !state.hiding_sessions.contains(&row.key())
                        && (row.upload.as_ref().is_some_and(|s| s.included)
                            || row.relay.as_ref().is_some_and(|s| s.registration.is_some()))
                })
                .map(|row| row.key())
                .collect::<Vec<_>>()
        });
        if !keys.is_empty() {
            self.set_sessions_hidden(keys, true);
        }
    }
    pub fn set_sessions_hidden(&self, keys: Vec<String>, hidden: bool) {
        let keys: BTreeSet<_> = keys
            .into_iter()
            .filter(|key| !self.with_state(|s| s.hiding_sessions.contains(key)))
            .collect();
        let mut stored = self.hidden_sessions();
        for key in &keys {
            if hidden {
                stored.insert(key.clone());
            } else {
                stored.remove(key);
            }
        }
        if self
            .inner
            .prefs
            .borrow_mut()
            .set(HIDDEN, serde_json::json!(stored))
            .is_err()
        {
            return;
        }
        self.update_tray();
        if !hidden {
            self.render_sessions();
            return;
        }
        let generation = self.with_state(|state| state.generation);
        for key in keys {
            self.update_state(|state| {
                state.hiding_sessions.insert(key.clone());
                state.session_selection.remove(&key);
            });
            let session =
                self.with_state(|state| relay_session_for(&state.local_sessions, &key).cloned());
            if let Some(session) = &session {
                self.toggle_relay(session, false);
            }
            let weak = self.downgrade();
            glib::spawn_future_local(async move {
                loop {
                    let Some(app) = weak.upgrade() else {
                        return;
                    };
                    if app.with_state(|s| s.generation) != generation {
                        app.finish_hiding_session(
                            &key,
                            Some("Account changed while hiding session".into()),
                        );
                        return;
                    }
                    let busy = app.with_state(|state| {
                        state.busy_uploads.contains(&key)
                            || session
                                .as_ref()
                                .is_some_and(|s| state.busy_targets.contains(&s.target.key()))
                    });
                    if busy {
                        drop(app);
                        glib::timeout_future(Duration::from_millis(20)).await;
                        continue;
                    }
                    let error = session.as_ref().and_then(|s| {
                        app.with_state(|state| {
                            state
                                .relay_errors
                                .get(&s.target.key())
                                .cloned()
                                .or_else(|| {
                                    state
                                        .local_sessions
                                        .iter()
                                        .any(|current| {
                                            current.target == s.target
                                                && current.registration.is_some()
                                        })
                                        .then(|| "Session is still on the relay. Try again.".into())
                                })
                        })
                    });
                    if error.is_some() {
                        app.finish_hiding_session(&key, error);
                        return;
                    }
                    let catalogued = app.with_state(|state| {
                        state
                            .sessions
                            .iter()
                            .any(|s| crate::linux_app::models::session_key(s) == key)
                    });
                    if !catalogued {
                        app.finish_hiding_session(&key, None);
                        return;
                    }
                    // Exclude preserves existing cloud copies; delete does not.
                    let params = SessionKeysParams {
                        session_keys: vec![key.clone()],
                    };
                    app.view_call::<method::UploaderSessionsExclude>(params, move |app, result| {
                        app.finish_hiding_session(&key, result.err().map(|error| error.message));
                    });
                    return;
                }
            });
        }
        self.render_sessions();
    }
    fn finish_hiding_session(&self, key: &str, error: Option<String>) {
        if error.is_some() {
            let mut hidden = self.hidden_sessions();
            hidden.remove(key);
            let _ = self
                .inner
                .prefs
                .borrow_mut()
                .set(HIDDEN, serde_json::json!(hidden));
        }
        self.update_state(|state| {
            state.hiding_sessions.remove(key);
            if let Some(error) = error {
                state
                    .upload_errors
                    .insert(key.into(), format!("Could not hide session: {error}"));
            } else {
                state.upload_selection_revision += 1;
                state.upload_errors.remove(key);
                if let Some(session) = state
                    .sessions
                    .iter_mut()
                    .find(|s| crate::linux_app::models::session_key(s) == key)
                {
                    session.included = false;
                    session.status = crate::relay::contract::account::UploadShareStatus::NotShared;
                }
            }
        });
        self.update_tray();
        self.render_sessions();
    }
}
