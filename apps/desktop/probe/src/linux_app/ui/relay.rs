//! The core's listings every surface shares: the uploader's status and
//! sessions (the status bar, the sidebar's counts, My sessions), and this
//! computer's sessions, agents, the fleet, the workspace's people and
//! roster (the tray's switches, the sidebar, My agents and Team). Pages draw
//! them; this reads them and switches sessions on and off the relay.

use super::app::App;
use super::state::{Page, Pane, Section};
use crate::linux_app::bridge::CoreError;
use crate::linux_app::models::{session_key, StatusView};
use crate::relay::contract::agents::{
    LimitParams, LocalSession, NameParams, RegisterParams, SessionRegistration,
};
use crate::relay::contract::directory::RosterParams;
use crate::relay::contract::{method, Method, NoParams};
use crate::relay::protocol::ErrorKind;
use crate::relay::store::Target;

mod pause;
mod registration;
mod session_reads;

impl App {
    pub fn refresh_request_log(&self) {
        if !self.bridge().offers(method::DiagnosticsRequests::NAME) {
            self.update_state(|state| state.request_log_error = Some("Request log unavailable. The background service may need to be updated or restarted.".into()));
            return;
        }
        if self.update_state(|state| {
            if state.reading_requests {
                return true;
            }
            state.reading_requests = true;
            false
        }) {
            return;
        }
        let identity_revision = self.with_state(|state| state.request_identity_revision);
        self.view_call::<method::DiagnosticsRequests>(NoParams {}, move |app, result| {
            app.update_state(|state| {
                state.reading_requests = false;
                match result {
                    Ok(log) => {
                        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;
                        let plan = state.snapshot.as_ref().and_then(|snapshot| snapshot.workspace.workspace_plan.as_deref());
                        let reason = crate::linux_app::models::relaycast_upgrade_from_log(&log.entries, plan, state.request_identity_started_at_ms, now_ms, &state.seen_request_failures);
                        if let Some(reason) = reason.filter(|_| identity_revision == state.request_identity_revision && state.last_relaycast_upgrade_at.is_none_or(|at| at.elapsed().as_secs() >= 900)) {
                            state.relaycast_upgrade = Some(reason);
                            state.last_relaycast_upgrade_at = Some(std::time::Instant::now());
                        }
                        if let Some(newest) = log.entries.iter().find(|entry| entry.failed && !state.seen_request_failures.contains(&entry.id)) {
                            state.request_failure = Some(newest.clone());
                        }
                        state.seen_request_failures.extend(log.entries.iter().filter(|entry| entry.failed).map(|entry| entry.id.clone()));
                        if state.seen_request_failures.len() > 1000 {
                            state.seen_request_failures = log.entries.iter().filter(|entry| entry.failed).map(|entry| entry.id.clone()).collect();
                        }
                        state.request_entries = log.entries;
                        state.request_log_error = None;
                    }
                    Err(_) => state.request_log_error = Some("Request log unavailable. The background service may need to be updated or restarted.".into()),
                }
            });
            app.render_status_bar();
            if app.page() == Page::Settings(Pane::Diagnostics) { app.render_settings(); }
        });
    }

    pub fn open_failed_request(&self) {
        self.update_state(|state| {
            state.selected_request = state.request_failure.take();
            state.request_failures_only = false;
            state.request_scroll = true;
        });
        self.go(Page::Settings(Pane::Diagnostics));
    }

    // Uploads.

    /// Reads the uploader's status, and its sessions when `sessions` (or
    /// when none were read yet). A change announced mid-refresh is read once
    /// this one ends.
    pub fn refresh_uploader(&self, sessions: bool) {
        if !self.with_state(|state| state.connected())
            || !self.bridge().offers(method::UploaderStatus::NAME)
        {
            return;
        }
        self.refresh_upload_status();
        if sessions || self.with_state(|state| state.sessions_refreshed.is_none()) {
            self.refresh_upload_sessions();
        }
    }

    fn refresh_upload_status(&self) {
        let deferred = self.update_state(|state| {
            if state.busy || state.refreshing_uploader {
                state.uploader_stale = true;
                return true;
            }
            state.uploader_stale = false;
            state.refreshing_uploader = true;
            false
        });
        if deferred {
            return;
        }
        let generation = self.with_state(|state| state.generation);
        let current = move |app: &App| {
            app.with_state(|state| state.generation == generation && state.connected())
        };
        self.call::<method::UploaderStatus>(NoParams {}, move |app, result| {
            if app.with_state(|state| state.generation) != generation {
                return;
            }
            app.update_state(|state| state.refreshing_uploader = false);
            if !current(app) {
                return;
            }
            match result {
                Ok(status) => app.upload_status_answered(StatusView::new(&status)),
                Err(error) => app.refresh_failed(&error),
            }
            app.refresh_if_stale();
        });
    }

    // A slow status read cannot delay history invalidations or pagination.
    fn refresh_upload_sessions(&self) {
        let request = self.update_state(|state| {
            if state.busy || state.refreshing_sessions {
                state.stale_sessions = true;
                return None;
            }
            state.stale_sessions = false;
            state.refreshing_sessions = true;
            Some((
                state.generation,
                state.session_limit,
                state.upload_selection_revision,
                state.title_write_revision,
            ))
        });
        if let Some((generation, limit, selection, title_revision)) = request {
            let current = move |app: &App| {
                app.with_state(|state| state.generation == generation && state.connected())
            };
            self.call::<method::UploaderSessionsList>(
                LimitParams { limit: Some(limit) },
                move |app, result| {
                    if app.with_state(|state| state.generation) != generation {
                        return;
                    }
                    app.update_state(|state| {
                        state.refreshing_sessions = false;
                        if state.upload_selection_revision != selection
                            || state.title_write_revision != title_revision
                        {
                            state.uploader_stale = true;
                            state.stale_sessions = true;
                        }
                    });
                    if current(app)
                        && app.with_state(|state| {
                            state.upload_selection_revision == selection
                                && state.title_write_revision == title_revision
                        })
                    {
                        match result {
                            Err(error) => app.refresh_failed(&error),
                            Ok(listed) => {
                                app.update_state(|state| {
                                    let keys: std::collections::BTreeSet<String> =
                                        listed.sessions.iter().map(session_key).collect();
                                    state.session_selection.retain(|key| keys.contains(key));
                                    state.sessions = listed.sessions;
                                    state.sessions_refreshed = Some(super::now_ms());
                                });
                                app.reconcile_hidden_sessions();
                                app.update_uploader_views();
                            }
                        }
                    }
                    app.refresh_if_stale();
                },
            );
        }
    }

    fn refresh_if_stale(&self) {
        let (status, sessions) = self.with_state(|state| {
            (
                state.connected()
                    && !state.busy
                    && state.uploader_stale
                    && !state.refreshing_uploader,
                state.connected()
                    && !state.busy
                    && state.stale_sessions
                    && !state.refreshing_sessions,
            )
        });
        if status {
            self.refresh_upload_status();
        }
        if sessions {
            self.refresh_upload_sessions();
        }
    }

    fn refresh_failed(&self, error: &CoreError) {
        if error.kind() == Some(ErrorKind::NotSignedIn) {
            return;
        }
        self.update_state(|state| {
            state.session_error = Some(
                "Could not refresh statuses just now. Agent Relay will try again automatically."
                    .into(),
            )
        });
        if self.page() == Page::Sessions {
            self.render_page();
        }
    }

    pub(super) fn update_uploader_views(&self) {
        if !self.with_state(|state| state.connected()) {
            return;
        }
        let busy = self.update_state(|state| {
            if !state.busy {
                state.session_error = None;
            }
            state.busy
        });
        match self.page() {
            Page::Sessions => self.render_page(),
            Page::Settings(pane) if !busy => self.render_uploader_settings(pane),
            _ => {}
        }
        self.render_status_bar();
        if self.page().section() == Section::Mine {
            self.render_sidebar();
        }
        self.update_tray();
    }

    /// Runs one uploader change at a time; `finished` gets its failure.
    /// Returns whether the change started: it does not while another runs.
    pub(super) fn uploader_command<M>(
        &self,
        params: M::Params,
        working: &str,
        finished: impl FnOnce(&App, Option<CoreError>) + 'static,
    ) -> bool
    where
        M: Method + 'static,
        M::Params: Send + 'static,
        M::Result: Send + 'static,
    {
        if self.with_state(|state| state.busy) {
            return false;
        }
        self.update_state(|state| {
            state.busy = true;
            state.work_description = Some(working.to_string()).filter(|text| !text.is_empty());
        });
        if self.page() == Page::Sessions {
            self.render_page();
        }
        self.view_call::<M>(params, move |app, result| {
            let error = result.err();
            app.update_state(|state| {
                state.busy = false;
                state.work_description = None;
                state.session_error = error.as_ref().map(|error| error.message.clone());
            });
            finished(app, error);
            app.refresh_uploader(true);
        });
        true
    }

    // The relay.

    pub fn refresh_relay(&self) {
        self.refresh_local();
        self.refresh_agents();
        self.refresh_fleet();
        self.refresh_activity();
        self.refresh_people();
    }

    pub fn refresh_local(&self) {
        // The spinner shows a read under way; a core without
        // `sessions.list` starts none.
        if !self.bridge().offers(method::SessionsList::NAME) {
            return;
        }
        let read = self.update_state(|state| {
            state.local_reads += 1;
            state.refreshing_relay = true;
            state.local_reads
        });
        let title_revision = self.with_state(|state| state.title_write_revision);
        // Asked again mid-read, it reads again as a newer read.
        self.once::<method::SessionsList>(
            "local",
            NoParams {},
            App::refresh_local,
            move |app, result| {
                app.update_state(|state| state.refreshing_relay = false);
                match result {
                    Err(error) => {
                        app.update_state(|state| state.relay_load_error = Some(error.message))
                    }
                    Ok(listed) => {
                        app.update_state(|state| state.relay_load_error = None);
                        app.apply_local_after_title_write(read, title_revision, listed.sessions);
                        app.update_state(|state| state.settle());
                    }
                }
                app.relay_changed();
            },
        );
    }

    /// Recent Messages: what was delivered into sessions on the relay.
    pub fn refresh_activity(&self) {
        self.once::<method::ActivityList>(
            "activity",
            LimitParams { limit: Some(50) },
            App::refresh_activity,
            |app, result| {
                if let Ok(log) = result {
                    app.update_state(|state| state.activity = log.activity);
                    app.activity_changed();
                }
            },
        );
    }

    pub fn refresh_agents(&self) {
        self.once::<method::AgentsList>(
            "agents",
            NoParams {},
            App::refresh_agents,
            |app, result| {
                if let Ok(listed) = result {
                    app.update_state(|state| {
                        state.local_agents = listed.agents;
                        state.archived_agents = listed.archived;
                    });
                    app.relay_changed();
                }
            },
        );
    }

    pub fn refresh_fleet(&self) {
        self.once::<method::FleetList>("fleet", NoParams {}, App::refresh_fleet, |app, result| {
            if let Ok(listed) = result {
                app.update_state(|state| {
                    let present: std::collections::HashSet<String> = listed
                        .brokers
                        .iter()
                        .flat_map(|broker| {
                            broker
                                .workers
                                .iter()
                                .map(move |worker| super::state::worker_key(broker, worker))
                        })
                        .collect();
                    state
                        .fleet_row_errors
                        .retain(|key, _| present.contains(key));
                    // The listing says what became of a released worker.
                    state.released.clear();
                    state.brokers = listed.brokers;
                });
                app.relay_changed();
            }
        });
    }

    /// The workspace's people and roster; signed out, both read as empty.
    /// Each read reruns only itself when asked again mid-read; a rerun that
    /// asked for the other too would keep the two reading each other.
    pub fn refresh_people(&self) {
        self.refresh_people_list();
        self.refresh_roster();
    }

    fn refresh_people_list(&self) {
        self.once::<method::PeopleList>(
            "people",
            NoParams {},
            App::refresh_people_list,
            |app, result| {
                app.update_state(|state| match result {
                    Err(error) if error.kind() != Some(ErrorKind::NotSignedIn) => {
                        state.people_error = Some(error.message);
                    }
                    result => {
                        state.people_error = None;
                        state.people = result.map(|listed| listed.people).unwrap_or_default();
                    }
                });
                app.relay_changed();
            },
        );
    }

    fn refresh_roster(&self) {
        let params = RosterParams {
            where_runs: None,
            include_idle: false,
            q: None,
        };
        self.once::<method::RosterList>("roster", params, App::refresh_roster, |app, result| {
            app.update_state(|state| match result {
                Err(error) if error.kind() != Some(ErrorKind::NotSignedIn) => {
                    state.roster_error = Some(error.message);
                }
                result => {
                    state.roster_error = None;
                    state.roster = result.map(|roster| roster.agents).unwrap_or_default();
                }
            });
            app.relay_changed();
        });
    }

    /// New relay data: every surface that shows it.
    pub(super) fn relay_changed(&self) {
        if !self.with_state(|state| state.connected()) {
            return;
        }
        if matches!(
            self.page(),
            Page::Sessions | Page::Agents | Page::Team | Page::Settings(Pane::Relay)
        ) {
            self.render_page();
        }
        self.render_chrome();
        self.update_tray();
    }

    /// Puts `session` on the relay or takes it off. The switch shows the new
    /// state at once; one change per session runs at a time, and the last
    /// state asked for wins.
    pub fn toggle_relay(&self, session: &LocalSession, on: bool) {
        if on
            && self.session_hidden(
                &session
                    .target
                    .upload_key()
                    .unwrap_or_else(|| session.target.key()),
            )
        {
            return;
        }
        let key = session.target.key();
        let running = self.update_state(|state| {
            state
                .held_sections
                .entry(key.clone())
                .or_insert(session.registration.is_some());
            state.wanted.insert(key.clone(), on);
            state.relay_errors.remove(&key);
            !state.busy_targets.insert(key.clone())
        });
        self.relay_changed();
        if !running {
            self.drive(key, session.target.clone());
        }
    }

    /// Sends the change `wanted` holds for `key` when the list disagrees,
    /// then reads the list again.
    fn drive(&self, key: String, target: Target) {
        let (on, registration) = self.with_state(|state| {
            let registration = state
                .local_sessions
                .iter()
                .find(|session| session.target.key() == key)
                .and_then(|session| session.registration.clone());
            (state.wanted.get(&key).copied(), registration)
        });
        let Some(on) = on.filter(|on| *on != registration.is_some()) else {
            self.update_state(|state| {
                state.busy_targets.remove(&key);
                state.settle();
            });
            self.relay_changed();
            return;
        };
        let register = target.clone();
        let changed = {
            let key = key.clone();
            move |app: &App, error: Option<CoreError>| {
                if let Some(error) = error {
                    app.update_state(|state| {
                        state.relay_errors.insert(key.clone(), error.message);
                        state.wanted.remove(&key);
                        state.busy_targets.remove(&key);
                    });
                    app.relay_changed();
                    return;
                }
                let read = app.update_state(|state| {
                    state.local_reads += 1;
                    state.local_reads
                });
                let title_revision = app.with_state(|state| state.title_write_revision);
                app.view_call::<method::SessionsList>(
                    NoParams {},
                    move |app, result| match result {
                        // A list that cannot be read ends the change rather than
                        // repeating it.
                        Err(_) => {
                            app.update_state(|state| {
                                state.busy_targets.remove(&key);
                                state.wanted.remove(&key);
                            });
                            app.relay_changed();
                        }
                        Ok(listed) => {
                            app.update_state(|state| {
                                state.relay_errors.remove(&key);
                            });
                            app.apply_local_after_title_write(
                                read,
                                title_revision,
                                listed.sessions,
                            );
                            app.refresh_agents();
                            // The core took this change, so a list that still
                            // disagrees is its answer: only a newer wish sends
                            // another, never the same one again.
                            if app.with_state(|state| state.wanted.get(&key) == Some(&on)) {
                                app.update_state(|state| {
                                    state.busy_targets.remove(&key);
                                    state.wanted.remove(&key);
                                    state.settle();
                                });
                                app.relay_changed();
                            } else {
                                app.drive(key, target);
                            }
                        }
                    },
                );
            }
        };
        match registration {
            None if on => self.view_call::<method::AgentsRegister>(
                RegisterParams {
                    target: register,
                    name: None,
                    description: None,
                },
                move |app, result| changed(app, result.err()),
            ),
            Some(registration) => self.view_call::<method::AgentsUnregister>(
                NameParams {
                    name: registration.name,
                },
                move |app, result| changed(app, result.err()),
            ),
            None => {}
        }
    }
}
