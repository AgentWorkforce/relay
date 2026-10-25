//! The signed-in pages beside Settings: My agents, My sessions, Team and
//! Messages. Each is built once into the page stack and redrawn from the
//! window's state ([`super::state::State`]) when what it lists changes;
//! what a redraw must not lose (an agent's typed tools, open conversations)
//! is kept here and put back.

use super::agents_page::AgentTools;
use super::capy_spawn::CapySpawnDialog;
use super::messages::MessagesPage;
use super::sessions_page::SessionsPage;
use super::state::Page;
use super::widgets;
use gtk::prelude::*;
use gtk4 as gtk;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// The Mac's readable width for a page's rows.
const CONTENT_WIDTH: i32 = 820;

/// A page that scrolls one column of rows.
pub struct PageColumn {
    pub scroller: gtk::ScrolledWindow,
    pub column: gtk::Box,
}

impl PageColumn {
    fn build() -> PageColumn {
        let (column, holder) = widgets::column(CONTENT_WIDTH);
        PageColumn {
            scroller: widgets::scrolled(&holder),
            column,
        }
    }

    /// Rebuilds the column with `build`, keeping the scroll position and
    /// the keyboard focus a rebuild would move.
    pub fn redraw(&self, build: impl FnOnce(&gtk::Box)) {
        let adjustment = self.scroller.vadjustment();
        let position = adjustment.value();
        let focus = self.column.root().and_then(|root| root.focus());
        widgets::clear(&self.column);
        build(&self.column);
        restore_focus(focus, &self.column);
        gtk::glib::idle_add_local_once(move || adjustment.set_value(position));
    }
}

/// Gives the keyboard focus back to a field a rebuild moved, without
/// selecting its text.
pub fn restore_focus(focus: Option<gtk::Widget>, within: &impl IsA<gtk::Widget>) {
    let Some(focus) = focus else {
        return;
    };
    if focus.has_focus() || focus.root().is_none() || focus.root() != within.root() {
        return;
    }
    match focus.downcast_ref::<gtk::Text>() {
        Some(text) => {
            text.grab_focus_without_selecting();
        }
        None => {
            focus.grab_focus();
        }
    }
}

/// Takes `widget` out of the box holding it, so it can be put back
/// elsewhere.
pub fn detach(widget: &impl IsA<gtk::Widget>) {
    if let Some(parent) = widget.parent().and_downcast::<gtk::Box>() {
        parent.remove(widget);
    }
}

/// The pages' roots, and what they keep across redraws.
pub struct Pages {
    pub agents: PageColumn,
    pub sessions: SessionsPage,
    pub team: PageColumn,
    pub messages: MessagesPage,
    /// The Capy spawn window, while open.
    pub(super) capy_spawn: RefCell<Option<Rc<CapySpawnDialog>>>,
    /// Each agent's tools by session (`Target::key`): typed text, the last
    /// outcome and a new webhook's token survive a redraw.
    pub tools: RefCell<HashMap<String, Rc<AgentTools>>>,
}

impl Pages {
    pub fn build() -> Pages {
        Pages {
            agents: PageColumn::build(),
            sessions: SessionsPage::build(),
            team: PageColumn::build(),
            messages: MessagesPage::build(),
            capy_spawn: RefCell::default(),
            tools: RefCell::default(),
        }
    }

    pub fn named(&self) -> [(&'static str, gtk::Widget); 4] {
        [
            (
                Page::Agents.stack_name(),
                self.agents.scroller.clone().upcast(),
            ),
            (
                Page::Sessions.stack_name(),
                self.sessions.root.clone().upcast(),
            ),
            (Page::Team.stack_name(), self.team.scroller.clone().upcast()),
            (
                Page::Messages.stack_name(),
                self.messages.root.clone().upcast(),
            ),
        ]
    }

    /// The tools of the agent the session (`Target::key`) is, while its
    /// details have shown them.
    pub fn tools(&self, key: &str) -> Option<Rc<AgentTools>> {
        self.tools.borrow().get(key).cloned()
    }
}
