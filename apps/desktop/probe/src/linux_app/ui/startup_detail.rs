//! The loading screen detail and its rotating startup hints.

use super::widgets::{text, LabelStyle};
use crate::linux_app::models::STARTUP_MESSAGES;
use gtk::{glib, prelude::*};
use gtk4 as gtk;
use std::time::Duration;

pub(super) fn add(panel: &gtk::Box, reconnecting: bool) {
    if reconnecting {
        panel.append(
            &text(
                "Agent Relay is reconnecting to its background service.",
                &["secondary", "signin-subtitle"],
            )
            .wrapped(),
        );
    } else {
        let mut index = glib::random_int_range(0, STARTUP_MESSAGES.len() as i32) as usize;
        let detail = text(STARTUP_MESSAGES[index], &["secondary", "signin-subtitle"]).wrapped();
        detail.set_size_request(-1, 48);
        detail.set_valign(gtk::Align::Start);
        panel.append(&detail);
        let weak_detail = detail.downgrade();
        glib::timeout_add_local(Duration::from_secs(4), move || {
            let Some(detail) = weak_detail.upgrade() else {
                return glib::ControlFlow::Break;
            };
            if detail.root().is_none() {
                return glib::ControlFlow::Break;
            }
            if detail.settings().is_gtk_enable_animations() {
                index = (index + 1) % STARTUP_MESSAGES.len();
                detail.set_text(STARTUP_MESSAGES[index]);
            }
            glib::ControlFlow::Continue
        });
    }
}
