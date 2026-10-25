//! Whole-editor focus and click-away debounce, fenced to this session and view.
use super::*;
use std::cell::RefCell;

fn inside(widget: &gtk::Widget, root: &gtk::Box) -> bool {
    widget == root.upcast_ref::<gtk::Widget>() || widget.is_ancestor(root)
}

fn defer(
    app: &App,
    row: &LocalSessionRow,
    root: &gtk::Box,
    token: &Rc<Cell<u64>>,
    check_focus: bool,
) {
    let generation = app.with_state(|state| state.generation);
    let nonce = token.get().wrapping_add(1);
    token.set(nonce);
    let (weak, widget, row, token) = (
        app.downgrade(),
        root.downgrade(),
        row.clone(),
        token.clone(),
    );
    glib::timeout_add_local_once(std::time::Duration::from_millis(150), move || {
        if token.get() != nonce {
            return;
        }
        let Some(root) = widget.upgrade().filter(|widget| widget.is_mapped()) else {
            return;
        };
        let Some(app) = weak.upgrade() else {
            return;
        };
        if check_focus
            && gtk::prelude::GtkWindowExt::focus(app.window())
                .is_some_and(|focused| inside(&focused, &root))
        {
            return;
        }
        let current = app.shell().is_some_and(|shell| {
            shell
                .pages
                .sessions
                .transcript
                .selected
                .borrow()
                .as_ref()
                .is_some_and(|selected| selected.key() == row.key())
        });
        let ready = app.with_state(|state| {
            state.generation == generation
                && state
                    .session_titles
                    .get(&row.key())
                    .is_some_and(|edit| edit.draft.is_some() && edit.error.is_none())
        });
        if current && ready {
            app.commit_session_title(&row);
        }
    });
}

fn outside_clicks(app: &App, row: &LocalSessionRow, root: &gtk::Box, token: &Rc<Cell<u64>>) {
    let click = gtk::GestureClick::new();
    click.set_name(Some("session-title-click-away"));
    click.set_propagation_phase(gtk::PropagationPhase::Capture);
    let (weak, widget, selected, revision) = (
        app.downgrade(),
        root.downgrade(),
        row.clone(),
        token.clone(),
    );
    click.connect_pressed(move |_, _, x, y| {
        let Some(app) = weak.upgrade() else {
            return;
        };
        let Some(root) = widget.upgrade().filter(|root| root.is_mapped()) else {
            return;
        };
        if app
            .window()
            .pick(x, y, gtk::PickFlags::DEFAULT)
            .is_some_and(|picked| inside(&picked, &root))
        {
            revision.set(revision.get().wrapping_add(1));
        } else {
            defer(&app, &selected, &root, &revision, false);
        }
    });
    let active_handler = Rc::new(RefCell::new(None));
    let (window, click_on, handler, weak, selected, revision) = (
        app.window().downgrade(),
        click.clone(),
        active_handler.clone(),
        app.downgrade(),
        row.clone(),
        token.clone(),
    );
    root.connect_map(move |root| {
        if let Some(window) = window.upgrade() {
            window.add_controller(click_on.clone());
            let (weak, widget, selected, revision) = (
                weak.clone(),
                root.downgrade(),
                selected.clone(),
                revision.clone(),
            );
            *handler.borrow_mut() = Some(window.connect_is_active_notify(move |window| {
                revision.set(revision.get().wrapping_add(1));
                if !window.is_active() {
                    if let (Some(app), Some(root)) = (weak.upgrade(), widget.upgrade()) {
                        defer(&app, &selected, &root, &revision, false);
                    }
                }
            }));
        }
    });
    let window = app.window().downgrade();
    root.connect_unmap(move |_| {
        if let Some(window) = window.upgrade() {
            window.remove_controller(&click);
            if let Some(handler) = active_handler.borrow_mut().take() {
                window.disconnect(handler);
            }
        }
    });
}

fn connect_text(
    app: &App,
    row: &LocalSessionRow,
    entry: &gtk::Entry,
    syncing: &Rc<Cell<bool>>,
    revision: &Rc<Cell<u64>>,
) {
    let (sync, token, changed_key, weak) = (
        syncing.clone(),
        revision.clone(),
        row.key(),
        app.downgrade(),
    );
    entry.connect_changed(move |entry| {
        if sync.get() {
            return;
        }
        token.set(token.get().wrapping_add(1));
        if let Some(app) = weak.upgrade() {
            app.update_state(|state| {
                if let Some(edit) = state
                    .session_titles
                    .get_mut(&changed_key)
                    .filter(|edit| edit.draft.is_some())
                {
                    edit.draft = Some(entry.text().to_string());
                    edit.error = None;
                }
            });
        }
    });
}

fn connect_keys(app: &App, row: &LocalSessionRow, root: &gtk::Box, entry: &gtk::Entry) {
    let (saved, weak) = (row.clone(), app.downgrade());
    entry.connect_activate(move |_| {
        if let Some(app) = weak.upgrade() {
            app.save_session_title(&saved);
        }
    });
    let keyboard = gtk::EventControllerKey::new();
    let (key, weak) = (row.key(), app.downgrade());
    keyboard.connect_key_pressed(move |_, keyval, _, _| {
        if keyval != gtk::gdk::Key::Escape {
            return glib::Propagation::Proceed;
        }
        if let Some(app) = weak.upgrade() {
            app.cancel_session_title_edit(&key);
        }
        glib::Propagation::Stop
    });
    root.add_controller(keyboard);
}

pub(super) fn connect(
    app: &App,
    row: &LocalSessionRow,
    root: &gtk::Box,
    entry: &gtk::Entry,
    syncing: &Rc<Cell<bool>>,
    revision: &Rc<Cell<u64>>,
) {
    connect_text(app, row, entry, syncing, revision);
    connect_keys(app, row, root, entry);
    let focus = gtk::EventControllerFocus::new();
    let token = revision.clone();
    focus.connect_enter(move |_| token.set(token.get().wrapping_add(1)));
    let token = revision.clone();
    root.connect_unmap(move |_| token.set(token.get().wrapping_add(1)));
    let (weak, widget, selected, token) = (
        app.downgrade(),
        root.downgrade(),
        row.clone(),
        revision.clone(),
    );
    focus.connect_leave(move |_| {
        if let (Some(app), Some(root)) = (weak.upgrade(), widget.upgrade()) {
            defer(&app, &selected, &root, &token, true);
        }
    });
    root.add_controller(focus);
    outside_clicks(app, row, root, revision);
}
