//! Settings rows for the person's always-on agents behind a local gateway:
//! OpenClaw (with Agent Relay's tools for its agents), Hermes, and the
//! relay senders trusted to reach them.
use super::*;
use crate::linux_app::models::{
    openclaw_unlimited_notice, trusted_senders, HERMES_OFF, HERMES_ON, HERMES_TITLE,
    HERMES_TURN_OFF_HELP, HERMES_TURN_ON_HELP, OPENCLAW_OFF, OPENCLAW_ON, OPENCLAW_TITLE,
    OPENCLAW_TURN_OFF_HELP, OPENCLAW_TURN_ON_HELP, TRUSTED_SENDERS_DETAIL,
    TRUSTED_SENDERS_PLACEHOLDER, TRUSTED_SENDERS_TITLE,
};

mod openclaw_tools;

impl App {
    /// OpenClaw's and Hermes's rows, each while its agent is set up (with
    /// Agent Relay's tools under OpenClaw's while it is on), then the
    /// trusted senders while either is on.
    pub(super) fn append_gateway_rows(&self, group: &gtk::Box) {
        let (openclaw, hermes) = self.with_state(|state| {
            let settings = state.settings.as_ref();
            (
                settings.and_then(|settings| settings.openclaw_gateway),
                settings.is_some_and(|settings| settings.hermes_agent.is_some()),
            )
        });
        if openclaw.is_some() {
            settings_divider(group, 62);
            group.append(&self.openclaw_row());
        }
        if openclaw == Some(true) {
            settings_divider(group, 62);
            group.append(&self.openclaw_tools_row());
        }
        if hermes {
            settings_divider(group, 62);
            group.append(&self.hermes_row());
        }
        if let Some(row) = self.trusted_senders_row() {
            settings_divider(group, 62);
            group.append(&row);
        }
    }

    /// The agents of the person's OpenClaw Gateway. Agent Relay connects to
    /// it on this computer; each relay sender gets a session of its own on
    /// the agent, and its answer goes back to the sender only.
    fn openclaw_row(&self) -> gtk::Box {
        let (enabled, unlimited, error) = self.with_state(|state| {
            let settings = state.settings.as_ref();
            (
                settings.and_then(|settings| settings.openclaw_gateway) == Some(true),
                settings.and_then(|settings| settings.openclaw_unlimited_version.clone()),
                state.openclaw.error.clone(),
            )
        });
        let set = |enabled: bool| {
            self.on(move |app| {
                app.set_setting(
                    SettingsChange {
                        openclaw_gateway: Some(enabled),
                        ..SettingsChange::default()
                    },
                    SettingRow::OpenClaw,
                )
            })
        };
        let (detail, accessory) = if enabled {
            let off = button("Turn Off", &[], set(false));
            off.set_tooltip_text(Some(OPENCLAW_TURN_OFF_HELP));
            (OPENCLAW_ON, off)
        } else {
            let on = button("Turn On", &[], set(true));
            on.set_tooltip_text(Some(OPENCLAW_TURN_ON_HELP));
            (OPENCLAW_OFF, on)
        };
        // A Gateway older than 2026.8.1 cannot make relay sessions
        // answer-only: said while it is on.
        let unlimited = unlimited
            .filter(|_| enabled)
            .map(|version| notice(&openclaw_unlimited_notice(&version), Tone::Warn));
        let extra: Vec<gtk::Widget> = unlimited
            .into_iter()
            .chain(error.iter().map(|error| notice(error, Tone::Error)))
            .collect();
        settings_row(
            OPENCLAW_TITLE,
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

    /// The relay senders trusted like the person: their messages reach the
    /// person's own OpenClaw and Hermes instead of an answer-only session.
    /// Shown while either is on.
    fn trusted_senders_row(&self) -> Option<gtk::Box> {
        let (saved, error) = self.with_state(|state| {
            let settings = state.settings.as_ref();
            (
                settings
                    .filter(|settings| {
                        settings.openclaw_gateway == Some(true)
                            || settings.hermes_agent == Some(true)
                    })
                    .and_then(|settings| settings.trusted_relay_senders.clone()),
                state.trusted_senders_error.clone(),
            )
        });
        let saved = saved?;
        let entry = gtk::Entry::new();
        entry.set_widget_name("openclaw-trusted-senders");
        entry.set_placeholder_text(Some(TRUSTED_SENDERS_PLACEHOLDER));
        entry.set_text(&saved.join(", "));
        entry.set_hexpand(true);
        let save = {
            let entry = entry.clone();
            let weak = self.downgrade();
            move || {
                if let Some(app) = weak.upgrade() {
                    app.set_setting(
                        SettingsChange {
                            trusted_relay_senders: Some(trusted_senders(&entry.text())),
                            ..SettingsChange::default()
                        },
                        SettingRow::TrustedSenders,
                    );
                }
            }
        };
        let button = button("Save", &[], {
            let save = save.clone();
            move || save()
        });
        entry.connect_activate(move |_| save());
        let mut extra: Vec<gtk::Widget> = vec![entry.upcast()];
        extra.extend(
            error
                .iter()
                .map(|error| notice(error, Tone::Error).upcast::<gtk::Widget>()),
        );
        Some(
            settings_row(
                TRUSTED_SENDERS_TITLE,
                TRUSTED_SENDERS_DETAIL,
                "security-high-symbolic",
                Some(button.upcast_ref()),
                &extra,
            )
            .0,
        )
    }

    /// The person's Hermes, through its loopback API server. Each relay
    /// sender gets a Hermes session of its own; only the final answer goes
    /// back to the sender.
    fn hermes_row(&self) -> gtk::Box {
        let (enabled, error) = self.with_state(|state| {
            (
                state
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.hermes_agent)
                    == Some(true),
                state.hermes_error.clone(),
            )
        });
        let set = |enabled: bool| {
            self.on(move |app| {
                app.set_setting(
                    SettingsChange {
                        hermes_agent: Some(enabled),
                        ..SettingsChange::default()
                    },
                    SettingRow::Hermes,
                )
            })
        };
        let (detail, accessory) = if enabled {
            let off = button("Turn Off", &[], set(false));
            off.set_tooltip_text(Some(HERMES_TURN_OFF_HELP));
            (HERMES_ON, off)
        } else {
            let on = button("Turn On", &[], set(true));
            on.set_tooltip_text(Some(HERMES_TURN_ON_HELP));
            (HERMES_OFF, on)
        };
        let extra: Vec<gtk::Widget> = error
            .iter()
            .map(|error| notice(error, Tone::Error))
            .collect();
        settings_row(
            HERMES_TITLE,
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
}
