//! Renaming the open session's agent from its header: the new name shows
//! at once and goes back if the core refuses.
use super::*;

impl App {
    pub(super) fn rename_transcript_agent(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions.transcript;
        if page.renaming.get() || !page.rename.is_sensitive() {
            return;
        }
        let Some(name) = page.current_name.borrow().clone() else {
            return;
        };
        let requested = page
            .agent_name
            .text()
            .trim()
            .trim_matches('@')
            .to_lowercase();
        if requested.is_empty() || requested == name.shown() {
            return;
        }
        let generation = page.generation.get();
        page.renaming.set(true);
        page.rename_status.set_text("");
        page.rename_status.set_visible(false);
        // The new name shows at once, and goes back if the core refuses.
        let previous = self.show_rename(&name.name, &requested);
        self.render_transcript_controls();
        let reverted_to = requested.clone();
        self.view_call::<method::AgentsRename>(
            RenameParams {
                name: name.name.clone(),
                new_name: requested,
            },
            move |app, result| {
                // The old name comes back wherever it shows, whether or not
                // this transcript is still open.
                if result.is_err() {
                    app.revert_rename(&name.name, &reverted_to, previous);
                }
                let Some(shell) = app.shell() else {
                    return;
                };
                let page = &shell.pages.sessions.transcript;
                if page.generation.get() != generation {
                    return;
                }
                page.renaming.set(false);
                page.rename_status.set_visible(true);
                match result {
                    Ok(renamed) => {
                        page.rename_status.set_text(&renamed.outcome(&name.name));
                        app.refresh_agents();
                        app.refresh_local();
                    }
                    Err(error) => page.rename_status.set_text(&error.message),
                }
                app.render_transcript_controls();
            },
        );
    }
}
