//! Settings → Relay rows for how relay messages reach agents: Devin's
//! lifecycle hooks and `show_relay_messages`, which shows relay messages in
//! agent chats (hidden unless turned on). The Mac's `devinDeliveryRow` and
//! `showRelayMessagesRow` match them.

use super::app::App;
use super::settings_page::SettingRow;
use super::widgets::{button, notice, settings_divider, settings_row, Tone};
use crate::linux_app::models::{
    SHOW_RELAY_MESSAGES_DETAIL, SHOW_RELAY_MESSAGES_SHOWN_DETAIL, SHOW_RELAY_MESSAGES_TITLE,
    SHOW_RELAY_MESSAGES_TURN_OFF_HELP, SHOW_RELAY_MESSAGES_TURN_ON_HELP,
};
use crate::relay::contract::agents::SettingsChange;
use gtk::prelude::*;
use gtk4 as gtk;

impl App {
    /// Agent Relay's Devin lifecycle hooks. A Devin session has no port to
    /// write into; with the hooks in its config.json, a staged message
    /// reaches the conversation at each hook boundary.
    pub(super) fn devin_delivery_row(&self) -> gtk::Box {
        let (enabled, error) = self.with_state(|state| {
            (
                state
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.devin_direct_delivery)
                    == Some(true),
                state.devin_delivery_error.clone(),
            )
        });
        let set = |enabled: bool| {
            self.on(move |app| {
                app.set_setting(
                    SettingsChange {
                        devin_direct_delivery: Some(enabled),
                        ..SettingsChange::default()
                    },
                    SettingRow::DevinDelivery,
                )
            })
        };
        let (detail, accessory) = if enabled {
            let off = button("Turn Off", &[], set(false));
            off.set_tooltip_text(Some("Remove Agent Relay's hooks from Devin"));
            ("Agent Relay's hooks are in ~/.config/devin/config.json. Messages reach a Devin session mid-turn and when its turn ends. Start Devin sessions that were open before it was on again.", off)
        } else {
            let on = button("Turn On", &[], set(true));
            on.set_tooltip_text(Some("Add Agent Relay's hooks to Devin"));
            ("A Devin session has no way in: messages wait in its inbox, unheard. Turn this on to add Agent Relay's hooks to Devin's config.json, so sessions you open in Devin appear here and can be messaged, the way Claude Code and Codex sessions are.", on)
        };
        let extra: Vec<gtk::Widget> = error
            .iter()
            .map(|error| notice(error, Tone::Error))
            .collect();
        settings_row(
            "Devin sessions",
            detail,
            if enabled {
                "emblem-ok-symbolic"
            } else {
                "network-transmit-receive-symbolic"
            },
            Some(accessory.upcast_ref()),
            &extra,
        )
        .0
    }

    /// The show relay messages row, once the core reports the setting. A
    /// failure shows in the pane's banner, as for the other store setting.
    pub(super) fn append_show_relay_messages_row(&self, group: &gtk::Box) {
        let Some(enabled) = self.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.show_relay_messages)
        }) else {
            return;
        };
        let set = |enabled: bool| {
            self.on(move |app| {
                app.set_setting(
                    SettingsChange {
                        show_relay_messages: Some(enabled),
                        ..SettingsChange::default()
                    },
                    SettingRow::Pane,
                )
            })
        };
        let accessory = if enabled {
            let off = button("Turn Off", &[], set(false));
            off.set_tooltip_text(Some(SHOW_RELAY_MESSAGES_TURN_OFF_HELP));
            off
        } else {
            let on = button("Turn On", &[], set(true));
            on.set_tooltip_text(Some(SHOW_RELAY_MESSAGES_TURN_ON_HELP));
            on
        };
        settings_divider(group, 62);
        group.append(
            &settings_row(
                SHOW_RELAY_MESSAGES_TITLE,
                if enabled {
                    SHOW_RELAY_MESSAGES_SHOWN_DETAIL
                } else {
                    SHOW_RELAY_MESSAGES_DETAIL
                },
                if enabled {
                    "emblem-ok-symbolic"
                } else {
                    "format-justify-left-symbolic"
                },
                Some(accessory.upcast_ref()),
                &[],
            )
            .0,
        );
    }
}
