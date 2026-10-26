//! The one per-computer experimental mobile Claude handoff preference.

use super::app::App;
use super::settings_page::{pending_toggle_row, SettingRow};
use super::widgets::settings_divider;
use crate::linux_app::models::{
    MOBILE_CLAUDE_HANDOFF_DETAIL, MOBILE_CLAUDE_HANDOFF_TITLE, MOBILE_CLAUDE_HANDOFF_UNAVAILABLE,
};
use crate::relay::contract::agents::SettingsChange;
use gtk::prelude::*;
use gtk4 as gtk;

impl App {
    pub(super) fn append_mobile_claude_handoff_row(&self, group: &gtk::Box) {
        let Some(enabled) = self.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.mobile_claude_handoff)
        }) else {
            return;
        };
        let supported = self.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.mobile_claude_handoff_supported)
                == Some(true)
        });
        let weak = self.downgrade();
        settings_divider(group, 62);
        group.append(&pending_toggle_row(
            MOBILE_CLAUDE_HANDOFF_TITLE,
            if supported {
                MOBILE_CLAUDE_HANDOFF_DETAIL
            } else {
                MOBILE_CLAUDE_HANDOFF_UNAVAILABLE
            },
            "phone-symbolic",
            enabled,
            supported,
            self.with_state(|state| state.setting_pending("mobile_claude_handoff")),
            move |enabled| {
                if let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) {
                    app.set_setting(
                        SettingsChange {
                            mobile_claude_handoff: Some(enabled),
                            ..SettingsChange::default()
                        },
                        SettingRow::Pane,
                    );
                }
            },
        ));
    }
}
