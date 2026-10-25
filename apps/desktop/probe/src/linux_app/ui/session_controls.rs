//! The macOS session toolbar in GTK. Widgets live as long as the page, so
//! changing a filter or refreshing data never dismisses a popover or steals focus.
use super::app::App;
use super::widgets::{self, button, hbox, icon, text, vbox};
use crate::linux_app::models::{source_name, LocalSessionQuery};
use gtk::{prelude::*, Image};
use gtk4 as gtk;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

pub(super) struct SessionControls {
    pub root: gtk::Box,
    pub display: gtk::DropDown,
    saved_views: super::saved_session_views::SavedViewControls,
    search_menu: gtk::MenuButton,
    filters_label: gtk::Label,
    clear: gtk::Button,
    chips: gtk::Box,
    chip_scroll: gtk::ScrolledWindow,
    query_button: gtk::Button,
    chip_terms: RefCell<Vec<String>>,
    harness: gtk::Box,
    sources: RefCell<Vec<String>>,
    projects: gtk::Box,
    project_names: RefCell<Vec<String>>,
    choices: Rc<RefCell<Vec<Choice>>>,
    grouping_syncing: Rc<Cell<bool>>,
}

struct Choice {
    field: &'static str,
    value: String,
    title: String,
    check: Image,
    button: gtk::Button,
}

const GROUPS: [&str; 5] = ["None", "Harness", "Project", "Status", "Week"];

impl SessionControls {
    pub fn build(app: &App, search: &gtk::SearchEntry) -> Self {
        // The Mac's header spaces the search field 20 points from its icon controls.
        let root = hbox(20, &["session-controls"]);
        root.set_hexpand(true);
        let filters = gtk::MenuButton::new();
        crate::linux_app::ui::widgets::action_cursor(&filters);
        filters.add_css_class("cloud-select");
        filters.set_widget_name("session-filters");
        widgets::name(&filters, "Search or filter sessions");
        filters.add_css_class("flat");
        filters.add_css_class("search-icon");
        filters.set_child(Some(&icon("edit-find-symbolic", 15)));
        let filters_label = text("Search or filter sessions…", &["secondary"]);
        filters_label.set_xalign(0.0);
        filters_label.set_ellipsize(gtk::pango::EllipsizeMode::End);
        filters_label.set_max_width_chars(40);
        let chips = hbox(6, &[]);
        let chip_scroll = gtk::ScrolledWindow::new();
        chip_scroll.set_policy(gtk::PolicyType::Automatic, gtk::PolicyType::Never);
        chip_scroll.set_hexpand(true);
        chip_scroll.set_min_content_height(28);
        chip_scroll.set_child(Some(&chips));
        let query_button = gtk::Button::new();
        query_button.add_css_class("cloud-option");
        query_button.add_css_class("search-query");
        widgets::action_cursor(&query_button);
        query_button.set_child(Some(&filters_label));
        widgets::name(&query_button, "Search and filter sessions");
        let menu = filters.downgrade();
        query_button.connect_clicked(move |_| {
            if let Some(menu) = menu.upgrade() {
                open_search(&menu);
            }
        });
        let popover: gtk::Popover = gtk::glib::Object::new::<AnimatedSearchPopover>().upcast();
        popover.add_css_class("session-popover");
        popover.add_css_class("animated-search");
        popover.set_autohide(true);
        popover.set_has_arrow(false);
        let content = vbox(12, &[]);
        widgets::pad(&content, 14, Some(14), None);
        content.set_size_request(542, -1);
        let heading = hbox(8, &[]);
        let title = text("Search sessions", &["row-title"]);
        title.set_visible(false);
        heading.append(&title);
        let pop = popover.downgrade();
        let close = widgets::icon_button(
            "window-close-symbolic",
            "Close search",
            &["cloud-option"],
            move || {
                if let Some(pop) = pop.upgrade() {
                    pop.popdown();
                }
            },
        );
        close.set_widget_name("session-search-close");
        heading.append(&close);
        content.append(&heading);
        if let Some(parent) = search.parent().and_downcast::<gtk::Box>() {
            parent.remove(search);
        }
        search.set_hexpand(true);
        search.set_placeholder_text(Some("Search or filter sessions…"));
        heading.prepend(search);
        let entry = search.clone();
        popover.connect_show(move |_| {
            entry.grab_focus();
        });
        let pop = popover.downgrade();
        search.connect_activate(move |_| {
            if let Some(pop) = pop.upgrade() {
                pop.popdown();
            }
        });
        let columns = vbox(8, &[]);
        let mut choices = Vec::new();
        let activity = section("Status");
        for (value, label) in [("active", "Active"), ("inactive", "Inactive")] {
            choices.push(choice(app, &activity, "is", value, label));
        }

        let harness = section("Harnesses");
        columns.append(&harness);
        columns.append(&activity);
        let messages = section("Messages");
        for (value, label) in [
            ("on-relay", "Receives messages"),
            ("off-relay", "Does not receive messages"),
        ] {
            choices.push(choice(app, &messages, "is", value, label));
        }
        columns.append(&messages);
        let projects = section("Projects");
        columns.append(&projects);
        let upload = section("Upload");
        for (value, label) in [
            ("", "Any upload status"),
            ("in-progress", "In progress"),
            ("uploaded", "Uploaded"),
            ("local", "Not uploading"),
            ("discovering", "Indexing"),
        ] {
            choices.push(choice(app, &upload, "upload", value, label));
        }
        columns.append(&upload);
        let scroll = gtk::ScrolledWindow::new();
        scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
        scroll.set_max_content_height(360);
        scroll.set_propagate_natural_height(true);
        scroll.set_child(Some(&columns));
        content.append(&scroll);
        content.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        let dates = hbox(8, &[]);
        dates.append(&text("Updated", &["caption"]));
        for (label, days) in [
            ("Today", 1),
            ("Last 7 days", 7),
            ("Last 30 days", 30),
            ("Any date", 0),
        ] {
            let weak = app.downgrade();
            dates.append(&button(
                label,
                &[if days == 0 {
                    "cloud-option"
                } else {
                    "cloud-control"
                }],
                move || {
                    if let Some(app) = weak.upgrade() {
                        let date = chrono::Utc::now() - chrono::Duration::days(days - 1);
                        app.set_session_query_filter(
                            "updated",
                            &if days == 0 {
                                String::new()
                            } else {
                                format!(">={}", date.format("%Y-%m-%d"))
                            },
                        );
                    }
                },
            ));
        }
        content.append(&dates);
        content.append(&text(
            "Filters update your search. Dates use UTC.",
            &["caption"],
        ));
        popover.set_child(Some(&content));
        filters.set_popover(Some(&popover));
        content.append(&search_help());
        let clear = button(
            "Clear",
            &["cloud-option"],
            app.on(|app| app.set_session_search("")),
        );
        clear.set_child(Some(&icon("edit-clear-symbolic", 15)));
        clear.set_widget_name("session-search-clear");
        widgets::name(&clear, "Clear search and filters");
        clear.set_tooltip_text(Some("clear search"));
        clear.set_valign(gtk::Align::Center);
        let search_control = hbox(10, &["session-search-bar"]);
        search_control.set_widget_name("session-search-bar");
        search_control.set_hexpand(true);
        search_control.append(&filters);
        search_control.append(&chip_scroll);
        search_control.append(&query_button);
        search_control.append(&clear);
        let shortcut = text("/", &["search-shortcut"]);
        shortcut.set_valign(gtk::Align::Center);
        shortcut.set_tooltip_text(Some("Search and filter sessions (/ or Ctrl+F)"));
        search_control.append(&shortcut);
        widgets::action_cursor(&search_control);
        let clicks = gtk::GestureClick::new();
        clicks.set_button(1);
        let menu = filters.downgrade();
        clicks.connect_released(move |gesture, _, x, y| {
            if let (Some(bar), Some(menu)) = (gesture.widget(), menu.upgrade()) {
                if !super::agents_page::within_control(
                    bar.pick(x, y, gtk::PickFlags::DEFAULT),
                    &bar,
                ) {
                    open_search(&menu);
                }
            }
        });
        let anchor = search_control.downgrade();
        let trigger = filters.downgrade();
        let search_content = content.clone();
        popover.connect_show(move |popover| {
            if let (Some(anchor), Some(trigger)) = (anchor.upgrade(), trigger.upgrade()) {
                anchor.add_css_class("search-open");
                search_content.set_size_request((anchor.width() - 4).max(480), -1);
                if let Some(bounds) = anchor.compute_bounds(&trigger) {
                    popover.set_pointing_to(Some(&gtk::gdk::Rectangle::new(
                        bounds.x() as i32,
                        bounds.y() as i32,
                        bounds.width() as i32,
                        bounds.height() as i32,
                    )));
                    popover.set_position(gtk::PositionType::Bottom);
                    popover.set_offset(0, -anchor.height() - 12);
                }
            }
        });
        let anchor = search_control.downgrade();
        popover.connect_hide(move |_| {
            if let Some(anchor) = anchor.upgrade() {
                anchor.remove_css_class("search-open");
            }
        });
        search_control.add_controller(clicks);
        root.prepend(&search_control);
        let saved_views = super::saved_session_views::SavedViewControls::build(app);
        root.append(&saved_views.button);
        let grouping = gtk::DropDown::from_strings(&GROUPS);
        widgets::action_cursor(&grouping);
        grouping.add_css_class("cloud-select");
        grouping.set_hexpand(true);
        grouping.set_widget_name("session-grouping");
        grouping.set_enable_search(false);
        widgets::name(&grouping, "Group by");
        let grouping_syncing = Rc::new(Cell::new(false));
        let syncing = grouping_syncing.clone();
        let weak = app.downgrade();
        grouping.connect_selected_notify(move |dropdown| {
            if !syncing.get() {
                if let Some(app) = weak.upgrade() {
                    app.set_session_grouping(dropdown.selected());
                }
            }
        });

        let choices = Rc::new(RefCell::new(choices));
        let keyboard_choices = choices.clone();
        let keyboard_app = app.downgrade();
        let keyboard_popover = popover.downgrade();
        let selected = Cell::new(0usize);
        let keyboard = gtk::EventControllerKey::new();
        keyboard.set_name(Some("session-search-navigation"));
        keyboard.set_propagation_phase(gtk::PropagationPhase::Capture);
        keyboard.connect_key_pressed(move |_, key, _, modifiers| {
            if modifiers
                .intersects(gtk::gdk::ModifierType::CONTROL_MASK | gtk::gdk::ModifierType::ALT_MASK)
            {
                return gtk::glib::Propagation::Proceed;
            }
            let choices = keyboard_choices.borrow();
            let mut visible: Vec<_> = choices
                .iter()
                .filter(|choice| choice.button.is_visible())
                .collect();
            visible.sort_by_key(|choice| match choice.field {
                "harness" => 0,
                "is" => 1,
                "project" => 2,
                _ => 3,
            });
            if visible.is_empty() {
                return gtk::glib::Propagation::Proceed;
            }
            // Use focus within this window when a query changes the visible rows.
            // The controller already scopes key events; desktop activation is separate.
            let index = visible
                .iter()
                .position(|choice| choice.button.is_focus())
                .unwrap_or_else(|| selected.get().min(visible.len() - 1));
            match key {
                gtk::gdk::Key::Down => {
                    let next = (index + 1).min(visible.len() - 1);
                    selected.set(next);
                    visible[next].button.grab_focus();
                }
                gtk::gdk::Key::Up => {
                    let next = index.saturating_sub(1);
                    selected.set(next);
                    visible[next].button.grab_focus();
                }
                gtk::gdk::Key::Right | gtk::gdk::Key::Left => {
                    if !visible[index].button.is_focus() {
                        return gtk::glib::Propagation::Proceed;
                    }
                    let button = visible[index].button.clone();
                    let field = visible[index].field;
                    let value = visible[index].value.clone();
                    let title = visible[index].title.clone();
                    drop(visible);
                    drop(choices);
                    if let Some(app) = keyboard_app.upgrade() {
                        let next = app.with_state(|state| {
                            if key == gtk::gdk::Key::Right {
                                LocalSessionQuery::completing_suggestion(
                                    &state.session_search,
                                    field,
                                    &value,
                                    &title,
                                )
                            } else {
                                LocalSessionQuery::selecting_suggestion(
                                    &state.session_search,
                                    field,
                                    &value,
                                    false,
                                )
                            }
                        });
                        app.set_session_search(&next);
                    }
                    let choices = keyboard_choices.borrow();
                    let mut visible: Vec<_> = choices
                        .iter()
                        .filter(|choice| choice.button.is_visible())
                        .collect();
                    visible.sort_by_key(|choice| match choice.field {
                        "harness" => 0,
                        "is" => 1,
                        "project" => 2,
                        _ => 3,
                    });
                    if let Some(index) = visible
                        .iter()
                        .position(|choice| choice.field == field && choice.value == value)
                    {
                        selected.set(index);
                    }
                    button.grab_focus();
                }
                gtk::gdk::Key::Return | gtk::gdk::Key::KP_Enter => {
                    if !visible[index].button.is_focus() {
                        return gtk::glib::Propagation::Proceed;
                    }
                    let field = visible[index].field;
                    let value = visible[index].value.clone();
                    let title = visible[index].title.clone();
                    drop(visible);
                    drop(choices);
                    if let Some(app) = keyboard_app.upgrade() {
                        let next = app.with_state(|state| {
                            LocalSessionQuery::completing_suggestion(
                                &state.session_search,
                                field,
                                &value,
                                &title,
                            )
                        });
                        app.set_session_search(&next);
                    }
                    if let Some(popover) = keyboard_popover.upgrade() {
                        popover.popdown();
                    }
                }
                _ => return gtk::glib::Propagation::Proceed,
            }
            gtk::glib::Propagation::Stop
        });
        popover.add_controller(keyboard);
        Self {
            root,
            saved_views,
            display: grouping,
            search_menu: filters,
            filters_label,
            clear,
            chips,
            chip_scroll,
            query_button,
            chip_terms: RefCell::default(),
            harness,
            sources: RefCell::default(),
            projects,
            project_names: RefCell::default(),
            choices,
            grouping_syncing,
        }
    }

    pub fn update_saved_view(&self, app: &App) {
        self.saved_views.update(app);
    }

    pub fn open_search(&self) {
        open_search(&self.search_menu);
    }

    pub fn update(
        &self,
        app: &App,
        query: &LocalSessionQuery,
        sources: &[String],
        projects: &[String],
        grouping: u32,
    ) {
        self.update_saved_view(app);
        // Only the harness column depends on discovery. Keep every other
        // button (and the popover itself) alive even as new sessions arrive.
        if self.sources.borrow().as_slice() != sources
            || self.harness.last_child() == self.harness.first_child()
        {
            let mut choices = self.choices.borrow_mut();
            choices.retain(|choice| choice.field != "harness");
            widgets::clear(&self.harness);
            self.harness.append(&section_label("Harnesses"));
            choices.push(choice(app, &self.harness, "harness", "", "Any harness"));
            for source in sources {
                choices.push(choice(
                    app,
                    &self.harness,
                    "harness",
                    source,
                    &source_name(source),
                ));
            }
            *self.sources.borrow_mut() = sources.to_vec();
        }
        if self.project_names.borrow().as_slice() != projects {
            let mut choices = self.choices.borrow_mut();
            choices.retain(|choice| choice.field != "project");
            widgets::clear(&self.projects);
            self.projects.append(&section_label("Projects"));
            for project in projects {
                choices.push(choice(app, &self.projects, "project", project, project));
            }
            *self.project_names.borrow_mut() = projects.to_vec();
        }
        let has_chips = query.terms.iter().any(|term| term.field.is_some());
        self.chip_scroll.set_visible(has_chips);
        self.query_button.set_hexpand(!has_chips);
        let terms: Vec<_> = query.terms.iter().map(|term| term.raw.clone()).collect();
        if *self.chip_terms.borrow() != terms {
            widgets::clear(&self.chips);
            for (index, term) in query
                .terms
                .iter()
                .enumerate()
                .filter(|(_, term)| term.field.is_some())
            {
                let weak = app.downgrade();
                let remove = button("", &["session-filter-remove"], move || {
                    if let Some(app) = weak.upgrade() {
                        let next = app.with_state(|state| {
                            LocalSessionQuery::new(&state.session_search).removing_term(index)
                        });
                        app.set_session_search(&next);
                    }
                });
                let chip = hbox(6, &["session-filter-chip"]);
                chip.append(&text(term.display_title(), &[]));
                remove.set_child(Some(&icon("window-close-symbolic", 10)));
                remove.set_widget_name(&format!("session-filter-chip-{index}"));
                widgets::name(&remove, &format!("Remove {}", term.display_title()));
                remove.set_tooltip_text(Some(&format!("Remove {}", term.display_title())));
                chip.append(&remove);
                self.chips.append(&chip);
            }
            *self.chip_terms.borrow_mut() = terms;
        }
        let words = query
            .terms
            .iter()
            .filter(|term| term.field.is_none())
            .map(|term| term.raw.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        self.filters_label.set_text(if words.is_empty() {
            if query.terms.is_empty() {
                "Search or filter sessions…"
            } else {
                "Add filters…"
            }
        } else {
            &words
        });
        self.clear.set_visible(!query.terms.is_empty());
        let raw = app.with_state(|state| state.session_search.clone());
        let complete_choice = self.choices.borrow().iter().any(|choice| {
            query.terms.last().is_some_and(|term| {
                !term.excluded
                    && term.field.as_deref() == Some(choice.field)
                    && term.value.eq_ignore_ascii_case(&choice.value)
            })
        });
        let token = if raw.ends_with(char::is_whitespace) || complete_choice {
            ""
        } else {
            raw.split_whitespace().last().unwrap_or("")
        }
        .to_lowercase();
        for choice in self.choices.borrow().iter() {
            choice.button.set_visible(
                token.is_empty()
                    || token.contains('"')
                    || choice.title.to_lowercase().contains(&token)
                    || format!("{}:{}", choice.field, choice.value)
                        .to_lowercase()
                        .contains(&token),
            );
            let selected = if choice.value.is_empty() {
                query.value(choice.field).is_none()
            } else {
                query.contains_selection(choice.field, &choice.value)
            };
            choice.check.set_opacity(if selected { 1.0 } else { 0.0 });
            widgets::name(
                &choice.button,
                &format!(
                    "{}, {}",
                    choice.title,
                    if selected { "Selected" } else { "Not selected" }
                ),
            );
        }
        self.grouping_syncing.set(true);
        self.display
            .set_selected(grouping.min(GROUPS.len() as u32 - 1));
        self.grouping_syncing.set(false);
    }
}

fn section_label(title: &str) -> gtk::Label {
    let label = text(title, &["caption"]);
    widgets::pad(&label, 8, Some(8), None);
    label
}
fn section(title: &str) -> gtk::Box {
    let column = vbox(2, &[]);
    column.set_valign(gtk::Align::Start);
    column.append(&section_label(title));
    column
}
fn option(title: &str, action: impl Fn() + 'static) -> (gtk::Button, Image) {
    let option = button("", &["cloud-option"], action);
    widgets::name(&option, title);
    let line = hbox(8, &[]);
    let label = text(title, &[]);
    label.set_hexpand(true);
    line.append(&label);
    let check = icon("object-select-symbolic", 12);
    line.append(&check);
    option.set_child(Some(&line));
    (option, check)
}
fn choice(app: &App, column: &gtk::Box, field: &'static str, value: &str, title: &str) -> Choice {
    let weak = app.downgrade();
    let chosen = value.to_string();
    let (button, check) = option(title, move || {
        if let Some(app) = weak.upgrade() {
            let query = app.with_state(|state| {
                LocalSessionQuery::suggesting(&state.session_search, field, &chosen)
            });
            app.set_session_search(&query);
        }
    });
    check.add_css_class("session-filter-check");
    column.append(&button);
    Choice {
        field,
        value: value.to_string(),
        title: title.to_string(),
        check,
        button,
    }
}
fn search_help() -> gtk::MenuButton {
    use super::widgets::LabelStyle;
    let help = gtk::MenuButton::new();
    crate::linux_app::ui::widgets::action_cursor(&help);
    help.set_icon_name("dialog-question-symbolic");
    help.add_css_class("cloud-select");
    help.add_css_class("flat");
    widgets::name(&help, "Search syntax");
    let pop = gtk::Popover::new();
    pop.add_css_class("session-popover");
    let words = vbox(10, &[]);
    widgets::pad(&words, 16, Some(16), None);
    words.append(&text("Search sessions", &["row-title"]));
    words.append(&text(
        "Combine words and filters to narrow your results.",
        &["caption"],
    ));
    for example in [
        "title: Foo",
        "title:\"Fix login\"",
        "project:cloud harness:codex",
        "is:active -harness:claude",
        "upload:uploaded",
        "updated:>=2026-10-01",
        "updated:2026-10-01..2026-10-11",
    ] {
        let label = text(example, &["mono"]);
        label.set_selectable(true);
        words.append(&label);
    }
    let note = text("Use quotes for phrases and - to exclude. Also supports path:, id:, agent:, before:, and after:. Dates use UTC. Search covers loaded sessions; older history loads automatically as you scroll.", &["caption"]).wrapped();
    note.set_max_width_chars(48);
    words.append(&note);
    pop.set_child(Some(&words));
    help.set_popover(Some(&pop));
    help
}

mod animated_search_imp {
    use super::*;
    use gtk::glib;
    use gtk::subclass::prelude::*;

    #[derive(Default)]
    pub struct AnimatedSearch {
        generation: Cell<u64>,
        closing: Cell<bool>,
    }
    #[gtk::glib::object_subclass]
    impl ObjectSubclass for AnimatedSearch {
        const NAME: &'static str = "RelayAnimatedSearchPopover";
        type Type = super::AnimatedSearchPopover;
        type ParentType = gtk::Popover;
    }
    impl AnimatedSearch {
        pub fn resume(&self) {
            if self.closing.replace(false) {
                self.generation.set(self.generation.get() + 1);
                self.obj().remove_css_class("search-collapsed");
            }
        }
    }
    impl ObjectImpl for AnimatedSearch {}
    impl PopoverImpl for AnimatedSearch {}
    impl WidgetImpl for AnimatedSearch {
        fn show(&self) {
            self.generation.set(self.generation.get() + 1);
            self.closing.set(false);
            let obj = self.obj();
            obj.add_css_class("search-collapsed");
            self.parent_show();
            let generation = self.generation.get();
            let weak = obj.downgrade();
            gtk::glib::timeout_add_local_once(std::time::Duration::from_millis(16), move || {
                if let Some(obj) = weak.upgrade() {
                    if obj.imp().generation.get() == generation {
                        obj.remove_css_class("search-collapsed");
                    }
                }
            });
        }
        fn hide(&self) {
            if self.closing.replace(true) {
                return;
            }
            self.generation.set(self.generation.get() + 1);
            let obj = self.obj();
            obj.add_css_class("search-collapsed");
            let animated = gtk::Settings::default()
                .is_some_and(|settings| settings.property::<bool>("gtk-enable-animations"));
            if !animated {
                self.parent_hide();
                self.closing.set(false);
                return;
            }
            let generation = self.generation.get();
            let weak = obj.downgrade();
            gtk::glib::timeout_add_local_once(std::time::Duration::from_millis(200), move || {
                if let Some(obj) = weak.upgrade() {
                    if obj.imp().generation.get() == generation {
                        obj.imp().parent_hide();
                        obj.imp().closing.set(false);
                    }
                }
            });
        }
    }
}
gtk::glib::wrapper! {
    pub struct AnimatedSearchPopover(ObjectSubclass<animated_search_imp::AnimatedSearch>)
        @extends gtk::Popover, gtk::Widget,
        @implements gtk::Buildable, gtk::ConstraintTarget, gtk::Native, gtk::ShortcutManager;
}

fn open_search(menu: &gtk::MenuButton) {
    use gtk::subclass::prelude::ObjectSubclassIsExt;
    if let Some(animated) = menu
        .popover()
        .and_then(|popover| popover.downcast::<AnimatedSearchPopover>().ok())
    {
        animated.imp().resume();
    }
    menu.popup();
}
