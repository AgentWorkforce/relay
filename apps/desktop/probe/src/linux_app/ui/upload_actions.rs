//! What the person can do from an upload stage: compact a full journal or
//! retry uploads a problem stopped. The stage shows the action under way
//! at once; a failure puts the button back with why.
use super::app::App;
use super::widgets::{button, text, vbox, LabelStyle};
use crate::linux_app::models::StageAction;
use crate::relay::contract::{method, NoParams};
use gtk::prelude::*;
use gtk4 as gtk;

impl App {
    /// Removes consumed records from a full upload journal.
    pub fn compact_journal(&self) {
        self.update_state(|state| {
            state.upload_action_error = None;
            state.compacting_journal = true;
        });
        self.render_stages();
        let started = self.uploader_command::<method::UploaderCompact>(
            NoParams {},
            "Compacting the upload journal…",
            |app, error| {
                app.update_state(|state| {
                    state.compacting_journal = false;
                    state.upload_action_error = error.map(|e| e.message);
                });
                app.render_stages();
            },
        );
        if !started {
            self.update_state(|state| {
                state.compacting_journal = false;
                state.upload_action_error = Some(super::settings_page::UPLOADER_BUSY.into());
            });
            self.render_stages();
        }
    }

    /// Retries uploads a problem stopped; queued records are kept.
    pub fn retry_uploads(&self) {
        self.update_state(|state| {
            state.upload_action_error = None;
            state.retrying_uploads = true;
        });
        self.render_stages();
        let started = self.uploader_command::<method::UploaderRetry>(
            NoParams {},
            "Retrying uploads…",
            |app, error| {
                app.update_state(|state| {
                    state.retrying_uploads = false;
                    state.upload_action_error = error.map(|e| e.message);
                });
                app.render_stages();
            },
        );
        if !started {
            self.update_state(|state| {
                state.retrying_uploads = false;
                state.upload_action_error = Some(super::settings_page::UPLOADER_BUSY.into());
            });
            self.render_stages();
        }
    }

    /// The stage checklist, wherever it shows.
    fn render_stages(&self) {
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
