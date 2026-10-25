//! Agent names in the window: a session row's second line, and the name
//! in a rename field with its alias explained on hover.

use super::widgets::{hbox, text};
use crate::linux_app::models::{AgentName, LocalSessionRow};
use crate::relay::contract::agents::LocalAgent;
use gtk::prelude::*;
use gtk4 as gtk;

/// `@name · model · harness` for a session on the relay (its alias once
/// renamed): what to message it by. Otherwise `details` alone.
pub fn subtitle(session: &LocalSessionRow, key: &str, details: gtk::Label) -> gtk::Widget {
    let Some(agent) = session.agent_name() else {
        return details.upcast();
    };
    let line = hbox(0, &[]);
    let name = text(&format!("@{agent}"), &["caption", "agent-name"]);
    name.set_ellipsize(gtk::pango::EllipsizeMode::End);
    name.set_tooltip_text(session.agent_detail().as_deref());
    name.set_widget_name(&format!("agent-name {key}"));
    line.append(&name);
    if !details.text().is_empty() {
        line.append(&text(" · ", &["caption", "secondary"]));
        details.set_hexpand(true);
        line.append(&details);
    }
    line.upcast()
}

/// Shows `name` in a rename field, with what renaming does on hover.
pub fn show_in_field(entry: &gtk::Entry, name: Option<&AgentName>) {
    entry.set_text(name.map_or("", AgentName::shown));
    entry.set_tooltip_text(name.map(AgentName::note).as_deref());
}

/// Shows `agent` in its tools' rename field, keeping what is typed there
/// until the name shown changes.
pub fn update_field(entry: &gtk::Entry, previous: Option<&LocalAgent>, agent: &LocalAgent) {
    let name = AgentName::of(agent);
    if previous.map(LocalAgent::display_name) != Some(name.shown()) || entry.text().is_empty() {
        show_in_field(entry, Some(&name));
    }
    entry.set_tooltip_text(Some(&name.note()));
}
