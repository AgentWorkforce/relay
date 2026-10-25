//! Sending from a conversation: the box clears at once and each message
//! shows as on its way until the history lists it.
use super::*;
use crate::linux_app::bridge::CoreError;
use crate::relay::contract::directory::SentMessage;

/// A message sent from the box that the history does not list yet. Once
/// the core took it, `sent_id` is the id a history read confirms it by.
pub struct Echo {
    token: u64,
    body: String,
    sent: bool,
    sent_id: Option<String>,
}

impl Chat {
    /// Draws every message still on its way at the end of the conversation.
    pub(super) fn show_echoes(&self, scroll: bool) {
        for row in self.echo_rows.borrow_mut().drain(..) {
            if row.parent().is_some() {
                self.messages.remove(&row);
            }
        }
        let state = self.state.borrow();
        for echo in &state.echoes {
            let entry = vbox(4, &[]);
            entry.set_margin_start(60);
            let meta = text("You · Sending…", &["caption"]);
            meta.set_xalign(1.0);
            let words = text(&echo.body, &[]).wrapped().copyable();
            words.set_xalign(1.0);
            entry.append(&meta);
            entry.append(&words);
            self.messages.append(&entry);
            self.echo_rows.borrow_mut().push(entry);
        }
        if scroll && !state.echoes.is_empty() {
            let adjustment = self.scroll.vadjustment();
            glib::idle_add_local_once(move || adjustment.set_value(adjustment.upper()));
        }
    }

    /// A history read listed `ids`: a message the core took that they list
    /// (or that it gave no id to confirm by) is retired.
    pub(super) fn retire_echoes(&self, ids: &[String]) {
        self.state
            .borrow_mut()
            .echoes
            .retain(|echo| !(echo.sent && echo.sent_id.as_ref().is_none_or(|id| ids.contains(id))));
    }

    /// The send `token` was refused: its echo goes and the text comes back,
    /// before the error is recorded, since typing into the box clears the
    /// last send's note and error.
    fn take_back(&self, token: u64, body: &str) {
        self.state
            .borrow_mut()
            .echoes
            .retain(|echo| echo.token != token);
        self.show_echoes(false);
        if self.body().is_empty() {
            self.text.buffer().set_text(body);
        }
    }

    /// Records the send's answer; returns the message id to follow when the
    /// core took it.
    fn record_send(
        &self,
        token: u64,
        result: Result<SentMessage, CoreError>,
    ) -> Option<Option<String>> {
        let mut state = self.state.borrow_mut();
        state.sending = false;
        // Lookups that left before the send answer for the old state.
        state.recipient_reads += 1;
        match result {
            Err(error) if error.kind() == Some(ErrorKind::NotFound) => {
                state.recipient = Some(Recipient {
                    known: true,
                    agent: None,
                    message: None,
                });
                state.last_send = None;
                state.error = Some(
                    delivery_note(Some(MessageState::NoSuchAgent), None)
                        .0
                        .into(),
                );
                None
            }
            Err(error) => {
                state.error = Some(error.message);
                None
            }
            Ok(sent) => {
                state.last_send = Some(LastSend {
                    message_id: sent.message_id.clone(),
                    state: sent.recipient.message,
                });
                state.recipient = Some(sent.recipient);
                // The core took it: the echo stays until a history read
                // lists the message, unless the last read already did.
                let listed = sent
                    .message_id
                    .as_ref()
                    .is_some_and(|id| state.shown.contains(id));
                if listed {
                    state.echoes.retain(|echo| echo.token != token);
                } else if let Some(echo) = state.echoes.iter_mut().find(|echo| echo.token == token)
                {
                    echo.sent = true;
                    echo.sent_id = sent.message_id.clone();
                }
                Some(sent.message_id)
            }
        }
    }
}

impl App {
    /// Sends what is typed in the conversation with `key`.
    pub fn send_chat(&self, key: &str) {
        let Some(chat) = self.chat(key) else {
            return;
        };
        let body = chat.body();
        // Return (and its key repeat) arrives here too, not just the
        // button: one message in flight per conversation, or it is sent
        // twice.
        let token = {
            let mut state = chat.state.borrow_mut();
            if body.is_empty() || state.sending {
                return;
            }
            state.sending = true;
            state.error = None;
            state.echo_token = state.echo_token.wrapping_add(1);
            let token = state.echo_token;
            state.echoes.push(Echo {
                token,
                body: body.clone(),
                sent: false,
                sent_id: None,
            });
            token
        };
        // The box clears at once and the message shows as on its way; a
        // refusal puts the text back.
        chat.text.buffer().set_text("");
        chat.show_echoes(true);
        chat.send.set_sensitive(false);
        self.render_delivery(key);
        let recipient = recipient_params(key);
        let key = key.to_string();
        self.view_call::<method::MessagesSend>(
            SendParams {
                to: recipient.to,
                address: recipient.address,
                text: body.clone(),
                reply_to: None,
            },
            move |app, result| {
                if app
                    .chat(&key)
                    .is_some_and(|current| Rc::ptr_eq(&current, &chat))
                {
                    app.finish_send(&chat, &key, token, &body, result);
                }
            },
        );
    }

    /// The core answered the send `token` of `body` in the conversation
    /// shown.
    fn finish_send(
        &self,
        chat: &Rc<Chat>,
        key: &str,
        token: u64,
        body: &str,
        result: Result<SentMessage, CoreError>,
    ) {
        chat.send.set_sensitive(true);
        if result.is_err() {
            chat.take_back(token, body);
        }
        if let Some(message_id) = chat.record_send(token, result) {
            chat.show_echoes(false);
            // Relaycast hands a message to a running agent's host within
            // moments; its state is read again once it has had the chance.
            if let Some(message_id) = message_id {
                self.recheck_send(chat, message_id);
            }
            self.refresh_chat(key);
        }
        self.render_delivery(key);
    }

    /// Reads the recipient again shortly after a send, while the
    /// conversation still shows that send.
    fn recheck_send(&self, chat: &Rc<Chat>, message_id: String) {
        let recheck = Rc::downgrade(chat);
        glib::timeout_add_local_once(
            RECHECK_AFTER,
            self.on(move |app| {
                let Some(chat) = recheck.upgrade() else {
                    return;
                };
                let current = app
                    .chat(&chat.key)
                    .is_some_and(|current| Rc::ptr_eq(&current, &chat));
                let same =
                    chat.state.borrow().last_send.as_ref().is_some_and(|sent| {
                        sent.message_id.as_deref() == Some(message_id.as_str())
                    });
                if current && same {
                    app.look_up_recipient(&chat.key);
                }
            }),
        );
    }
}
