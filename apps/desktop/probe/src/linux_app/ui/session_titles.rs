//! Inline native session titles. Saved pipeline briefs are read for the selected
//! session; the sparkle copies a cached title into the draft and never starts work.
use super::app::App;
use crate::linux_app::models::{
    parse_overview, relay_session_for, LocalSessionRow, Overview, OverviewStatus,
};
use crate::relay::contract::agents::{SessionTitleIdentity, SessionTitleSetParams};
use crate::relay::contract::directory::SessionOverviewParams;
use crate::relay::contract::method;
use gtk::{glib, prelude::*};
use gtk4 as gtk;

mod cell;
pub(super) use cell::SessionTitleCell;

impl App {
    fn use_generated_session_title(&self, row: &LocalSessionRow) {
        let generated = self.with_state(|state| {
            state
                .title_overviews
                .get(&row.key())
                .map(|overview| overview.title.trim().to_owned())
                .filter(|title| !title.is_empty())
        });
        if let Some(title) = generated {
            self.update_state(|state| {
                if let Some(edit) = state.session_titles.get_mut(&row.key()) {
                    if edit.draft.is_some() {
                        edit.draft = Some(title);
                        edit.error = None;
                    }
                }
            });
            self.refresh_session_title_cells();
            if let Some(shell) = self.shell() {
                if let Some(cell) = shell.pages.sessions.transcript.title_cell.borrow().as_ref() {
                    cell.focus_entry();
                }
            }
        }
    }

    fn cancel_title_blur(&self) {
        if let Some(shell) = self.shell() {
            if let Some(cell) = shell.pages.sessions.transcript.title_cell.borrow().as_ref() {
                cell.cancel_blur();
            }
        }
    }

    pub(super) fn refresh_session_title_cells(&self) {
        if let Some(shell) = self.shell() {
            if let Some(cell) = shell.pages.sessions.transcript.title_cell.borrow().as_ref() {
                cell.refresh(self);
            }
        }
    }

    fn current_session_title(&self, row: &LocalSessionRow) -> String {
        self.with_state(|state| {
            state
                .session_titles
                .get(&row.key())
                .and_then(|edit| edit.optimistic.clone())
                .or_else(|| {
                    state
                        .sessions
                        .iter()
                        .find(|session| {
                            session.source == row.source() && session.session_id == row.session_id()
                        })
                        .map(crate::linux_app::models::session_title)
                })
                .or_else(|| {
                    relay_session_for(&state.local_sessions, &row.key())
                        .map(|session| session.title.clone())
                })
                .unwrap_or_else(|| row.title())
        })
    }

    fn begin_session_title_edit(&self, row: &LocalSessionRow) {
        let title = self.current_session_title(row);
        self.update_state(|state| {
            let edit = state.session_titles.entry(row.key()).or_default();
            if edit.supported == Some(true) {
                edit.begin(&title);
            }
        });
        self.refresh_session_title_cells();
        self.load_session_title_capability(row);
        self.load_session_title_overview(row);
    }

    pub(super) fn load_session_title_capability(&self, row: &LocalSessionRow) {
        let key = row.key();
        let check = self.update_state(|state| {
            if !state.core_connected {
                return false;
            }
            if state
                .session_titles
                .values()
                .filter(|edit| edit.checking)
                .count()
                >= 4
            {
                return false;
            }
            let edit = state.session_titles.entry(key.clone()).or_default();
            if edit.checking
                || edit
                    .capability_checked_at
                    .is_some_and(|at| super::now_ms() - at < 60_000)
            {
                return false;
            }
            edit.checking = true;
            true
        });
        if !check {
            return;
        }
        self.view_call::<method::SessionsTitleCapability>(
            SessionTitleIdentity {
                source: row.source().into(),
                session_id: row.session_id(),
            },
            move |app, result| {
                app.update_state(|state| {
                    let edit = state.session_titles.entry(key).or_default();
                    edit.checking = false;
                    edit.capability_checked_at = Some(super::now_ms());
                    match result {
                        Ok(capability) => {
                            edit.supported = Some(capability.supported);
                            edit.reason = capability.reason;
                        }
                        Err(error) => {
                            edit.supported = Some(false);
                            edit.reason = Some(error.message);
                        }
                    }
                    if edit.supported == Some(false) {
                        edit.draft = None;
                    }
                });
                app.refresh_session_title_cells();
                app.preload_session_titles();
            },
        );
    }

    fn focus_title_after_action(&self) {
        if let Some(shell) = self.shell() {
            if let Some(cell) = shell.pages.sessions.transcript.title_cell.borrow().as_ref() {
                cell.focus_after_action();
            }
        }
    }

    fn cancel_session_title_edit(&self, key: &str) {
        self.focus_title_after_action();
        self.cancel_title_blur();
        self.update_state(|state| {
            if let Some(edit) = state.session_titles.get_mut(key) {
                edit.cancel();
            }
        });
        self.refresh_session_title_cells();
    }

    fn save_session_title(&self, row: &LocalSessionRow) {
        self.focus_title_after_action();
        self.commit_session_title(row);
    }

    fn commit_session_title(&self, row: &LocalSessionRow) {
        self.cancel_title_blur();
        let key = row.key();
        let save = self.update_state(|state| {
            let save = state
                .session_titles
                .get_mut(&key)
                .and_then(|edit| edit.save());
            if save.is_some() {
                state.title_write_revision += 1;
            }
            save
        });
        self.refresh_session_title_cells();
        self.render_sessions();
        let Some((revision, title)) = save else {
            return;
        };
        self.view_call::<method::SessionsTitleSet>(
            SessionTitleSetParams {
                source: row.source().into(),
                session_id: row.session_id(),
                title,
            },
            move |app, result| {
                app.update_state(|state| {
                    state.title_write_revision += 1;
                    if let Some(edit) = state.session_titles.get_mut(&key) {
                        edit.finish(
                            revision,
                            result
                                .map(|updated| updated.title)
                                .map_err(|error| error.message),
                            super::now_ms(),
                        );
                        edit.expire(super::now_ms());
                    }
                });
                app.render_sessions();
                app.refresh_session_title_cells();
                app.refresh_local();
                app.refresh_uploader(true);
                let weak = app.downgrade();
                let generation = app.with_state(|state| state.generation);
                glib::timeout_add_local_once(std::time::Duration::from_secs(60), move || {
                    if let Some(app) = weak.upgrade() {
                        if app.with_state(|state| state.generation) != generation {
                            return;
                        }
                        app.update_state(|state| {
                            if let Some(edit) = state.session_titles.get_mut(&key) {
                                edit.expire(super::now_ms());
                            }
                        });
                        app.refresh_session_title_cells();
                        app.refresh_local();
                        app.refresh_uploader(true);
                    }
                });
            },
        );
    }

    /// Only the open transcript preloads metadata; the table never does.
    pub(super) fn preload_session_titles(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions.transcript;
        if page.root.is_visible() && page.root.is_mapped() {
            let selected = page.selected.borrow().clone();
            if let Some(row) = selected {
                self.load_session_title_capability(&row);
                self.load_session_title_overview(&row);
            }
        }
    }

    pub(super) fn load_session_title_overview(&self, row: &LocalSessionRow) {
        if !row.upload.as_ref().is_some_and(|upload| {
            upload.status == crate::relay::contract::account::UploadShareStatus::Uploaded
        }) {
            return;
        }
        let key = row.key();
        let start = self.update_state(|state| {
            if !state.core_connected {
                return false;
            }
            if state.loading_title_overviews.len() >= 4
                || state.loading_title_overviews.contains(&key)
                || state
                    .title_overview_reads
                    .get(&key)
                    .is_some_and(|at| super::now_ms() - at < 60_000)
            {
                return false;
            }
            state
                .title_overview_reads
                .insert(key.clone(), super::now_ms());
            state.loading_title_overviews.insert(key.clone());
            state
                .title_overviews
                .entry(key.clone())
                .or_insert(Overview {
                    status: OverviewStatus::Loading,
                    ..Default::default()
                });
            true
        });
        if !start {
            return;
        }
        let id = row.session_id();
        let source = row.source().to_owned();
        self.view_call::<method::SessionsOverviewGet>(
            SessionOverviewParams {
                session_id: id.clone(),
            },
            move |app, result| {
                let overview = result
                    .map_err(|error| error.message)
                    .and_then(|value| {
                        parse_overview(&value, &id, Some(&source))
                            .map_err(|error| error.to_string())
                    })
                    .unwrap_or_else(|error| Overview {
                        status: OverviewStatus::Failed,
                        error: Some(error),
                        ..Default::default()
                    });
                app.update_state(|state| {
                    state.loading_title_overviews.remove(&key);
                    state.title_overviews.insert(key, overview);
                });
                app.refresh_session_title_cells();
                app.preload_session_titles();
            },
        );
    }
}
