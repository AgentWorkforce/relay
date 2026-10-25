//! Joining and taking over a spawned agent from its transcript page: the
//! live transcript, followed every few seconds; the message box under it,
//! which sends into the running agent through the relay; and the sidebar's
//! open and take-over buttons (`spawn_take_over`). The Mac's
//! `LocalTranscriptModel.follow`, `SpawnComposer` and `SessionOpenButton` are
//! the reference.

use super::app::App;
use super::transcript::{entry_view, is_tool, tool_group_label, TranscriptPage};
use super::widgets::{self, hbox, text, vbox, LabelStyle};
use crate::linux_app::bridge::CoreError;
use crate::linux_app::models::*;
use crate::relay::contract::agents::LocalSession;
use crate::relay::contract::directory::SendParams;
use crate::relay::contract::method;
use crate::relay::contract::spawned::AgentTranscriptParams;
use crate::relay::contract::transcript::{
    LocalTranscriptCursor, LocalTranscriptEntry, LocalTranscriptPage, LocalTranscriptParams,
};
use gtk::{glib, prelude::*};
use gtk4 as gtk;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::time::Duration;

/// How often a spawned agent's transcript is read for what it wrote since.
const FOLLOW_EVERY: Duration = Duration::from_secs(3);

/// The widgets and state of joining a spawned agent.
pub struct SpawnJoin {
    /// Under the transcript: the live note, the message box and its status.
    pub composer: gtk::Box,
    pub entry: gtk::Entry,
    pub send: gtk::Button,
    pub status: gtk::Label,
    /// In the sidebar, under the open button.
    pub actions: gtk::Box,
    pub take_over: gtk::Button,
    pub note: gtk::Label,
    pub interrupt: gtk::Button,
    /// The agent a whole read was of (`None`: the session's transcript) and
    /// where following it continues; `None` until a whole read ends.
    follow: RefCell<Option<(Option<String>, Option<LocalTranscriptCursor>)>>,
    /// Bumped by every read: a follow that a read overtook drops its page.
    reads: Cell<u64>,
    following: Cell<bool>,
    /// The session (`LocalSessionRow::key`) the message box was last shown
    /// for: its draft and status are that session's alone.
    composing: RefCell<Option<String>>,
    sending: Cell<bool>,
    pub(super) taking: RefCell<Option<PendingTakeOver>>,
    /// Failures survive switching transcripts, as on macOS.
    pub(super) take_over_errors: RefCell<HashMap<String, String>>,
}

pub(super) struct PendingTakeOver {
    pub name: String,
    pub key: String,
    pub working: bool,
}

impl SpawnJoin {
    pub fn build() -> SpawnJoin {
        let composer = vbox(0, &[]);
        composer.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        let inner = vbox(6, &[]);
        widgets::pad(&inner, 10, Some(32), Some(12));
        composer.append(&inner);
        inner.append(&text(SPAWN_FOLLOWING, &["caption"]).wrapped());
        let line = hbox(8, &[]);
        let entry = gtk::Entry::new();
        entry.set_hexpand(true);
        line.append(&entry);
        let send = gtk::Button::with_label(SPAWN_SEND);
        widgets::action_cursor(&send);
        send.add_css_class("primary");
        line.append(&send);
        inner.append(&line);
        let status = text(SPAWN_COMPOSER_NOTE, &["caption"]).wrapped();
        inner.append(&status);
        composer.set_visible(false);
        let actions = vbox(6, &[]);
        let take_over = gtk::Button::with_label(SPAWN_TAKE_OVER_TITLE);
        widgets::action_cursor(&take_over);
        take_over.add_css_class("session-action");
        take_over.set_hexpand(true);
        take_over.set_tooltip_text(Some(SPAWN_TAKE_OVER_HELP));
        widgets::name(&take_over, SPAWN_TAKE_OVER_TITLE);
        take_over.set_visible(false);
        actions.append(&take_over);
        let note = text("", &["caption"]).wrapped();
        note.set_max_width_chars(28);
        note.set_visible(false);
        actions.append(&note);
        let interrupt = gtk::Button::with_label(SPAWN_INTERRUPT_NOW);
        widgets::action_cursor(&interrupt);
        interrupt.set_halign(gtk::Align::Start);
        interrupt.set_visible(false);
        actions.append(&interrupt);
        SpawnJoin {
            composer,
            entry,
            send,
            status,
            actions,
            take_over,
            note,
            interrupt,
            follow: RefCell::default(),
            reads: Cell::new(0),
            following: Cell::new(false),
            composing: RefCell::default(),
            sending: Cell::new(false),
            taking: RefCell::default(),
            take_over_errors: RefCell::default(),
        }
    }

    /// `transcript` with the message box under it.
    pub(super) fn under(&self, transcript: &impl IsA<gtk::Widget>) -> gtk::Box {
        let column = vbox(0, &[]);
        column.append(transcript);
        column.append(&self.composer);
        column
    }

    /// A read from the start began: nothing is followed until one ends.
    pub(super) fn reset(&self) {
        self.reads.set(self.reads.get() + 1);
        *self.follow.borrow_mut() = None;
    }

    /// The last page of a read of `agent` (`None`: the session's transcript)
    /// that asked for `requested`.
    pub(super) fn read(
        &self,
        agent: Option<String>,
        requested: Option<&LocalTranscriptCursor>,
        page: &LocalTranscriptPage,
    ) {
        if page.next_cursor.is_none() {
            self.reads.set(self.reads.get() + 1);
            *self.follow.borrow_mut() =
                Some((agent, SpawnHandover::follow_cursor(requested, page)));
        }
    }

    pub(super) fn show_note(&self, value: &str) {
        self.note.set_text(value);
        self.note.set_visible(!value.is_empty());
    }

    /// Shows the message box for the session `key`: another session's draft
    /// and status are cleared, as the Mac's composer is per session.
    fn compose_for(&self, key: String) {
        if self.composing.borrow().as_deref() == Some(key.as_str()) {
            return;
        }
        self.entry.set_text("");
        self.status.set_text(SPAWN_COMPOSER_NOTE);
        *self.composing.borrow_mut() = Some(key);
    }

    /// Whether the message box is still shown for the session `key`.
    fn composing(&self, key: &str) -> bool {
        self.composing.borrow().as_deref() == Some(key)
    }
}

impl App {
    pub(super) fn connect_spawn_join(&self, page: &TranscriptPage) {
        let send = self.on(|app| app.send_to_spawned());
        page.join.send.connect_clicked(move |_| send());
        let send = self.on(|app| app.send_to_spawned());
        page.join.entry.connect_activate(move |_| send());
        self.connect_take_over(page);
        let open = self.on(|app| app.open_transcript_session());
        page.open.connect_clicked(move |_| open());
        let weak = self.downgrade();
        glib::timeout_add_local(FOLLOW_EVERY, move || match weak.upgrade() {
            Some(app) => {
                app.follow_transcript();
                glib::ControlFlow::Continue
            }
            None => glib::ControlFlow::Break,
        });
    }

    /// The transcript page's session as last read: a spawned agent's changes
    /// as it is taken over.
    pub(super) fn joined_session(&self, row: &LocalSessionRow) -> Option<LocalSession> {
        let relay = row.relay.as_ref()?;
        self.listed_session(row).or_else(|| Some(relay.clone()))
    }

    /// The row's session as the session list has it now, without the
    /// row's own copy standing in for one the list no longer has. What
    /// holds a session is read from this: a row keeps the copy it was
    /// built with, and a session that has ended holds nothing.
    pub(super) fn listed_session(&self, row: &LocalSessionRow) -> Option<LocalSession> {
        let key = row.relay.as_ref()?.target.key();
        self.with_state(|state| {
            state
                .local_sessions
                .iter()
                .find(|session| session.target.key() == key)
                .cloned()
        })
    }

    /// One page of the transcript page's session: a spawned agent's own
    /// output while Agent Relay runs it headless (`agent`), else the
    /// session's transcript.
    pub(super) fn transcript_page(
        &self,
        agent: Option<String>,
        params: LocalTranscriptParams,
        done: impl FnOnce(&App, Result<LocalTranscriptPage, CoreError>) + 'static,
    ) {
        match agent {
            Some(name) => self.view_call::<method::AgentsTranscript>(
                AgentTranscriptParams {
                    name,
                    cursor: params.cursor,
                },
                done,
            ),
            None => self.view_call::<method::SessionsTranscript>(params, done),
        }
    }

    /// Shows `entries` under the transcript, consecutive tool activity in
    /// one disclosure; an entry already shown is skipped.
    pub(super) fn append_transcript_entries(
        &self,
        page: &TranscriptPage,
        entries: Vec<LocalTranscriptEntry>,
        source: &str,
    ) {
        let person = self.with_state(|state| state.account().person.unwrap_or_default());
        let name = person.name.as_deref().unwrap_or("You");
        for entry in entries {
            if !page.entry_ids.borrow_mut().insert(entry.id.clone()) {
                continue;
            }
            let widget = entry_view(&entry, source, name, person.avatar_url.as_deref());
            let mut group = page.tool_group.borrow_mut();
            if !is_tool(&entry) {
                *group = None;
                page.messages.append(&widget);
                continue;
            }
            let (disclosure, children, count) = group.get_or_insert_with(|| {
                let disclosure = gtk::Expander::new(None);
                widgets::action_cursor(&disclosure);
                let children = vbox(8, &[]);
                disclosure.set_child(Some(&children));
                page.messages.append(&disclosure);
                (disclosure, children, 0)
            });
            if entry.kind == "tool_use" {
                *count += 1;
            }
            let label = tool_group_label(*count);
            disclosure.set_label(Some(&label));
            widgets::name(disclosure, &label);
            children.append(&widget);
        }
    }

    /// `Transcript: Join` in a spawned agent's details, while Agent Relay
    /// runs it: opens its live transcript.
    pub(super) fn join_fact(&self, session: &LocalSession) -> Option<(&'static str, gtk::Widget)> {
        if !SpawnHandover::joins(Some(session)) {
            return None;
        }
        let key = session.target.key();
        let join = widgets::button(
            SPAWN_JOIN_TITLE,
            &["link"],
            self.on(move |app| app.join_spawned(&key)),
        );
        join.set_tooltip_text(Some(SPAWN_JOIN_HELP));
        Some(("Transcript", join.upcast()))
    }

    /// Opens the live transcript of the session `key` names.
    fn join_spawned(&self, key: &str) {
        let row = self.with_state(|state| {
            let session = state
                .local_sessions
                .iter()
                .find(|s| s.target.key() == key)?;
            merge_local_sessions(&state.sessions, std::slice::from_ref(session))
                .into_iter()
                .find(|row| row.relay.is_some())
        });
        if let Some(row) = row {
            self.go(super::state::Page::Sessions);
            self.open_local_session(row);
        }
    }

    /// Reads what a spawned agent wrote since the last read; reads it all
    /// again when what it is read from changed (it was taken over).
    fn follow_transcript(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions.transcript;
        let Some(row) = page.selected.borrow().clone() else {
            return;
        };
        let session = self.joined_session(&row);
        if !page.root.is_visible()
            || page.loading.get()
            || SpawnHandover::of(session.as_ref()).is_none()
        {
            return;
        }
        let agent = SpawnHandover::transcript_agent(session.as_ref());
        let Some((read, from)) = page.join.follow.borrow().clone() else {
            return;
        };
        if read != agent {
            self.load_transcript(false);
            return;
        }
        if page.join.following.replace(true) {
            return;
        }
        let generation = page.generation.get();
        let reads = page.join.reads.get();
        let params = LocalTranscriptParams {
            source: row.source().into(),
            session_id: row.session_id(),
            cursor: from.clone(),
        };
        self.transcript_page(agent.clone(), params, move |app, result| {
            let Some(shell) = app.shell() else {
                return;
            };
            let page = &shell.pages.sessions.transcript;
            page.join.following.set(false);
            let Ok(result) = result else {
                return;
            };
            // A refresh or take-over read replaced the transcript meanwhile.
            if page.generation.get() != generation
                || page.join.reads.get() != reads
                || page.loading.get()
            {
                return;
            }
            let next = result
                .next_cursor
                .clone()
                .filter(|next| Some(next) != from.as_ref());
            let follow = next.or_else(|| SpawnHandover::follow_cursor(from.as_ref(), &result));
            *page.join.follow.borrow_mut() = Some((agent, follow));
            app.append_transcript_entries(page, result.entries, row.source());
        });
    }

    /// Shows the open and take-over buttons, the hosted note and the message
    /// box for the transcript page's session as last read.
    pub(super) fn render_spawn_join(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions.transcript;
        let Some(row) = page.selected.borrow().clone() else {
            return;
        };
        let session = self.joined_session(&row);
        let listed = self.listed_session(&row);
        let opening = SessionOpening::for_session(&row, session.as_ref(), listed.as_ref());
        page.open.set_visible(opening.is_some());
        if let Some(action) = &opening {
            let destination = action.destination(
                self.prefs().session_opening(row.source()),
                self.inner.desktop.has_uri_handler("codex"),
            );
            let title = action.button_title(destination);
            page.open.set_label(title);
            page.open.set_tooltip_text(Some(title));
            widgets::name(&page.open, title);
        }
        let join = &page.join;
        let handover = SpawnHandover::of(session.as_ref());
        let headless = handover == Some(SpawnHandover::TakeOver);
        join.take_over.set_visible(headless);
        let taking = join.taking.borrow();
        join.take_over.set_sensitive(taking.is_none());
        let pending = taking.as_ref().filter(|pending| pending.key == row.key());
        join.interrupt
            .set_visible(pending.is_some_and(|pending| pending.working));
        if let Some(pending) = pending {
            join.show_note(&if pending.working {
                spawn_waiting(&pending.name)
            } else {
                SPAWN_STOPPING.to_string()
            });
        } else {
            join.show_note(&match handover {
                Some(SpawnHandover::TakenOver) => spawn_taken_over(&registration_name(&session)),
                _ => SpawnHandover::hosted_note(session.as_ref(), opening.as_ref())
                    .or_else(|| SessionOpening::held_note(listed.as_ref()))
                    .unwrap_or_default()
                    .to_string(),
            });
        }
        if let Some(error) = join.take_over_errors.borrow().get(&row.key()) {
            page.show_opening_error(error);
        }
        let name = session
            .as_ref()
            .filter(|session| SpawnHandover::joins(Some(session)))
            .and_then(|session| session.registration.as_ref())
            .map(|registration| registration.name.clone());
        join.compose_for(row.key());
        join.composer.set_visible(name.is_some());
        let placeholder = spawn_composer_placeholder(name.as_deref().unwrap_or_default());
        join.entry.set_placeholder_text(Some(&placeholder));
        widgets::name(&join.entry, &placeholder);
        join.send.set_sensitive(!join.sending.get());
    }

    /// The open button: the session in its app, or resumed in Terminal.
    fn open_transcript_session(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions.transcript;
        let Some(row) = page.selected.borrow().clone() else {
            return;
        };
        let session = self.joined_session(&row);
        let listed = self.listed_session(&row);
        let Some(action) = SessionOpening::for_session(&row, session.as_ref(), listed.as_ref())
        else {
            return;
        };
        page.show_opening_error("");
        let destination = action.destination(
            self.prefs().session_opening(row.source()),
            self.inner.desktop.has_uri_handler("codex"),
        );
        let result = match (destination, &action.deep_link, &action.command) {
            (SessionOpenDestination::Desktop, Some(link), _) => {
                self.inner.desktop.open_uri(link);
                Ok(())
            }
            (SessionOpenDestination::Unavailable, _, _) if action.live_only => {
                Err(SPAWN_CODEX_MISSING.to_string())
            }
            (SessionOpenDestination::Unavailable, _, _) => {
                self.go(super::state::Page::Settings(super::state::Pane::Opening));
                Ok(())
            }
            (_, _, Some(command)) => self
                .inner
                .desktop
                .open_terminal(command)
                .map_err(|error| format!("Couldn’t open session: {error}")),
            (_, _, None) => Err("Couldn’t open session: Install Codex to open this session. Its working directory is unavailable for terminal resume.".into()),
        };
        if let Err(error) = result {
            page.show_opening_error(&error);
        }
    }

    /// Sends what is typed under a spawned agent's transcript to it.
    fn send_to_spawned(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions.transcript;
        let Some(row) = page.selected.borrow().clone() else {
            return;
        };
        let key = row.key();
        let address = self
            .joined_session(&row)
            .and_then(|session| session.registration)
            .map(|registration| registration.address);
        let body = page.join.entry.text().trim().to_string();
        let Some(address) = address.filter(|_| !body.is_empty()) else {
            return;
        };
        if page.join.sending.replace(true) {
            return;
        }
        page.join.send.set_sensitive(false);
        let recipient = recipient_params(&address);
        let params = SendParams {
            to: recipient.to,
            address: recipient.address,
            text: body.clone(),
            reply_to: None,
        };
        self.call::<method::MessagesSend>(params, move |app, result| {
            let Some(shell) = app.shell() else {
                return;
            };
            let join = &shell.pages.sessions.transcript.join;
            join.sending.set(false);
            join.send.set_sensitive(true);
            // Another session is shown now: its draft and status are its own.
            if !join.composing(&key) {
                return;
            }
            match result {
                Ok(sent) => {
                    if join.entry.text().trim() == body {
                        join.entry.set_text("");
                    }
                    let (note, _) = delivery_note(sent.recipient.message, Some(&sent.recipient));
                    join.status.set_text(note);
                }
                Err(error) => join.status.set_text(&error.message),
            }
        });
    }
}

/// The agent name of `session`'s registration; empty without one.
fn registration_name(session: &Option<LocalSession>) -> String {
    session
        .as_ref()
        .and_then(|session| session.registration.as_ref())
        .map(|registration| registration.name.clone())
        .unwrap_or_default()
}

impl TranscriptPage {
    /// Shows why opening the session failed; empty hides it.
    pub(super) fn show_opening_error(&self, error: &str) {
        self.opening_error.set_text(error);
        self.opening_error.set_visible(!error.is_empty());
    }
}
