//! Borderless title editing in the transcript header only.
use super::super::app::App;
use super::super::widgets::{self, button, hbox, icon};
use crate::linux_app::models::LocalSessionRow;
use gtk::{glib, prelude::*};
use gtk4 as gtk;
use std::cell::Cell;
use std::rc::Rc;

mod focus;

pub(in crate::linux_app::ui) struct SessionTitleCell {
    pub root: gtk::Box,
    row: LocalSessionRow,
    title_stack: gtk::Stack,
    controls: gtk::Stack,
    title: gtk::Label,
    edit: gtk::Button,
    edit_symbol: gtk::Box,
    saving: gtk::Box,
    spinner: gtk::Spinner,
    entry: gtk::Entry,
    auto: gtk::Button,
    save: gtk::Button,
    error: gtk::Image,
    syncing: Rc<Cell<bool>>,
    blur_revision: Rc<Cell<u64>>,
    return_focus: Cell<bool>,
}

impl SessionTitleCell {
    pub fn build(app: &App, row: &LocalSessionRow, title: &gtk::Label) -> Self {
        let key = row.key();
        let root = hbox(8, &["session-title-cell"]);
        root.set_hexpand(true);
        root.set_height_request(24);
        root.set_valign(gtk::Align::Center);
        title.add_css_class("session-header-title");
        title.set_valign(gtk::Align::Center);
        let title_stack = gtk::Stack::new();
        title_stack.set_hexpand(true);
        title_stack.add_named(title, Some("title"));
        let entry = gtk::Entry::new();
        entry.add_css_class("session-title-entry");
        entry.set_hexpand(true);
        entry.set_width_chars(4);
        entry.set_widget_name(&format!("session-title-entry {key}"));
        widgets::name(&entry, "Session title");
        title_stack.add_named(&entry, Some("editor"));
        root.append(&title_stack);
        let controls = gtk::Stack::new();
        controls.set_size_request(160, 24);
        let display = hbox(4, &[]);
        display.set_halign(gtk::Align::End);
        let selected = row.clone();
        let edit = button(
            "",
            &["flat", "title-action"],
            app.on(move |app| app.begin_session_title_edit(&selected)),
        );
        let edit_label = hbox(4, &[]);
        let edit_symbol = hbox(0, &[]);
        edit_label.append(&edit_symbol);
        edit_label.append(&gtk::Label::new(Some("Rename")));
        edit.set_child(Some(&edit_label));
        widgets::name(&edit, "Rename session");
        edit.set_widget_name(&format!("rename-session {key}"));
        display.append(&edit);
        let saving = hbox(4, &[]);
        let spinner = gtk::Spinner::new();
        spinner.set_size_request(14, 14);
        saving.append(&spinner);
        saving.append(&gtk::Label::new(Some("Saving title…")));
        display.append(&saving);
        controls.add_named(&display, Some("display"));
        let editor = hbox(4, &[]);
        editor.set_halign(gtk::Align::End);
        let generated = row.clone();
        let auto = button(
            "",
            &["flat", "title-action"],
            app.on(move |app| app.use_generated_session_title(&generated)),
        );

        auto.set_tooltip_text(Some("Use generated title"));
        widgets::name(&auto, "Use generated title");
        auto.set_widget_name(&format!("generated-session-title {key}"));
        editor.append(&auto);
        let saved = row.clone();
        let save = button(
            "Done",
            &["flat", "title-action"],
            app.on(move |app| app.save_session_title(&saved)),
        );
        save.set_tooltip_text(Some("Save title"));
        save.set_widget_name(&format!("save-session-title {key}"));
        editor.append(&save);
        let cancelled = key.clone();
        let cancel = button(
            "Cancel",
            &["flat", "title-action"],
            app.on(move |app| app.cancel_session_title_edit(&cancelled)),
        );
        cancel.set_tooltip_text(Some("Cancel editing"));
        cancel.set_widget_name(&format!("cancel-session-title {key}"));
        editor.append(&cancel);
        let error = icon("dialog-warning-symbolic", 14);
        error.add_css_class("warn");
        editor.append(&error);
        controls.add_named(&editor, Some("editor"));
        root.append(&controls);
        let syncing = Rc::new(Cell::new(false));
        let blur_revision = Rc::new(Cell::new(0));
        focus::connect(app, row, &root, &entry, &syncing, &blur_revision);
        let cell = Self {
            root,
            row: row.clone(),
            title_stack,
            controls,
            title: title.clone(),
            edit,
            edit_symbol,
            saving,
            spinner,
            entry,
            auto,
            save,
            error,
            syncing,
            blur_revision,
            return_focus: Cell::new(false),
        };
        cell.refresh(app);
        cell
    }

    pub fn cancel_blur(&self) {
        self.blur_revision
            .set(self.blur_revision.get().wrapping_add(1));
    }

    pub fn focus_after_action(&self) {
        self.return_focus.set(true);
        self.root.set_focusable(true);
        self.root.grab_focus();
    }

    pub fn focus_entry(&self) {
        self.cancel_blur();
        self.entry.grab_focus();
    }

    fn restore_focus(&self, editing: bool, pending: bool) {
        if pending || !self.return_focus.replace(false) {
            return;
        }
        if self.root.is_focus() {
            if editing {
                self.entry.grab_focus();
            } else {
                self.edit.grab_focus();
            }
        }
        self.root.set_focusable(false);
    }

    pub fn refresh(&self, app: &App) {
        let (edit, generated) = app.with_state(|state| {
            (
                state
                    .session_titles
                    .get(&self.row.key())
                    .cloned()
                    .unwrap_or_default(),
                state
                    .title_overviews
                    .get(&self.row.key())
                    .is_some_and(|overview| !overview.title.trim().is_empty()),
            )
        });
        let title = app.current_session_title(&self.row);
        widgets::clear(&self.edit_symbol);
        self.edit_symbol
            .append(&widgets::glyph("square.and.pencil", 14, "secondary"));
        self.auto
            .set_child(Some(&widgets::glyph("sparkles", 14, "secondary")));
        self.title.set_text(&title);
        self.title.set_tooltip_text(Some(&title));
        let editing = edit.draft.is_some();
        let was_editing = self.title_stack.visible_child_name().as_deref() == Some("editor");
        self.title_stack
            .set_visible_child_name(if editing { "editor" } else { "title" });
        self.controls
            .set_visible_child_name(if editing { "editor" } else { "display" });
        self.edit.set_visible(!edit.pending);
        self.saving.set_visible(edit.pending);
        self.spinner.set_spinning(edit.pending);
        self.edit
            .set_sensitive(!edit.pending && edit.supported == Some(true));
        self.edit.set_tooltip_text(Some(if edit.pending {
            "Saving title…"
        } else {
            edit.reason.as_deref().unwrap_or("Rename session")
        }));
        self.save
            .set_sensitive(edit.supported == Some(true) && !edit.pending);
        self.auto.set_visible(editing && generated);
        self.error.set_visible(edit.error.is_some());
        self.error.set_tooltip_text(edit.error.as_deref());
        widgets::name(&self.error, edit.error.as_deref().unwrap_or(""));
        if let Some(draft) = &edit.draft {
            if self.entry.text().as_str() != draft {
                self.syncing.set(true);
                self.entry.set_text(draft);
                self.entry.set_position(-1);
                self.syncing.set(false);
            }
        }
        self.restore_focus(editing, edit.pending);
        if editing && !was_editing {
            self.cancel_blur();
            let entry = self.entry.downgrade();
            glib::idle_add_local_once(move || {
                if let Some(entry) = entry.upgrade().filter(|entry| entry.is_mapped()) {
                    entry.grab_focus();
                    entry.select_region(0, -1);
                }
            });
        }
    }
}
