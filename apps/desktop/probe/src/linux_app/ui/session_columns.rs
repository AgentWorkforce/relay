use super::{
    app::App,
    widgets::{self, button, hbox, text, vbox},
};
use crate::linux_app::models::{SessionColumn, SessionColumnLayout, SESSION_COLUMNS_KEY};
use gtk::{gdk, prelude::*};
use gtk4 as gtk;
use std::{cell::Cell, rc::Rc};

pub(super) struct SessionColumnControls {
    pub button: gtk::MenuButton,
    list: gtk::Box,
    count: gtk::Label,
    show_hidden: gtk::CheckButton,
    syncing: Rc<Cell<bool>>,
    rows: Vec<(
        SessionColumn,
        gtk::Box,
        gtk::CheckButton,
        gtk::Button,
        gtk::Button,
    )>,
}
impl SessionColumnControls {
    pub fn build(app: &App, grouping: &gtk::DropDown) -> Self {
        let button_menu = gtk::MenuButton::new();
        button_menu.set_child(Some(&widgets::glyph("rectangle.split.3x1", 16, "text")));
        button_menu.set_tooltip_text(Some("Table display"));
        widgets::name(&button_menu, "Table display");
        button_menu.set_widget_name("session-columns");
        button_menu.add_css_class("cloud-select");
        button_menu.add_css_class("header-icon");
        widgets::action_cursor(&button_menu);
        let popover = gtk::Popover::new();
        widgets::name(&popover, "Table display");
        let content = vbox(12, &[]);
        widgets::pad(&content, 20, Some(20), None);
        content.set_size_request(380, -1);
        let group_field = vbox(8, &[]);
        group_field.append(&text("Group by", &["caption"]));
        grouping.set_hexpand(true);
        group_field.append(grouping);
        content.append(&group_field);
        let count = text("", &["caption"]);
        content.append(&count);
        let list = vbox(6, &[]);
        content.append(&list);
        let syncing = Rc::new(Cell::new(false));
        let show_hidden = gtk::CheckButton::with_label("Show hidden");
        show_hidden.set_widget_name("show-hidden-sessions");
        widgets::action_cursor(&show_hidden);
        content.insert_child_after(&show_hidden, Some(&group_field));
        let sync = syncing.clone();
        let weak = app.downgrade();
        show_hidden.connect_toggled(move |check| {
            if !sync.get() {
                if let Some(app) = weak.upgrade() {
                    app.set_show_hidden_sessions(check.is_active());
                }
            }
        });
        let mut rows = Vec::new();
        for column in SessionColumn::ALL {
            let row = hbox(8, &["column-setting"]);
            row.set_height_request(40);
            row.set_widget_name(&format!("column-setting {}", column.id()));
            let handle = button("☰", &["flat"], || {});
            handle.set_tooltip_text(Some(&format!("Drag to reorder {}", column.title())));
            widgets::name(&handle, &format!("Reorder {}", column.title()));
            handle.set_cursor_from_name(Some("grab"));
            let source = gtk::DragSource::new();
            source.set_actions(gdk::DragAction::MOVE);
            let preview_row = row.downgrade();
            source.connect_prepare(move |source, x, y| {
                if let Some(row) = preview_row.upgrade() {
                    // Snapshot the entire row before dimming its original location.
                    let image = gtk::WidgetPaintable::new(Some(&row)).current_image();
                    source.set_icon(Some(&image), x as i32 + 8, y as i32);
                }
                Some(gdk::ContentProvider::for_value(
                    &format!("session-column:{}", column.id()).to_value(),
                ))
            });
            let dragging_row = row.downgrade();
            source.connect_drag_begin(move |_, _| {
                if let Some(row) = dragging_row.upgrade() {
                    row.add_css_class("column-dragging");
                }
            });
            let finished_list = list.downgrade();
            source.connect_drag_end(move |_, _, _| {
                if let Some(list) = finished_list.upgrade() {
                    clear_drag_feedback(&list);
                }
            });
            let cancelled_list = list.downgrade();
            source.connect_drag_cancel(move |_, _, _| {
                if let Some(list) = cancelled_list.upgrade() {
                    clear_drag_feedback(&list);
                }
                false
            });
            handle.add_controller(source);
            row.append(&handle);
            let check = gtk::CheckButton::with_label(column.title());
            check.set_hexpand(true);
            check.set_widget_name(&format!("show-column {}", column.id()));
            widgets::name(&check, &format!("Show {}", column.title()));
            let weak = app.downgrade();
            let syncing_check = syncing.clone();
            check.connect_toggled(move |check| {
                if syncing_check.get() {
                    return;
                }
                if let Some(app) = weak.upgrade() {
                    let mut layout = app.session_columns();
                    layout.set_visible(column, check.is_active());
                    app.set_session_columns(layout);
                }
            });
            row.append(&check);
            let mut arrows = Vec::new();
            for (direction, label, offset) in [("up", "↑", -1isize), ("down", "↓", 1)] {
                let weak = app.downgrade();
                let arrow = button(label, &["flat"], move || {
                    if let Some(app) = weak.upgrade() {
                        let mut layout = app.session_columns();
                        let index = layout.order.iter().position(|c| *c == column).unwrap()
                            as isize
                            + offset;
                        if let Some(target) = usize::try_from(index)
                            .ok()
                            .and_then(|i| layout.order.get(i))
                            .copied()
                        {
                            layout.move_to(column, target);
                            app.set_session_columns(layout);
                        }
                    }
                });
                arrow.set_widget_name(&format!("move-column-{} {}", direction, column.id()));
                widgets::name(&arrow, &format!("Move {} {}", column.title(), direction));
                row.append(&arrow);
                arrows.push(arrow);
            }
            let drop = gtk::DropTarget::new(String::static_type(), gdk::DragAction::MOVE);
            let hover_row = row.downgrade();
            drop.connect_motion(move |_, _, y| {
                if let Some(row) = hover_row.upgrade() {
                    let after = y > f64::from(row.height()) / 2.0;
                    widgets::toggle_class(&row, "column-drop-before", !after);
                    widgets::toggle_class(&row, "column-drop-after", after);
                }
                gdk::DragAction::MOVE
            });
            let leave_row = row.downgrade();
            drop.connect_leave(move |_| {
                if let Some(row) = leave_row.upgrade() {
                    row.remove_css_class("column-drop-before");
                    row.remove_css_class("column-drop-after");
                }
            });
            let weak = app.downgrade();
            let target_row = row.downgrade();
            let finished_list = list.downgrade();
            drop.connect_drop(move |_, value, _, y| {
                let Some(from) = value.get::<String>().ok().and_then(|v| {
                    v.strip_prefix("session-column:").and_then(|id| {
                        serde_json::from_value::<SessionColumn>(serde_json::json!(id)).ok()
                    })
                }) else {
                    return false;
                };
                if let Some(list) = finished_list.upgrade() {
                    clear_drag_feedback(&list);
                }
                if let Some(app) = weak.upgrade() {
                    if from != column {
                        let mut layout = app.session_columns();
                        layout.order.retain(|id| *id != from);
                        let after = target_row
                            .upgrade()
                            .is_some_and(|row| y > f64::from(row.height()) / 2.0);
                        let index = layout.order.iter().position(|id| *id == column).unwrap()
                            + usize::from(after);
                        layout.order.insert(index, from);
                        app.set_session_columns(layout);
                    }
                    return true;
                }
                false
            });
            row.add_controller(drop);
            list.append(&row);
            rows.push((column, row, check, arrows[0].clone(), arrows[1].clone()));
        }
        let footer = hbox(8, &[]);
        let weak = app.downgrade();
        let reset = button("Reset to default", &[], move || {
            if let Some(app) = weak.upgrade() {
                app.set_session_columns(SessionColumnLayout::default());
                if !app.inner.window.is_fullscreen() {
                    app.inner.window.unmaximize();
                    app.inner.window.set_default_size(
                        crate::linux_app::models::DEFAULT_WINDOW_WIDTH,
                        crate::linux_app::models::DEFAULT_WINDOW_HEIGHT,
                    );
                }
            }
        });
        reset.set_widget_name("reset-session-columns");
        footer.append(&reset);
        footer.append(&widgets::spacer());
        let pop = popover.downgrade();
        let done = button("Done", &["primary"], move || {
            if let Some(pop) = pop.upgrade() {
                pop.popdown();
            }
        });
        done.set_size_request(72, 32);
        footer.append(&done);
        content.append(&footer);
        popover.set_child(Some(&content));
        button_menu.set_popover(Some(&popover));
        Self {
            button: button_menu,
            list,
            count,
            show_hidden,
            syncing,
            rows,
        }
    }
    pub fn update(&self, layout: &SessionColumnLayout, show_hidden: bool) {
        self.button
            .set_child(Some(&widgets::glyph("rectangle.split.3x1", 16, "text")));
        self.syncing.set(true);
        self.show_hidden.set_active(show_hidden);
        let visible = layout.visible();
        self.count.set_text(&format!(
            "{} of {} columns shown",
            visible.len(),
            layout.order.len()
        ));
        let mut previous: Option<gtk::Widget> = None;
        for (index, column) in layout.order.iter().enumerate() {
            let (_, row, check, up, down) = self.rows.iter().find(|(id, ..)| id == column).unwrap();
            self.list.reorder_child_after(row, previous.as_ref());
            previous = Some(row.clone().upcast());
            check.set_active(visible.contains(column));
            check.set_sensitive(visible.len() > 1 || !visible.contains(column));
            up.set_sensitive(index > 0);
            down.set_sensitive(index + 1 < layout.order.len());
        }
        self.syncing.set(false);
    }
}
fn clear_drag_feedback(list: &gtk::Box) {
    let mut row = list.first_child();
    while let Some(widget) = row {
        widget.remove_css_class("column-dragging");
        widget.remove_css_class("column-drop-before");
        widget.remove_css_class("column-drop-after");
        row = widget.next_sibling();
    }
}

impl App {
    pub fn session_columns(&self) -> SessionColumnLayout {
        SessionColumnLayout::from_value(self.prefs().get(SESSION_COLUMNS_KEY))
    }
    pub fn set_session_columns(&self, layout: SessionColumnLayout) {
        let _ = self
            .inner
            .prefs
            .borrow_mut()
            .set(SESSION_COLUMNS_KEY, layout.value());
        if let Some(shell) = self.shell() {
            shell.pages.sessions.invalidate_columns();
        }
        self.render_sessions();
    }
}
