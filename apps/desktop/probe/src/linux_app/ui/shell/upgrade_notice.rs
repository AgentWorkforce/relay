//! The upgrade notice: a plan limit reached, or a workspace at capacity.

use crate::linux_app::models::{self, RelaycastUpgradeReason};
use crate::linux_app::ui::app::App;
use crate::linux_app::ui::widgets::{self, hbox, text, vbox};
use gtk::prelude::*;
use gtk4 as gtk;

/// The notice card and its title and message labels.
pub(super) fn build(app: &App) -> (gtk::Box, (gtk::Label, gtk::Label)) {
    let notice = vbox(10, &["card"]);
    widgets::pad(&notice, 16, Some(20), None);
    notice.set_visible(false);
    let title = text(models::RELAYCAST_UPGRADE_TITLE, &["heading"]);
    notice.append(&title);
    let message = text(models::RELAYCAST_UPGRADE_MESSAGE, &[]);
    message.set_wrap(true);
    notice.append(&message);
    let actions = hbox(10, &[]);
    let upgrade = gtk::Button::with_label(models::RELAYCAST_UPGRADE_ACTION);
    upgrade.add_css_class("primary");
    let open_billing = app.on(|app| {
        let url = app.with_state(|state| {
            let site = state.account().site_url;
            models::relaycast_upgrade_url(site.as_deref(), state.relaycast_upgrade.as_ref())
        });
        if let Some(url) = url {
            app.open_url(&url);
            app.update_state(|state| state.relaycast_upgrade = None);
            app.render_status_bar();
        }
    });
    upgrade.connect_clicked(move |_| open_billing());
    actions.append(&upgrade);
    let dismiss = gtk::Button::with_label("Dismiss upgrade notice");
    let close_notice = app.on(|app| {
        app.update_state(|state| state.relaycast_upgrade = None);
        app.render_status_bar();
    });
    dismiss.connect_clicked(move |_| close_notice());
    actions.append(&dismiss);
    notice.append(&actions);
    (notice, (title, message))
}

/// Shows the notice worded for `reason`, or hides it.
pub(super) fn render(
    notice: &gtk::Box,
    (title, message): &(gtk::Label, gtk::Label),
    reason: Option<&RelaycastUpgradeReason>,
) {
    if let Some(reason) = reason {
        title.set_text(reason.title());
        message.set_text(&reason.message());
    }
    notice.set_visible(reason.is_some());
}
