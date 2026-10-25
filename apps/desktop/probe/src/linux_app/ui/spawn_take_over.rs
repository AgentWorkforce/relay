//! Taking a spawned Claude over from its transcript page: it asks first (or,
//! mid-turn, offers to wait for the turn, with "Interrupt Now" while it
//! waits), has the core stop the headless agent, then resumes the session in
//! Terminal in its folder. It keeps its name, so relay messages keep
//! arriving. Claude Desktop does not take sessions over on Linux. The Mac's
//! `SpawnTakeOverButton` is the reference.

use super::app::App;
use super::desktop::Confirmation;
use super::spawn_join::PendingTakeOver;
use super::transcript::TranscriptPage;
use crate::linux_app::models::*;
use crate::relay::contract::method;
use crate::relay::contract::spawned::{TakeOverParams, TakenOver};
use gtk::{glib, prelude::*};
use gtk4 as gtk;

impl App {
    pub(super) fn connect_take_over(&self, page: &TranscriptPage) {
        let take_over = self.on(|app| app.confirm_take_over());
        page.join.take_over.connect_clicked(move |_| take_over());
        let interrupt = self.on(|app| app.confirm_interrupt());
        page.join.interrupt.connect_clicked(move |_| interrupt());
    }

    /// Asks before a take over; mid-turn, offers to wait for the turn.
    fn confirm_take_over(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let Some(row) = shell.pages.sessions.transcript.selected.borrow().clone() else {
            return;
        };
        let Some(session) = self.joined_session(&row) else {
            return;
        };
        let Some(name) = session.registration.as_ref().map(|r| r.name.clone()) else {
            return;
        };
        let key = row.key();
        let working = self.with_state(|state| SpawnHandover::is_working(state.agent_for(&session)));
        let confirmation = match working {
            true => Confirmation::new(
                &spawn_confirm_title(&name),
                &spawn_working_message(&name),
                SPAWN_AFTER_TURN,
            ),
            false => Confirmation::new(
                &spawn_confirm_title(&name),
                &spawn_confirm_message(&name),
                SPAWN_TAKE_OVER_BUTTON,
            ),
        };
        let answer = self.confirm(confirmation);
        let weak = self.downgrade();
        let directory = session.directory.clone().unwrap_or_default();
        glib::spawn_future_local(async move {
            if let (true, Some(app)) = (answer.await, weak.upgrade()) {
                app.take_over(name, working, directory, key);
            }
        });
    }

    /// Asks before interrupting the turn a take over waits for.
    fn confirm_interrupt(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let Some(name) = shell
            .pages
            .sessions
            .transcript
            .join
            .taking
            .borrow()
            .as_ref()
            .map(|pending| pending.name.clone())
        else {
            return;
        };
        let answer = self.confirm(
            Confirmation::new(
                &spawn_interrupt_title(&name),
                SPAWN_INTERRUPT_MESSAGE,
                SPAWN_INTERRUPT,
            )
            .destructive(),
        );
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            if let (true, Some(app)) = (answer.await, weak.upgrade()) {
                let params = TakeOverParams {
                    name,
                    interrupt: true,
                };
                app.call::<method::AgentsTakeOver>(params, |_, _| {});
            }
        });
    }

    /// Has the core stop the headless agent, then resumes its session in
    /// Terminal; `directory` is its folder, as last listed.
    fn take_over(&self, name: String, working: bool, directory: String, key: String) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions.transcript;
        let join = &page.join;
        if join.taking.borrow().is_some() {
            return;
        }
        *join.taking.borrow_mut() = Some(PendingTakeOver {
            name: name.clone(),
            key: key.clone(),
            working,
        });
        join.take_over_errors.borrow_mut().remove(&key);
        if page
            .selected
            .borrow()
            .as_ref()
            .map(LocalSessionRow::key)
            .as_ref()
            == Some(&key)
        {
            page.show_opening_error("");
        }
        self.render_transcript_controls();
        let params = TakeOverParams {
            name: name.clone(),
            interrupt: false,
        };
        self.call::<method::AgentsTakeOver>(params, move |app, result| {
            if let Some(shell) = app.shell() {
                let join = &shell.pages.sessions.transcript.join;
                *join.taking.borrow_mut() = None;
            }
            let opened = result
                .map_err(|error| error.message)
                .and_then(|taken| app.resume_taken_over(&taken, &directory));
            // Shown under its open button while its session is shown.
            if let (Err(error), Some(shell)) = (opened, app.shell()) {
                let page = &shell.pages.sessions.transcript;
                page.join
                    .take_over_errors
                    .borrow_mut()
                    .insert(key.clone(), format!("{SPAWN_TAKE_OVER_FAILED}: {error}"));
            }
            app.refresh_local();
            app.refresh_agents();
            app.render_transcript_controls();
        });
    }

    /// Resumes a session taken over in Terminal, in its folder.
    fn resume_taken_over(&self, taken: &TakenOver, directory: &str) -> Result<(), String> {
        let directory = taken.directory.as_deref().unwrap_or(directory);
        let command = SessionOpening::new("claude", &taken.target.id, directory)
            .and_then(|action| action.command)
            .ok_or_else(|| spawn_no_folder(&taken.target.id))?;
        self.inner.desktop.open_terminal(&command)
    }
}
