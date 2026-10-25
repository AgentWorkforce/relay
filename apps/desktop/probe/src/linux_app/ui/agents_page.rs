//! My agents: every live session on this computer with the switch that puts
//! it on the relay (and so shares it), this computer's fleet workers, and
//! the signed-in person's agents on other machines. The sidebar scopes it,
//! the machine picker narrows it.
//!
//! Also the pieces Team reuses: roster rows, the agent overview card, the
//! relay banners and the machine picker.

use super::app::{App, WeakApp};
use super::desktop::Confirmation;
use super::pages::detach;
use super::state::{worker_key, AgentScope, Page, State};
use super::widgets::{
    self, agent_badge, banner, button, empty_note, hbox, icon, icon_button, presence_dot,
    section_header, text, vbox, with_dot, Callback, Color, Dot, LabelStyle, Tone as BannerTone,
};
use crate::linux_app::models::{
    agent_line, agent_mentions, agent_task, archived_detail, fleet_attach_command,
    group_roster_by_machine, hosted_kind_label, listed_sessions, machine_matches, machine_options,
    matches_archived, matches_roster, matches_session, matches_worker, parse_goal, parse_overview,
    relative_ms, roster_host, session_subtitle, shows_elsewhere_as_relay, worker_state_label,
    Overview, OverviewStatus, Presence, SessionUploadState, Tone, ARCHIVED_SECTION_TITLE,
};
use crate::relay::contract::account::UploadSession;
use crate::relay::contract::agents::{
    AgentIntegration, ArchivedAgent, IntegrationParams, LocalAgent, LocalSession, NameParams,
    RenameParams, ReplySettingParams, TestMessageParams,
};
use crate::relay::contract::directory::{ReleaseParams, SessionOverviewParams};
use crate::relay::contract::{method, Method};
use crate::relay::fleet::{BrokerListing, WorkerRow, WorkerState};
use crate::relay::people::{Liveness, RosterAgent};
use crate::relay::protocol::ErrorKind;
use crate::relay::store::SessionKind;
use gtk::{glib, prelude::*};
use gtk4 as gtk;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

mod fleet;

/// The integrations an agent can subscribe to.
const PROVIDERS: [&str; 4] = ["github", "linear", "slack", "jira"];

/// How long a row says its name was copied.
const COPIED_FOR: Duration = Duration::from_millis(1600);

/// A row of the relay pages: its whole area highlights together, so it
/// reads as one control.
pub(super) fn hover_row(content: &impl IsA<gtk::Widget>, height: i32) -> gtk::Box {
    let frame = hbox(0, &["row"]);
    content.set_hexpand(true);
    frame.append(content);
    frame.set_size_request(-1, height);
    let motion = gtk::EventControllerMotion::new();
    let entered = frame.downgrade();
    motion.connect_enter(move |_, _, _| {
        if let Some(frame) = entered.upgrade() {
            frame.add_css_class("hover");
        }
    });
    let left = frame.downgrade();
    motion.connect_leave(move |_| {
        if let Some(frame) = left.upgrade() {
            frame.remove_css_class("hover");
        }
    });
    frame.add_controller(motion);
    frame
}

/// Runs `on` with the pointer button and position of each press on
/// `widget`. A primary press on a control inside it (a chevron, a switch)
/// is the control's own: the row acting too would redraw the list and take
/// the control away before its click lands.
pub(super) fn on_press(widget: &impl IsA<gtk::Widget>, on: impl Fn(u32, f64, f64) + 'static) {
    let click = gtk::GestureClick::new();
    click.set_button(0);
    click.connect_pressed(move |gesture, presses, x, y| {
        let button = gesture.current_button();
        if presses != 1 {
            return;
        }
        if button == 1 {
            if let Some(row) = gesture.widget() {
                if within_control(row.pick(x, y, gtk::PickFlags::DEFAULT), &row) {
                    return;
                }
            }
        }
        on(button, x, y);
    });
    widget.add_controller(click);
}

/// Whether `picked` is, or is inside, a control that handles its own
/// clicks, below `row`.
pub fn within_control(picked: Option<gtk::Widget>, row: &gtk::Widget) -> bool {
    let mut current = picked;
    while let Some(widget) = current {
        if &widget == row {
            return false;
        }
        if widget.is::<gtk::Button>()
            || widget.is::<gtk::Switch>()
            || widget.is::<gtk::CheckButton>()
            || widget.is::<gtk::DropDown>()
            || widget.is::<gtk::Entry>()
            || widget.is::<gtk::Text>()
        {
            return true;
        }
        current = widget.parent();
    }
    false
}

/// A menu's items: a label and what it runs, `None` for an insensitive
/// line, `-` for a separator.
pub type MenuItems = Vec<(String, Option<Callback>)>;

/// A menu under `widget`, or at `at` within it.
pub(super) fn menu(widget: &impl IsA<gtk::Widget>, at: Option<(f64, f64)>, items: MenuItems) {
    let (labels, actions): (Vec<String>, Vec<Option<Callback>>) = items.into_iter().unzip();
    let popover = widgets::popup_menu(
        widget,
        labels.iter().map(String::as_str).zip(actions).collect(),
    );
    if let Some((x, y)) = at {
        popover.set_pointing_to(Some(&gtk::gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
    }
}

/// The button that shows or hides a row's details.
pub(super) fn chevron(expanded: bool, what: &str, on: impl Fn() + 'static) -> gtk::Button {
    let tip = if expanded {
        format!("Hide {what}")
    } else {
        format!("Show {what}")
    };
    let item = icon_button(
        if expanded {
            "pan-down-symbolic"
        } else {
            "pan-end-symbolic"
        },
        &tip,
        &["icon"],
        on,
    );
    item.set_valign(gtk::Align::Center);
    item
}

/// A fact's value: selectable text that wraps.
pub(super) fn fact(value: &str) -> gtk::Widget {
    text(value, &["detail-value"]).wrapped().copyable().upcast()
}

/// Labels on the left, values on the right, as the Mac's detail grid.
pub(super) fn fact_grid(rows: Vec<(&str, gtk::Widget)>) -> gtk::Grid {
    let grid = gtk::Grid::new();
    grid.set_column_spacing(14);
    grid.set_row_spacing(6);
    for (index, (name, value)) in rows.into_iter().enumerate() {
        let label = text(name, &["detail-label"]);
        label.set_xalign(1.0);
        label.set_valign(gtk::Align::Start);
        grid.attach(&label, 0, index as i32, 1, 1);
        value.set_hexpand(true);
        value.set_halign(gtk::Align::Start);
        grid.attach(&value, 1, index as i32, 1, 1);
    }
    grid
}

/// A one-off outcome under a tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    Waiting,
    Failed,
}

fn status_line(status: Option<&(Outcome, String)>) -> gtk::Widget {
    let row = hbox(6, &[]);
    let Some((outcome, message)) = status.filter(|(_, message)| !message.is_empty()) else {
        return row.upcast();
    };
    let (glyph, class) = match outcome {
        Outcome::Ok => ("emblem-ok-symbolic", "ok"),
        Outcome::Waiting => ("alarm-symbolic", "warn"),
        Outcome::Failed => ("dialog-warning-symbolic", "error"),
    };
    let image = icon(glyph, 12);
    image.add_css_class(class);
    image.set_valign(gtk::Align::Start);
    row.append(&image);
    let words = text(message, &[class, "caption"]).wrapped();
    words.set_hexpand(true);
    row.append(&words);
    row.upcast()
}

/// A worker's dot: working is filled, idle a ring, as on the Mac.
/// A live session's title as its row shows it, which search matches.
fn shown_title(session: &LocalSession) -> &str {
    if session.title.is_empty() {
        "Untitled session"
    } else {
        &session.title
    }
}

fn worker_dot(state: WorkerState) -> (Option<Color>, bool) {
    match state {
        WorkerState::Working => (Some(Color::Green), true),
        WorkerState::Idle => (Some(Color::Green), false),
        WorkerState::Waiting => (Some(Color::Orange), false),
        WorkerState::Starting => (Some(Color::Accent), false),
        WorkerState::Unknown => (None, true),
    }
}

/// Rename, replies, a message, integrations and the inbound webhook for one
/// agent on the relay. Built once per session and kept across redraws, so
/// typed text, the last outcome and a new webhook's token stay.
pub struct AgentTools {
    app: WeakApp,
    /// The disclosure the tools sit in, as on the Mac.
    pub expander: gtk::Expander,
    pub name_entry: gtk::Entry,
    rename_button: gtk::Button,
    replies: gtk::DropDown,
    replies_note: gtk::Label,
    pub message: gtk::Entry,
    send_button: gtk::Button,
    message_note: gtk::Label,
    integration_note: gtk::Label,
    provider: gtk::DropDown,
    pub resource: gtk::Entry,
    subscribe_button: gtk::Button,
    integrations: gtk::Box,
    webhook: gtk::Box,
    statuses_shown: Vec<(&'static str, gtk::Box)>,
    agent: RefCell<Option<LocalAgent>>,
    working: Cell<bool>,
    statuses: RefCell<HashMap<&'static str, (Outcome, String)>>,
    secret: RefCell<Option<String>>,
    /// Set while drawing: the replies picker changing then changes nothing.
    drawing: Cell<bool>,
}

fn tool_section(title: &str, children: &[&gtk::Widget]) -> gtk::Box {
    let section = vbox(6, &[]);
    section.append(&text(title, &["tool-heading"]));
    for child in children {
        section.append(*child);
    }
    section
}

impl AgentTools {
    fn build(app: &App, expanded: bool, key: &str) -> Rc<AgentTools> {
        let root = vbox(14, &[]);
        root.set_margin_top(8);
        let mut statuses_shown = Vec::new();
        let mut status_holder = |name: &'static str| {
            let holder = hbox(0, &[]);
            statuses_shown.push((name, holder.clone()));
            holder
        };

        let name_entry = gtk::Entry::new();
        name_entry.set_placeholder_text(Some("new name"));
        name_entry.set_width_chars(28);
        widgets::name(&name_entry, "New name");
        let rename_button = gtk::Button::with_label("Rename");
        crate::linux_app::ui::widgets::action_cursor(&rename_button);
        let name_row = hbox(6, &[]);
        name_row.append(&text("@", &["secondary"]));
        name_row.append(&name_entry);
        name_row.append(&rename_button);
        let rename_status = status_holder("rename");
        root.append(&tool_section(
            "Name",
            &[name_row.upcast_ref(), rename_status.upcast_ref()],
        ));

        let replies = gtk::DropDown::from_strings(&[
            "When no reply command is available",
            "For unanswered messages",
            "Off",
        ]);
        crate::linux_app::ui::widgets::action_cursor(&replies);
        widgets::name(&replies, "Reply with final answer");
        let replies_row = hbox(8, &[]);
        replies_row.append(&text("Reply with final answer", &[]));
        replies_row.append(&replies);
        let replies_note = text("", &["caption"]).wrapped();
        let replies_status = status_holder("replies");
        root.append(&tool_section(
            "Replies",
            &[
                replies_row.upcast_ref(),
                replies_note.upcast_ref(),
                replies_status.upcast_ref(),
            ],
        ));

        let message = gtk::Entry::new();
        message.set_placeholder_text(Some("Message"));
        message.set_hexpand(true);
        widgets::name(&message, "Message");
        let send_button = gtk::Button::with_label("Send");
        crate::linux_app::ui::widgets::action_cursor(&send_button);
        let message_row = hbox(6, &[]);
        message_row.append(&message);
        message_row.append(&send_button);
        let message_note = text("", &["caption"]).wrapped();
        let message_status = status_holder("message");
        root.append(&tool_section(
            "Message this session",
            &[
                message_row.upcast_ref(),
                message_note.upcast_ref(),
                message_status.upcast_ref(),
            ],
        ));

        let integration_note = text("", &["caption"]).wrapped();
        let provider = gtk::DropDown::from_strings(&PROVIDERS);
        crate::linux_app::ui::widgets::action_cursor(&provider);
        widgets::name(&provider, "Provider");
        let resource = gtk::Entry::new();
        resource.set_placeholder_text(Some("Resource, e.g. acme/api"));
        resource.set_hexpand(true);
        widgets::name(&resource, "Resource");
        let provider_row = hbox(8, &[]);
        provider_row.append(&provider);
        provider_row.append(&resource);
        let subscribe_button = gtk::Button::with_label("Subscribe");
        crate::linux_app::ui::widgets::action_cursor(&subscribe_button);
        subscribe_button.set_halign(gtk::Align::Start);
        let integrations = vbox(4, &[]);
        let integration_status = status_holder("integration");
        let uses = text(
            "Uses your Agent Relay workspace. If the provider isn't connected yet, Agent Relay opens to connect it.",
            &["caption"],
        )
        .wrapped();
        root.append(&tool_section(
            "Integrations",
            &[
                integration_note.upcast_ref(),
                provider_row.upcast_ref(),
                uses.upcast_ref(),
                subscribe_button.upcast_ref(),
                integrations.upcast_ref(),
                integration_status.upcast_ref(),
            ],
        ));

        let webhook = vbox(6, &[]);
        let webhook_status = status_holder("webhook");
        root.append(&tool_section(
            "Webhook",
            &[webhook.upcast_ref(), webhook_status.upcast_ref()],
        ));

        let expander = gtk::Expander::new(Some("Name, replies, webhook and integrations"));
        expander.set_expanded(expanded);
        expander.set_child(Some(&root));
        let tools = Rc::new(AgentTools {
            app: app.downgrade(),
            expander,
            name_entry,
            rename_button,
            replies,
            replies_note,
            message,
            send_button,
            message_note,
            integration_note,
            provider,
            resource,
            subscribe_button,
            integrations,
            webhook,
            statuses_shown,
            agent: RefCell::new(None),
            working: Cell::new(false),
            statuses: RefCell::default(),
            secret: RefCell::new(None),
            drawing: Cell::new(false),
        });
        let weak = Rc::downgrade(&tools);
        let with = move |action: fn(&Rc<AgentTools>)| {
            let weak = weak.clone();
            move || {
                if let Some(tools) = weak.upgrade() {
                    action(&tools);
                }
            }
        };
        let rename = with(AgentTools::rename);
        tools.name_entry.connect_activate(move |_| rename());
        let rename = with(AgentTools::rename);
        tools.rename_button.connect_clicked(move |_| rename());
        let sensitivity = with(|tools| tools.sensitivity());
        tools.name_entry.connect_changed(move |_| sensitivity());
        let replies = with(AgentTools::set_replies);
        tools.replies.connect_selected_notify(move |_| replies());
        let send = with(AgentTools::send);
        tools.message.connect_activate(move |_| send());
        let send = with(AgentTools::send);
        tools.send_button.connect_clicked(move |_| send());
        let sensitivity = with(|tools| tools.sensitivity());
        tools.message.connect_changed(move |_| sensitivity());
        let subscribe = with(AgentTools::subscribe);
        tools.resource.connect_activate(move |_| subscribe());
        let subscribe = with(AgentTools::subscribe);
        tools.subscribe_button.connect_clicked(move |_| subscribe());
        let sensitivity = with(|tools| tools.sensitivity());
        tools.resource.connect_changed(move |_| sensitivity());
        let key = key.to_string();
        let weak_app = app.downgrade();
        tools.expander.connect_expanded_notify(move |expander| {
            if let Some(app) = weak_app.upgrade() {
                app.update_state(|state| {
                    if expander.is_expanded() {
                        state.expanded_tools.insert(key.clone());
                    } else {
                        state.expanded_tools.remove(&key);
                    }
                });
            }
        });
        tools
    }

    /// The agent the tools are for.
    pub fn agent(&self) -> Option<LocalAgent> {
        self.agent.borrow().clone()
    }

    fn name(&self) -> String {
        self.agent
            .borrow()
            .as_ref()
            .map(|agent| agent.name.clone())
            .unwrap_or_default()
    }

    fn display_name(&self) -> String {
        self.agent()
            .map(|a| a.display_name().to_owned())
            .unwrap_or_default()
    }

    /// A tool's call is running.
    pub fn working(&self) -> bool {
        self.working.get()
    }

    /// A new webhook's token, shown until the tools are gone.
    pub fn secret(&self) -> Option<String> {
        self.secret.borrow().clone()
    }

    /// The last outcome of a tool: `rename`, `replies`, `message`,
    /// `integration` or `webhook`.
    pub fn status(&self, section: &str) -> Option<(Outcome, String)> {
        self.statuses.borrow().get(section).cloned()
    }

    /// A tool's call runs, or the session's relay switch is changing.
    fn busy(&self) -> bool {
        let key = self.agent.borrow().as_ref().map(|agent| agent.target.key());
        self.working.get()
            || self
                .app
                .upgrade()
                .zip(key)
                .is_some_and(|(app, key)| app.with_state(|state| state.busy_targets.contains(&key)))
    }

    /// The name typed, as the relay takes it.
    fn requested_name(&self) -> String {
        self.name_entry
            .text()
            .trim()
            .trim_matches('@')
            .to_lowercase()
    }

    /// Draws the tools for `agent`.
    pub fn update(&self, agent: &LocalAgent) {
        let previous = self.agent.replace(Some(agent.clone()));
        let name = agent.name.as_str();
        super::agent_names::update_field(&self.name_entry, previous.as_ref(), agent);
        let busy = self.busy();
        let cloud = agent.target.kind == SessionKind::ClaudeCloud;
        // While a call runs the picker keeps the choice being saved; the
        // call's end draws what the agent holds.
        if !self.working.get() {
            self.drawing.set(true);
            self.replies
                .set_selected(match agent.reply_with_final_answer {
                    None => 0,
                    Some(true) => 1,
                    Some(false) => 2,
                });
            self.drawing.set(false);
        }
        self.replies.set_sensitive(!busy && !cloud);
        self.replies_note.set_text(&if cloud {
            "Claude app has no local transcript; automatic replies are unavailable.".to_string()
        } else {
            format!(
                "Forwards the completed answer as @{name}, unless the session already replied. Replies longer than 4,000 characters are truncated."
            )
        });
        self.message_note.set_text(&format!(
            "Sent through Agent Relay as a DM to {}, the same way a teammate's message arrives.",
            agent.address
        ));
        self.integration_note.set_text(&format!(
            "Provider events for @{name} arrive in the session. Its automatic answers are never posted back to the provider."
        ));
        widgets::clear(&self.integrations);
        for integration in &agent.integrations {
            self.integrations
                .append(&self.integration_row(integration, busy));
        }
        self.render_webhook(agent, busy);
        let statuses = self.statuses.borrow();
        for (section, holder) in &self.statuses_shown {
            widgets::clear(holder);
            holder.append(&status_line(statuses.get(section)));
        }
        drop(statuses);
        self.sensitivity();
    }

    fn integration_row(&self, integration: &AgentIntegration, busy: bool) -> gtk::Box {
        let row = hbox(8, &[]);
        let words = vbox(2, &[]);
        words.set_hexpand(true);
        words.append(&text(
            &format!("{}: {}", integration.provider, integration.resource),
            &[],
        ));
        if !integration.ready {
            words.append(&text("Setup or cleanup incomplete", &["warn", "caption"]));
        }
        row.append(&words);
        let weak = self.app.clone();
        let item = integration.clone();
        let key = self.agent_key();
        let action = button(
            if integration.ready {
                "Unsubscribe"
            } else {
                "Clean up"
            },
            &[],
            move || {
                if let Some(tools) = weak.upgrade().and_then(|app| app.agent_tools(&key)) {
                    tools.unsubscribe(&item);
                }
            },
        );
        action.set_sensitive(!busy);
        row.append(&action);
        row
    }

    /// The session these tools are kept under.
    fn agent_key(&self) -> String {
        self.agent
            .borrow()
            .as_ref()
            .map(|agent| agent.target.key())
            .unwrap_or_default()
    }

    fn copy_row(label: &str, value: &str) -> gtk::Box {
        let row = hbox(8, &[]);
        let heading = text(label, &["caption"]);
        heading.set_size_request(40, -1);
        row.append(&heading);
        let shown = text(value, &["mono", "caption"]).ellipsized().copyable();
        shown.set_hexpand(true);
        row.append(&shown);
        let value = value.to_string();
        row.append(&icon_button(
            "edit-copy-symbolic",
            &format!("Copy {}", label.to_lowercase()),
            &["icon"],
            move || widgets::copy_to_clipboard(&value),
        ));
        row
    }

    fn render_webhook(&self, agent: &LocalAgent, busy: bool) {
        widgets::clear(&self.webhook);
        let key = agent.target.key();
        let with = |action: fn(&Rc<AgentTools>)| {
            let weak = self.app.clone();
            let key = key.clone();
            move || {
                if let Some(tools) = weak.upgrade().and_then(|app| app.agent_tools(&key)) {
                    action(&tools);
                }
            }
        };
        let Some(webhook) = &agent.webhook else {
            self.webhook.append(
                &text(
                    &format!(
                        "Give @{} a webhook URL and bearer token, so CI, alerts or any service can post straight into this session.",
                        agent.name
                    ),
                    &["caption"],
                )
                .wrapped(),
            );
            let create = button("Create webhook", &[], with(AgentTools::create_webhook));
            create.set_halign(gtk::Align::Start);
            create.set_sensitive(!busy);
            self.webhook.append(&create);
            return;
        };
        self.webhook.append(
            &text(
                "POST JSON to this URL with the bearer token; the `text` field arrives in the session.",
                &["caption"],
            )
            .wrapped(),
        );
        self.webhook
            .append(&AgentTools::copy_row("URL", &webhook.url));
        let secret = self.secret.borrow().clone();
        if let Some(secret) = &secret {
            self.webhook.append(&AgentTools::copy_row("Token", secret));
            self.webhook.append(&text(
                "Copy the token now: Agent Relay does not show it again.",
                &["warn", "caption"],
            ));
        }
        let actions = hbox(8, &[]);
        if secret.is_some() {
            actions.append(&button(
                "Copy curl example",
                &[],
                with(AgentTools::copy_curl),
            ));
        }
        let revoke = button("Revoke", &["destructive"], with(AgentTools::revoke));
        revoke.set_sensitive(!busy);
        actions.append(&revoke);
        self.webhook.append(&actions);
    }

    fn copy_curl(self: &Rc<Self>) {
        let (Some(secret), Some(url)) = (
            self.secret(),
            self.agent()
                .and_then(|agent| agent.webhook)
                .map(|webhook| webhook.url),
        ) else {
            return;
        };
        widgets::copy_to_clipboard(&format!(
            "curl -X POST '{url}' -H 'Authorization: Bearer {secret}' -H 'Content-Type: application/json' -d '{{\"text\":\"Build failed on main\",\"source\":\"ci\"}}'"
        ));
        self.set_status(
            "webhook",
            Outcome::Ok,
            format!("Copied a curl command that posts to @{}.", self.name()),
        );
    }

    fn sensitivity(&self) {
        let busy = self.busy();
        let requested = self.requested_name();
        self.rename_button
            .set_sensitive(!busy && !requested.is_empty() && requested != self.display_name());
        self.send_button
            .set_sensitive(!self.working.get() && !self.message.text().trim().is_empty());
        self.subscribe_button
            .set_sensitive(!busy && !self.resource.text().trim().is_empty());
    }

    /// Starts a tool's call unless one is running, dimming every tool
    /// until it ends: one call at a time per agent.
    fn start(&self) -> bool {
        if self.working.replace(true) {
            return false;
        }
        match self.agent() {
            Some(agent) => self.update(&agent),
            None => self.sensitivity(),
        }
        true
    }

    fn set_status(&self, section: &'static str, outcome: Outcome, message: String) {
        self.statuses
            .borrow_mut()
            .insert(section, (outcome, message));
        if let Some(agent) = self.agent() {
            self.update(&agent);
        }
    }

    /// Calls `M` for the tool `section`; `after` takes the answer, `failed`
    /// a refusal, and `success` says what it did. A change done rereads
    /// the agents and the sessions, which hold what it changed.
    fn run<M>(
        self: &Rc<Self>,
        params: M::Params,
        section: &'static str,
        success: impl FnOnce(&M::Result) -> String + 'static,
        after: impl FnOnce(&AgentTools, &M::Result) + 'static,
        failed: impl FnOnce(&App, &AgentTools) + 'static,
    ) where
        M: Method + 'static,
        M::Params: Send + 'static,
        M::Result: Send + 'static,
    {
        let Some(app) = self.app.upgrade() else {
            return;
        };
        if !self.start() {
            return;
        }
        let tools = self.clone();
        app.view_call::<M>(params, move |app, result| {
            tools.working.set(false);
            match result {
                Err(error) => {
                    failed(app, &tools);
                    tools.set_status(section, Outcome::Failed, error.message)
                }
                Ok(answer) => {
                    after(&tools, &answer);
                    let message = success(&answer);
                    let address = tools.agent().map(|agent| agent.address).unwrap_or_default();
                    let waiting = (section == "message")
                        .then(|| app.with_state(|state| state.waiting_status(&address)))
                        .flatten();
                    match waiting {
                        Some(waiting) => {
                            tools.set_status(section, Outcome::Waiting, waiting.to_string())
                        }
                        None => tools.set_status(section, Outcome::Ok, message),
                    }
                    app.refresh_agents();
                    app.refresh_local();
                }
            }
        });
    }

    /// Renames the agent: the new name shows at once and goes back if the
    /// core refuses.
    pub fn rename(self: &Rc<Self>) {
        let requested = self.requested_name();
        let name = self.name();
        if requested.is_empty() || self.busy() || requested == self.display_name() {
            return;
        }
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let previous = app.show_rename(&name, &requested);
        let (reverted_name, reverted_to) = (name.clone(), requested.clone());
        self.run::<method::AgentsRename>(
            RenameParams {
                name: name.clone(),
                new_name: requested,
            },
            "rename",
            move |renamed| renamed.outcome(&name),
            |_, _| {},
            move |app, _| app.revert_rename(&reverted_name, &reverted_to, previous),
        );
    }

    pub fn set_replies(self: &Rc<Self>) {
        if self.drawing.get() {
            return;
        }
        let Some(agent) = self.agent() else {
            return;
        };
        let enabled = match self.replies.selected() {
            1 => Some(true),
            2 => Some(false),
            _ => None,
        };
        if enabled == agent.reply_with_final_answer {
            return;
        }
        self.run::<method::AgentsReplySetting>(
            ReplySettingParams {
                name: agent.name,
                enabled,
            },
            "replies",
            |_| String::new(),
            |_, _| {},
            |_, _| {},
        );
    }

    /// Sends the test message: the field clears at once and the status
    /// says it is on its way; a refusal puts the text back.
    pub fn send(self: &Rc<Self>) {
        let body = self.message.text().trim().to_string();
        if body.is_empty() || self.working.get() {
            return;
        }
        self.message.set_text("");
        self.set_status("message", Outcome::Waiting, "Sending…".to_string());
        let sent = body.clone();
        self.run::<method::AgentsTestMessage>(
            TestMessageParams {
                name: self.name(),
                text: Some(body),
            },
            "message",
            |_| "Queued for delivery.".to_string(),
            |_, _| {},
            move |_, tools| {
                if tools.message.text().trim().is_empty() {
                    tools.message.set_text(&sent);
                }
            },
        );
    }

    pub fn subscribe(self: &Rc<Self>) {
        let resource = self.resource.text().trim().to_string();
        if resource.is_empty() || self.busy() {
            return;
        }
        let provider = PROVIDERS
            .get(self.provider.selected() as usize)
            .copied()
            .unwrap_or("github")
            .to_string();
        self.run::<method::AgentsIntegrationsSubscribe>(
            IntegrationParams {
                name: self.name(),
                provider,
                resource,
            },
            "integration",
            |_| "Subscribed. Provider events will arrive in this session.".to_string(),
            |tools, _| tools.resource.set_text(""),
            |_, _| {},
        );
    }

    pub fn unsubscribe(self: &Rc<Self>, integration: &AgentIntegration) {
        let params = IntegrationParams {
            name: self.name(),
            provider: integration.provider.clone(),
            resource: integration.resource.clone(),
        };
        let success = |_: &_| "Subscription removed.".to_string();
        if integration.ready {
            self.run::<method::AgentsIntegrationsUnsubscribe>(
                params,
                "integration",
                success,
                |_, _| {},
                |_, _| {},
            );
        } else {
            self.run::<method::AgentsIntegrationsCleanUp>(
                params,
                "integration",
                success,
                |_, _| {},
                |_, _| {},
            );
        }
    }

    pub fn create_webhook(self: &Rc<Self>) {
        let Some(app) = self.app.upgrade() else {
            return;
        };
        let name = self.name();
        if !self.start() {
            return;
        }
        let tools = self.clone();
        app.view_call::<method::AgentsWebhookCreate>(
            NameParams { name: name.clone() },
            move |app, result| {
                tools.working.set(false);
                match result {
                    Err(error) => tools.set_status("webhook", Outcome::Failed, error.message),
                    Ok(created) => match created.secret {
                        None => tools.set_status(
                            "webhook",
                            Outcome::Failed,
                            "This webhook already existed, so its token can't be shown again. Revoke it and create a new one for a new token.".into(),
                        ),
                        Some(secret) => {
                            *tools.secret.borrow_mut() = Some(secret);
                            tools.set_status(
                                "webhook",
                                Outcome::Ok,
                                format!("Webhook ready. Anything posted to it goes to @{name}."),
                            );
                        }
                    },
                }
                app.refresh_agents();
            },
        );
    }

    pub fn revoke(self: &Rc<Self>) {
        self.run::<method::AgentsWebhookRevoke>(
            NameParams { name: self.name() },
            "webhook",
            |_| "Webhook revoked; its URL and token no longer work.".to_string(),
            |tools, _| *tools.secret.borrow_mut() = None,
            |_, _| {},
        );
    }
}

impl App {
    /// The tools of the agent the session (`Target::key`) is, while shown.
    pub fn agent_tools(&self, key: &str) -> Option<Rc<AgentTools>> {
        self.shell().and_then(|shell| shell.pages.tools(key))
    }

    // The page.

    pub fn render_agents(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        shell
            .pages
            .agents
            .redraw(|column| self.agents_content(column));
        // Tools for a session no longer listed are dropped.
        let listed: std::collections::HashSet<String> = self.with_state(|state| {
            state
                .local_sessions
                .iter()
                .map(|session| session.target.key())
                .collect()
        });
        shell
            .pages
            .tools
            .borrow_mut()
            .retain(|key, _| listed.contains(key));
    }

    /// Narrows My agents to one machine; empty shows every one.
    pub fn set_agents_machine(&self, machine: &str) {
        let changed = self.update_state(|state| {
            let changed = state.agents_machine != machine;
            state.agents_machine = machine.to_string();
            changed
        });
        if changed {
            glib::idle_add_local_once(self.on(|app| {
                if app.page() == Page::Agents {
                    app.render_page();
                }
            }));
        }
    }

    fn agents_content(&self, column: &gtk::Box) {
        column.append(&self.relay_banners());
        let (this, machines) = self.with_state(|state| {
            let this = state.this_machine();
            let mut machines = vec![this.clone()];
            machines.extend(
                state
                    .roster
                    .iter()
                    .filter_map(|agent| roster_host(agent).map(str::to_string)),
            );
            machines.extend(state.brokers.iter().map(|broker| broker.name.clone()));
            (this, machines)
        });
        let (picker, selected) = self.machine_picker(
            &machines,
            |state| &mut state.agents_machine,
            App::set_agents_machine,
        );
        column.append(&picker);
        let lists = vbox(0, &[]);
        column.append(&lists);

        let (query, scope) =
            self.with_state(|state| (state.agent_search.clone(), state.agent_scope));
        let here = machine_matches(Some(&this), &selected);
        let (
            on_relay,
            others,
            fleet,
            fleet_errors,
            elsewhere,
            online,
            off_count,
            roster_error,
            load_error,
            total_workers,
        ) = self.with_state(|state| {
            let matching: Vec<LocalSession> = listed_sessions(&state.local_sessions)
                .into_iter()
                .filter(|session| here && matches_session(session, shown_title(session), &query))
                .cloned()
                .collect();
            let in_relay = |session: &LocalSession| {
                state
                    .held_sections
                    .get(&session.target.key())
                    .copied()
                    .unwrap_or(session.registration.is_some())
            };
            let (on, off): (Vec<LocalSession>, Vec<LocalSession>) =
                matching.into_iter().partition(in_relay);
            let fleet: Vec<(BrokerListing, WorkerRow)> = state
                .brokers
                .iter()
                .flat_map(|broker| {
                    broker
                        .workers
                        .iter()
                        .filter(|worker| {
                            machine_matches(Some(&broker.name), &selected)
                                && matches_worker(worker, broker, &query)
                        })
                        .map(move |worker| (broker.clone(), worker.clone()))
                })
                .collect();
            let fleet_errors: Vec<String> = state
                .brokers
                .iter()
                .filter_map(|broker| {
                    broker
                        .error
                        .as_ref()
                        .map(|error| format!("{}: {error}", broker.name))
                })
                .collect();
            let elsewhere: Vec<RosterAgent> = state
                .roster_groups()
                .mine
                .into_iter()
                .filter(|agent| {
                    machine_matches(roster_host(agent), &selected) && matches_roster(agent, &query)
                })
                .collect();
            (
                on,
                off,
                fleet,
                fleet_errors,
                elsewhere,
                state.online_count(),
                state.count_of(AgentScope::OffRelay),
                state.roster_error.clone(),
                state.relay_load_error.clone(),
                state
                    .brokers
                    .iter()
                    .map(|broker| broker.workers.len())
                    .sum::<usize>(),
            )
        });
        // Another machine's agents on the relay are its "On the relay"
        // list: this computer's sessions are not on that machine.
        let elsewhere_as_relay = shows_elsewhere_as_relay(&this, &selected);
        let no_match =
            (!query.trim().is_empty()).then(|| format!("Nothing here matches “{}”.", query.trim()));
        let shows = |part: AgentScope| scope == AgentScope::All || scope == part;
        let top = |header: &gtk::Box| {
            header.set_margin_top(if scope == AgentScope::All { 14 } else { 0 })
        };

        if shows(AgentScope::OnRelay) && elsewhere_as_relay {
            let count = (!elsewhere.is_empty()).then(|| elsewhere.len().to_string());
            lists.append(&section_header("On the relay", count.as_deref()));
            if elsewhere.is_empty() {
                lists.append(&empty_note(&no_match.clone().unwrap_or_else(|| {
                    format!("None of your agents are on the relay from {selected}.")
                })));
            }
            for group in group_roster_by_machine(&elsewhere) {
                for agent in &group.agents {
                    lists.append(&self.roster_row(agent));
                }
            }
        } else if shows(AgentScope::OnRelay) {
            let detail = (!on_relay.is_empty()).then(|| format!("{online} online"));
            lists.append(&section_header("On the relay", detail.as_deref()));
            if on_relay.is_empty() {
                let message = match &no_match {
                    Some(no_match) => no_match.clone(),
                    None if others.is_empty() && off_count == 0 => "No live sessions on this computer yet. Start Claude Code or Codex and it appears here.".into(),
                    None if scope == AgentScope::OnRelay => "None of your sessions are on the relay. Turn one on under Not on the relay to message it by name and share it.".into(),
                    None => "Turn on a session below to message it by name. Sessions on the relay are shared with your workspace.".into(),
                };
                lists.append(&empty_note(&message));
            }
            for session in &on_relay {
                lists.append(&self.session_row(session));
            }
        }
        if shows(AgentScope::OffRelay) && (!others.is_empty() || scope == AgentScope::OffRelay) {
            let header = section_header("Not on the relay", Some(&others.len().to_string()));
            top(&header);
            lists.append(&header);
            if others.is_empty() {
                lists.append(&empty_note(
                    no_match
                        .as_deref()
                        .unwrap_or("Every live session is on the relay."),
                ));
            }
            for session in &others {
                lists.append(&self.session_row(session));
            }
        }
        if shows(AgentScope::OnRelay) && !elsewhere_as_relay {
            let archived: Vec<ArchivedAgent> = self.with_state(|state| {
                state
                    .archived_agents
                    .iter()
                    .filter(|agent| matches_archived(agent, &query))
                    .cloned()
                    .collect()
            });
            if !archived.is_empty() {
                let header =
                    section_header(ARCHIVED_SECTION_TITLE, Some(&archived.len().to_string()));
                header.set_margin_top(14);
                lists.append(&header);
                for agent in &archived {
                    lists.append(&archived_row(agent));
                }
            }
        }
        if (shows(AgentScope::Fleet) && (!fleet.is_empty() || !fleet_errors.is_empty()))
            || scope == AgentScope::Fleet
        {
            let header = section_header("Fleet workers", Some(&total_workers.to_string()));
            top(&header);
            lists.append(&header);
            if fleet.is_empty() && fleet_errors.is_empty() {
                lists.append(&empty_note(no_match.as_deref().unwrap_or(
                    "No fleet workers on this computer. Workers an agent-relay broker spawns appear here.",
                )));
            }
            for (broker, worker) in &fleet {
                lists.append(&self.fleet_row(broker, worker));
            }
            for error in &fleet_errors {
                lists.append(&text(error, &["warn", "caption"]).wrapped());
            }
        }
        if (shows(AgentScope::Elsewhere) && !elsewhere.is_empty() && !elsewhere_as_relay)
            || scope == AgentScope::Elsewhere
        {
            let header = section_header("On other machines", Some(&elsewhere.len().to_string()));
            top(&header);
            lists.append(&header);
            if elsewhere.is_empty() {
                lists.append(&empty_note(no_match.as_deref().unwrap_or(
                    "None of your agents are on the relay from another machine.",
                )));
            }
            for group in group_roster_by_machine(&elsewhere) {
                lists.append(&section_header(
                    &group.name,
                    Some(&group.agents.len().to_string()),
                ));
                for agent in &group.agents {
                    lists.append(&self.roster_row(agent));
                }
            }
        }
        // The roster also fills another machine's On the relay list.
        if let Some(error) = roster_error.filter(|_| {
            shows(AgentScope::Elsewhere) || (shows(AgentScope::OnRelay) && elsewhere_as_relay)
        }) {
            lists.append(&text(&error, &["warn", "caption"]).wrapped());
        }
        if let Some(error) = load_error {
            lists.append(&text(&error, &["warn", "caption"]).wrapped());
        }
    }

    // Banners: only what stops messages or uploads, most blocking first.

    pub(super) fn relay_banners(&self) -> gtk::Box {
        let holder = vbox(8, &[]);
        let (paused, workspace, connecting, connect_error, problem) = self.with_state(|state| {
            (
                state.is_paused(),
                state.has_workspace(),
                state.connecting_workspace(),
                state.workspace_connect_error.clone(),
                state.relay_problem(),
            )
        });
        if paused {
            holder.append(&banner(
                "Paused. Agents don't receive messages and nothing uploads.",
                BannerTone::Warn,
                Some((
                    "Resume",
                    Box::new(self.on(|app| app.set_paused(false))) as Callback,
                )),
            ));
        }
        if !workspace && connecting {
            holder.append(&banner(
                "Finish connecting the workspace in your browser.",
                BannerTone::Neutral,
                Some((
                    "Cancel",
                    Box::new(self.on(App::cancel_connect_workspace)) as Callback,
                )),
            ));
        }
        if !workspace && !connecting {
            holder.append(&banner(
                connect_error
                    .as_deref()
                    .unwrap_or("Connect a relay workspace to put agents on the relay."),
                BannerTone::Warn,
                Some((
                    "Connect",
                    Box::new(self.on(App::connect_workspace)) as Callback,
                )),
            ));
        }
        if let Some(problem) = problem {
            holder.append(&banner(&problem, BannerTone::Warn, None));
        }
        holder
    }

    /// The machine picker: All machines, then one per machine in `names`.
    /// The machine picker over `names`, and the machine it narrows to.
    /// A machine no longer among them stops narrowing: `selection` goes
    /// back to every machine, as the picker shows.
    pub(super) fn machine_picker(
        &self,
        names: &[String],
        selection: fn(&mut State) -> &mut String,
        on: fn(&App, &str),
    ) -> (gtk::Box, String) {
        let row = hbox(8, &[]);
        row.set_margin_start(8);
        row.set_margin_end(8);
        row.append(&icon("computer-symbolic", 14));
        let options = machine_options(names.iter().map(|name| Some(name.as_str())));
        let position = |selected: &str| {
            options
                .iter()
                .position(|option| !selected.is_empty() && machine_matches(Some(option), selected))
        };
        let selected = self.update_state(|state| {
            let selected = selection(state);
            if position(selected).is_none() {
                selected.clear();
            }
            selected.clone()
        });
        let mut shown: Vec<&str> = vec!["All machines"];
        shown.extend(options.iter().map(String::as_str));
        let picker = gtk::DropDown::from_strings(&shown);
        crate::linux_app::ui::widgets::action_cursor(&picker);
        widgets::name(&picker, "Machine");
        let index = position(&selected).map_or(0, |index| index + 1);
        picker.set_selected(index as u32);
        let weak = self.downgrade();
        picker.connect_selected_notify(move |picker| {
            if let Some(app) = weak.upgrade() {
                let chosen = match picker.selected() as usize {
                    0 => String::new(),
                    index => options.get(index - 1).cloned().unwrap_or_default(),
                };
                on(&app, &chosen);
            }
        });
        row.append(&picker);
        (row, selected)
    }

    // Sessions.

    fn session_row(&self, session: &LocalSession) -> gtk::Widget {
        let key = session.target.key();
        let (presence, error, copied, expanded, can, help) = self.with_state(|state| {
            let presence = state.presence_of(session);
            (
                presence,
                state.relay_errors.get(&key).cloned(),
                state.copied.contains(&key),
                state.expanded_sessions.contains(&key),
                state.can_toggle(session, presence),
                state.switch_help(session, presence),
            )
        });
        let title = shown_title(session).to_string();
        let name = session
            .registration
            .as_ref()
            .map(|r| r.display_name().to_string());
        let outer = vbox(0, &[]);
        let content = hbox(10, &[]);
        content.set_margin_start(8);
        content.set_margin_end(6);
        let dot = Dot::new(10);
        let (color, filled) = presence_dot(presence);
        dot.set(color, filled);
        let badge = with_dot(
            &widgets::hosted_agent_badge(session.target.kind.source(), 28, session.host.as_deref()),
            &dot,
        );
        badge.set_opacity(if presence == Presence::Leaving {
            0.55
        } else {
            1.0
        });
        badge.set_valign(gtk::Align::Center);
        content.append(&badge);
        let words = vbox(2, &[]);
        words.set_valign(gtk::Align::Center);
        words.set_hexpand(true);
        words.append(&text(&title, &["row-title"]).ellipsized());
        let (line, class) = match (&name, copied) {
            (Some(name), true) => (format!("Copied @{name}"), "ok"),
            _ => {
                let (line, tone) =
                    session_subtitle(session, presence, error.as_deref(), super::now_ms());
                let class = match tone {
                    Tone::Muted => "secondary",
                    Tone::Accent => "accent",
                    Tone::Warn => "warn",
                };
                (line, class)
            }
        };
        words.append(&text(&line, &["row-subtitle", class]).ellipsized());
        content.append(&words);
        let toggle_key = key.clone();
        content.append(&chevron(
            expanded,
            "details",
            self.on(move |app| app.toggle_session_details(&toggle_key)),
        ));
        let switch = gtk::Switch::new();
        crate::linux_app::ui::widgets::action_cursor(&switch);
        switch.set_valign(gtk::Align::Center);
        switch.set_active(presence.is_on());
        switch.set_state(presence.is_on());
        switch.set_sensitive(can);
        switch.set_tooltip_text(Some(help));
        switch.set_widget_name(&format!("relay-switch {key}"));
        widgets::name(
            &switch,
            &if presence.is_on() {
                format!("Take {title} off the relay")
            } else {
                format!("Put {title} on the relay")
            },
        );
        let weak = self.downgrade();
        let switched = session.clone();
        switch.connect_state_set(move |_, on| {
            if let Some(app) = weak.upgrade() {
                app.toggle_relay(&switched, on);
            }
            glib::Propagation::Stop
        });
        content.append(&switch);
        let row = hover_row(&content, 50);
        let copyable = name.is_some() && !presence.is_changing();
        row.set_tooltip_text(Some(&match &name {
            Some(name) if copyable => format!("Copy @{name} — {}", presence.detail()),
            _ => help.to_string(),
        }));
        let weak = self.downgrade();
        let pressed = session.clone();
        let anchor = row.downgrade();
        on_press(&row, move |button, x, y| {
            let (Some(app), Some(anchor)) = (weak.upgrade(), anchor.upgrade()) else {
                return;
            };
            app.session_pressed(&pressed, &anchor, button, x, y);
        });
        outer.append(&row);
        if expanded {
            let detail = self.agent_detail(session, presence);
            detail.set_margin_start(46);
            detail.set_margin_end(8);
            detail.set_margin_bottom(12);
            outer.append(&detail);
        }
        outer.upcast()
    }

    /// A click on a session's row: a settled row on the relay copies its
    /// name; any other row toggles, as its switch does. The context menu
    /// copies and shows details.
    fn session_pressed(
        &self,
        session: &LocalSession,
        anchor: &gtk::Box,
        button: u32,
        x: f64,
        y: f64,
    ) {
        let key = session.target.key();
        let registration = session.registration.clone();
        if button == 3 {
            let expanded = self.with_state(|state| state.expanded_sessions.contains(&key));
            let mut items: MenuItems = Vec::new();
            if let Some(registration) = &registration {
                let name = format!("@{}", registration.display_name());
                items.push((
                    format!("Copy {name}"),
                    Some(Box::new(move || widgets::copy_to_clipboard(&name))),
                ));
                let address = registration.address.clone();
                items.push((
                    "Copy exact address".into(),
                    (!address.is_empty()).then(|| {
                        Box::new(move || widgets::copy_to_clipboard(&address)) as Callback
                    }),
                ));
                items.push(("-".into(), None));
            }
            let toggle = key.clone();
            items.push((
                if expanded {
                    "Hide Details"
                } else {
                    "Show Details"
                }
                .into(),
                Some(Box::new(
                    self.on(move |app| app.toggle_session_details(&toggle)),
                )),
            ));
            menu(anchor, Some((x, y)), items);
            return;
        }
        if button != 1 {
            return;
        }
        let (presence, can) = self.with_state(|state| {
            let presence = state.presence_of(session);
            (presence, state.can_toggle(session, presence))
        });
        match registration {
            Some(registration) if !presence.is_changing() => {
                self.copy_name(&key, registration.display_name());
            }
            _ if can => self.toggle_relay(session, !presence.is_on()),
            _ => {}
        }
    }

    /// Copies `@name` and says so on the row `key` for a moment.
    fn copy_name(&self, key: &str, name: &str) {
        widgets::copy_to_clipboard(&format!("@{name}"));
        self.update_state(|state| state.copied.insert(key.to_string()));
        self.render_page();
        let key = key.to_string();
        glib::timeout_add_local_once(
            COPIED_FOR,
            self.on(move |app| {
                if app.update_state(|state| state.copied.remove(&key)) {
                    app.render_page();
                }
            }),
        );
    }

    pub fn toggle_session_details(&self, key: &str) {
        self.update_state(|state| {
            if !state.expanded_sessions.remove(key) {
                state.expanded_sessions.insert(key.to_string());
            }
        });
        self.render_page();
    }

    /// What a row keeps out of the list: where the session runs, its ids
    /// and upload, then the tools for an agent on the relay.
    fn agent_detail(&self, session: &LocalSession, presence: Presence) -> gtk::Box {
        let panel = vbox(10, &["detail-panel"]);
        let inner = vbox(10, &[]);
        widgets::pad(&inner, 12, None, None);
        panel.append(&inner);
        let (registration, target) = (session.registration.as_ref(), &session.target);
        let mut rows: Vec<(&str, gtk::Widget)> = Vec::new();
        if let Some(registration) =
            registration.filter(|registration| !registration.address.is_empty())
        {
            let address = hbox(6, &[]);
            address.append(&text(&registration.address, &["detail-value", "mono"]).copyable());
            let copied = registration.address.clone();
            address.append(&icon_button(
                "edit-copy-symbolic",
                "Copy exact address",
                &["icon"],
                move || widgets::copy_to_clipboard(&copied),
            ));
            let endpoint = registration.address.clone();
            let message = button(
                "Message",
                &["link"],
                self.on(move |app| app.show_message_composer(&endpoint)),
            );
            message.set_tooltip_text(Some("Message this exact endpoint"));
            address.append(&message);
            rows.push(("Address", address.upcast()));
        }
        let (status, upload, published) = self.with_state(|state| {
            let status = if presence == Presence::Off {
                state.switch_help(session, presence).to_string()
            } else {
                presence.detail().to_string()
            };
            let upload = state.upload_entry(session).map(|entry| {
                (
                    entry.clone(),
                    SessionUploadState::of(entry, state.status.as_ref()),
                )
            });
            let published = state
                .roster
                .iter()
                .find(|agent| agent.session_id.as_deref() == Some(target.id.as_str()))
                .map(|agent| agent.description.clone())
                .unwrap_or_default();
            (status, upload, published)
        });
        rows.push(("Status", fact(&status)));
        rows.extend(self.join_fact(session));
        if let Some((entry, state)) = upload {
            let line = hbox(6, &[]);
            line.append(&text(state.title(), &["detail-value"]));
            let uploaded = state == SessionUploadState::Uploaded;
            line.append(&button(
                if uploaded {
                    "Open in Cloud"
                } else {
                    "Show in Sessions"
                },
                &["link"],
                self.on(move |app| app.open_session(&entry)),
            ));
            rows.push(("Upload", line.upcast()));
        }
        rows.push((
            "Kind",
            fact(&hosted_kind_label(target.kind, session.host.as_deref())),
        ));
        if let Some(directory) = session
            .directory
            .as_deref()
            .filter(|directory| !directory.is_empty())
        {
            rows.push((
                "Folder",
                text(directory, &["detail-value"])
                    .ellipsized()
                    .copyable()
                    .upcast(),
            ));
        }
        rows.push((
            "Session",
            text(&target.id, &["detail-value", "mono"])
                .ellipsized()
                .copyable()
                .upcast(),
        ));
        if let Some(updated) = session
            .updated_at_ms
            .filter(|updated| *updated > 0 && target.kind == SessionKind::Codex)
        {
            rows.push((
                "Last active",
                fact(&relative_ms(Some(updated), super::now_ms())),
            ));
        }
        if registration.is_some_and(|registration| registration.added_by_session) {
            rows.push(("", text("added by the session", &["caption"]).upcast()));
        }
        inner.append(&fact_grid(rows));
        if registration.is_none() {
            let name_row = hbox(6, &[]);
            let entry = gtk::Entry::new();
            entry.set_placeholder_text(Some("new relay name"));
            widgets::name(&entry, "New relay name");
            name_row.append(&text("@", &["secondary"]));
            name_row.append(&entry);
            let retry_entry = entry.clone();
            let retry_target = target.clone();
            let retry = button(
                "Set Name & Retry",
                &[],
                self.on(move |app| {
                    let name = retry_entry.text().trim().to_string();
                    if !name.is_empty() {
                        app.register_session_with_name(retry_target.clone(), name);
                    }
                }),
            );
            retry.set_sensitive(false);
            let sensitivity = retry.clone();
            entry.connect_changed(move |entry| {
                sensitivity.set_sensitive(!entry.text().trim().is_empty());
            });
            name_row.append(&retry);
            inner.append(&name_row);
            inner.append(&text("Relay names are unique across your workspace. Choose another name to put this session on the relay.", &["caption", "secondary"]).wrapped());
        }

        if registration.is_some() {
            inner.append(&self.overview_card(&target.id, &published));
        }
        let key = target.key();
        let agent = self.with_state(|state| state.agent_for(session).cloned());
        let Some(shell) = self.shell() else {
            return panel;
        };
        // Tools are kept across redraws (typed text, a new webhook's token)
        // only while the session is an agent on the relay.
        if agent.is_none() {
            shell.pages.tools.borrow_mut().remove(&key);
        }
        if let Some(agent) = agent {
            let tools = shell.pages.tools.borrow().get(&key).cloned();
            let tools = tools.unwrap_or_else(|| {
                let expanded = self.with_state(|state| state.expanded_tools.contains(&key));
                let tools = AgentTools::build(self, expanded, &key);
                shell
                    .pages
                    .tools
                    .borrow_mut()
                    .insert(key.clone(), tools.clone());
                tools
            });
            detach(&tools.expander);
            inner.append(&tools.expander);
            tools.update(&agent);
        }
        panel
    }

    /// An agent's upload: its Cloud page once uploaded, else its row in My
    /// sessions.
    pub fn open_session(&self, entry: &UploadSession) {
        if SessionUploadState::of(entry, None) == SessionUploadState::Uploaded {
            self.open_cloud(entry);
            return;
        }
        let title = crate::linux_app::models::session_title(entry);
        self.update_state(|state| {
            state.session_search = title;
            state.session_source = None;
        });
        self.go_sessions(crate::linux_app::models::SessionFilter::All);
    }

    // Overviews.

    /// Reads the session's saved Cloud brief; one still being generated is
    /// read again every 5 seconds while its account view shows.
    pub fn load_overview(&self, session_id: &str) {
        let previous = self.update_state(|state| {
            if session_id.is_empty() || !state.loading_overviews.insert(session_id.to_string()) {
                return None;
            }
            Some(
                state
                    .overviews
                    .entry(session_id.to_string())
                    .or_insert(Overview {
                        status: OverviewStatus::Loading,
                        ..Overview::default()
                    })
                    .clone(),
            )
        });
        let Some(previous) = previous else {
            return;
        };
        let id = session_id.to_string();
        self.view_call::<method::SessionsOverviewGet>(
            SessionOverviewParams {
                session_id: id.clone(),
            },
            move |app, result| {
                let needs_sign_in = needs_sign_in(&result);
                let overview = result
                    .map_err(|error| error.message)
                    .and_then(|value| {
                        parse_overview(&value, &id, None).map_err(|wrong| wrong.to_string())
                    })
                    .unwrap_or_else(|error| Overview {
                        status: OverviewStatus::Failed,
                        title: previous.title.clone(),
                        description: previous.description.clone(),
                        error: Some(error),
                    });
                let pending = overview.pending();
                let generation = app.update_state(|state| {
                    state.loading_overviews.remove(&id);
                    state.overviews.insert(id.clone(), overview);
                    state.overview_needs_sign_in = needs_sign_in;
                    state.generation
                });
                if pending {
                    let id = id.clone();
                    glib::timeout_add_local_once(
                        Duration::from_secs(5),
                        app.on(move |app| {
                            // Asked again only for the account view that asked.
                            if app.with_state(|state| state.generation) == generation {
                                app.load_overview(&id);
                            }
                        }),
                    );
                }
                app.relay_changed();
            },
        );
    }

    /// Reads, once, the request the session was started for: the fallback
    /// when it has no brief.
    fn load_goal(&self, session_id: &str) {
        let start = self.update_state(|state| {
            !session_id.is_empty()
                && !state.goals.contains_key(session_id)
                && state.loading_goals.insert(session_id.to_string())
        });
        if !start {
            return;
        }
        let id = session_id.to_string();
        self.view_call::<method::SessionsOverviewEvents>(
            SessionOverviewParams {
                session_id: id.clone(),
            },
            move |app, result| {
                // Asked once: the saved summary and published description
                // still work without History's events.
                let goal = result
                    .ok()
                    .and_then(|value| parse_goal(&value, &id).ok().flatten())
                    .unwrap_or_default();
                let found = !goal.is_empty();
                app.update_state(|state| {
                    state.loading_goals.remove(&id);
                    state.goals.insert(id.clone(), goal);
                });
                if found {
                    app.relay_changed();
                }
            },
        );
    }

    /// Asks Cloud to generate the session's brief.
    pub fn request_overview(&self, session_id: &str) {
        let pending = self.with_state(|state| {
            state
                .overviews
                .get(session_id)
                .is_some_and(Overview::pending)
        });
        if session_id.is_empty() || pending {
            return;
        }
        let id = session_id.to_string();
        self.view_call::<method::SessionsOverviewRequest>(
            SessionOverviewParams {
                session_id: id.clone(),
            },
            move |app, result| {
                let failed = app.update_state(|state| {
                    state.overview_needs_sign_in = needs_sign_in(&result);
                    let previous = state.overviews.get(&id).cloned().unwrap_or_default();
                    let (status, error) = match &result {
                        Err(error) => (OverviewStatus::Failed, Some(error.message.clone())),
                        Ok(_) => (OverviewStatus::Queued, None),
                    };
                    state.overviews.insert(
                        id.clone(),
                        Overview {
                            status,
                            error,
                            ..previous
                        },
                    );
                    result.is_err()
                });
                app.relay_changed();
                if !failed {
                    app.load_overview(&id);
                }
            },
        );
    }

    /// The agent overview: Cloud's brief of the session, else what it
    /// published and the request it started for.
    pub(super) fn overview_card(&self, session_id: &str, published: &str) -> gtk::Box {
        if !self.with_state(|state| state.overviews.contains_key(session_id)) {
            self.load_overview(session_id);
        }
        self.load_goal(session_id);
        let (overview, goal) = self.with_state(|state| {
            (
                state.overviews.get(session_id).cloned(),
                state.goals.get(session_id).cloned().unwrap_or_default(),
            )
        });
        let card = vbox(6, &["overview"]);
        let top = hbox(6, &[]);
        let heading = hbox(6, &[]);
        heading.set_hexpand(true);
        heading.append(&icon("starred-symbolic", 12));
        heading.append(&text("Agent overview", &["tool-heading"]));
        top.append(&heading);
        let has_brief = overview.as_ref().is_some_and(Overview::has_brief);
        let id = session_id.to_string();
        let generate = button(
            if has_brief { "Regenerate" } else { "Generate" },
            &[],
            self.on(move |app| app.request_overview(&id)),
        );
        generate.set_sensitive(!overview.as_ref().is_some_and(|overview| {
            overview.pending() || overview.status == OverviewStatus::Loading
        }));
        top.append(&generate);
        card.append(&top);
        match overview.as_ref().filter(|overview| overview.has_brief()) {
            Some(overview) => {
                card.append(&text(&overview.title, &["row-title"]).wrapped());
                card.append(&text(&overview.description, &["caption"]).wrapped());
            }
            None => {
                if !published.is_empty() {
                    card.append(&text("Published description", &["tool-heading"]));
                    card.append(&text(published, &["caption"]).wrapped());
                }
                if !goal.is_empty() {
                    card.append(&text("Original request", &["tool-heading"]));
                    card.append(&text(&goal, &["caption"]).wrapped());
                }
                let hint = if overview
                    .as_ref()
                    .is_some_and(|overview| overview.status == OverviewStatus::Loading)
                {
                    "Checking for a saved summary…"
                } else if published.is_empty() {
                    "Generate a short summary to see what this agent is working on."
                } else {
                    "Generate a Cloud summary for more detail."
                };
                card.append(&text(hint, &["caption"]).wrapped());
            }
        }
        if let Some(overview) = overview.as_ref().filter(|overview| overview.pending()) {
            card.append(&text(
                if overview.status == OverviewStatus::Queued {
                    "Summary queued. This may take a few minutes."
                } else {
                    "Generating summary…"
                },
                &["caption"],
            ));
        }
        if let Some(error) = overview
            .as_ref()
            .and_then(|overview| overview.error.as_deref())
        {
            card.append(&text(error, &["warn", "caption"]).wrapped());
            let (needs_sign_in, renewing) = self.with_state(|state| {
                (
                    state.overview_needs_sign_in,
                    state.renew_requested || state.approving_change(),
                )
            });
            if needs_sign_in {
                let sign_in = button(
                    if renewing {
                        "Waiting for the browser…"
                    } else {
                        "Sign in again"
                    },
                    &[],
                    self.on(|app| app.renew_sign_in()),
                );
                sign_in.set_sensitive(!renewing);
                sign_in.set_halign(gtk::Align::Start);
                card.append(&sign_in);
            }
        }
        card
    }

    // Roster rows: agents elsewhere, yours or a teammate's.

    pub(super) fn roster_row(&self, agent: &RosterAgent) -> gtk::Widget {
        let address = agent.address.clone().filter(|address| !address.is_empty());
        let key = address
            .clone()
            .unwrap_or_else(|| format!("@{}", agent.name));
        let (expanded, summary) = self.with_state(|state| {
            let summary = agent.session_id.as_ref().and_then(|id| {
                state
                    .overviews
                    .get(id)
                    .map(|overview| overview.title.clone())
                    .filter(|title| !title.is_empty())
                    .or_else(|| state.goals.get(id).cloned().filter(|goal| !goal.is_empty()))
            });
            (state.expanded_roster.contains(&key), summary)
        });
        let outer = vbox(0, &[]);
        let content = hbox(10, &[]);
        content.set_margin_start(8);
        content.set_margin_end(6);
        // Working is a filled dot, idle a ring, as on a fleet worker.
        let dot = Dot::new(8);
        dot.set(Some(Color::Green), agent.liveness == Liveness::Live);
        // The harness mark when the registering desktop said which it is; a
        // generic glyph for people and services.
        let source = agent
            .provider
            .clone()
            .filter(|provider| !provider.is_empty())
            .unwrap_or_else(|| {
                if agent.kind.is_empty() {
                    "agent".into()
                } else {
                    agent.kind.clone()
                }
            });
        let badge = with_dot(&agent_badge(&source, 28), &dot);
        badge.set_valign(gtk::Align::Center);
        content.append(&badge);
        let words = vbox(2, &[]);
        words.set_valign(gtk::Align::Center);
        words.set_hexpand(true);
        words.append(&text(&key, &["row-title", "mono"]).ellipsized());
        let line = agent_line(
            summary.as_deref(),
            None,
            &agent.description,
            &agent.status,
            agent.last_seen_ms,
            super::now_ms(),
            &chrono::Local,
        );
        words.append(&text(&line, &["row-subtitle"]).ellipsized());
        // An idle agent is offered, dimmed.
        if agent.liveness == Liveness::Idle {
            words.set_opacity(0.6);
        }
        content.append(&words);
        let endpoint = key.clone();
        let message = button(
            "Message",
            &[],
            self.on(move |app| app.show_message_composer(&endpoint)),
        );
        message.set_valign(gtk::Align::Center);
        message.set_sensitive(address.is_some());
        message.set_tooltip_text(Some(if address.is_some() {
            "Message this exact endpoint"
        } else {
            "This agent did not advertise an exact address."
        }));
        content.append(&message);
        let toggle = key.clone();
        content.append(&chevron(
            expanded,
            "agent details",
            self.on(move |app| app.toggle_roster(&toggle)),
        ));
        let row = hover_row(&content, 48);
        let weak = self.downgrade();
        let anchor = row.downgrade();
        let menu_key = key.clone();
        let menu_address = address.clone();
        on_press(&row, move |button, x, y| {
            let (Some(app), Some(anchor)) = (weak.upgrade(), anchor.upgrade()) else {
                return;
            };
            if button != 3 {
                return;
            }
            let mut items: MenuItems = Vec::new();
            let message = menu_address.clone();
            items.push((
                "Message…".into(),
                message.map(|endpoint| {
                    Box::new(app.on(move |app| app.show_message_composer(&endpoint))) as Callback
                }),
            ));
            let toggle = menu_key.clone();
            items.push((
                if expanded {
                    "Hide Details"
                } else {
                    "Show Details"
                }
                .into(),
                Some(Box::new(app.on(move |app| app.toggle_roster(&toggle)))),
            ));
            if let Some(address) = menu_address.clone() {
                items.push((
                    "Copy Address".into(),
                    Some(Box::new(move || widgets::copy_to_clipboard(&address))),
                ));
            }
            menu(&anchor, Some((x, y)), items);
        });
        outer.append(&row);
        if expanded {
            let mut facts: Vec<(&str, gtk::Widget)> = vec![(
                "Task",
                fact(
                    &agent_task(&agent.description)
                        .unwrap_or_else(|| "Task details unavailable".into()),
                ),
            )];
            let mentions = agent_mentions(&agent.description);
            if !mentions.is_empty() {
                facts.push(("Mentions", fact(&mentions.join(", "))));
            }
            let status = if agent.status.is_empty() {
                "Unknown".to_string()
            } else {
                let mut letters = agent.status.chars();
                letters
                    .next()
                    .map(|first| first.to_uppercase().chain(letters).collect())
                    .unwrap_or_default()
            };
            facts.push(("Status", fact(&status)));
            if let Some(seen) = agent.last_seen_ms.filter(|seen| *seen > 0) {
                facts.push((
                    "Last seen",
                    fact(&crate::linux_app::models::clock_ms(
                        Some(seen),
                        &chrono::Local,
                    )),
                ));
            }
            facts.push((
                "Location",
                fact(&crate::linux_app::models::where_label(agent)),
            ));
            if let Some(host) = agent.host.as_deref().filter(|host| !host.is_empty()) {
                facts.push(("Host", fact(host)));
            }
            let details = vbox(6, &[]);
            details.set_margin_start(46);
            details.set_margin_end(8);
            details.set_margin_bottom(12);
            details.append(&fact_grid(facts));
            if let Some(session) = &agent.session_id {
                details.append(&self.overview_card(session, &agent.description));
            }
            details.append(&text(
                "Recent activity is unavailable.",
                &["tertiary", "caption"],
            ));
            outer.append(&details);
        }
        outer.upcast()
    }

    pub fn toggle_roster(&self, key: &str) {
        self.update_state(|state| {
            if !state.expanded_roster.remove(key) {
                state.expanded_roster.insert(key.to_string());
            }
        });
        self.render_page();
    }
}

/// Cloud turned the call away because the core holds no session to make it
/// as the person: signing in again fixes it.
fn needs_sign_in<T>(result: &Result<T, crate::linux_app::bridge::CoreError>) -> bool {
    matches!(result, Err(error) if error.kind() == Some(ErrorKind::NotSignedIn))
}

/// An agent that left the relay because its session was archived.
fn archived_row(agent: &ArchivedAgent) -> gtk::Widget {
    let content = hbox(10, &[]);
    content.set_margin_start(8);
    content.set_margin_end(6);
    let image = icon("folder-symbolic", 16);
    image.set_size_request(28, -1);
    image.set_valign(gtk::Align::Center);
    image.add_css_class("dim-label");
    content.append(&image);
    let words = vbox(2, &[]);
    words.set_valign(gtk::Align::Center);
    words.set_hexpand(true);
    words.append(&text(&format!("@{}", agent.name), &["row-title", "dim-label"]).ellipsized());
    words.append(
        &text(
            &archived_detail(&agent.archived_at, super::now_ms()),
            &["row-subtitle"],
        )
        .ellipsized(),
    );
    content.append(&words);
    let row = hover_row(&content, 50);
    row.set_tooltip_text(Some(&if agent.title.is_empty() {
        agent.address.clone()
    } else {
        format!("{} · {}", agent.title, agent.address)
    }));
    let anchor = row.downgrade();
    let address = agent.address.clone();
    on_press(&row, move |button, x, y| {
        let Some(anchor) = anchor.upgrade() else {
            return;
        };
        if button != 3 {
            return;
        }
        let copy = address.clone();
        let copy: Callback = Box::new(move || widgets::copy_to_clipboard(&copy));
        menu(
            &anchor,
            Some((x, y)),
            vec![("Copy Address".into(), Some(copy))],
        );
    });
    row.upcast()
}
