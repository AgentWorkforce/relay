//! General: startup, privacy and how long session history is kept. The
//! Mac's `SettingsPaneView.general` and `HistoryRetentionRow` match it.

use super::{pending_toggle_row, toggle_row, SettingRow};
use crate::linux_app::models::{
    history_retention_choices, history_retention_warning, HISTORY_RETENTION_DETAIL,
    HISTORY_RETENTION_SECTION, HISTORY_RETENTION_TITLE,
};
use crate::linux_app::ui::app::App;
use crate::linux_app::ui::state::{Page, Pane, State};
use crate::linux_app::ui::widgets::{
    self, hbox, notice, settings_divider, settings_row, settings_section, Tone,
};
use crate::relay::contract::agents::SettingsChange;
use gtk::prelude::*;
use gtk4 as gtk;

impl App {
    pub(super) fn general_pane(&self, column: &gtk::Box) {
        self.appearance_section(column);
        let (section, group) = settings_section("Startup", None);
        let (login_item, analytics, analytics_pending) = self.with_state(|state| {
            (
                state.login_item_shown(),
                state
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.analytics_enabled)
                    .unwrap_or(true),
                state.setting_pending("analytics_enabled"),
            )
        });
        let keeps_connected = self.prefs().keeps_agents_connected_after_quit();
        let weak = self.downgrade();
        group.append(&toggle_row(
            "Open at login",
            if keeps_connected {
                "Show Agent Relay in the system tray when you log in. Your agents stay connected either way."
            } else {
                "Show Agent Relay in the system tray when you log in. Your agents connect when it opens."
            },
            "system-shutdown-symbolic",
            login_item.unwrap_or(false),
            login_item.is_some(),
            move |enabled| {
                if let Some(app) = weak.upgrade() {
                    app.change_autostart(enabled);
                }
            },
        ));
        settings_divider(&group, 54);
        let weak = self.downgrade();
        group.append(&toggle_row(
            "Keep agents connected after quitting",
            "When off, quitting Agent Relay disconnects your agents and stops uploads until you open it again.",
            "system-run-symbolic",
            keeps_connected,
            true,
            move |enabled| {
                if let Some(app) = weak.upgrade() {
                    app.change_keep_connected(enabled);
                }
            },
        ));
        if self.with_state(|state| {
            state
                .service_state
                .is_none_or(|service| !service.installed || !service.enabled || !service.active)
                || state.service_error.is_some()
        }) {
            settings_divider(&group, 54);
            group.append(&self.background_service_row());
        }
        column.append(&section);
        let (section, group) = settings_section("Privacy", None);
        let weak = self.downgrade();
        group.append(&pending_toggle_row(
            "Share diagnostics",
            "Send feature usage and error categories, linked to your Agent Relay account after sign-in. They never contain message or session text, searches, paths, URLs, credentials or raw errors. Turning this off stops all of it.",
            "utilities-system-monitor-symbolic",
            analytics,
            true,
            analytics_pending,
            move |enabled| {
                if let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) {
                    app.set_setting(
                        SettingsChange {
                            analytics_enabled: Some(enabled),
                            ..SettingsChange::default()
                        },
                        SettingRow::Pane,
                    );
                }
            },
        ));
        column.append(&section);
        if let Some(row) = self.history_retention_row() {
            let (section, group) = settings_section(HISTORY_RETENTION_SECTION, None);
            group.append(&row);
            column.append(&section);
        }
    }

    /// How long this computer keeps local session history, with the warning
    /// a choice shorter than the default gets (the Mac's
    /// `HistoryRetentionRow`). Absent in cores without the setting.
    fn history_retention_row(&self) -> Option<gtk::Box> {
        let (days, pending, held) = self.with_state(|state| {
            (
                state
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.history_retention_days),
                state.setting_pending("history_retention_days"),
                uploads_held(state),
            )
        });
        let days = days?;
        let choices = history_retention_choices();
        let labels: Vec<&str> = choices.iter().map(|(_, label)| label.as_str()).collect();
        let choice = gtk::DropDown::from_strings(&labels);
        if let Some(index) = choices.iter().position(|(value, _)| *value == days) {
            choice.set_selected(index as u32);
        }
        choice.set_valign(gtk::Align::Start);
        choice.set_sensitive(false);
        widgets::name(&choice, HISTORY_RETENTION_TITLE);
        if held {
            choice.add_css_class(HELD_CLASS);
        }
        choice.set_widget_name("history-retention");
        let weak = self.downgrade();
        choice.connect_selected_notify(move |choice| {
            let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) else {
                return;
            };
            let Some((next, _)) = choices.get(choice.selected() as usize) else {
                return;
            };
            if *next != days {
                app.set_setting(
                    SettingsChange {
                        history_retention_days: Some(*next),
                        ..SettingsChange::default()
                    },
                    SettingRow::Pane,
                );
            }
        });
        let accessory = hbox(8, &[]);
        accessory.set_valign(gtk::Align::Start);
        if pending {
            let spinner = gtk::Spinner::new();
            spinner.set_valign(gtk::Align::Center);
            widgets::name(&spinner, "Saving…");
            spinner.start();
            accessory.append(&spinner);
        }
        accessory.append(&choice);
        let extra: Vec<gtk::Widget> = history_retention_warning(days, held)
            .map(|warning| notice(&warning, Tone::Warn))
            .into_iter()
            .collect();
        Some(
            settings_row(
                HISTORY_RETENTION_TITLE,
                HISTORY_RETENTION_DETAIL,
                "document-open-recent-symbolic",
                Some(accessory.upcast_ref()),
                &extra,
            )
            .0,
        )
    }

    /// Settings after the uploader changed: Sharing is drawn again, and
    /// General only when its session history warning no longer matches.
    pub(in crate::linux_app::ui) fn render_uploader_settings(&self, pane: Pane) {
        match pane {
            Pane::Sharing => self.render_settings(),
            Pane::General => self.refresh_history_retention(),
            _ => {}
        }
    }

    /// Draws General again when uploads start or stop being held while it
    /// shows, so the session history warning follows a pause, a resume or a
    /// lost connection. Nothing is drawn while the row is already current.
    pub(in crate::linux_app::ui) fn refresh_history_retention(&self) {
        if self.page() != Page::Settings(Pane::General) {
            return;
        }
        let Some(shell) = self.shell() else {
            return;
        };
        let Some(choice) = named(shell.settings.column.upcast_ref(), "history-retention") else {
            return;
        };
        if choice.has_css_class(HELD_CLASS) != self.with_state(uploads_held) {
            self.render_settings();
        }
    }
}

/// Marks a session history menu drawn while uploads were held.
const HELD_CLASS: &str = "uploads-held";

/// Signed out or uploads paused: any limit can remove what has not uploaded.
fn uploads_held(state: &State) -> bool {
    !state.connected() || state.is_paused()
}

/// The first widget under `root` (or `root`) with this name.
fn named(root: &gtk::Widget, name: &str) -> Option<gtk::Widget> {
    if root.widget_name() == name {
        return Some(root.clone());
    }
    let mut child = root.first_child();
    while let Some(widget) = child {
        if let Some(found) = named(&widget, name) {
            return Some(found);
        }
        child = widget.next_sibling();
    }
    None
}
