//! Messages: open conversations on the left, the one shown on the right,
//! opened by any name or exact `agent@machine` address; and Recent
//! Messages, what was delivered into sessions on the relay.
//!
//! Each open conversation follows its recipient on the roster
//! (`roster.get`): before a send it warns when the agent is not running,
//! after one it shows what Relaycast holds for the message
//! (`docs/agents-people.md`, "Recipient liveness and message state"), and
//! whether a reply is expected. The recipient is read when the
//! conversation is shown and two seconds after a send. On `sessions`,
//! `fleet`, `roster` and `messages` invalidations and every 10 s it is read
//! for the conversation shown and for any whose last message has no final
//! state yet; one read per conversation runs at a time, and a closed
//! conversation is no longer read.

use super::app::App;
use super::state::Page;
use super::widgets::{self, button, clear, hbox, icon, text, vbox, LabelStyle};
use crate::linux_app::models::{
    activity_body, activity_heading, delivery_note, endpoint_label, queues, recipient_params,
    recipient_warning, relative_ms, reply_note, DeliveryTone,
};
use crate::relay::contract::directory::{History, HistoryParams, Recipient, SendParams};
use crate::relay::contract::method;
use crate::relay::delivery::DeliveryOutcome;
use crate::relay::people::MessageState;
use crate::relay::protocol::ErrorKind;
use gtk::{gdk, glib, prelude::*};
use gtk4 as gtk;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

mod send;

/// How often an open conversation is read without being asked.
const FOLLOW_EVERY: Duration = Duration::from_secs(10);
/// How long after a send its state is read again.
const RECHECK_AFTER: Duration = Duration::from_secs(2);

/// The line under a conversation before anything is known.
const EXACT_ADDRESS: &str = "An exact address reaches only that agent on that machine.";

/// The stack's child while no conversation is open.
const EMPTY: &str = "empty";

/// A message sent, and the last state Relaycast reported for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LastSend {
    pub message_id: Option<String>,
    pub state: Option<MessageState>,
}

/// What an open conversation knows.
#[derive(Default)]
pub struct ChatState {
    /// The ids of the messages shown, in order.
    pub shown: Vec<String>,
    loading: bool,
    pending: bool,
    pub sending: bool,
    pub unread: bool,
    /// The roster's latest record of the recipient.
    pub recipient: Option<Recipient>,
    recipient_reads: u64,
    recipient_loading: bool,
    recipient_pending: bool,
    pub last_send: Option<LastSend>,
    /// Why the last send failed.
    pub error: Option<String>,
    /// The message just sent, shown under "You" as on its way until the
    /// history lists it; `echo_sent` once the core took it.
    pub echoes: Vec<send::Echo>,
    echo_token: u64,
}

/// One open conversation: its page in the stack and its row in the list.
pub struct Chat {
    /// The name or address it was opened with.
    pub key: String,
    pub label: String,
    page: gtk::Box,
    row: gtk::ListBoxRow,
    name: gtk::Label,
    pub messages: gtk::Box,
    scroll: gtk::ScrolledWindow,
    /// Who you message as, or why the history could not be read.
    pub status: gtk::Label,
    /// Whether the recipient runs, or what the last send met.
    pub delivery: gtk::Label,
    /// Whether a reply is expected.
    pub reply: gtk::Label,
    pub text: gtk::TextView,
    pub send: gtk::Button,
    pub state: RefCell<ChatState>,
    timer: RefCell<Option<glib::SourceId>>,
    /// The echoes' rows while shown.
    echo_rows: RefCell<Vec<gtk::Box>>,
}

impl Chat {
    fn body(&self) -> String {
        let buffer = self.text.buffer();
        buffer
            .text(&buffer.start_iter(), &buffer.end_iter(), false)
            .trim()
            .to_string()
    }
}

/// The page: the conversation list and the conversation shown.
pub struct MessagesPage {
    pub root: gtk::Box,
    pub recipient: gtk::Entry,
    pub recipient_error: gtk::Label,
    list: gtk::ListBox,
    stack: gtk::Stack,
    chats: RefCell<Vec<Rc<Chat>>>,
    shown: RefCell<Option<String>>,
    /// Most recently viewed last, so closing a conversation returns to the
    /// one read before it.
    recent: RefCell<Vec<String>>,
    /// Set while the list's selection follows the conversation shown.
    selecting: Cell<bool>,
    /// The Recent Messages window and its rows, while open.
    activity: RefCell<Option<(gtk::Window, gtk::Box)>>,
}

impl MessagesPage {
    pub fn build() -> MessagesPage {
        let root = hbox(0, &[]);
        let side = vbox(8, &["sidebar"]);
        widgets::pad(&side, 14, None, None);
        side.set_size_request(230, -1);
        side.append(&text("Conversations", &["settings-row-title"]));
        let recipient = gtk::Entry::new();
        recipient.set_placeholder_text(Some("agent@machine or @name"));
        recipient.set_tooltip_text(Some("Open one exact endpoint, or a name"));
        widgets::name(&recipient, "Open a conversation");
        side.append(&recipient);
        let recipient_error = text("", &["error", "caption"]).wrapped();
        recipient_error.set_visible(false);
        side.append(&recipient_error);
        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::Single);
        list.add_css_class("conversations");
        side.append(&widgets::scrolled(&list));
        root.append(&side);
        root.append(&gtk::Separator::new(gtk::Orientation::Vertical));
        let stack = gtk::Stack::new();
        stack.set_transition_type(gtk::StackTransitionType::None);
        stack.set_hexpand(true);
        let empty = vbox(8, &[]);
        empty.set_valign(gtk::Align::Center);
        empty.set_halign(gtk::Align::Center);
        empty.append(&text(Page::Messages.title(), &["placeholder-title"]).centered());
        empty.append(
            &text(Page::Messages.subtitle(), &["secondary"])
                .wrapped()
                .centered(),
        );
        empty.append(
            &text(
                "Type a name or an agent@machine address to open a conversation.",
                &["caption"],
            )
            .wrapped()
            .centered(),
        );
        stack.add_named(&empty, Some(EMPTY));
        root.append(&stack);
        MessagesPage {
            root,
            recipient,
            recipient_error,
            list,
            stack,
            chats: RefCell::default(),
            shown: RefCell::new(None),
            recent: RefCell::default(),
            selecting: Cell::new(false),
            activity: RefCell::new(None),
        }
    }

    fn chat(&self, key: &str) -> Option<Rc<Chat>> {
        self.chats
            .borrow()
            .iter()
            .find(|chat| chat.key == key)
            .cloned()
    }

    /// Closes Recent Messages and stops following every conversation.
    pub fn close_all(&self) {
        let activity = self.activity.borrow_mut().take();
        if let Some((window, _)) = activity {
            window.destroy();
        }
        let chats: Vec<Rc<Chat>> = self.chats.borrow_mut().drain(..).collect();
        for chat in chats {
            if let Some(timer) = chat.timer.borrow_mut().take() {
                timer.remove();
            }
        }
    }
}

/// `Oct 3, 18:45` in local time, from an ISO-8601 instant.
fn message_time(value: Option<&str>) -> String {
    value
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|time| {
            time.with_timezone(&chrono::Local)
                .format("%b %-d, %H:%M")
                .to_string()
        })
        .unwrap_or_default()
}

fn tone_class(tone: DeliveryTone) -> &'static str {
    match tone {
        DeliveryTone::Delivered => "ok",
        DeliveryTone::Waiting => "warn",
        DeliveryTone::Failed => "error",
        DeliveryTone::Unknown => "secondary",
    }
}

fn activity_glyph(outcome: DeliveryOutcome) -> (&'static str, &'static str) {
    match outcome {
        DeliveryOutcome::Injected => ("mail-unread-symbolic", "ok"),
        DeliveryOutcome::Answered => ("mail-replied-symbolic", "ok"),
        DeliveryOutcome::Skipped => ("list-remove-symbolic", "secondary"),
        DeliveryOutcome::Failed => ("dialog-warning-symbolic", "warn"),
        DeliveryOutcome::Waiting => ("alarm-symbolic", "warn"),
        DeliveryOutcome::InDoubt => ("dialog-question-symbolic", "warn"),
    }
}

/// Once a message is picked up or has no recipient, nothing more is
/// learned about it.
fn settled(state: Option<MessageState>) -> bool {
    matches!(
        state,
        Some(MessageState::PickedUp | MessageState::NoSuchAgent)
    )
}

impl App {
    /// Connects the page's own controls; built once with the shell.
    pub(super) fn connect_messages_page(&self, page: &MessagesPage) {
        let open = self.on(App::open_typed_chat);
        page.recipient.connect_activate(move |_| open());
        let weak = self.downgrade();
        page.list.connect_row_selected(move |_, row| {
            let (Some(app), Some(row)) = (weak.upgrade(), row) else {
                return;
            };
            let key = app.with_messages(|page| {
                if page.selecting.get() {
                    return None;
                }
                page.chats
                    .borrow()
                    .iter()
                    .find(|chat| &chat.row == row)
                    .map(|chat| chat.key.clone())
            });
            if let Some(key) = key.flatten() {
                app.select_chat(&key);
            }
        });
        // Ctrl+W closes the conversation shown.
        let keys = gtk::EventControllerKey::new();
        keys.set_propagation_phase(gtk::PropagationPhase::Capture);
        let weak = self.downgrade();
        keys.connect_key_pressed(move |_, key, _, modifiers| {
            if modifiers.contains(gdk::ModifierType::CONTROL_MASK)
                && matches!(key, gdk::Key::w | gdk::Key::W)
            {
                if let Some(app) = weak.upgrade() {
                    if let Some(shown) = app.shown_chat() {
                        app.close_chat(&shown);
                        return glib::Propagation::Stop;
                    }
                }
            }
            glib::Propagation::Proceed
        });
        page.root.add_controller(keys);
    }

    fn with_messages<T>(&self, read: impl FnOnce(&MessagesPage) -> T) -> Option<T> {
        self.shell().map(|shell| read(&shell.pages.messages))
    }

    /// The open conversation with `key`.
    pub fn chat(&self, key: &str) -> Option<Rc<Chat>> {
        self.with_messages(|page| page.chat(key)).flatten()
    }

    /// The conversation shown.
    pub fn shown_chat(&self) -> Option<String> {
        self.with_messages(|page| page.shown.borrow().clone())
            .flatten()
    }

    /// The open conversations, in the list's order.
    pub fn open_chats(&self) -> Vec<String> {
        self.with_messages(|page| {
            page.chats
                .borrow()
                .iter()
                .map(|chat| chat.key.clone())
                .collect()
        })
        .unwrap_or_default()
    }

    /// Opens Messages to `endpoint`; empty, to the field that opens one.
    pub fn show_message_composer(&self, endpoint: &str) {
        self.open_message_composer();
        if !endpoint.trim().is_empty() {
            self.open_chat(endpoint);
        } else if let Some(shell) = self.shell() {
            shell.pages.messages.recipient.grab_focus();
        }
    }

    pub fn render_messages(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.messages;
        if page.chats.borrow().is_empty() {
            page.stack.set_visible_child_name(EMPTY);
        }
    }

    /// Opens the conversation typed in the field.
    pub fn open_typed_chat(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.messages;
        let endpoint = page.recipient.text().trim().to_string();
        let problem = if endpoint.is_empty() {
            Some("Enter an agent name or an agent@machine address.")
        } else if endpoint.chars().any(char::is_whitespace) {
            Some("Names and addresses cannot contain whitespace.")
        } else {
            None
        };
        page.recipient_error.set_text(problem.unwrap_or_default());
        page.recipient_error.set_visible(problem.is_some());
        if problem.is_none() {
            page.recipient.set_text("");
            self.open_chat(&endpoint);
        }
    }

    /// Opens one name or exact `agent@machine` address. The core
    /// validates it on the first read. A conversation is keyed by its
    /// label, so `alice` and `@alice` open the same one.
    pub fn open_chat(&self, endpoint: &str) {
        let Some(shell) = self.shell().filter(|_| !endpoint.trim().is_empty()) else {
            return;
        };
        let key = endpoint_label(endpoint);
        let label = key.clone();
        if self.page() != Page::Messages {
            self.go(Page::Messages);
        }
        let page = &shell.pages.messages;
        if page.chat(&key).is_some() {
            self.select_chat(&key);
            return;
        }
        let view = vbox(10, &[]);
        widgets::pad(&view, 18, None, None);
        let top = hbox(12, &[]);
        let heading = text(&label, &["headline"]).ellipsized();
        heading.set_hexpand(true);
        top.append(&heading);
        let close = button(
            "Close conversation",
            &[],
            self.on({
                let key = key.clone();
                move |app| app.close_chat(&key)
            }),
        );
        close.set_tooltip_text(Some("Ctrl+W"));
        close.set_valign(gtk::Align::Start);
        top.append(&close);
        view.append(&top);
        let messages = vbox(12, &[]);
        widgets::pad(&messages, 12, None, None);
        let scroll = widgets::scrolled(&messages);
        scroll.set_min_content_height(320);
        view.append(&scroll);
        let status = text(
            "You message as your Agent Relay identity, the same one the dashboard uses.",
            &["caption"],
        )
        .wrapped();
        view.append(&status);
        let delivery = text("", &["caption"]).wrapped();
        view.append(&delivery);
        let compose = hbox(10, &[]);
        let typed = gtk::TextView::new();
        typed.set_wrap_mode(gtk::WrapMode::WordChar);
        typed.set_size_request(-1, 64);
        typed.set_hexpand(true);
        typed.add_css_class("compose");
        widgets::name(&typed, "Message");
        compose.append(&typed);
        let send = gtk::Button::with_label("Send");
        crate::linux_app::ui::widgets::action_cursor(&send);
        send.add_css_class("primary");
        send.set_valign(gtk::Align::End);
        compose.append(&send);
        view.append(&compose);
        // Whether a reply is expected: shown once the roster has answered.
        let reply = text("", &["caption"]).wrapped();
        reply.set_visible(false);
        view.append(&reply);
        page.stack.add_named(&view, Some(&key));

        let row = gtk::ListBoxRow::new();
        crate::linux_app::ui::widgets::action_cursor(&row);
        let row_box = hbox(6, &[]);
        widgets::pad(&row_box, 6, None, None);
        let name = text(&label, &[]).ellipsized();
        name.set_hexpand(true);
        row_box.append(&name);
        let dismiss = widgets::icon_button(
            "window-close-symbolic",
            "Close conversation",
            &["icon"],
            self.on({
                let key = key.clone();
                move |app| app.close_chat(&key)
            }),
        );
        row_box.append(&dismiss);
        row.set_child(Some(&row_box));
        page.list.append(&row);

        let chat = Rc::new(Chat {
            key: key.clone(),
            label,
            page: view,
            row,
            name,
            messages,
            scroll,
            status,
            delivery,
            reply,
            text: typed,
            send,
            state: RefCell::default(),
            timer: RefCell::new(None),
            echo_rows: RefCell::new(Vec::new()),
        });
        page.chats.borrow_mut().push(chat.clone());

        // A new message gives the last send's note way to the recipient's
        // state, so a warning about it is never hidden.
        let weak = self.downgrade();
        let edited = key.clone();
        chat.text.buffer().connect_changed(move |buffer| {
            let Some(app) = weak.upgrade() else {
                return;
            };
            let Some(chat) = app.chat(&edited) else {
                return;
            };
            let cleared = {
                let mut state = chat.state.borrow_mut();
                let clear =
                    buffer.char_count() > 0 && (state.last_send.is_some() || state.error.is_some());
                if clear {
                    state.last_send = None;
                    state.error = None;
                }
                clear
            };
            if cleared {
                app.render_delivery(&edited);
            }
        });
        let keys = gtk::EventControllerKey::new();
        let weak = self.downgrade();
        let sent = key.clone();
        keys.connect_key_pressed(move |_, pressed, _, modifiers| {
            if matches!(pressed, gdk::Key::Return | gdk::Key::KP_Enter)
                && !modifiers.contains(gdk::ModifierType::SHIFT_MASK)
            {
                if let Some(app) = weak.upgrade() {
                    app.send_chat(&sent);
                }
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        chat.text.add_controller(keys);
        let send_key = key.clone();
        let send = self.on(move |app| app.send_chat(&send_key));
        chat.send.connect_clicked(move |_| send());
        // The core's invalidations wake a conversation on a reply or a
        // change in its recipient; this catches what the core does not
        // announce, such as a message handed over or a remote agent going
        // offline.
        let weak = self.downgrade();
        let followed = Rc::downgrade(&chat);
        let timer = glib::timeout_add_local(FOLLOW_EVERY, move || {
            match (weak.upgrade(), followed.upgrade()) {
                (Some(app), Some(chat)) => {
                    app.follow_chat(&chat.key);
                    glib::ControlFlow::Continue
                }
                _ => glib::ControlFlow::Break,
            }
        });
        *chat.timer.borrow_mut() = Some(timer);
        self.render_delivery(&key);
        // Shown, it looks its recipient up.
        self.select_chat(&key);
        self.refresh_chat(&key);
    }

    /// Reads the conversation and, when it is followed, its recipient.
    fn follow_chat(&self, key: &str) {
        self.follow_recipient(key);
        self.refresh_chat(key);
    }

    /// Looks the recipient up again for the conversation shown, and for one
    /// whose last message may still change state.
    fn follow_recipient(&self, key: &str) {
        let Some(chat) = self.chat(key) else {
            return;
        };
        let shown = self.shown_chat().as_deref() == Some(key);
        let unsettled = chat
            .state
            .borrow()
            .last_send
            .as_ref()
            .is_some_and(|sent| !settled(sent.state));
        if shown || unsettled {
            self.look_up_recipient(key);
        }
    }

    /// The core said something a followed recipient depends on changed.
    pub(super) fn follow_recipients(&self) {
        for key in self.open_chats() {
            self.follow_recipient(&key);
        }
    }

    /// The core said conversations changed: each open one is read.
    pub(super) fn refresh_chats(&self) {
        for key in self.open_chats() {
            self.refresh_chat(&key);
        }
    }

    /// Reads the recipient and, after a send, what Relaycast holds for the
    /// message. Asked again while a read runs, it reads once more when that
    /// one answers. A read that cannot tell keeps the last state Relaycast
    /// reported; an answer for a closed conversation, or older than a send,
    /// is dropped.
    pub fn look_up_recipient(&self, key: &str) {
        let Some(chat) = self.chat(key) else {
            return;
        };
        if !self.bridge().offers(method::RosterGet::NAME) {
            return;
        }
        let (read, message_id) = {
            let mut state = chat.state.borrow_mut();
            if state.recipient_loading {
                state.recipient_pending = true;
                return;
            }
            state.recipient_loading = true;
            state.recipient_pending = false;
            state.recipient_reads += 1;
            (
                state.recipient_reads,
                state
                    .last_send
                    .as_ref()
                    .and_then(|sent| sent.message_id.clone()),
            )
        };
        let mut params = recipient_params(key);
        params.message_id = message_id.clone();
        let key = key.to_string();
        self.view_call::<method::RosterGet>(params, move |app, result| {
            if !app
                .chat(&key)
                .is_some_and(|current| Rc::ptr_eq(&current, &chat))
            {
                return;
            }
            let again = {
                let mut state = chat.state.borrow_mut();
                state.recipient_loading = false;
                std::mem::take(&mut state.recipient_pending)
            };
            if again {
                let key = key.clone();
                glib::idle_add_local_once(app.on(move |app| app.look_up_recipient(&key)));
            }
            let Ok(recipient) = result else {
                return;
            };
            {
                let mut state = chat.state.borrow_mut();
                if read != state.recipient_reads {
                    return;
                }
                if let (Some(message), Some(sent)) = (recipient.message, state.last_send.as_mut()) {
                    if sent.message_id == message_id {
                        sent.state = Some(message);
                    }
                }
                state.recipient = Some(recipient);
            }
            app.render_delivery(&key);
        });
    }

    /// Before a send: whether the recipient runs. After one: what it met,
    /// updated as the recipient comes and goes.
    fn render_delivery(&self, key: &str) {
        let Some(chat) = self.chat(key) else {
            return;
        };
        let state = chat.state.borrow();
        let recipient = state.recipient.as_ref();
        let (line, class) = if let Some(error) = &state.error {
            (error.clone(), "error")
        } else if let Some(sent) = &state.last_send {
            let (note, tone) = delivery_note(sent.state, recipient);
            (note.to_string(), tone_class(tone))
        } else if let Some((recipient, warning)) = recipient
            .and_then(|recipient| recipient_warning(recipient).map(|warning| (recipient, warning)))
        {
            (
                warning,
                if recipient.agent.is_none() {
                    "error"
                } else {
                    "warn"
                },
            )
        } else {
            (EXACT_ADDRESS.to_string(), "secondary")
        };
        for name in ["ok", "warn", "error", "secondary"] {
            chat.delivery.remove_css_class(name);
        }
        chat.delivery.add_css_class(class);
        chat.delivery.set_text(&line);
        let note = recipient.and_then(|recipient| reply_note(recipient, super::now_ms()));
        chat.reply.set_text(note.as_deref().unwrap_or_default());
        chat.reply.set_visible(note.is_some());
        chat.send.set_label(if state.sending {
            "Sending…"
        } else if queues(recipient) {
            "Queue Anyway"
        } else {
            "Send"
        });
    }

    /// Shows the conversation with `key`; newly shown, its recipient is
    /// read.
    pub fn select_chat(&self, key: &str) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.messages;
        let Some(chat) = page.chat(key) else {
            return;
        };
        page.stack.set_visible_child(&chat.page);
        let newly = page.shown.replace(Some(key.to_string())).as_deref() != Some(key);
        {
            let mut recent = page.recent.borrow_mut();
            recent.retain(|shown| shown != key);
            recent.push(key.to_string());
        }
        if page.list.selected_row().as_ref() != Some(&chat.row) {
            page.selecting.set(true);
            page.list.select_row(Some(&chat.row));
            page.selecting.set(false);
        }
        self.mark_chat(&chat, false);
        chat.text.grab_focus();
        if newly {
            self.look_up_recipient(key);
        }
    }

    fn mark_chat(&self, chat: &Chat, unread: bool) {
        if std::mem::replace(&mut chat.state.borrow_mut().unread, unread) == unread {
            return;
        }
        if unread {
            chat.name.set_text(&format!("● {}", chat.label));
            chat.name.add_css_class("settings-row-title");
        } else {
            chat.name.set_text(&chat.label);
            chat.name.remove_css_class("settings-row-title");
        }
    }

    /// Closes the conversation with `key`; it is no longer read.
    pub fn close_chat(&self, key: &str) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.messages;
        let Some(chat) = page.chat(key) else {
            return;
        };
        page.chats
            .borrow_mut()
            .retain(|open| !Rc::ptr_eq(open, &chat));
        if let Some(timer) = chat.timer.borrow_mut().take() {
            timer.remove();
        }
        page.selecting.set(true);
        page.list.remove(&chat.row);
        page.selecting.set(false);
        page.stack.remove(&chat.page);
        let next = {
            let mut recent = page.recent.borrow_mut();
            let open: Vec<String> = page
                .chats
                .borrow()
                .iter()
                .map(|chat| chat.key.clone())
                .collect();
            recent.retain(|shown| open.contains(shown));
            recent.last().cloned().or_else(|| open.first().cloned())
        };
        *page.shown.borrow_mut() = None;
        match next {
            Some(next) => self.select_chat(&next),
            None => page.stack.set_visible_child_name(EMPTY),
        }
    }

    pub(super) fn refresh_chat(&self, key: &str) {
        let Some(chat) = self.chat(key) else {
            return;
        };
        {
            let mut state = chat.state.borrow_mut();
            if state.loading {
                // A reply that arrives while a read is in flight may be
                // newer than what that read returns: read once more when it
                // finishes.
                state.pending = true;
                return;
            }
            state.loading = true;
            state.pending = false;
        }
        let key = key.to_string();
        self.view_call::<method::MessagesHistory>(
            HistoryParams {
                endpoint: key.clone(),
                before: None,
            },
            move |app, result| {
                if app
                    .chat(&key)
                    .is_some_and(|current| Rc::ptr_eq(&current, &chat))
                {
                    app.show_chat(&chat, result);
                }
            },
        );
    }

    fn show_chat(
        &self,
        chat: &Rc<Chat>,
        result: Result<History, crate::linux_app::bridge::CoreError>,
    ) {
        let again = {
            let mut state = chat.state.borrow_mut();
            state.loading = false;
            std::mem::take(&mut state.pending)
        };
        if again {
            let key = chat.key.clone();
            glib::idle_add_local_once(self.on(move |app| app.refresh_chat(&key)));
        }
        let history = match result {
            Err(error) => {
                chat.status.set_text(&error.message);
                return;
            }
            Ok(history) => history,
        };
        if !history.identity.is_empty() {
            chat.status.set_text(&format!(
                "You message as @{}, the same you as on the dashboard.",
                history.identity
            ));
        }
        let ids: Vec<String> = history
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect();
        // A message the core took and this read lists is no longer on its
        // way, whether or not the listing changed.
        chat.retire_echoes(&ids);
        if ids == chat.state.borrow().shown {
            chat.show_echoes(false);
            return;
        }
        let new_reply = {
            let mut state = chat.state.borrow_mut();
            let new_reply = !state.shown.is_empty()
                && history
                    .messages
                    .iter()
                    .any(|message| !message.mine && !state.shown.contains(&message.id));
            state.shown = ids;
            new_reply
        };
        if new_reply && self.shown_chat().as_deref() != Some(chat.key.as_str()) {
            self.mark_chat(chat, true);
        }
        clear(&chat.messages);
        if history.messages.is_empty() {
            chat.messages.append(&text(
                &format!("No messages with {} yet.", chat.label),
                &["secondary"],
            ));
        }
        for message in &history.messages {
            let who = if message.mine {
                "You".to_string()
            } else {
                message
                    .sender_address
                    .clone()
                    .filter(|address| !address.is_empty())
                    .unwrap_or_else(|| format!("@{}", message.sender))
            };
            let reply = if message.thread_id.is_some() {
                "↳ Reply · "
            } else {
                ""
            };
            let entry = vbox(4, &[]);
            let meta = text(
                &format!(
                    "{reply}{who} · {}",
                    message_time(message.created_at.as_deref())
                ),
                &["caption"],
            );
            let body = text(&message.text, &[]).wrapped().copyable();
            if message.mine {
                entry.set_margin_start(60);
                meta.set_xalign(1.0);
                body.set_xalign(1.0);
            } else {
                entry.set_margin_end(60);
            }
            if message.thread_id.is_some() {
                entry.set_margin_start(entry.margin_start().max(28));
            }
            entry.append(&meta);
            entry.append(&body);
            chat.messages.append(&entry);
        }
        // A message the core took is listed now; one still on its way
        // stays at the end.
        chat.show_echoes(false);
        let adjustment = chat.scroll.vadjustment();
        glib::idle_add_local_once(move || adjustment.set_value(adjustment.upper()));
    }

    // Recent Messages: what was delivered into sessions on the relay.

    /// Opens Recent Messages, or brings it forward.
    pub fn show_activity(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.messages;
        if let Some((window, _)) = page.activity.borrow().as_ref() {
            window.present();
            return;
        }
        let window = gtk::Window::new();
        window.set_title(Some("Recent Messages — Agent Relay"));
        window.set_transient_for(Some(self.window()));
        if let Some(application) = self.window().application() {
            window.set_application(Some(&application));
        }
        window.set_default_size(620, 480);
        let root = vbox(0, &[]);
        let top = hbox(8, &[]);
        widgets::pad(&top, 20, None, None);
        let heading = text("Recent Messages", &["headline"]);
        heading.set_hexpand(true);
        top.append(&heading);
        let weak = window.downgrade();
        top.append(&button("Done", &[], move || {
            if let Some(window) = weak.upgrade() {
                window.close();
            }
        }));
        root.append(&top);
        root.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        let rows = vbox(0, &[]);
        widgets::pad(&rows, 8, Some(12), None);
        root.append(&widgets::scrolled(&rows));
        window.set_child(Some(&root));
        let keys = gtk::EventControllerKey::new();
        let weak = window.downgrade();
        keys.connect_key_pressed(move |_, key, _, _| {
            if key == gdk::Key::Escape {
                if let Some(window) = weak.upgrade() {
                    window.close();
                }
                return glib::Propagation::Stop;
            }
            glib::Propagation::Proceed
        });
        window.add_controller(keys);
        let weak = self.downgrade();
        window.connect_close_request(move |_| {
            if let Some(shell) = weak.upgrade().and_then(|app| app.shell()) {
                shell.pages.messages.activity.borrow_mut().take();
            }
            glib::Propagation::Proceed
        });
        *page.activity.borrow_mut() = Some((window.clone(), rows));
        self.render_activity();
        window.present();
        self.refresh_activity();
    }

    /// The rows of Recent Messages, while open.
    pub fn activity_rows(&self) -> Option<gtk::Box> {
        self.with_messages(|page| {
            page.activity
                .borrow()
                .as_ref()
                .map(|(_, rows)| rows.clone())
        })
        .flatten()
    }

    /// New deliveries: Recent Messages shows them.
    pub(super) fn activity_changed(&self) {
        self.render_activity();
    }

    fn render_activity(&self) {
        let Some(rows) = self.activity_rows() else {
            return;
        };
        clear(&rows);
        let activity = self.with_state(|state| state.activity.clone());
        if activity.is_empty() {
            let empty = text("No messages yet.", &["secondary"]).centered();
            empty.set_margin_top(40);
            rows.append(&empty);
        }
        let now = super::now_ms();
        for entry in &activity {
            let row = hbox(8, &[]);
            widgets::pad(&row, 6, Some(4), None);
            let (glyph, class) = activity_glyph(entry.outcome);
            let image = icon(glyph, 14);
            image.add_css_class(class);
            image.set_valign(gtk::Align::Start);
            row.append(&image);
            let words = vbox(2, &[]);
            words.set_hexpand(true);
            words.append(&text(&activity_heading(entry), &["settings-row-title"]));
            let preview = text(activity_body(entry), &["secondary"]).wrapped();
            preview.set_lines(2);
            preview.set_ellipsize(gtk::pango::EllipsizeMode::End);
            words.append(&preview);
            row.append(&words);
            let when = text(&relative_ms(Some(entry.at_ms), now), &["caption"]);
            when.set_valign(gtk::Align::Start);
            row.append(&when);
            rows.append(&row);
        }
    }
}
