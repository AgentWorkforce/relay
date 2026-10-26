//! What the person can do from an upload stage: compact a full journal or
//! retry uploads a problem stopped or a lasting transient failure holds. The
//! stage shows the action under way at once; a failure puts the button back
//! with why, and one the core never received is sent again once it answers.
use super::app::App;
use super::widgets::{button, text, vbox, LabelStyle};
use crate::linux_app::models::StageAction;
use crate::relay::contract::{method, NoParams};
use gtk::prelude::*;
use gtk4 as gtk;

impl App {
    /// Removes consumed records from a full upload journal.
    pub fn compact_journal(&self) {
        self.send_upload_action(StageAction::Compact, false);
    }

    /// Retries uploads a problem stopped, or waiting out a lasting transient
    /// failure; queued records are kept.
    pub fn retry_uploads(&self) {
        self.send_upload_action(StageAction::Retry, false);
    }

    /// `uploader.status` answered: the core is reachable, so a stage action
    /// it never received is sent now (`State::core_answered`).
    pub(super) fn upload_status_answered(&self, status: crate::linux_app::models::StatusView) {
        let unsent = self.update_state(|state| {
            state.status = Some(status);
            state.core_answered()
        });
        self.update_uploader_views();
        if let Some(action) = unsent {
            self.send_upload_action(action, true);
        }
    }

    /// Sends a stage action. `automatic` is the second send of one the core
    /// never received (`State::core_answered`).
    pub(super) fn send_upload_action(&self, action: StageAction, automatic: bool) {
        let mark = move |state: &mut super::state::State, on: bool| {
            state.pending_upload_action = on.then_some(action);
        };
        self.update_state(|state| {
            state.upload_action_error = None;
            state.unsent_upload_action = None;
            mark(state, true);
        });
        self.render_stages();
        let finished = move |app: &App, error: Option<crate::linux_app::bridge::CoreError>| {
            app.update_state(|state| {
                mark(state, false);
                state.upload_action_finished(action, error, automatic);
            });
            app.render_stages();
        };
        let started = match action {
            StageAction::Compact => self.uploader_command::<method::UploaderCompact>(
                NoParams {},
                "Compacting the upload journal…",
                finished,
            ),
            StageAction::Retry => self.uploader_command::<method::UploaderRetry>(
                NoParams {},
                "Retrying uploads…",
                finished,
            ),
        };
        if !started {
            self.update_state(|state| {
                mark(state, false);
                state.upload_action_error = Some(super::settings_page::UPLOADER_BUSY.into());
            });
            self.render_stages();
        }
    }

    /// The stage checklist, wherever it shows.
    pub(super) fn render_stages(&self) {
        match self.page() {
            super::state::Page::Sessions => self.render_page(),
            super::state::Page::Settings(super::state::Pane::Sharing) => self.render_settings(),
            _ => {}
        }
    }

    /// A stage's action button, with why the last upload action failed.
    pub(super) fn stage_action(
        &self,
        action: StageAction,
        busy: bool,
        error: Option<&str>,
    ) -> gtk::Box {
        let (label, tooltip, act): (_, _, fn(&App)) = match action {
            StageAction::Compact => (
                "Compact now",
                "Remove consumed records from the upload journal so capture and uploads can continue",
                App::compact_journal,
            ),
            StageAction::Retry => (
                "Retry uploads",
                "Send the queued records again. Nothing queued is lost.",
                App::retry_uploads,
            ),
        };
        let holder = vbox(4, &[]);
        let control = button(label, &[], self.on(act));
        control.set_tooltip_text(Some(tooltip));
        control.set_halign(gtk::Align::Start);
        control.set_sensitive(!busy);
        holder.append(&control);
        if let Some(error) = error {
            holder.append(&text(error, &["error", "caption"]).wrapped());
        }
        holder
    }
}
