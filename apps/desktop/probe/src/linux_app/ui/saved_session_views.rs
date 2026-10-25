//! One saved-view menu beside the session search bar.
use super::{
    app::App,
    widgets::{self, button, hbox, text, vbox},
};
use crate::linux_app::models::{
    SavedSessionView, SavedSessionViews, SessionViewConfiguration, SAVED_SESSION_VIEWS_KEY,
    SESSION_COLUMNS_KEY,
};
use gtk4::{self as gtk, prelude::*};

impl App {
    pub fn saved_session_views(&self) -> SavedSessionViews {
        SavedSessionViews::from_value(self.prefs().get(SAVED_SESSION_VIEWS_KEY))
    }
    pub fn store_saved_session_views(&self, views: &SavedSessionViews) -> Result<(), String> {
        let result = self
            .inner
            .prefs
            .borrow_mut()
            .set(
                SAVED_SESSION_VIEWS_KEY,
                serde_json::to_value(views).unwrap(),
            )
            .map_err(|_| "Could not save views. Please try again.".to_owned());
        if result.is_ok() {
            self.refresh_saved_view_indicator();
        }
        result
    }
    pub fn session_view_configuration(&self) -> SessionViewConfiguration {
        let shell = self.shell();
        SessionViewConfiguration {
            search: self.with_state(|state| state.session_search.clone()),
            grouping: shell
                .as_ref()
                .map(|s| s.pages.sessions.grouping.get())
                .unwrap_or(0),
            sort: shell
                .as_ref()
                .map(|s| s.pages.sessions.sort.get())
                .unwrap_or_default(),
            columns: self.session_columns().value(),
            show_hidden: self.show_hidden_sessions(),
        }
    }
    pub fn apply_session_view(&self, view: &SavedSessionView) -> Result<(), String> {
        let config = &view.configuration;
        {
            let mut prefs = self.inner.prefs.borrow_mut();
            prefs
                .set(SESSION_COLUMNS_KEY, config.layout().value())
                .map_err(|e| e.to_string())?;
            prefs
                .set("showHiddenSessions.v1", config.show_hidden.into())
                .map_err(|e| e.to_string())?;
        }
        if let Some(shell) = self.shell() {
            shell.pages.sessions.grouping.set(config.grouping.min(4));
            shell.pages.sessions.sort.set(config.sort);
            shell.pages.sessions.invalidate_columns();
        }
        self.update_state(|state| {
            state.session_search = config.search.clone();
            state.session_selection.clear();
        });
        self.update_tray();
        self.render_sessions();
        Ok(())
    }
}

pub(super) struct SavedViewControls {
    pub button: gtk::MenuButton,
    icon: gtk::DrawingArea,
    filled: std::rc::Rc<std::cell::Cell<bool>>,
}
impl SavedViewControls {
    pub fn build(app: &App) -> Self {
        let button = gtk::MenuButton::new();
        button.add_css_class("flat");
        button.add_css_class("header-icon");
        button.set_always_show_arrow(false);
        button.set_widget_name("saved-session-views");
        widgets::action_cursor(&button);
        let content = hbox(0, &[]);
        widgets::pad(&content, 4, Some(4), None);
        let filled = std::rc::Rc::new(std::cell::Cell::new(false));
        let state = filled.clone();
        let icon = gtk::DrawingArea::new();
        icon.set_content_width(16);
        icon.set_content_height(16);
        icon.set_valign(gtk::Align::Center);
        icon.set_draw_func(move |area, cr, _, _| {
            let color = area.style_context().color();
            cr.set_source_rgba(
                color.red() as f64,
                color.green() as f64,
                color.blue() as f64,
                color.alpha() as f64,
            );
            cr.set_line_width(1.5);
            cr.set_line_join(gtk::cairo::LineJoin::Round);
            cr.move_to(4.0, 2.0);
            cr.line_to(12.0, 2.0);
            cr.line_to(12.0, 14.0);
            cr.line_to(8.0, 11.0);
            cr.line_to(4.0, 14.0);
            cr.close_path();
            if state.get() {
                let _ = cr.fill();
            } else {
                let _ = cr.stroke();
            }
        });
        content.append(&icon);
        button.set_child(Some(&content));
        let pop = gtk::Popover::new();
        pop.add_css_class("session-popover");
        button.set_popover(Some(&pop));
        let weak = app.downgrade();
        pop.connect_show(move |pop| {
            if let Some(app) = weak.upgrade() {
                view_list(&app, pop, None);
            }
        });
        let controls = Self {
            button,
            icon,
            filled,
        };
        controls.update(app);
        controls
    }
    pub fn update(&self, app: &App) {
        let current = app.session_view_configuration();
        let views = app.saved_session_views();
        let matched = views
            .views
            .iter()
            .find(|view| view.configuration == current);
        if self.filled.replace(matched.is_some()) != matched.is_some() {
            self.icon.queue_draw();
        }
        let state = matched
            .map(|view| format!("Saved view: {}", view.name))
            .unwrap_or_else(|| "Unsaved view".to_owned());
        widgets::name(&self.button, &format!("Saved views, {state}"));
        self.button
            .set_tooltip_text(Some(&format!("Saved views — {state}")));
        if matched.is_some() {
            self.button.add_css_class("bookmarked");
        } else {
            self.button.remove_css_class("bookmarked");
        }
    }
}
fn save_form(app: &App, pop: &gtk::Popover) {
    let content = vbox(14, &[]);
    widgets::pad(&content, 20, Some(20), None);
    content.set_size_request(340, -1);
    content.append(&text("Save current view", &["row-title"]));
    let description = text(
        "Keep this search, grouping, sort order, columns, and hidden-session display.",
        &["caption"],
    );
    description.set_wrap(true);
    description.set_max_width_chars(44);
    content.append(&description);
    let name = gtk::Entry::new();
    name.set_placeholder_text(Some("View name"));
    name.set_widget_name("saved-view-name");
    widgets::name(&name, "View name");
    content.append(&name);
    let error = text("", &["caption"]);
    error.set_wrap(true);
    error.set_visible(false);
    content.append(&error);
    let default = gtk::CheckButton::with_label("Make default");
    default.set_tooltip_text(Some("Open this view when the app starts"));
    default.set_widget_name("saved-view-default");
    content.append(&default);
    let actions = hbox(8, &[]);
    let pop_weak = pop.downgrade();
    actions.append(&button("Cancel", &["cloud-control"], move || {
        if let Some(pop) = pop_weak.upgrade() {
            pop.popdown();
        }
    }));
    let spacer = hbox(0, &[]);
    spacer.set_hexpand(true);
    actions.append(&spacer);
    let weak = app.downgrade();
    let pop_weak = pop.downgrade();
    let input = name.clone();
    let toggle = default.clone();
    let feedback = error.clone();
    let save = button("Save", &["primary"], move || {
        if let Some(app) = weak.upgrade() {
            let mut views = app.saved_session_views();
            if views
                .save(
                    &input.text(),
                    app.session_view_configuration(),
                    toggle.is_active(),
                )
                .is_none()
            {
                return;
            }
            match app.store_saved_session_views(&views) {
                Ok(()) => {
                    if let Some(pop) = pop_weak.upgrade() {
                        pop.popdown();
                    }
                }
                Err(message) => {
                    feedback.set_text(&message);
                    feedback.set_visible(true);
                }
            }
        }
    });
    save.set_widget_name("confirm-save-session-view");
    save.set_sensitive(false);
    let weak = app.downgrade();
    let save_weak = save.downgrade();
    name.connect_changed(move |entry| {
        if let (Some(app), Some(save)) = (weak.upgrade(), save_weak.upgrade()) {
            let valid = app.saved_session_views().can_save(&entry.text());
            save.set_sensitive(valid);
            error.set_text("A view with this name already exists.");
            error.set_visible(!entry.text().trim().is_empty() && !valid);
        }
    });
    let save_weak = save.downgrade();
    name.connect_activate(move |_| {
        if let Some(save) = save_weak.upgrade() {
            if save.is_sensitive() {
                save.emit_clicked();
            }
        }
    });
    actions.append(&save);
    content.append(&actions);
    pop.set_child(Some(&content));
    name.grab_focus();
}
fn view_list(app: &App, pop: &gtk::Popover, error: Option<&str>) {
    let content = vbox(12, &[]);
    widgets::pad(&content, 16, Some(16), None);
    content.set_size_request(340, -1);
    content.append(&text("Saved views", &["row-title"]));
    let views = app.saved_session_views();
    let current = app.session_view_configuration();
    let rows = vbox(4, &[]);
    if views.views.is_empty() {
        content.append(&text(
            "Save a search and table layout to use it again.",
            &["caption"],
        ));
    }
    for view in &views.views {
        let row = hbox(4, &["saved-view-row"]);
        let weak = app.downgrade();
        let pop_weak = pop.downgrade();
        let selected = view.clone();
        let apply = button(&view.name, &["cloud-option"], move || {
            if let (Some(app), Some(pop)) = (weak.upgrade(), pop_weak.upgrade()) {
                match app.apply_session_view(&selected) {
                    Ok(()) => pop.popdown(),
                    Err(_) => view_list(
                        &app,
                        &pop,
                        Some("Could not restore view. Please try again."),
                    ),
                }
            }
        });
        apply.set_hexpand(true);
        apply.set_tooltip_text(Some(&view.name));
        widgets::name(
            &apply,
            &format!(
                "Open {}{}",
                view.name,
                if current == view.configuration {
                    ", Current view"
                } else {
                    ""
                }
            ),
        );
        apply.set_widget_name(&format!("open-saved-view-{}", view.id));
        let label = hbox(8, &[]);
        let check = widgets::icon("object-select-symbolic", 12);
        check.set_opacity(if current == view.configuration {
            1.0
        } else {
            0.0
        });
        label.append(&check);
        let title = text(&view.name, &[]);
        title.set_ellipsize(gtk::pango::EllipsizeMode::End);
        title.set_max_width_chars(28);
        title.set_hexpand(true);
        label.append(&title);
        apply.set_child(Some(&label));
        row.append(&apply);
        for delete in [false, true] {
            let is_default = views.default_id == Some(view.id);
            let title = format!(
                "{} {}",
                if delete {
                    "Delete saved view"
                } else if is_default {
                    "Remove default:"
                } else {
                    "Make default:"
                },
                view.name
            );
            let weak = app.downgrade();
            let pop_weak = pop.downgrade();
            let id = view.id;
            let action = widgets::icon_button(
                if delete {
                    "window-close-symbolic"
                } else if is_default {
                    "starred-symbolic"
                } else {
                    "non-starred-symbolic"
                },
                &title,
                &["cloud-option"],
                move || {
                    if let (Some(app), Some(pop)) = (weak.upgrade(), pop_weak.upgrade()) {
                        let mut views = app.saved_session_views();
                        if delete {
                            views.delete(id);
                        } else {
                            views.set_default(if views.default_id == Some(id) {
                                None
                            } else {
                                Some(id)
                            });
                        }
                        let error = app.store_saved_session_views(&views).err();
                        view_list(&app, &pop, error.as_deref());
                        pop.child_focus(gtk::DirectionType::TabForward);
                    }
                },
            );
            action.set_widget_name(&format!(
                "{}-saved-view-{}",
                if delete { "delete" } else { "default" },
                view.id
            ));
            if delete {
                action.add_css_class("saved-view-delete");
            }
            row.append(&action);
        }
        rows.append(&row);
    }
    let scroll = gtk::ScrolledWindow::new();
    scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    scroll.set_max_content_height(300);
    scroll.set_propagate_natural_height(true);
    scroll.set_child(Some(&rows));
    content.append(&scroll);
    if !views.views.is_empty() {
        content.append(&text(
            "The default view opens when the app starts.",
            &["caption"],
        ));
    }
    if let Some(error) = error {
        content.append(&text(error, &["caption"]));
    }
    let pop_weak = pop.downgrade();
    let weak = app.downgrade();
    let save_current = button("Save current view", &["primary"], move || {
        if let (Some(app), Some(pop)) = (weak.upgrade(), pop_weak.upgrade()) {
            save_form(&app, &pop);
        }
    });
    save_current.set_halign(gtk::Align::End);
    content.append(&save_current);
    pop.set_child(Some(&content));
}
