//! The Sessions page's setup cards, each an offer to put another tool's
//! sessions on the relay: Capy threads while Capy is detected, and Devin
//! sessions while Devin has run here and Agent Relay's hooks are off. Not
//! now hides a card for good. The Mac's `CapySetupCard` and
//! `DevinSetupCard` match these.

use super::app::App;
use super::sessions_page::SessionsPage;
use super::settings_page::SettingRow;
use super::widgets::{self, button, clear, hbox, text, vbox, LabelStyle};
use crate::linux_app::models::{
    capy_setup_shows, devin_setup_shows, CAPY_SETUP_ACTION, CAPY_SETUP_COPIED, CAPY_SETUP_MESSAGE,
    CAPY_SETUP_NOT_NOW, CAPY_SETUP_PROMPT, CAPY_SETUP_TITLE, CAPY_URL, DEVIN_SETUP_MESSAGE,
    DEVIN_SETUP_NOT_NOW, DEVIN_SETUP_TITLE, DEVIN_SETUP_TURN_ON,
};
use crate::relay::contract::agents::SettingsChange;
use gtk::prelude::*;
use gtk4 as gtk;

impl App {
    pub(super) fn render_setup_cards(&self, page: &SessionsPage) {
        self.render_capy_setup(page);
        self.render_devin_setup(page);
    }

    /// Redraws the cards after the core's settings changed.
    pub(super) fn redraw_setup_cards(&self) {
        if let Some(shell) = self.shell() {
            self.render_setup_cards(&shell.pages.sessions);
        }
    }

    /// The offer to put Capy threads on the relay, while Capy is detected
    /// and the person has not chosen Not now.
    fn render_capy_setup(&self, page: &SessionsPage) {
        let copied = self.with_state(|state| state.capy_prompt_copied);
        let drawn = capy_setup_shows(
            self.inner.capy_installed,
            self.prefs().capy_setup_dismissed(),
        )
        .then_some(copied);
        if page.capy_drawn.replace(drawn) == drawn
            && page.capy_setup.first_child().is_some() == drawn.is_some()
        {
            return;
        }
        let slot = &page.capy_setup;
        clear(slot);
        slot.set_visible(drawn.is_some());
        if drawn.is_none() {
            return;
        }
        let card = vbox(8, &["card"]);
        card.append(&text(CAPY_SETUP_TITLE, &["heading"]));
        card.append(&text(CAPY_SETUP_MESSAGE, &["caption"]).wrapped());
        let actions = hbox(8, &[]);
        let set_up = button(
            CAPY_SETUP_ACTION,
            &["primary"],
            self.on(|app| {
                widgets::copy_to_clipboard(CAPY_SETUP_PROMPT);
                app.open_url(CAPY_URL);
                app.update_state(|state| state.capy_prompt_copied = true);
                app.render_sessions();
            }),
        );
        set_up.set_tooltip_text(Some("Copies a prompt and opens Capy"));
        actions.append(&set_up);
        let not_now = button(
            CAPY_SETUP_NOT_NOW,
            &[],
            self.on(|app| {
                let _ = app.inner.prefs.borrow_mut().dismiss_capy_setup();
                app.render_sessions();
            }),
        );
        not_now.set_tooltip_text(Some("Hide this for good"));
        actions.append(&not_now);
        card.append(&actions);
        if copied {
            card.append(&widgets::notice(CAPY_SETUP_COPIED, widgets::Tone::Ok));
        }
        slot.append(&card);
    }

    /// The offer to turn on Devin's hooks, while the core reports them off
    /// and the person has not chosen Not now. Turn On shows the core's
    /// error under it; the card goes once the hooks are on.
    fn render_devin_setup(&self, page: &SessionsPage) {
        let (hooks, error) = self.with_state(|state| {
            (
                state
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.devin_direct_delivery),
                state.devin_delivery_error.clone(),
            )
        });
        let drawn = devin_setup_shows(hooks, self.prefs().devin_setup_dismissed()).then_some(error);
        if *page.devin_drawn.borrow() == drawn
            && page.devin_setup.first_child().is_some() == drawn.is_some()
        {
            return;
        }
        page.devin_drawn.replace(drawn.clone());
        let slot = &page.devin_setup;
        clear(slot);
        slot.set_visible(drawn.is_some());
        let Some(error) = drawn else {
            return;
        };
        let card = vbox(8, &["card"]);
        card.append(&text(DEVIN_SETUP_TITLE, &["heading"]));
        card.append(&text(DEVIN_SETUP_MESSAGE, &["caption"]).wrapped());
        let actions = hbox(8, &[]);
        let turn_on = button(
            DEVIN_SETUP_TURN_ON,
            &["primary"],
            self.on(|app| {
                app.set_setting(
                    SettingsChange {
                        devin_direct_delivery: Some(true),
                        ..SettingsChange::default()
                    },
                    SettingRow::DevinDelivery,
                )
            }),
        );
        turn_on.set_tooltip_text(Some("Add Agent Relay's hooks to Devin"));
        actions.append(&turn_on);
        let not_now = button(
            DEVIN_SETUP_NOT_NOW,
            &[],
            self.on(|app| {
                let _ = app.inner.prefs.borrow_mut().dismiss_devin_setup();
                app.render_sessions();
            }),
        );
        not_now.set_tooltip_text(Some("Hide this for good"));
        actions.append(&not_now);
        card.append(&actions);
        if let Some(error) = error {
            card.append(&widgets::notice(&error, widgets::Tone::Error));
        }
        slot.append(&card);
    }
}
