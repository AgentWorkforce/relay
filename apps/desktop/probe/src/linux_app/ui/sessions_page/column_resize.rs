//! Column resizing from the trailing edge of each sessions-table header.
use super::*;

impl App {
    fn begin_column_resize(&self, column: SessionColumn) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions;
        let mut layout = self.session_columns();
        let width = page
            .column_frames
            .iter()
            .find(|(id, _, _)| *id == column)
            .map(|(_, frame, _)| frame.width())
            .unwrap_or(layout.width(column));
        layout.set_width(column, width);
        *page.resizing.borrow_mut() = Some((column, width, layout));
    }
    fn update_column_resize(&self, offset: f64) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions;
        let mut pending = page.resizing.borrow_mut();
        if let Some((column, initial, layout)) = pending.as_mut() {
            layout.set_width(*column, (*initial as f64 + offset).round() as i32);
            page.apply_column_widths(layout);
        }
    }
    /// Returns whether a resize was pending.
    fn finish_column_resize(&self, commit: bool) -> bool {
        let Some(shell) = self.shell() else {
            return false;
        };
        let page = &shell.pages.sessions;
        let pending = page.resizing.borrow_mut().take();
        let Some((_, _, layout)) = pending else {
            return false;
        };
        if commit {
            self.set_session_columns(layout);
        } else {
            page.apply_column_widths(&self.session_columns());
        }
        true
    }
    fn reset_column_width(&self, column: SessionColumn) {
        self.finish_column_resize(false);
        let mut layout = self.session_columns();
        layout.set_width(column, column.width());
        self.set_session_columns(layout);
    }
    pub(super) fn bind_column_resizing(&self, page: &SessionsPage) {
        for (column, frame, handle) in &page.column_frames {
            let drag = self.resize_drag(*column, handle);
            frame.add_controller(drag.clone());
            let click = self.reset_click(*column);
            frame.add_controller(click.clone());
            drag.group_with(&click);
            handle.add_controller(self.resize_keys(*column, handle));
        }
    }
    /// Tracks in the header cell's coordinates, not the moving grip's.
    /// Otherwise each width update moves the gesture's coordinate origin.
    fn resize_drag(&self, column: SessionColumn, handle: &gtk::Box) -> gtk::GestureDrag {
        let drag = gtk::GestureDrag::new();
        drag.set_button(1);
        drag.set_propagation_phase(gtk::PropagationPhase::Capture);
        let (weak, focus) = (self.downgrade(), handle.downgrade());
        drag.connect_drag_begin(move |gesture, x, _| {
            if !gesture.widget().is_some_and(|widget| on_grip(&widget, x)) {
                gesture.set_state(gtk::EventSequenceState::Denied);
                return;
            }
            if let (Some(app), Some(handle)) = (weak.upgrade(), focus.upgrade()) {
                handle.grab_focus();
                app.begin_column_resize(column);
            }
        });
        let weak = self.downgrade();
        drag.connect_drag_update(move |gesture, x, _| {
            if x.abs() >= 2.0 {
                gesture.set_state(gtk::EventSequenceState::Claimed);
            }
            if let Some(app) = weak.upgrade() {
                app.update_column_resize(x);
            }
        });
        let (weak, focus) = (self.downgrade(), handle.downgrade());
        drag.connect_drag_end(move |_, x, _| {
            if let Some(app) = weak.upgrade() {
                app.update_column_resize(x);
                app.finish_column_resize(true);
            }
            if let Some(handle) = focus.upgrade() {
                release_focus(&handle);
            }
        });
        let (weak, focus) = (self.downgrade(), handle.downgrade());
        drag.connect_cancel(move |_, _| {
            if let Some(app) = weak.upgrade() {
                app.finish_column_resize(false);
            }
            if let Some(handle) = focus.upgrade() {
                release_focus(&handle);
            }
        });
        drag
    }
    fn reset_click(&self, column: SessionColumn) -> gtk::GestureClick {
        let click = gtk::GestureClick::new();
        click.set_button(1);
        click.set_propagation_phase(gtk::PropagationPhase::Capture);
        let weak = self.downgrade();
        click.connect_pressed(move |gesture, count, x, _| {
            if count == 2 && gesture.widget().is_some_and(|widget| on_grip(&widget, x)) {
                gesture.set_state(gtk::EventSequenceState::Claimed);
                if let Some(app) = weak.upgrade() {
                    app.reset_column_width(column);
                }
            }
        });
        click
    }
    fn resize_keys(&self, column: SessionColumn, handle: &gtk::Box) -> gtk::EventControllerKey {
        let key = gtk::EventControllerKey::new();
        let (weak, focus) = (self.downgrade(), handle.downgrade());
        key.connect_key_pressed(move |_, key, _, modifiers| {
            let Some(app) = weak.upgrade() else {
                return glib::Propagation::Proceed;
            };
            if key == gtk::gdk::Key::Escape {
                // Only a pointer drag leaves a resize pending; keyboard focus
                // on the grip stays put.
                if app.finish_column_resize(false) {
                    if let Some(handle) = focus.upgrade() {
                        release_focus(&handle);
                    }
                }
                return glib::Propagation::Stop;
            }
            let Some(step) = key_step(key, modifiers) else {
                return glib::Propagation::Proceed;
            };
            app.begin_column_resize(column);
            app.update_column_resize(step);
            app.finish_column_resize(true);
            glib::Propagation::Stop
        });
        key
    }
}

/// The grip is the trailing 10 points of a header cell.
fn on_grip(header: &gtk::Widget, x: f64) -> bool {
    x >= f64::from(header.width() - 10)
}

/// Left and Right resize by 10 points, or 40 with Shift.
fn key_step(key: gtk::gdk::Key, modifiers: gtk::gdk::ModifierType) -> Option<f64> {
    let step = if modifiers.contains(gtk::gdk::ModifierType::SHIFT_MASK) {
        40.0
    } else {
        10.0
    };
    match key {
        gtk::gdk::Key::Left => Some(-step),
        gtk::gdk::Key::Right => Some(step),
        _ => None,
    }
}

/// A pointer drag holds the grip's focus only while it runs, so Escape can
/// cancel it; releasing it afterwards keeps the grip from staying highlighted.
fn release_focus(widget: &impl IsA<gtk::Widget>) {
    if let Some(root) = widget.root() {
        if root.focus().as_ref() == Some(widget.upcast_ref()) {
            root.set_focus(None::<&gtk::Widget>);
        }
    }
}
