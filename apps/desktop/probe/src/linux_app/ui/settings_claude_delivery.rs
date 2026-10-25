//! Settings › Relay: Claude Code message approvals and consent controls.
use super::app::App;
use super::state::{Page, Pane};
use super::widgets::{self, button, hbox, notice, text, vbox, LabelStyle, Tone};
use crate::relay::contract::claude_delivery::{
    ClaudeDeliverySession, ClaudeDeliveryStatus, ClaudeHeldDelivery, ClaudeHeldParams,
    ClaudeRestrictionParams, ClaudeSender, ClaudeSenderDeliveryParams, ClaudeSessionDeliveryParams,
};
use crate::relay::contract::{method, Method, NoParams};
use gtk::prelude::*;
use gtk4 as gtk;

const APPROVALS_KEY: &str = "settings.claude-message-approvals";

impl App {
    pub(super) fn claude_delivery_section(&self) -> gtk::Box {
        let (status, error) = self.with_state(|state| {
            (
                state.claude_delivery.clone(),
                state.claude_delivery_error.clone(),
            )
        });
        let section = vbox(10, &[]);
        let disclosure = gtk::Expander::new(Some("Claude Code message approvals"));
        disclosure.set_expanded(
            self.with_state(|state| state.settings_details_open.contains(APPROVALS_KEY)),
        );
        let weak = self.downgrade();
        disclosure.connect_expanded_notify(move |expander| {
            if let Some(app) = weak.upgrade() {
                app.update_state(|state| {
                    if expander.is_expanded() {
                        state.settings_details_open.insert(APPROVALS_KEY.into());
                    } else {
                        state.settings_details_open.remove(APPROVALS_KEY);
                    }
                });
            }
        });
        let group = vbox(0, &["settings-group"]);
        disclosure.set_child(Some(&group));
        section.append(&disclosure);
        let body = vbox(12, &[]);
        widgets::pad(&body, 16, None, None);
        body.append(
            &text(
                "Choose which Claude Code sessions and workspace members may receive messages directly. Ask first holds each message in Agent Relay for your approval.",
                &["caption"],
            )
            .wrapped(),
        );
        let restricted = status.as_ref().is_some_and(|status| status.restricted);
        let weak = self.downgrade();
        let restriction = gtk::CheckButton::with_label("Only allowed members may deliver directly");
        restriction.set_active(restricted);
        restriction.connect_toggled(move |check| {
            if let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) {
                let restricted = check.is_active();
                app.claude_delivery_change::<method::ClaudeDeliveryRestrict>(
                    ClaudeRestrictionParams { restricted },
                    move |status| status.restricting(restricted),
                );
            }
        });
        body.append(&restriction);
        if restricted
            && status
                .as_ref()
                .is_none_or(|status| status.allowed_senders.is_empty())
        {
            body.append(&text(
                "No members are allowed yet. Their messages will wait for approval.",
                &["caption"],
            ));
        }
        if let Some(error) = error {
            body.append(&notice(&error, Tone::Error));
        }
        if let Some(status) = status {
            self.claude_approval_sessions(&body, status.sessions);
            self.claude_approval_senders(&body, status.allowed_senders);
            self.claude_approval_messages(&body, status.held);
        }
        body.append(&button(
            "Refresh",
            &[],
            self.on(App::refresh_claude_delivery),
        ));
        group.append(&body);
        section
    }

    pub fn refresh_claude_delivery(&self) {
        self.read_claude_delivery(false);
    }

    // Reconciliation keeps the current mutation error, including while another
    // change is in flight; it never restores an error captured before a read.
    fn read_claude_delivery(&self, preserve_error: bool) {
        // Numbered as it starts: it lists only what the core took before.
        let read = self.update_state(|state| state.claude_delivery_pending.begin_read());
        self.once::<method::ClaudeDeliveryStatus>(
            "claude-delivery",
            NoParams {},
            if preserve_error {
                |app| app.read_claude_delivery(true)
            } else {
                App::refresh_claude_delivery
            },
            move |app, result| {
                let interrupted = crate::linux_app::bridge::CoreError::interrupted().message;
                app.update_state(|state| match result {
                    Ok(status) => {
                        state.claude_delivery_read(read, status);
                        if !preserve_error
                            && state.claude_delivery_error.as_ref() != Some(&interrupted)
                        {
                            state.claude_delivery_error = None;
                        }
                    }
                    Err(error) => {
                        if !preserve_error
                            && state.claude_delivery_error.as_ref() != Some(&interrupted)
                        {
                            state.claude_delivery_error = Some(error.message);
                        }
                    }
                });
                if app.page() == Page::Settings(Pane::Relay) {
                    app.render_settings();
                }
            },
        );
    }

    /// Makes one change: the list shows `optimistic` at once, over every
    /// read until the core has taken it and listed it; a refusal takes it
    /// away again and says why.
    fn claude_delivery_change<M>(
        &self,
        params: M::Params,
        optimistic: impl Fn(ClaudeDeliveryStatus) -> ClaudeDeliveryStatus + 'static,
    ) where
        M: Method + 'static,
        M::Params: Send + 'static,
        M::Result: Send + 'static,
    {
        let token = self.show_claude_delivery(optimistic);
        self.view_call::<M>(params, move |app, result| {
            app.settle_claude_delivery(token, result.err().map(|error| error.message));
        });
    }

    /// Shows `optimistic` over the status; returns the change's token for
    /// `settle_claude_delivery`.
    fn show_claude_delivery(
        &self,
        optimistic: impl Fn(ClaudeDeliveryStatus) -> ClaudeDeliveryStatus + 'static,
    ) -> u64 {
        self.inner
            .claude_delivery_changes
            .set(self.inner.claude_delivery_changes.get() + 1);
        let token = self.update_state(|state| {
            state.claude_delivery_error = None;
            let token = state.claude_delivery_pending.begin(optimistic);
            state.sync_claude_delivery();
            token
        });
        if self.page() == Page::Settings(Pane::Relay) {
            self.render_settings();
        }
        token
    }

    /// The change `token` answered: a refusal stops showing it and says
    /// why; the read after it settles the list.
    fn settle_claude_delivery(&self, token: u64, error: Option<String>) {
        let pending = &self.inner.claude_delivery_changes;
        pending.set(pending.get().saturating_sub(1));
        let refused = error.is_some();
        self.update_state(|state| {
            state
                .claude_delivery_pending
                .answered(token, error.is_none());
            state.sync_claude_delivery();
            state.claude_delivery_error = error;
        });
        if self.page() == Page::Settings(Pane::Relay) {
            self.render_settings();
        }
        self.read_claude_delivery(refused);
    }

    /// Always allow: the sender is allowed, then the held message approved;
    /// both show at once as one change.
    fn claude_delivery_allow_and_approve(&self, id: &str, sender: &str, name: &str) {
        let id = id.to_string();
        let allowed = ClaudeSender {
            address: sender.to_string(),
            name: name.to_string(),
        };
        let approved = id.clone();
        let token = self.show_claude_delivery(move |status| {
            status.allowing(allowed.clone()).without_held(&approved)
        });
        self.view_call::<method::ClaudeDeliverySender>(
            ClaudeSenderDeliveryParams {
                sender: sender.to_string(),
                name: name.to_string(),
                allowed: true,
            },
            move |app, result| match result {
                Ok(_) => app.view_call::<method::ClaudeDeliveryApprove>(
                    ClaudeHeldParams { id },
                    move |app, result| {
                        app.settle_claude_delivery(token, result.err().map(|error| error.message));
                    },
                ),
                Err(error) => app.settle_claude_delivery(token, Some(error.message)),
            },
        );
    }

    fn claude_approval_sessions(&self, body: &gtk::Box, sessions: Vec<ClaudeDeliverySession>) {
        for session in sessions {
            let row = hbox(8, &[]);
            let words = vbox(2, &[]);
            words.set_hexpand(true);
            words.append(&text(
                if session.title.is_empty() {
                    &session.agent
                } else {
                    &session.title
                },
                &["settings-row-title"],
            ));
            words.append(&text(
                if session.direct {
                    "Direct delivery"
                } else {
                    "Ask first"
                },
                &["caption"],
            ));
            row.append(&words);
            let direct = gtk::Switch::new();
            direct.set_active(session.direct);
            let weak = self.downgrade();
            let id = session.id.clone();
            direct.connect_active_notify(move |direct| {
                if let Some(app) = weak.upgrade().filter(|app| !app.inner.updating.get()) {
                    let (session, on) = (id.clone(), direct.is_active());
                    app.claude_delivery_change::<method::ClaudeDeliverySession>(
                        ClaudeSessionDeliveryParams {
                            session_id: id.clone(),
                            direct: on,
                        },
                        move |status| status.with_session(&session, on),
                    );
                }
            });
            row.append(&direct);
            body.append(&row);
        }
    }
    fn claude_approval_senders(&self, body: &gtk::Box, senders: Vec<ClaudeSender>) {
        for sender in senders {
            let row = hbox(8, &[]);
            let words = vbox(2, &[]);
            words.set_hexpand(true);
            words.append(&text(&sender.name, &["settings-row-title"]));
            words.append(&text(&sender.address, &["caption"]));
            row.append(&words);
            let address = sender.address.clone();
            let name = sender.name.clone();
            row.append(&button(
                "Remove",
                &[],
                self.on(move |app| {
                    let removed = address.clone();
                    app.claude_delivery_change::<method::ClaudeDeliverySender>(
                        ClaudeSenderDeliveryParams {
                            sender: address.clone(),
                            name: name.clone(),
                            allowed: false,
                        },
                        move |status| status.without_sender(&removed),
                    )
                }),
            ));
            body.append(&row);
        }
    }
    fn claude_approval_messages(&self, body: &gtk::Box, messages: Vec<ClaudeHeldDelivery>) {
        for message in messages {
            let item = vbox(4, &[]);
            item.append(&text(
                &format!("{} → @{}", message.sender_name, message.agent),
                &["settings-row-title"],
            ));
            let words = text(&message.text, &[]).wrapped().copyable();
            words.set_lines(8);
            words.set_ellipsize(gtk::pango::EllipsizeMode::End);
            item.append(&words);
            let actions = hbox(8, &[]);
            let id = message.id.clone();
            actions.append(&button(
                "Approve once",
                &["primary"],
                self.on(move |app| {
                    let approved = id.clone();
                    app.claude_delivery_change::<method::ClaudeDeliveryApprove>(
                        ClaudeHeldParams { id: id.clone() },
                        move |status| status.without_held(&approved),
                    )
                }),
            ));
            if !message.sender.is_empty() {
                let id = message.id.clone();
                let sender = message.sender.clone();
                let name = message.sender_name.clone();
                actions.append(&button(
                    "Always allow",
                    &[],
                    self.on(move |app| app.claude_delivery_allow_and_approve(&id, &sender, &name)),
                ));
            }
            let id = message.id.clone();
            actions.append(&button(
                "Dismiss",
                &[],
                self.on(move |app| {
                    let dismissed = id.clone();
                    app.claude_delivery_change::<method::ClaudeDeliveryDismiss>(
                        ClaudeHeldParams { id: id.clone() },
                        move |status| status.without_held(&dismissed),
                    )
                }),
            ));
            item.append(&actions);
            body.append(&item);
        }
    }
}
