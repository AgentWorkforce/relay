//! Explicit desktop usage and debounced search events. Never records query text.
use super::app::App;
use super::state::{Page, Pane, State};
use crate::relay::contract::method;
use crate::relay::telemetry::{
    TelemetryEvent, TelemetryFailure, TelemetryOperation, TelemetryOutcome, TelemetrySurface,
};
use gtk::{glib, prelude::*};
use gtk4 as gtk;
use std::time::Duration;

impl App {
    /// Changes the window's state without redrawing.
    pub fn update_state<T>(&self, change: impl FnOnce(&mut State) -> T) -> T {
        let (result, page, session_search, agent_search, connected) = {
            let mut state = self.inner.state.borrow_mut();
            let before = (
                state.connected(),
                state.page,
                state.session_search.clone(),
                state.agent_search.clone(),
            );
            let result = change(&mut state);
            let page =
                (state.connected() && (!before.0 || before.1 != state.page)).then_some(state.page);
            let sessions = (before.2 != state.session_search).then(|| state.session_search.clone());
            let agents = (before.3 != state.agent_search).then(|| {
                (
                    state.agent_search.clone(),
                    if state.page == Page::Team {
                        TelemetrySurface::Team
                    } else {
                        TelemetrySurface::Agents
                    },
                )
            });
            (result, page, sessions, agents, state.connected())
        };
        if let Some(page) = page {
            self.cancel_search_telemetry(Some(page.telemetry_surface()));
            self.record_surface(
                TelemetryOperation::PageView,
                TelemetryOutcome::Succeeded,
                page.telemetry_surface(),
            );
            if matches!(page, Page::Settings(_)) {
                self.record_surface(
                    TelemetryOperation::Settings,
                    TelemetryOutcome::Started,
                    page.telemetry_surface(),
                );
            }
        }
        if connected {
            if let Some(query) = session_search {
                self.schedule_search_telemetry(&query, TelemetrySurface::Sessions);
            }
            if let Some((query, surface)) = agent_search {
                self.schedule_search_telemetry(&query, surface);
            }
        } else {
            self.cancel_search_telemetry(None);
        }
        result
    }

    fn cancel_search_telemetry(&self, keep: Option<TelemetrySurface>) {
        let mut timers = self.inner.search_telemetry.borrow_mut();
        // A query can be applied in a separate update just before navigation.
        let arriving = keep.and_then(|surface| timers.remove(&surface));
        for (_, timer) in timers.drain() {
            timer.remove();
        }
        if let (Some(surface), Some(timer)) = (keep, arriving) {
            timers.insert(surface, timer);
        }
    }

    /// `telemetry.record` for what only the UI sees.
    pub(super) fn record(
        &self,
        operation: TelemetryOperation,
        outcome: TelemetryOutcome,
        failure: Option<TelemetryFailure>,
    ) {
        if !self.inner.bridge.offers(method::TelemetryRecord::NAME) {
            return;
        }
        let mut event = TelemetryEvent::new(operation, outcome);
        if let Some(failure) = failure {
            event = event.failure(failure);
        }
        self.call::<method::TelemetryRecord>(event, |_, _| {});
    }

    pub(super) fn record_surface(
        &self,
        operation: TelemetryOperation,
        outcome: TelemetryOutcome,
        surface: TelemetrySurface,
    ) {
        if self.inner.bridge.offers(method::TelemetryRecord::NAME) {
            self.call::<method::TelemetryRecord>(
                TelemetryEvent::new(operation, outcome).surface(surface),
                |_, _| {},
            );
        }
    }

    fn schedule_search_telemetry(&self, query: &str, surface: TelemetrySurface) {
        let related: &[TelemetrySurface] = if surface == TelemetrySurface::Sessions {
            &[TelemetrySurface::Sessions]
        } else {
            &[TelemetrySurface::Agents, TelemetrySurface::Team]
        };
        for key in related {
            if let Some(timer) = self.inner.search_telemetry.borrow_mut().remove(key) {
                timer.remove();
            }
        }
        if query.trim().is_empty() {
            return;
        }
        let weak = self.downgrade();
        let timer = glib::timeout_add_local_once(Duration::from_millis(500), move || {
            if let Some(app) = weak.upgrade() {
                app.inner.search_telemetry.borrow_mut().remove(&surface);
                if !app.with_state(|state| {
                    state.connected() && state.page.telemetry_surface() == surface
                }) {
                    return;
                }
                app.record_surface(
                    TelemetryOperation::Search,
                    TelemetryOutcome::Succeeded,
                    surface,
                );
            }
        });
        self.inner
            .search_telemetry
            .borrow_mut()
            .insert(surface, timer);
    }

    pub(super) fn open_approval_url(&self, url: &str) {
        self.record(
            TelemetryOperation::BrowserApproval,
            TelemetryOutcome::Started,
            None,
        );
        let opened = self.inner.desktop.open_uri(url);
        self.record(
            TelemetryOperation::BrowserApproval,
            if opened {
                TelemetryOutcome::Succeeded
            } else {
                TelemetryOutcome::Failed
            },
            (!opened).then_some(TelemetryFailure::BrowserOpen),
        );
    }

    pub fn set_agent_search(&self, value: &str) {
        let changed = self.update_state(|state| {
            let changed = state.agent_search != value;
            state.agent_search = value.to_string();
            changed
        });
        if changed {
            if let Some(shell) = self.shell() {
                if let Some((search, Page::Agents | Page::Team)) =
                    shell.topbar_search.borrow().as_ref()
                {
                    if search.text().as_str() != value {
                        shell.syncing_agent_search.set(true);
                        search.set_text(value);
                        shell.syncing_agent_search.set(false);
                    }
                }
            }
            self.render_page();
        }
    }

    pub(super) fn open_message_composer(&self) {
        self.record_surface(
            TelemetryOperation::MessageComposer,
            TelemetryOutcome::Started,
            TelemetrySurface::Messages,
        );
        self.go(Page::Messages);
    }

    pub(super) fn agent_search_changed(&self, entry: &gtk::SearchEntry) {
        let current = self.shell().is_some_and(|shell| {
            !shell.syncing_agent_search.get()
                && shell
                    .topbar_search
                    .borrow()
                    .as_ref()
                    .is_some_and(|(active, searched)| active == entry && *searched == self.page())
        });
        if current {
            self.set_agent_search(&entry.text());
        }
    }
}

impl Page {
    pub fn telemetry_surface(self) -> crate::relay::telemetry::TelemetrySurface {
        use crate::relay::telemetry::TelemetrySurface as Surface;
        match self {
            Self::Agents => Surface::Agents,
            Self::Sessions => Surface::Sessions,
            Self::Team => Surface::Team,
            Self::Messages => Surface::Messages,
            Self::Settings(pane) => match pane {
                Pane::General => Surface::SettingsGeneral,
                Pane::Opening => Surface::SettingsOpening,
                Pane::Relay => Surface::SettingsRelay,
                Pane::Sharing => Surface::SettingsSharing,
                Pane::Account => Surface::SettingsAccount,
                Pane::About => Surface::SettingsAbout,
                Pane::Diagnostics => Surface::SettingsDiagnostics,
            },
        }
    }
}
