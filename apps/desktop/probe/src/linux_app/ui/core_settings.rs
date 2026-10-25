//! Reading and changing the core's settings, for every page that shows
//! them: Settings, and the Sessions page's setup cards; and the reads a
//! fresh connection makes.

use super::app::App;
use super::settings_page::SettingRow;
use super::state::Page;
use crate::relay::contract::agents::SettingsChange;
use crate::relay::contract::{method, NoParams};
use gtk::glib;
use gtk4 as gtk;

impl App {
    /// Everything a fresh connection reads.
    pub(super) fn refresh_all(&self) {
        self.refresh_request_log();
        self.refresh_uploader(true);
        self.refresh_relay();
        self.load_settings();
        self.refresh_incoming();
        self.refresh_claude_delivery();
    }

    /// Each read reruns only itself when asked again mid-read; a rerun that
    /// asked for the other too would keep the two reading each other.
    pub fn load_settings(&self) {
        self.load_core_settings();
        self.load_login_item();
        self.load_openclaw_tools();
    }

    fn load_core_settings(&self) {
        self.once::<method::SettingsGet>(
            "settings",
            NoParams {},
            App::load_core_settings,
            |app, result| {
                if let Ok(settings) = result {
                    app.update_state(|state| state.settings_read(settings));
                    app.settings_changed();
                    if app.view() == Some(super::state::View::SignIn) {
                        app.show_sign_in();
                    }
                }
            },
        );
    }

    fn load_login_item(&self) {
        self.once::<method::LoginItemStatus>(
            "login_item",
            NoParams {},
            App::load_login_item,
            |app, result| {
                if let Ok(login_item) = result {
                    app.update_state(|state| state.login_item = Some(login_item.enabled));
                    app.settings_changed();
                }
            },
        );
    }

    pub(super) fn settings_changed(&self) {
        if !self.with_state(|state| state.connected()) || self.inner.updating.get() {
            return;
        }
        match self.page() {
            Page::Settings(_) => self.render_settings(),
            // The Devin card follows its setting.
            Page::Sessions => self.redraw_setup_cards(),
            _ => {}
        }
    }

    /// Changes the core's settings. The change shows at once, with a spinner
    /// beside its row until the core answers; a failure reverts it and shows
    /// under `row`.
    pub fn set_setting(&self, change: SettingsChange, row: SettingRow) {
        // The draft this save sends: a reply clears only that one, never an
        // edit made while the save was on its way.
        let submitted_cap = change
            .spawn_max_agents
            .is_some()
            .then(|| self.with_state(|state| state.spawn_cap.draft.clone()));
        let token = self.update_state(|state| state.begin_setting(change.clone()));
        // The switch that asked is drawn again with its spinner once its
        // signal has run, not from inside it.
        glib::idle_add_local_once(self.on(|app| app.settings_changed()));
        self.call::<method::SettingsSet>(change, move |app, result| {
            let error = result.as_ref().err().map(|error| error.message.clone());
            app.update_state(|state| {
                state.finish_setting(token, result.as_ref().ok().cloned());
                if let Some(submitted) = &submitted_cap {
                    state.spawn_cap.saving = false;
                    if *submitted == state.spawn_cap.draft {
                        state.spawn_cap.draft = None;
                    }
                }
                match row {
                    SettingRow::DirectDelivery => state.inbound_error = error.clone(),
                    SettingRow::GrokLeader => state.grok_leader_error = error.clone(),
                    SettingRow::OpenCodePlugin => state.opencode_plugin_error = error.clone(),
                    SettingRow::OpenClaw => state.openclaw.error = error.clone(),
                    SettingRow::TrustedSenders => state.trusted_senders_error = error.clone(),
                    SettingRow::Hermes => state.hermes_error = error.clone(),
                    SettingRow::DevinDelivery => state.devin_delivery_error = error.clone(),
                    SettingRow::ClaudeFolders => state.claude_folders_error = error.clone(),
                    SettingRow::ClaudeSessionHook => {
                        state.claude_session_hook_error = error.clone()
                    }
                    SettingRow::Pane if error.is_some() => state.settings_error = error.clone(),
                    // A row's own setting reports under it; its success says
                    // nothing about an earlier error of another setting.
                    SettingRow::Pane => state.settings_error = None,
                }
            });
            app.settings_changed();
        });
    }
}
