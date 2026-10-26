//! Settings grouped by task: Preferences, Sessions, and Account & app.
//! Updates, diagnostic reports, and session data each have one home.

mod notices;
mod pending;
pub(super) use pending::{pending_toggle_row, switch_accessory};

use super::app::App;
use super::appearance_preview::mini_window;
use super::desktop::Confirmation;
use super::state::{Page, Pane, UpdateState};
use super::widgets::{
    self, avatar, button, clear, hbox, icon, notice, settings_divider, settings_row,
    settings_section, text, vbox, LabelStyle, Tone,
};
use crate::linux_app::install::InstallKind;
use crate::linux_app::models::{
    diagnostics_sections, incoming_state_label, managed_inbound_detail, DiagnosticsSection,
    SharingModeText, CLAUDE_SESSION_HOOK_OFF, CLAUDE_SESSION_HOOK_ON, CLAUDE_SESSION_HOOK_TITLE,
    CLAUDE_SESSION_HOOK_TURN_OFF_HELP, CLAUDE_SESSION_HOOK_TURN_ON_HELP, SHARING_DISPLAY_ORDER,
    WORKSPACE_FOUND_DETAIL, WORKSPACE_MISSING_DETAIL,
};
use crate::linux_app::prefs::{Appearance, SessionOpenPreference};
use crate::relay::contract::account::SharingParams;
use crate::relay::contract::agents::SettingsChange;
use crate::relay::contract::incoming::{HeldMessageParams, IncomingThread, ShareParams};
use crate::relay::contract::platform::LoginItemParams;
use crate::relay::contract::{method, NoParams};
use crate::relay::outbox::Mode;
use crate::relay::store::SessionKind;
use crate::relay::telemetry::{TelemetryFailure, TelemetryOperation, TelemetryOutcome};
use crate::relay::uploader::SharingMode;
use gtk::{gio, glib, prelude::*};
use gtk4 as gtk;
use std::path::PathBuf;
use std::time::Duration;

/// The uploader runs one change at a time; the Mac's `perform` refuses
/// a second with this sentence.
pub(super) const UPLOADER_BUSY: &str =
    "Another upload change is still running. Try again in a moment.";

/// The settings pane's scrolling column.
pub struct SettingsPage {
    pub scroller: gtk::ScrolledWindow,
    pub column: gtk::Box,
    holder: widgets::Column,
}

impl SettingsPage {
    pub fn build() -> SettingsPage {
        let (column, holder) = widgets::column(776);
        column.set_spacing(28);
        widgets::pad(&column, 28, None, None);
        column.add_css_class("settings-content");
        SettingsPage {
            scroller: widgets::scrolled(&holder),
            holder,
            column,
        }
    }
}

/// Which row reports a setting's failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingRow {
    DirectDelivery,
    GrokLeader,
    OpenCodePlugin,
    OpenClaw,
    TrustedSenders,
    Hermes,
    DevinDelivery,
    ClaudeFolders,
    ClaudeSessionHook,
    /// The pane's own banner.
    Pane,
}

/// A switch row: `on` gets each change the person makes.
pub(super) fn toggle_row(
    title: &str,
    detail: &str,
    icon_name: &str,
    active: bool,
    sensitive: bool,
    on: impl Fn(bool) + 'static,
) -> gtk::Box {
    pending_toggle_row(title, detail, icon_name, active, sensitive, false, on)
}

/// `Windows 10.0.26100 (aarch64)`: the system as diagnostics name it.
#[cfg(windows)]
fn platform() -> String {
    use crate::linux_app::install::windows::registry::{self, Root};
    const KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let major = registry::read_dword(Root::LocalMachine, KEY, "CurrentMajorVersionNumber");
    let minor = registry::read_dword(Root::LocalMachine, KEY, "CurrentMinorVersionNumber");
    let build = registry::read_string(Root::LocalMachine, KEY, "CurrentBuild");
    match (major, minor, build) {
        (Some(major), Some(minor), Some(build)) => format!(
            "Windows {major}.{minor}.{build} ({})",
            std::env::consts::ARCH
        ),
        _ => format!("Windows ({})", std::env::consts::ARCH),
    }
}

/// `Linux 6.8.0 (x86_64)`: the system as diagnostics name it.
#[cfg(not(windows))]
fn platform() -> String {
    // SAFETY: `uname` fills the zeroed struct it is given.
    let mut names: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut names) } != 0 {
        return std::env::consts::OS.to_string();
    }
    let field = |value: &[libc::c_char]| {
        let bytes: Vec<u8> = value
            .iter()
            .take_while(|byte| **byte != 0)
            .map(|byte| *byte as u8)
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    format!(
        "{} {} ({})",
        field(&names.sysname),
        field(&names.release),
        field(&names.machine)
    )
}

impl App {
    /// Draws the Settings pane shown.
    pub fn render_settings(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let Page::Settings(pane) = self.page() else {
            return;
        };
        if !self.with_state(|state| state.connected()) {
            return;
        }
        let adjustment = shell.settings.scroller.vadjustment();
        let position = adjustment.value();
        let column = &shell.settings.column;
        shell
            .settings
            .holder
            .set_max_width(if pane == Pane::Diagnostics {
                i32::MAX
            } else {
                776
            });
        clear(column);
        self.inner.updating.set(true);
        match pane {
            Pane::General => self.general_pane(column),
            Pane::Opening => self.session_opening_pane(column),
            Pane::About => self.about_pane(column),
            Pane::Relay => self.relay_pane(column),
            Pane::Sharing => {
                self.sharing_pane(column);
            }
            Pane::Diagnostics => self.diagnostics_pane(column),
            Pane::Account => self.account_pane(column),
        }
        self.inner.updating.set(false);
        if let Some(error) = self.with_state(|state| state.settings_error.clone()) {
            let banner = hbox(8, &["banner", "banner-warn"]);
            banner.append(&text(&error, &["error"]).wrapped());
            column.append(&banner);
        }
        let target = self.update_state(|state| {
            let jump = state.request_scroll;
            state.request_scroll = false;
            jump.then(|| {
                state
                    .selected_request
                    .as_ref()
                    .map(|entry| entry.id.clone())
            })
            .flatten()
        });
        if let Some(target) = target {
            // An idle callback runs before GTK allocates newly expanded rows.
            // Wait for their layout, then scroll using the actual row bounds.
            let frames = std::cell::Cell::new(0);
            column.add_tick_callback(move |column, _| {
                frames.set(frames.get() + 1);
                let mut child = column.first_child();
                while let Some(widget) = child {
                    if widget.widget_name().as_str() == target && widget.height() > 0 {
                        if let Some(bounds) = widget.compute_bounds(column) {
                            adjustment.set_value(bounds.y() as f64);
                            return glib::ControlFlow::Break;
                        }
                    }
                    child = widget.next_sibling();
                }
                if frames.get() > 10 {
                    glib::ControlFlow::Break
                } else {
                    glib::ControlFlow::Continue
                }
            });
        } else {
            glib::idle_add_local_once(move || adjustment.set_value(position));
        }
    }

    // General.

    fn session_opening_pane(&self, column: &gtk::Box) {
        let (section, group) = settings_section("Open local sessions", Some("Automatic opens the desktop app when installed, otherwise Terminal. These preferences apply only to this computer."));
        for (source, title) in [("claude", "Claude Code"), ("codex", "Codex")] {
            let choice = gtk::DropDown::from_strings(&["Automatic", "Terminal"]);
            choice.set_selected(
                if self.prefs().session_opening(source) == SessionOpenPreference::Terminal {
                    1
                } else {
                    0
                },
            );
            widgets::name(&choice, &format!("Open {title} sessions"));
            choice.set_widget_name(&format!("session-opening-{source}"));
            let weak = self.downgrade();
            choice.connect_selected_notify(move |choice| {
                if let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) {
                    let preference = if choice.selected() == 1 {
                        SessionOpenPreference::Terminal
                    } else {
                        SessionOpenPreference::Automatic
                    };
                    let result = app
                        .inner
                        .prefs
                        .borrow_mut()
                        .set_session_opening(source, preference);
                    if let Err(error) = result {
                        app.update_state(|state| state.settings_error = Some(error.to_string()));
                        app.render_settings();
                    }
                }
            });
            let detail = if source == "claude" {
                "Claude Desktop handoff isn’t supported on Linux. Sessions open in Terminal."
            } else if self.inner.desktop.has_uri_handler("codex") {
                "Codex is installed"
            } else {
                "Codex isn’t installed. Sessions open in Terminal."
            };
            group.append(
                &settings_row(
                    title,
                    detail,
                    "utilities-terminal-symbolic",
                    Some(choice.upcast_ref()),
                    &[],
                )
                .0,
            );
        }
        group.append(&settings_row("Grok", "Terminal", "utilities-terminal-symbolic", None, &[]).0);
        column.append(&section);
        let requirements = gtk::Expander::new(Some("Requirements & troubleshooting"));
        let detail = vbox(12, &[]);
        detail.set_margin_top(12);
        detail.append(&text("Terminal resume requires the matching CLI and the session’s original folder. Historical sessions don’t reliably record whether they were used in a terminal or desktop app.", &["settings-row-detail"]).wrapped());
        detail.append(&button(
            "Set up Claude Code",
            &[],
            self.on(|app| app.open_url("https://code.claude.com/docs/en/quickstart")),
        ));
        requirements.set_expanded(self.with_state(|state| state.opening_requirements_open));
        let weak = self.downgrade();
        requirements.connect_expanded_notify(move |expander| {
            if let Some(app) = weak.upgrade() {
                app.update_state(|state| state.opening_requirements_open = expander.is_expanded());
            }
        });
        requirements.set_child(Some(&detail));
        column.append(&requirements);
        let check = button(
            "Check installed apps",
            &[],
            self.on(|app| app.render_settings()),
        );
        check.set_halign(gtk::Align::Start);
        column.append(&check);
    }

    // Appearance.

    fn appearance_section(&self, column: &gtk::Box) {
        let (section, group) = settings_section(
            "Appearance",
            Some("Match system follows your desktop's light and dark setting."),
        );
        let options = hbox(12, &[]);
        widgets::pad(&options, 16, None, None);
        options.set_homogeneous(true);
        let chosen = self.prefs().appearance();
        for (choice, title, icon_name) in [
            (
                Appearance::System,
                "Match system",
                "weather-few-clouds-symbolic",
            ),
            (Appearance::Light, "Light", "weather-clear-symbolic"),
            (Appearance::Dark, "Dark", "weather-clear-night-symbolic"),
        ] {
            let selected = chosen == choice;
            let option = gtk::Button::new();
            crate::linux_app::ui::widgets::action_cursor(&option);
            widgets::add_classes(
                &option,
                &["appearance-option", if selected { "selected" } else { "" }],
            );
            let content = vbox(10, &[]);
            if choice == Appearance::System {
                let preview = hbox(0, &[]);
                preview.set_homogeneous(true);
                preview.append(&mini_window(false));
                preview.append(&mini_window(true));
                content.append(&preview);
            } else {
                content.append(&mini_window(choice == Appearance::Dark));
            }
            let caption = hbox(6, &[]);
            caption.set_halign(gtk::Align::Center);
            let glyph = icon(
                if selected {
                    "emblem-ok-symbolic"
                } else {
                    icon_name
                },
                14,
            );
            glyph.add_css_class(if selected { "accent" } else { "secondary" });
            caption.append(&glyph);
            caption.append(&text(
                title,
                &[if selected { "settings-row-title" } else { "" }],
            ));
            content.append(&caption);
            option.set_child(Some(&content));
            widgets::name(&option, title);
            let choose = self.on(move |app| app.set_appearance(choice));
            option.connect_clicked(move |_| choose());
            options.append(&option);
        }
        group.append(&options);
        column.append(&section);
    }

    pub fn set_appearance(&self, choice: Appearance) {
        // A preference that cannot be saved holds for this run.
        let _ = self.inner.prefs.borrow_mut().set_appearance(choice);
        self.inner.styling.set(choice);
        self.render_settings();
    }

    // Software updates.

    fn about_pane(&self, column: &gtk::Box) {
        let (section, group) = settings_section(
            "Software updates",
            Some("Check for new Agent Relay releases."),
        );
        let version = crate::VERSION;
        let (state, release, message, checked, kind) = self.with_state(|state| {
            (
                state.update_state,
                state.update_release.clone(),
                state.update_message.clone(),
                state.update_checked.clone(),
                state.install_kind,
            )
        });
        let headline = match state {
            UpdateState::Idle => "Agent Relay".into(),
            UpdateState::Checking => "Checking for updates…".into(),
            UpdateState::UpToDate => "Agent Relay is up to date".into(),
            UpdateState::Unavailable => "Updates unavailable".into(),
            UpdateState::Failed => "Update failed".into(),
            UpdateState::Available | UpdateState::Downloading | UpdateState::Installing => {
                match &release {
                    Some(release) => format!("Agent Relay {} is available", release.version),
                    None => "Update available".into(),
                }
            }
        };
        let detail = match state {
            UpdateState::Idle => format!("You’re running version {version}."),
            UpdateState::Checking => "Looking for the latest stable release.".into(),
            UpdateState::UpToDate => format!(
                "Version {version} is the latest release. Checked {}.",
                checked.as_deref().unwrap_or("just now")
            ),
            UpdateState::Available => update_detail(kind).into(),
            UpdateState::Downloading => "Downloading and verifying the update…".into(),
            UpdateState::Installing => {
                "Installing the update. Agent Relay will reopen when it finishes.".into()
            }
            UpdateState::Unavailable | UpdateState::Failed => message.unwrap_or_default(),
        };
        let action_title = match state {
            UpdateState::Available => "Update",
            UpdateState::Downloading => "Downloading…",
            UpdateState::Installing => "Installing…",
            UpdateState::Checking => "Checking…",
            _ => "Check now",
        };
        let accessory = hbox(8, &[]);
        if state.busy() {
            let spinner = gtk::Spinner::new();
            spinner.start();
            accessory.append(&spinner);
        }
        let action = button(
            action_title,
            if state == UpdateState::Available {
                &["primary"]
            } else {
                &[]
            },
            self.on(App::update_action),
        );
        action.set_sensitive(!state.busy());
        accessory.append(&action);
        let icon_name = match state {
            UpdateState::UpToDate => "emblem-ok-symbolic",
            UpdateState::Available | UpdateState::Downloading => {
                "software-update-available-symbolic"
            }
            UpdateState::Failed => "dialog-warning-symbolic",
            _ => "view-refresh-symbolic",
        };
        let (row, words) =
            settings_row(&headline, "", icon_name, Some(accessory.upcast_ref()), &[]);
        words.append(
            &text(
                &detail,
                &[if state == UpdateState::Failed {
                    "error"
                } else {
                    "settings-row-detail"
                }],
            )
            .wrapped(),
        );
        group.append(&row);
        settings_divider(&group, 62);
        let weak = self.downgrade();
        group.append(&toggle_row(
            "Automatically check for updates",
            "Check once a day while Agent Relay is running. You choose when to install an available update.",
            "alarm-symbolic",
            self.prefs().automatically_checks_for_updates(),
            true,
            move |enabled| {
                if let Some(app) = weak.upgrade() {
                    app.set_auto_update(enabled);
                }
            },
        ));
        column.append(&section);
    }

    pub fn set_auto_update(&self, enabled: bool) {
        if !self.inner.updating.get() {
            let _ = self
                .inner
                .prefs
                .borrow_mut()
                .set_automatically_checks_for_updates(enabled);
        }
    }

    /// About's allowlisted diagnostics.
    pub fn diagnostics(&self) -> Vec<DiagnosticsSection> {
        self.with_state(|state| {
            diagnostics_sections(
                state.snapshot.as_ref(),
                state.core_connected,
                crate::VERSION,
                &platform(),
                state
                    .service_state
                    .map_or("Unknown", |service| service.label()),
                state.status.as_ref().map(|status| status.headline.as_str()),
                &chrono::Local,
            )
        })
    }

    fn diagnostics_view(&self) -> gtk::Box {
        let outer = vbox(20, &[]);
        let top = hbox(12, &[]);
        let words = vbox(5, &[]);
        words.set_hexpand(true);
        words.append(&text("Diagnostic report", &["settings-section-title"]));
        words.append(&text(
            "Build, connection and workspace details.",
            &["secondary"],
        ));
        top.append(&words);
        let copy = gtk::Button::with_label("Copy diagnostics");
        crate::linux_app::ui::widgets::action_cursor(&copy);
        let weak = self.downgrade();
        copy.connect_clicked(move |copy| {
            let Some(app) = weak.upgrade() else {
                return;
            };
            widgets::copy_to_clipboard(&crate::linux_app::models::diagnostics_report(
                &app.diagnostics(),
            ));
            copy.set_label("Copied");
            let copy = copy.downgrade();
            glib::timeout_add_local_once(Duration::from_secs(2), move || {
                if let Some(copy) = copy.upgrade() {
                    copy.set_label("Copy diagnostics");
                }
            });
        });
        copy.set_valign(gtk::Align::Center);
        top.append(&copy);
        outer.append(&top);
        if !self.with_state(|state| state.core_connected) {
            outer.append(&notice(
                "Service offline. Build and workspace details below are from the last received snapshot.",
                Tone::Warn,
            ));
        }
        for section in self.diagnostics() {
            let card = vbox(12, &["card"]);

            for (label, value) in section.rows {
                let line = hbox(24, &[]);
                line.append(&text(label, &["secondary", "caption"]));
                line.append(&widgets::spacer());
                let value = text(&value, &["caption"]).wrapped().copyable();
                value.set_xalign(1.0);
                line.append(&value);
                card.append(&line);
            }
            let disclosure = gtk::Expander::new(Some(section.title));
            disclosure.set_expanded(
                self.with_state(|state| state.settings_details_open.contains(section.title)),
            );
            let weak = self.downgrade();
            let title = section.title.to_owned();
            disclosure.connect_expanded_notify(move |expander| {
                if let Some(app) = weak.upgrade() {
                    app.update_state(|state| {
                        if expander.is_expanded() {
                            state.settings_details_open.insert(title.clone());
                        } else {
                            state.settings_details_open.remove(&title);
                        }
                    });
                }
            });
            disclosure.set_child(Some(&card));
            disclosure.add_css_class("diagnostic-disclosure");
            outer.append(&disclosure);
        }
        outer.append(
            &text(
                "Includes workspace and account IDs. No credentials, session content, or logs are copied.",
                &["caption"],
            )
            .wrapped(),
        );
        outer
    }

    // Messages.

    fn relay_pane(&self, column: &gtk::Box) {
        let (connected, claude, claude_hook, grok, opencode, devin, allow) =
            self.with_state(|state| {
                (
                    state.connected(),
                    state
                        .local_sessions
                        .iter()
                        .any(|session| session.target.kind == SessionKind::ClaudeTerminal),
                    state
                        .settings
                        .as_ref()
                        .is_some_and(|settings| settings.claude_session_hook.is_some()),
                    state
                        .settings
                        .as_ref()
                        .is_some_and(|settings| settings.grok_leader.is_some()),
                    state
                        .settings
                        .as_ref()
                        .is_some_and(|settings| settings.opencode_plugin.is_some()),
                    state
                        .settings
                        .as_ref()
                        .is_some_and(|settings| settings.devin_direct_delivery.is_some()),
                    state
                        .settings
                        .as_ref()
                        .is_none_or(|settings| settings.allow_self_registration),
                )
            });
        if connected {
            let (section, group) = settings_section(
                "Relay",
                Some("Sessions you put on the relay get a name anyone in this workspace can message."),
            );
            group.append(&self.workspace_row());
            if claude {
                settings_divider(&group, 62);
                group.append(&self.claude_delivery_row());
            }
            if claude_hook {
                settings_divider(&group, 62);
                group.append(&self.claude_session_hook_row());
            }
            if grok {
                settings_divider(&group, 62);
                group.append(&self.grok_leader_row());
            }
            if opencode {
                settings_divider(&group, 62);
                group.append(&self.opencode_plugin_row());
            }
            self.append_gateway_rows(&group);
            if devin {
                settings_divider(&group, 62);
                group.append(&self.devin_delivery_row());
            }
            self.append_agent_relay_rows(&group);
            column.append(&section);
        }
        let (section, group) = settings_section("Joining the relay", None);
        let weak = self.downgrade();
        group.append(&pending_toggle_row(
            "Let sessions put themselves on the relay",
            "Allow a supported local agent session to register only itself through the private desktop socket.",
            "contact-new-symbolic",
            allow,
            true,
            self.with_state(|state| state.setting_pending("allow_self_registration")),
            move |enabled| {
                if let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) {
                    app.set_setting(
                        SettingsChange {
                            allow_self_registration: Some(enabled),
                            ..SettingsChange::default()
                        },
                        SettingRow::Pane,
                    );
                }
            },
        ));
        column.append(&section);
        if let Some(section) = self.spawn_section() {
            column.append(&section);
        }
        if let Some(section) = self.claude_folders_section() {
            column.append(&section);
        }
        if connected {
            column.append(&self.claude_delivery_section());
            column.append(&self.incoming_section());
        }
    }

    fn workspace_row(&self) -> gtk::Box {
        let (found, agents, connect_error, connecting, account_workspace) =
            self.with_state(|state| {
                (
                    state.has_workspace(),
                    state
                        .snapshot
                        .as_ref()
                        .map(|snapshot| snapshot.agents.clone()),
                    state.workspace_connect_error.clone(),
                    state.connecting_workspace(),
                    state.account().workspace_id.is_some(),
                )
            });
        let mut extra = notices::workspace_notices(agents.unwrap_or_default(), connect_error);
        if connecting || !found {
            let actions = hbox(8, &[]);
            actions.set_margin_top(4);
            if connecting {
                let spinner = gtk::Spinner::new();
                spinner.start();
                actions.append(&spinner);
                actions.append(&button(
                    "Cancel",
                    &[],
                    self.on(App::cancel_connect_workspace),
                ));
            } else {
                let connect = button("Connect Workspace", &[], self.on(App::connect_workspace));
                connect.set_tooltip_text(Some(
                    "Fetch this workspace's relay key with your Agent Relay sign-in",
                ));
                connect.set_sensitive(account_workspace);
                actions.append(&connect);
            }
            extra.push(actions.upcast());
        }
        settings_row(
            if found {
                "Workspace from your Agent Relay account"
            } else {
                "No relay workspace"
            },
            if found {
                WORKSPACE_FOUND_DETAIL
            } else {
                WORKSPACE_MISSING_DETAIL
            },
            if found {
                "network-wireless-symbolic"
            } else {
                "network-wireless-offline-symbolic"
            },
            None,
            &extra,
        )
        .0
    }

    fn claude_delivery_row(&self) -> gtk::Box {
        let (direct, managed, error) = self.with_state(|state| {
            let settings = state.settings.as_ref();
            (
                settings.and_then(|settings| settings.direct_delivery) == Some(true),
                settings.and_then(|settings| settings.direct_delivery_managed.clone()),
                state.inbound_error.clone(),
            )
        });
        let is_managed = managed
            .as_deref()
            .is_some_and(|managed| managed != "accept");
        let detail = if direct {
            "Relayed messages arrive directly: crossSessionInbound is accept in your Claude settings.".to_string()
        } else if let Some(managed) = managed.as_deref().filter(|_| is_managed) {
            managed_inbound_detail(managed)
        } else {
            "Sessions that skip permission prompts hold relayed messages for your approval. Deliver directly to let them arrive the way Codex messages do.".to_string()
        };
        let accessory: Option<gtk::Widget> = if direct && managed.is_none() {
            let ask = button(
                "Ask Again",
                &[],
                self.on(|app| {
                    app.set_setting(
                        SettingsChange {
                            direct_delivery: Some(false),
                            ..SettingsChange::default()
                        },
                        SettingRow::DirectDelivery,
                    )
                }),
            );
            ask.set_tooltip_text(Some(
                "Set crossSessionInbound to hold in your Claude settings",
            ));
            Some(ask.upcast())
        } else if !direct && !is_managed {
            Some(
                button(
                    "Deliver Directly…",
                    &[],
                    self.on(App::confirm_direct_delivery),
                )
                .upcast(),
            )
        } else {
            None
        };
        let extra: Vec<gtk::Widget> = error
            .iter()
            .map(|error| notice(error, Tone::Error))
            .collect();
        settings_row(
            "Claude Code delivery",
            &detail,
            if direct {
                "emblem-ok-symbolic"
            } else {
                "dialog-question-symbolic"
            },
            accessory.as_ref(),
            &extra,
        )
        .0
    }

    pub fn confirm_direct_delivery(&self) {
        let answer = self.confirm(Confirmation::new(
            "Deliver relayed messages to Claude Code without asking?",
            "This adds \"crossSessionInbound\": \"accept\" to ~/.claude/settings.json. Every local Claude Code session will then show messages from other sessions and programs, including Agent Relay, without holding them for approval. Claude Code still labels them and never lets them change permissions. Your current file is kept as settings.json.relay-desktop-backup.",
            "Deliver directly",
        ));
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            if let (true, Some(app)) = (answer.await, weak.upgrade()) {
                app.set_setting(
                    SettingsChange {
                        direct_delivery: Some(true),
                        ..SettingsChange::default()
                    },
                    SettingRow::DirectDelivery,
                );
            }
        });
    }

    /// Grok's `[cli] use_leader`. A plain Grok session opens no route in;
    /// one on the shared leader can be listed and messaged like a Claude
    /// Code or Codex session.
    fn grok_leader_row(&self) -> gtk::Box {
        let (enabled, error) = self.with_state(|state| {
            (
                state
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.grok_leader)
                    == Some(true),
                state.grok_leader_error.clone(),
            )
        });
        let (detail, accessory) = if enabled {
            let off = button(
                "Turn Off",
                &[],
                self.on(|app| {
                    app.set_setting(
                        SettingsChange {
                            grok_leader: Some(false),
                            ..SettingsChange::default()
                        },
                        SettingRow::GrokLeader,
                    )
                }),
            );
            off.set_tooltip_text(Some("Set use_leader = false in your Grok config"));
            ("Grok runs its sessions on a shared leader: use_leader is true in your Grok config. Sessions you open in Grok appear here and can be messaged.", off)
        } else {
            ("A plain Grok session has no way in. Turn on leader mode so sessions you open in Grok appear here and can be messaged, the way Claude Code and Codex sessions are.",
             button("Turn On Leader Mode…", &[], self.on(App::confirm_grok_leader)))
        };
        let extra: Vec<gtk::Widget> = error
            .iter()
            .map(|error| notice(error, Tone::Error))
            .collect();
        settings_row(
            "Grok sessions",
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

    /// Agent Relay's OpenCode plugin. A plain OpenCode session opens no
    /// port; with the plugin, each OpenCode window can be listed and
    /// messaged like a Claude Code or Codex session.
    fn opencode_plugin_row(&self) -> gtk::Box {
        let (enabled, error) = self.with_state(|state| {
            (
                state
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.opencode_plugin)
                    == Some(true),
                state.opencode_plugin_error.clone(),
            )
        });
        let set = |enabled: bool| {
            self.on(move |app| {
                app.set_setting(
                    SettingsChange {
                        opencode_plugin: Some(enabled),
                        ..SettingsChange::default()
                    },
                    SettingRow::OpenCodePlugin,
                )
            })
        };
        let (detail, accessory) = if enabled {
            let off = button("Turn Off", &[], set(false));
            off.set_tooltip_text(Some("Remove Agent Relay's plugin from OpenCode"));
            ("Agent Relay's plugin is in ~/.config/opencode/plugins/agent-relay.js. OpenCode sessions you open appear here and can be messaged. Restart OpenCode windows that were open before it was on.", off)
        } else {
            let on = button("Turn On", &[], set(true));
            on.set_tooltip_text(Some("Add Agent Relay's plugin to OpenCode"));
            ("A plain OpenCode session has no way in. Turn this on to add Agent Relay's plugin, so sessions you open in OpenCode appear here and can be messaged, the way Claude Code and Codex sessions are.", on)
        };
        let extra: Vec<gtk::Widget> = error
            .iter()
            .map(|error| notice(error, Tone::Error))
            .collect();
        settings_row(
            "OpenCode sessions",
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

    /// Claude Code's SessionStart hook. Off unless turned on. It never
    /// registers a session; it tells one that is not on the relay how to
    /// POST /register.
    fn claude_session_hook_row(&self) -> gtk::Box {
        let (enabled, error) = self.with_state(|state| {
            (
                state
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.claude_session_hook)
                    == Some(true),
                state.claude_session_hook_error.clone(),
            )
        });
        let set = |enabled: bool| {
            self.on(move |app| {
                app.set_setting(
                    SettingsChange {
                        claude_session_hook: Some(enabled),
                        ..SettingsChange::default()
                    },
                    SettingRow::ClaudeSessionHook,
                )
            })
        };
        let (detail, accessory) = if enabled {
            let off = button("Turn Off", &[], set(false));
            off.set_tooltip_text(Some(CLAUDE_SESSION_HOOK_TURN_OFF_HELP));
            (CLAUDE_SESSION_HOOK_ON, off)
        } else {
            let on = button("Turn On", &[], set(true));
            on.set_tooltip_text(Some(CLAUDE_SESSION_HOOK_TURN_ON_HELP));
            (CLAUDE_SESSION_HOOK_OFF, on)
        };
        let extra: Vec<gtk::Widget> = error
            .iter()
            .map(|error| notice(error, Tone::Error))
            .collect();
        settings_row(
            CLAUDE_SESSION_HOOK_TITLE,
            detail,
            if enabled {
                "emblem-ok-symbolic"
            } else {
                "dialog-information-symbolic"
            },
            Some(accessory.upcast_ref()),
            &extra,
        )
        .0
    }

    pub fn confirm_grok_leader(&self) {
        let answer = self.confirm(Confirmation::new(
            "Run Grok sessions on a shared leader?",
            "This sets use_leader = true under [cli] in ~/.grok/config.toml. Grok sessions you open afterwards run on a shared grok agent leader process, which stays running after you close Grok and is what Agent Relay delivers through. Sessions already open are not affected until you restart them. Grok refuses leader mode when a sandbox profile is on. Your current file is kept as config.toml.relay-desktop-backup.",
            "Turn on leader mode",
        ));
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            if let (true, Some(app)) = (answer.await, weak.upgrade()) {
                app.set_setting(
                    SettingsChange {
                        grok_leader: Some(true),
                        ..SettingsChange::default()
                    },
                    SettingRow::GrokLeader,
                );
            }
        });
    }

    fn incoming_section(&self) -> gtk::Box {
        let (status, error) =
            self.with_state(|state| (state.incoming.clone(), state.incoming_error.clone()));
        let (section, group) = settings_section(
            "Incoming messages",
            status
                .as_ref()
                .map(|status| incoming_state_label(status.state)),
        );
        let body = vbox(12, &[]);
        widgets::pad(&body, 16, None, None);
        body.append(
            &text(
                "Choose which Codex threads teammates may message. Ask first holds each message for your approval.",
                &["caption"],
            )
            .wrapped(),
        );
        if let Some(error) = error.or(status.as_ref().and_then(|status| status.error.clone())) {
            body.append(&notice(&error, Tone::Error));
        }
        let (threads, held, can_approve) = status
            .map(|status| (status.threads, status.held, status.can_approve))
            .unwrap_or_default();
        for thread in &threads {
            body.append(&self.thread_row(thread));
            body.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        }
        for message in &held {
            let item = vbox(4, &[]);
            item.append(&text(
                message.sender_name.as_deref().unwrap_or("Teammate"),
                &["settings-row-title"],
            ));
            let words = text(&message.text, &[]).wrapped().copyable();
            words.set_lines(8);
            words.set_ellipsize(gtk::pango::EllipsizeMode::End);
            item.append(&words);
            let actions = hbox(8, &[]);
            let id = message.id.clone();
            let approve = button(
                "Approve",
                &["primary"],
                self.on(move |app| app.decide_held(&id, true)),
            );
            approve.set_sensitive(can_approve);
            actions.append(&approve);
            let id = message.id.clone();
            actions.append(&button(
                "Decline",
                &[],
                self.on(move |app| app.decide_held(&id, false)),
            ));
            item.append(&actions);
            body.append(&item);
        }
        let refresh = button("Refresh", &[], self.on(App::refresh_incoming));
        refresh.set_halign(gtk::Align::Start);
        body.append(&refresh);
        group.append(&body);
        section
    }

    fn thread_row(&self, thread: &IncomingThread) -> gtk::Box {
        let item = vbox(4, &[]);
        let title = if thread.title.is_empty() {
            &thread.id
        } else {
            &thread.title
        };
        item.append(&text(title, &["settings-row-title"]).ellipsized());
        let project = if thread.project.is_empty() {
            "Codex"
        } else {
            &thread.project
        };
        item.append(&text(
            &format!(
                "{project} · {}",
                if thread.open { "Open" } else { "Closed" }
            ),
            &["caption"],
        ));
        let modes = [None, Some(Mode::Hold), Some(Mode::Auto)];
        let choice = gtk::DropDown::from_strings(&["Off", "Ask first", "Allow automatically"]);
        crate::linux_app::ui::widgets::action_cursor(&choice);
        choice.set_selected(
            modes
                .iter()
                .position(|mode| *mode == thread.mode)
                .unwrap_or(0) as u32,
        );
        choice.set_halign(gtk::Align::Start);
        let weak = self.downgrade();
        let id = thread.id.clone();
        let unrestricted = thread.allows_unrestricted;
        choice.connect_selected_notify(move |choice| {
            if let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) {
                let mode = modes.get(choice.selected() as usize).copied().flatten();
                app.share_thread(&id, mode, unrestricted);
            }
        });
        item.append(&choice);
        if thread.mode == Some(Mode::Auto) {
            let check = gtk::CheckButton::with_label(
                "Also allow without approval when this thread has full access to this computer",
            );
            crate::linux_app::ui::widgets::action_cursor(&check);
            check.set_active(thread.allows_unrestricted);
            let weak = self.downgrade();
            let id = thread.id.clone();
            check.connect_toggled(move |check| {
                if let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) {
                    app.share_thread(&id, Some(Mode::Auto), check.is_active());
                }
            });
            item.append(&check);
        }
        item
    }

    pub fn refresh_incoming(&self) {
        // Numbered as it starts: it lists only what the core took before.
        let read = self.update_state(|state| state.incoming_pending.begin_read());
        self.once::<method::IncomingStatus>(
            "incoming",
            NoParams {},
            App::refresh_incoming,
            move |app, result| {
                if let Ok(status) = result {
                    app.update_state(|state| state.incoming_read(read, status));
                    if app.page() == Page::Settings(Pane::Relay) {
                        app.render_settings();
                    }
                }
            },
        );
    }

    pub fn share_thread(&self, thread_id: &str, mode: Option<Mode>, allows_unrestricted: bool) {
        let shown = thread_id.to_string();
        self.incoming_change::<method::IncomingShare>(
            ShareParams {
                thread_id: thread_id.to_string(),
                mode,
                allows_unrestricted,
            },
            String::new(),
            |_| true,
            move |status| status.sharing(&shown, mode, allows_unrestricted),
        );
    }

    pub fn decide_held(&self, id: &str, approve: bool) {
        let verb = if approve { "approved" } else { "declined" };
        let refused = format!(
            "This message can't be {verb} now: it expired, is gone, or incoming messages are paused."
        );
        let params = HeldMessageParams { id: id.to_string() };
        let decided = id.to_string();
        if approve {
            self.incoming_change::<method::IncomingApprove>(
                params,
                refused,
                |answer| answer.approved,
                move |status| status.without_held(&decided),
            );
        } else {
            self.incoming_change::<method::IncomingReject>(
                params,
                refused,
                |answer| answer.rejected,
                move |status| status.without_held(&decided),
            );
        }
    }

    // Session sharing.

    fn sharing_pane(&self, column: &gtk::Box) {
        let details = gtk::Expander::new(Some("Upload details"));
        details.set_expanded(self.with_state(|state| state.upload_details_open));
        let weak = self.downgrade();
        details.connect_expanded_notify(move |details| {
            if let Some(app) = weak.upgrade() {
                app.update_state(|state| state.upload_details_open = details.is_expanded());
            }
        });
        details.set_child(Some(&self.stages_view()));
        let (status, preparing, shown_mode, pending_mode) = self.with_state(|state| {
            (
                state.status.clone().filter(|_| state.connected()),
                state.account().phase.as_deref() == Some("preparing_local_sessions"),
                state.sharing_mode(),
                state.sharing_mode_wanted.wanted().copied(),
            )
        });
        let Some(status) = status else {
            let (section, group) = settings_section("Upload policy", None);
            group.append(
                &settings_row(
                    if preparing {
                        "Finding your sessions"
                    } else {
                        "Checking uploads"
                    },
                    if preparing {
                        "Upload settings will be available when session preparation finishes."
                    } else {
                        "Upload settings appear once the uploader answers."
                    },
                    "send-to-symbolic",
                    None,
                    &[],
                )
                .0,
            );
            column.append(&section);
            column.append(&details);
            return;
        };
        let (section, group) = settings_section(
            "Upload policy",
            Some("Shared sessions are visible to your workspace. Sessions you put on the relay are always shared."),
        );
        for (index, mode) in SHARING_DISPLAY_ORDER.into_iter().enumerate() {
            if index > 0 {
                settings_divider(&group, 52);
            }
            // The policy asked for is selected at once; its row spins until
            // the uploader answers, and every row stays clickable so a later
            // choice wins.
            let selected = shown_mode.unwrap_or(status.sharing_mode) == mode;
            let row = gtk::Button::new();
            crate::linux_app::ui::widgets::action_cursor(&row);
            widgets::add_classes(
                &row,
                &["flat", "policy-row", if selected { "selected" } else { "" }],
            );
            let content = hbox(14, &[]);
            widgets::pad(&content, 10, None, None);
            let glyph = icon(
                if selected {
                    "emblem-ok-symbolic"
                } else {
                    "radio-symbolic"
                },
                18,
            );
            glyph.add_css_class(if selected { "accent" } else { "secondary" });
            glyph.set_valign(gtk::Align::Start);
            content.append(&glyph);
            let words = vbox(4, &[]);
            words.set_hexpand(true);
            words.append(&text(mode.title(), &["settings-row-title"]));
            words.append(&text(mode.explanation(), &["settings-row-detail"]).wrapped());
            content.append(&words);
            if pending_mode == Some(mode) {
                let spinner = gtk::Spinner::new();
                spinner.set_valign(gtk::Align::Start);
                widgets::name(&spinner, "Changing the upload policy…");
                spinner.start();
                content.append(&spinner);
            }
            row.set_child(Some(&content));
            let change = self.on(move |app| app.change_sharing(mode));
            row.connect_clicked(move |_| change());
            group.append(&row);
        }
        column.append(&section);
        column.append(&details);
    }

    // Account.

    fn account_pane(&self, column: &gtk::Box) {
        let (person, workspace, signed_in, signing_out) = self.with_state(|state| {
            (
                state.account().person.unwrap_or_default(),
                state.workspace_name(),
                state.connected(),
                state.signing_out,
            )
        });
        let email = person.email.clone().filter(|email| !email.is_empty());
        let given = person.name.clone().filter(|name| !name.is_empty());
        let name = given
            .clone()
            .or(email.clone())
            .unwrap_or_else(|| "Not signed in".into());
        let (section, group) = settings_section("Profile", None);
        let profile = vbox(16, &[]);
        widgets::pad(&profile, 20, None, None);
        let who = hbox(14, &[]);
        who.append(&avatar(&name, person.avatar_url.as_deref(), 44));
        let words = vbox(5, &[]);
        words.set_hexpand(true);
        words.set_valign(gtk::Align::Center);
        words.append(&text(&name, &["settings-profile-name"]).wrapped());
        if let (Some(_), Some(email)) = (&given, &email) {
            words.append(&text(email, &["secondary"]).wrapped().copyable());
        }
        who.append(&words);
        let log_out = button("Log out…", &[], self.on(App::confirm_logout));
        log_out.set_sensitive(signed_in && !signing_out);
        log_out.set_valign(gtk::Align::Center);
        who.append(&log_out);
        profile.append(&who);
        profile.append(&text("Logging out stops uploads and disconnects this app. Local sessions stay where they are.", &["settings-row-detail"]).wrapped());
        group.append(&profile);
        column.append(&section);
        let (section, group) = settings_section("Workspace", None);
        group.append(&settings_row(&workspace,
            "Shared sessions belong to this workspace. Log out and sign in again to switch workspaces.",
            "network-workgroup-symbolic", None, &[]).0);
        column.append(&section);
    }

    fn request_log_view(&self, column: &gtk::Box) {
        let problems = self.status_problems();
        if !problems.is_empty() {
            column.append(&text("Current problems", &["heading", "warn"]));
            let details = problems.join("\n\n");
            column.append(&text(&details, &[]).wrapped().copyable());
            column.append(&self.diagnostics_copy_button(details));
        }
        let heading = hbox(12, &[]);
        let title = text("Requests", &["heading"]);
        title.set_hexpand(true);
        heading.append(&title);
        let filter = gtk::CheckButton::with_label("Failures only");
        filter.set_active(self.with_state(|state| state.request_failures_only));
        let app = self.clone();
        filter.connect_toggled(move |button| {
            app.update_state(|state| state.request_failures_only = button.is_active());
            app.render_settings();
        });
        heading.append(&filter);
        column.append(&heading);
        let (mut entries, selected, failures_only, error) = self.with_state(|state| {
            (
                state.request_entries.clone(),
                state.selected_request.clone(),
                state.request_failures_only,
                state.request_log_error.clone(),
            )
        });
        if let Some(error) = error {
            column.append(&text(&error, &["warn"]).wrapped());
        }
        if let Some(entry) = &selected {
            if !entries.iter().any(|item| item.id == entry.id) {
                entries.insert(0, entry.clone());
            }
        }
        entries.retain(|entry| !failures_only || entry.failed);
        if entries.is_empty() {
            column.append(&text(
                if failures_only {
                    "No failed requests."
                } else {
                    "No requests recorded yet."
                },
                &["secondary"],
            ));
        }
        for entry in entries {
            let status = entry
                .status
                .map(|status| format!("HTTP {status}"))
                .unwrap_or_else(|| {
                    if entry.duration_ms.is_none() {
                        "Pending"
                    } else if entry.failed {
                        "Failed"
                    } else {
                        "Completed"
                    }
                    .into()
                });
            let time = chrono::DateTime::from_timestamp_millis(entry.started_at_ms as i64)
                .map(|time| {
                    time.with_timezone(&chrono::Local)
                        .format("%H:%M:%S")
                        .to_string()
                })
                .unwrap_or_default();
            let title = format!(
                "{} · {} {}\n{} · {}{}",
                entry.service_name(),
                entry.method,
                entry.endpoint,
                time,
                status,
                entry
                    .duration_ms
                    .map(|ms| format!(" · {ms} ms"))
                    .unwrap_or_default()
            );
            let row = gtk::Expander::new(None);
            row.set_widget_name(&entry.id);
            let label = text(&title, if entry.failed { &["warn"] } else { &[] }).wrapped();
            label.set_hexpand(true);
            label.set_halign(gtk::Align::Fill);
            row.set_hexpand(true);
            row.set_label_widget(Some(&label));
            row.set_expanded(
                selected.as_ref().is_some_and(|item| item.id == entry.id)
                    || self.with_state(|state| state.settings_details_open.contains(&entry.id)),
            );
            if selected.as_ref().is_some_and(|item| item.id == entry.id) {
                row.add_css_class("banner-warn");
            }
            let detail = vbox(8, &[]);
            let report = format!(
                "{title}\nRequest\n{}\nResponse\n{}",
                entry.request, entry.response
            );
            detail.append(&text(&report, &["monospace"]).wrapped().copyable());
            let copy = button(
                "Copy request details",
                &[],
                self.on(move |_| widgets::copy_to_clipboard(&report)),
            );
            detail.append(&copy);
            row.set_child(Some(&detail));
            let app = self.clone();
            row.connect_expanded_notify(move |row| {
                app.update_state(|state| {
                    if row.is_expanded() {
                        state.settings_details_open.insert(entry.id.clone());
                    } else {
                        state.settings_details_open.remove(&entry.id);
                        if state
                            .selected_request
                            .as_ref()
                            .is_some_and(|item| item.id == entry.id)
                        {
                            state.selected_request = None;
                        }
                    }
                });
            });
            column.append(&row);
        }
    }

    fn diagnostics_copy_button(&self, details: String) -> gtk::Button {
        let copied = self.with_state(|state| {
            state
                .diagnostics_copied_at
                .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
        });
        let copy = gtk::Button::with_label(if copied { "Copied" } else { "Copy details" });
        widgets::action_cursor(&copy);
        let weak = self.downgrade();
        copy.connect_clicked(move |copy| {
            copy.clipboard().set_text(&details);
            let Some(app) = weak.upgrade() else {
                return;
            };
            let copied_at = std::time::Instant::now();
            app.update_state(|state| state.diagnostics_copied_at = Some(copied_at));
            copy.set_label("Copied");
            let weak = weak.clone();
            glib::timeout_add_local_once(Duration::from_secs(2), move || {
                let Some(app) = weak.upgrade() else {
                    return;
                };
                let expired = app.update_state(|state| {
                    if state.diagnostics_copied_at == Some(copied_at) {
                        state.diagnostics_copied_at = None;
                        true
                    } else {
                        false
                    }
                });
                if expired && app.page() == Page::Settings(Pane::Diagnostics) {
                    app.render_settings();
                }
            });
        });
        copy
    }

    fn diagnostics_pane(&self, column: &gtk::Box) {
        self.request_log_view(column);
        let (section, group) = settings_section("Support", None);
        let logs = button("Open log file", &[], self.on(App::open_logs));
        logs.set_sensitive(self.with_state(|state| {
            state
                .status
                .as_ref()
                .and_then(|s| s.directory.as_ref())
                .is_some()
        }));
        group.append(
            &settings_row(
                "Log file",
                "What the background service recorded, for a bug report.",
                "text-x-generic-symbolic",
                Some(logs.upcast_ref()),
                &[],
            )
            .0,
        );
        column.append(&section);
        column.append(&self.diagnostics_view());
    }

    fn open_logs(&self) {
        let Some(directory) = self.with_state(|state| {
            state
                .status
                .as_ref()
                .and_then(|status| status.directory.clone())
        }) else {
            return;
        };
        self.record(
            TelemetryOperation::OpenLogs,
            TelemetryOutcome::Started,
            None,
        );
        let log = PathBuf::from(directory).join("collector.log");
        let shown = if log.exists() {
            log
        } else {
            log.parent().map(PathBuf::from).unwrap_or(log)
        };
        self.inner
            .desktop
            .open_uri(&gio::File::for_path(shown).uri());
    }

    // The relay workspace.

    /// Fetches the account workspace's relay key with the sign-in.
    pub fn connect_workspace(&self) {
        let Some(workspace) = self.with_state(|state| {
            state
                .account()
                .workspace_id
                .filter(|_| !state.connecting_workspace())
        }) else {
            return;
        };
        self.update_state(|state| {
            state.connect_requested = true;
            state.workspace_connect_error = None;
        });
        self.relay_changed();
        self.view_call::<method::AccountConnectWorkspace>(
            crate::relay::contract::account::ConnectWorkspaceParams {
                workspace_id: workspace,
            },
            |app, result| {
                app.update_state(|state| {
                    state.connect_requested = false;
                    state.workspace_connect_error = result.err().map(|error| error.message);
                });
                app.relay_changed();
                app.refresh_local();
            },
        );
    }

    pub(super) fn cancel_connect_workspace(&self) {
        self.call::<method::AccountSignInCancel>(NoParams {}, |_, _| {});
    }
}

fn update_detail(kind: InstallKind) -> &'static str {
    match kind {
        InstallKind::Tarball => "Install this update and reopen Agent Relay.",
        InstallKind::Deb => {
            "Download the verified package, then install it with your package manager."
        }
        InstallKind::Source => "This copy runs from source. Pull the latest changes to update it.",
    }
}

mod background_service;
mod gateway_rows;
mod general;
