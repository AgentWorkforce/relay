//! Settings → Relay rows for agent-wide settings: whether new agents join
//! #general, and the settings agents changed on the session socket. The
//! Mac's `autoJoinGeneralRow` and `agentChangesRow` match them.

use super::app::App;
use super::settings_page::SettingRow;
use super::widgets::{button, settings_divider, settings_row, text, LabelStyle};
use crate::linux_app::models::{
    agent_change_line, agent_change_time, AGENT_CHANGES_DETAIL, AGENT_CHANGES_TITLE,
    AUTO_JOIN_GENERAL_DETAIL, AUTO_JOIN_GENERAL_JOINED_DETAIL, AUTO_JOIN_GENERAL_TITLE,
    AUTO_JOIN_GENERAL_TURN_OFF_HELP, AUTO_JOIN_GENERAL_TURN_ON_HELP,
};
use crate::relay::contract::agents::SettingsChange;
use gtk::prelude::*;
use gtk4 as gtk;

/// How many of the agents' changes Settings lists.
const CHANGES_SHOWN: usize = 5;

impl App {
    /// The rows for how agents hear from the relay, each once the core
    /// reports its setting: relay messages in chats, joining #general, and
    /// the settings agents changed.
    pub(super) fn append_agent_relay_rows(&self, group: &gtk::Box) {
        self.append_mobile_claude_handoff_row(group);
        self.append_show_relay_messages_row(group);
        self.append_auto_join_general_row(group);
        self.append_agent_changes_row(group);
    }

    /// Whether agents put on the relay from now on join #general. A failure
    /// shows in the pane's banner, as for the other store settings.
    fn append_auto_join_general_row(&self, group: &gtk::Box) {
        let Some(enabled) = self.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.auto_join_general)
        }) else {
            return;
        };
        let set = |enabled: bool| {
            self.on(move |app| {
                app.set_setting(
                    SettingsChange {
                        auto_join_general: Some(enabled),
                        ..SettingsChange::default()
                    },
                    SettingRow::Pane,
                )
            })
        };
        let accessory = if enabled {
            let off = button("Turn Off", &[], set(false));
            off.set_tooltip_text(Some(AUTO_JOIN_GENERAL_TURN_OFF_HELP));
            off
        } else {
            let on = button("Turn On", &[], set(true));
            on.set_tooltip_text(Some(AUTO_JOIN_GENERAL_TURN_ON_HELP));
            on
        };
        settings_divider(group, 62);
        group.append(
            &settings_row(
                AUTO_JOIN_GENERAL_TITLE,
                if enabled {
                    AUTO_JOIN_GENERAL_JOINED_DETAIL
                } else {
                    AUTO_JOIN_GENERAL_DETAIL
                },
                if enabled {
                    "emblem-ok-symbolic"
                } else {
                    "mail-send-symbolic"
                },
                Some(accessory.upcast_ref()),
                &[],
            )
            .0,
        );
    }

    /// The latest settings agents changed, newest first; nothing until one
    /// has.
    fn append_agent_changes_row(&self, group: &gtk::Box) {
        let changes = self.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.agent_changes.clone())
                .unwrap_or_default()
        });
        if changes.is_empty() {
            return;
        }
        let lines: Vec<gtk::Widget> = changes
            .iter()
            .take(CHANGES_SHOWN)
            .map(|change| {
                let line = match agent_change_time(change, &chrono::Local) {
                    Some(time) => format!("{} · {time}", agent_change_line(change)),
                    None => agent_change_line(change),
                };
                text(&line, &["settings-row-detail"]).wrapped().upcast()
            })
            .collect();
        settings_divider(group, 62);
        group.append(
            &settings_row(
                AGENT_CHANGES_TITLE,
                AGENT_CHANGES_DETAIL,
                "document-edit-symbolic",
                None,
                &lines,
            )
            .0,
        );
    }
}
