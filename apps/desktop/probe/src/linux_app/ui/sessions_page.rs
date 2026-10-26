//! Local sessions: a grouped, searchable table with selection, bulk actions,
//! and read-only upload status. Opening a row reads its local conversation.

use super::agents_page::{menu, on_press, within_control, MenuItems};
use super::app::App;
use super::desktop::Confirmation;
use super::session_controls::SessionControls;
use super::widgets::{
    self, agent_badge, button, clear, grouped, hbox, icon, text, vbox, Callback, LabelStyle,
};
use crate::linux_app::models::{
    capture_is_active, cloud_session_url, exact_ms, local_session_week, merge_local_sessions,
    relative_ms, session_key, source_name, upload_stages, LocalSessionQuery, LocalSessionRow,
    LocalSessionSearchCache, LocalSessionSort, Presence, SessionActivityIndex, SessionColumn,
    SessionColumnLayout, SessionUploadState, StageState, UploadSummary,
};
use crate::relay::contract::account::{SessionKeysParams, UploadSession};
use crate::relay::contract::method;
use gtk::{glib, prelude::*};
use gtk4 as gtk;
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::time::Duration;

mod column_resize;
mod titles;

/// The page's parts that are redrawn in place.
pub struct SessionsPage {
    pub root: gtk::Box,
    pub table: gtk::Box,
    /// The Capy setup card, while it shows.
    pub capy_setup: gtk::Box,
    /// Whether the card drawn says the prompt was copied; `None` while hidden.
    pub(super) capy_drawn: Cell<Option<bool>>,
    /// The offer to turn on Devin's hooks, while it shows.
    pub devin_setup: gtk::Box,
    /// The error the card drawn shows; `None` while hidden.
    pub(super) devin_drawn: RefCell<Option<Option<String>>>,
    pub transcript: super::transcript::TranscriptPage,
    collapsed: RefCell<BTreeSet<String>>,
    pub progress: gtk::Box,
    pub controls: gtk::Box,
    toolbar: RefCell<Option<SessionControls>>,
    search_results: RefCell<Option<glib::SourceId>>,
    search_data: RefCell<LocalSessionSearchCache>,
    pub search: gtk::SearchEntry,
    pub syncing_search: Cell<bool>,
    pub search_error: gtk::Label,
    pub(super) grouping: Cell<u32>,
    pub(super) sort: Cell<LocalSessionSort>,
    sort_headers: Vec<(SessionColumn, gtk::Button, gtk::Label)>,
    column_frames: Vec<(SessionColumn, gtk::Overlay, gtk::Box)>,
    resizing: RefCell<Option<(SessionColumn, i32, SessionColumnLayout)>>,
    header: gtk::Box,
    horizontal_content: gtk::Box,
    column_controls: RefCell<Option<super::session_columns::SessionColumnControls>>,
    pub selection_bar: gtk::Box,
    selection_revealer: gtk::Revealer,
    group_checks: RefCell<Vec<(gtk::CheckButton, Vec<String>)>>,
    pub list: gtk::ListBox,
    pub(super) scroller: gtk::ScrolledWindow,
    /// The `SOURCE:ID` of each row of `list`, in order.
    keys: RefCell<Vec<String>>,
    /// What each row of `list` was drawn from.
    drawn: RefCell<Vec<DrawnRow>>,
    /// Each row's last active time, with the moment it reads from: kept
    /// current on every redraw.
    active: RefCell<Vec<(gtk::Label, Option<i64>)>>,
    pub empty: gtk::Box,
    pub error: gtk::Label,
    pub count: gtk::Label,
    pub preparing: gtk::Box,
    /// Set while the list is rebuilt: its selection changing then is not
    /// the person's.
    drawing: Cell<bool>,
}

/// Hover previews the next click, while the resting arrow records current order.
fn update_sort_indicator(
    sort: LocalSessionSort,
    column: crate::linux_app::models::LocalSessionSortColumn,
    button: &gtk::Button,
    arrow: &gtk::Label,
) {
    let selected = sort.column == column;
    let hovering = button.state_flags().contains(gtk::StateFlags::PRELIGHT);
    let ascending = if hovering {
        if selected {
            !sort.ascending
        } else {
            column.starts_ascending()
        }
    } else {
        sort.ascending
    };
    arrow.set_text(if selected || hovering {
        if ascending {
            "↑"
        } else {
            "↓"
        }
    } else {
        ""
    });
}

/// Overlays do not contribute their content's natural width. Long titles and
/// controls therefore cannot force a resized column wider than its header.
fn session_column_frame(child: &impl IsA<gtk::Widget>, width: i32) -> gtk::Overlay {
    let frame = gtk::Overlay::new();
    frame.set_child(Some(&gtk::DrawingArea::new()));
    frame.set_size_request(width, -1);
    frame.set_overflow(gtk::Overflow::Hidden);
    frame.add_overlay(child);
    frame
}

impl SessionsPage {
    fn apply_column_widths(&self, layout: &SessionColumnLayout) {
        let visible = layout.visible();
        for (column, frame, _) in &self.column_frames {
            frame.set_size_request(layout.width(*column), 36);
            frame.set_hexpand(layout.expanding_column() == Some(*column));
        }
        self.horizontal_content.set_halign(gtk::Align::Fill);
        self.horizontal_content.set_size_request(
            100 + visible.iter().map(|c| layout.width(*c)).sum::<i32>()
                + visible.len().saturating_sub(1) as i32 * 16,
            -1,
        );
        let mut index = 0;
        while let Some(row) = self.list.row_at_index(index) {
            if let Some(content) = row.child() {
                let mut child = content.first_child();
                while let Some(cell) = child {
                    let name = cell.widget_name();
                    for column in &visible {
                        if name.starts_with(&format!("session-cell {} ", column.id()))
                            || (*column == SessionColumn::Session
                                && name.starts_with("open-session "))
                        {
                            cell.set_size_request(layout.width(*column), -1);
                            cell.set_hexpand(layout.expanding_column() == Some(*column));
                        }
                    }
                    child = cell.next_sibling();
                }
            }
            index += 1;
        }
    }
    pub(super) fn invalidate_columns(&self) {
        self.drawn.borrow_mut().clear();
    }

    pub(super) fn open_search(&self) {
        if let Some(toolbar) = self.toolbar.borrow().as_ref() {
            toolbar.open_search();
        }
    }

    pub(super) fn schedule_search_results(&self, app: &App) {
        if let Some(previous) = self.search_results.borrow_mut().take() {
            previous.remove();
        }
        let weak = app.downgrade();
        let pending = glib::timeout_add_local_once(Duration::from_millis(80), move || {
            if let Some(app) = weak.upgrade() {
                if let Some(shell) = app.shell() {
                    shell.pages.sessions.search_results.borrow_mut().take();
                }
                app.render_sessions();
            }
        });
        *self.search_results.borrow_mut() = Some(pending);
    }

    pub fn build() -> SessionsPage {
        let root = vbox(0, &[]);
        let table = vbox(0, &[]);
        let transcript = super::transcript::TranscriptPage::build();
        table.set_margin_top(0);
        table.set_margin_bottom(0);
        table.set_margin_start(24);
        table.set_margin_end(24);
        let progress = vbox(12, &["progress-card"]);
        progress.set_visible(false);
        let search = gtk::SearchEntry::new();
        search.set_placeholder_text(Some("Search sessions… title:Foo, is:active"));
        // This editor lives in the search popover. Its trigger fills the
        // shared header beside Group by, as on macOS.
        search.set_hexpand(false);
        search.set_width_chars(36);
        search.set_max_width_chars(60);
        widgets::name(&search, "Search sessions");

        let controls = hbox(8, &["session-controls"]);
        controls.set_halign(gtk::Align::End);
        let capy_setup = vbox(0, &[]);
        capy_setup.set_margin_bottom(12);
        capy_setup.set_visible(false);
        table.append(&capy_setup);
        let devin_setup = vbox(0, &[]);
        devin_setup.set_margin_bottom(12);
        devin_setup.set_visible(false);
        table.append(&devin_setup);
        let search_error = text("", &["caption", "warn"]).wrapped();
        search_error.set_visible(false);
        search_error.set_margin_bottom(10);
        table.append(&search_error);
        let selection_bar = hbox(12, &["selection-bar"]);
        selection_bar.set_visible(false);
        selection_bar.set_margin_top(8);
        selection_bar.set_margin_bottom(8);
        let selection_revealer = gtk::Revealer::new();
        selection_revealer.set_transition_type(gtk::RevealerTransitionType::SlideDown);
        selection_revealer.set_transition_duration(180);
        selection_revealer.set_child(Some(&selection_bar));
        table.append(&selection_revealer);
        let header = hbox(16, &[]);
        header.set_margin_start(12);
        header.set_margin_end(12);
        header.set_size_request(-1, 36);
        let mut sort_headers = Vec::new();
        let mut column_frames = Vec::new();
        for column in SessionColumn::ALL {
            let button = gtk::Button::new();
            crate::linux_app::ui::widgets::action_cursor(&button);
            button.add_css_class("flat");
            button.add_css_class("session-sort-header");
            button.set_widget_name(&format!("sort-session-{}", column.title()));
            let content = hbox(4, &[]);
            if matches!(column, SessionColumn::Relay | SessionColumn::Upload) {
                let balance = gtk::DrawingArea::new();
                balance.set_size_request(10, -1);
                content.append(&balance);
            }
            content.append(&text(column.title(), &["table-header-title"]));
            let arrow = text("", &["table-header-title"]);
            arrow.set_size_request(10, -1);
            content.append(&arrow);
            button.set_hexpand(true);
            content.set_halign(
                if matches!(column, SessionColumn::Relay | SessionColumn::Upload) {
                    gtk::Align::Center
                } else {
                    gtk::Align::Start
                },
            );
            button.set_child(Some(&content));
            let frame = session_column_frame(&button, column.width());
            frame.set_widget_name(&format!("session-header {}", column.id()));
            let resize = hbox(0, &["session-column-resize"]);
            resize.set_widget_name(&format!("resize-column {}", column.id()));
            resize.set_size_request(10, 20);
            resize.set_halign(gtk::Align::End);
            resize.set_focusable(true);
            resize.set_cursor_from_name(Some("col-resize"));
            resize.set_tooltip_text(Some("Drag to resize; double-click to reset"));
            widgets::name(&resize, &format!("Resize {} column", column.title()));
            frame.add_overlay(&resize);
            header.append(&frame);
            column_frames.push((column, frame, resize));
            sort_headers.push((column, button, arrow));
        }
        let horizontal_content = vbox(0, &[]);
        horizontal_content.append(&header);
        horizontal_content.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        let list = gtk::ListBox::new();
        list.set_selection_mode(gtk::SelectionMode::Multiple);
        list.set_activate_on_single_click(false);
        list.add_css_class("sessions");
        let scroller = gtk::ScrolledWindow::new();
        scroller.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
        scroller.set_min_content_height(120);
        scroller.set_vexpand(true);
        scroller.set_child(Some(&list));
        horizontal_content.append(&scroller);
        let horizontal = gtk::ScrolledWindow::new();
        horizontal.set_policy(gtk::PolicyType::Automatic, gtk::PolicyType::Never);
        horizontal.set_vexpand(true);
        horizontal.set_child(Some(&horizontal_content));
        table.append(&horizontal);
        let empty = vbox(10, &[]);
        empty.set_halign(gtk::Align::Center);
        empty.set_visible(false);
        empty.set_margin_top(50);
        empty.set_margin_bottom(50);
        list.set_placeholder(Some(&empty));
        let error = text("", &["warn", "caption"]);
        error.set_ellipsize(gtk::pango::EllipsizeMode::End);
        error.set_max_width_chars(60);
        error.set_visible(false);
        let count = text("", &["caption"]);
        count.set_tooltip_text(Some(
            "Search covers loaded sessions; older history loads automatically as you scroll.",
        ));
        let preparing = hbox(8, &[]);
        let spinner = gtk::Spinner::new();
        spinner.start();
        preparing.append(&spinner);
        preparing.append(&text("Preparing history…", &["caption"]));
        preparing.set_visible(false);
        root.append(&table);
        root.append(&transcript.root);
        SessionsPage {
            root,
            table,
            capy_setup,
            capy_drawn: Cell::new(None),
            devin_setup,
            devin_drawn: RefCell::new(None),
            transcript,
            collapsed: RefCell::default(),
            progress,
            controls,
            toolbar: RefCell::default(),
            search_results: RefCell::default(),
            search_data: RefCell::default(),
            search,
            syncing_search: Cell::new(false),
            search_error,
            grouping: Cell::new(0),
            sort: Cell::new(LocalSessionSort::default()),
            sort_headers,
            column_frames,
            resizing: RefCell::default(),
            header,
            horizontal_content,
            column_controls: RefCell::default(),
            selection_bar,
            selection_revealer,
            group_checks: RefCell::default(),
            list,
            scroller,
            keys: RefCell::default(),
            drawn: RefCell::default(),
            active: RefCell::default(),
            empty,
            error,
            count,
            preparing,
            drawing: Cell::new(false),
        }
    }

    /// The rows shown, by `SOURCE:ID`.
    pub fn row_keys(&self) -> Vec<String> {
        self.keys
            .borrow()
            .iter()
            .filter(|key| !key.is_empty())
            .cloned()
            .collect()
    }

    /// The row showing `key`.
    pub fn row(&self, key: &str) -> Option<gtk::ListBoxRow> {
        let index = self.keys.borrow().iter().position(|shown| shown == key)?;
        self.list.row_at_index(index as i32)
    }
}

/// What one row of the list is drawn from.
#[derive(Clone, PartialEq)]
struct DrawnRow {
    activity: &'static str,
    session: LocalSessionRow,
    state: Option<SessionUploadState>,
    presence: Option<Presence>,
    relay_error: Option<String>,
    can_relay: bool,
    hidden: bool,
    requesting: bool,
    stopping: bool,
    read_only: bool,
    /// The theme's text color: the marks and glyphs are drawn in the theme.
    theme: &'static str,
}

/// The palette color a row's status reads in, as the Mac's.
fn state_color(state: SessionUploadState) -> &'static str {
    match state {
        SessionUploadState::Uploaded => "secondary",
        SessionUploadState::Uploading
        | SessionUploadState::Preparing
        | SessionUploadState::Queued => "accent",
        SessionUploadState::Paused
        | SessionUploadState::Blocked
        | SessionUploadState::Stopped
        | SessionUploadState::Unknown => "orange",
        SessionUploadState::Discovering
        | SessionUploadState::Local
        | SessionUploadState::Checking => "secondary",
    }
}

fn stage_glyph(state: StageState) -> (&'static str, &'static str) {
    match state {
        StageState::Waiting => ("content-loading-symbolic", "secondary"),
        StageState::Active => ("view-refresh-symbolic", "accent"),
        StageState::Complete => ("emblem-ok-symbolic", "ok"),
        StageState::Paused => ("media-playback-pause-symbolic", "warn"),
        StageState::Blocked => ("dialog-warning-symbolic", "warn"),
    }
}

fn sessions_noun(count: usize) -> String {
    if count == 1 {
        "session".into()
    } else {
        format!("{count} sessions")
    }
}

/// A compact status glyph with a short hover label and an upward upload sweep.
pub(super) fn status_cell(state: SessionUploadState, requesting: bool, stopping: bool) -> gtk::Box {
    // A session being switched on reads as preparing until the core
    // answers, as the Mac's `uploadState(for:)`.
    let state = if requesting {
        SessionUploadState::Preparing
    } else {
        state
    };
    let (symbol, title, color) = if stopping {
        ("stop.circle", "Deleting…", "secondary")
    } else {
        (state.symbol(), state.icon_title(), state_color(state))
    };
    let cell = vbox(0, &["session-status-icon"]);
    cell.set_size_request(28, -1);
    cell.set_valign(gtk::Align::Center);
    cell.set_tooltip_text(Some(title));
    widgets::name(&cell, title);
    let glyph = if state == SessionUploadState::Uploading && !stopping {
        widgets::upload_activity_icon(14).upcast::<gtk::Widget>()
    } else {
        let glyph = widgets::glyph(symbol, 14, color);
        if !stopping {
            glyph.set_opacity(match state {
                SessionUploadState::Local => 0.45,
                SessionUploadState::Uploaded => 0.8,
                _ => 1.0,
            });
        }
        glyph
    };
    glyph.set_halign(gtk::Align::Center);
    cell.append(&glyph);
    cell
}

impl App {
    /// Connects the page's own controls; built once with the shell.
    pub(super) fn connect_sessions_page(&self, page: &SessionsPage, shortcut_root: &gtk::Box) {
        if !self.with_state(|state| state.restored_default_session_view) {
            if let Some(view) = self.saved_session_views().default_view() {
                let config = &view.configuration;
                page.grouping.set(config.grouping.min(4));
                page.sort.set(config.sort);
                self.update_state(|state| state.session_search = config.search.clone());
                let _ = self.inner.prefs.borrow_mut().set(
                    crate::linux_app::models::SESSION_COLUMNS_KEY,
                    config.layout().value(),
                );
                let _ = self
                    .inner
                    .prefs
                    .borrow_mut()
                    .set("showHiddenSessions.v1", config.show_hidden.into());
            }
            self.update_state(|state| state.restored_default_session_view = true);
        }
        self.connect_transcript(&page.transcript);
        let shortcut = gtk::EventControllerKey::new();
        shortcut.set_name(Some("session-search-shortcut"));
        shortcut.set_propagation_phase(gtk::PropagationPhase::Capture);
        let weak = self.downgrade();
        shortcut.connect_key_pressed(move |controller, key, _, modifiers| {
            if key != gtk::gdk::Key::slash
                || modifiers.intersects(
                    gtk::gdk::ModifierType::CONTROL_MASK | gtk::gdk::ModifierType::ALT_MASK,
                )
            {
                return glib::Propagation::Proceed;
            }
            let editing = controller
                .widget()
                .and_then(|widget| widget.root())
                .and_then(|root| root.focus())
                .is_some_and(|focus| {
                    focus.is::<gtk::Text>()
                        || focus.is::<gtk::TextView>()
                        || focus.is::<gtk::Entry>()
                });
            if editing {
                return glib::Propagation::Proceed;
            }
            if let Some(app) = weak.upgrade() {
                if app.page() != super::state::Page::Sessions
                    || app
                        .shell()
                        .is_some_and(|shell| shell.pages.sessions.transcript.root.is_visible())
                {
                    return glib::Propagation::Proceed;
                }
                app.focus_search();
            }
            glib::Propagation::Stop
        });
        shortcut_root.add_controller(shortcut);
        self.bind_column_resizing(page);
        for (column, button, arrow) in &page.sort_headers {
            let Some(column) = column.sort_column() else {
                continue;
            };
            let weak = self.downgrade();
            let indicator = arrow.clone();
            button.connect_state_flags_changed(move |button, _| {
                if let Some(shell) = weak.upgrade().and_then(|app| app.shell()) {
                    update_sort_indicator(
                        shell.pages.sessions.sort.get(),
                        column,
                        button,
                        &indicator,
                    );
                }
            });
            let weak = self.downgrade();
            button.connect_clicked(move |_| {
                if let Some(app) = weak.upgrade() {
                    if let Some(shell) = app.shell() {
                        let mut sort = shell.pages.sessions.sort.get();
                        sort.select(column);
                        shell.pages.sessions.sort.set(sort);
                    }
                    app.render_sessions();
                }
            });
        }
        let weak = self.downgrade();
        page.search.connect_changed(move |entry| {
            if let Some(app) = weak.upgrade() {
                if app
                    .shell()
                    .is_some_and(|shell| !shell.pages.sessions.syncing_search.get())
                {
                    app.set_session_search(&entry.text());
                }
            }
        });
        let weak = self.downgrade();
        page.list.connect_selected_rows_changed(move |_| {
            if let Some(app) = weak.upgrade() {
                app.session_selection_changed();
            }
        });
        let weak = self.downgrade();
        page.list.connect_row_activated(move |_, row| {
            if let Some(app) = weak.upgrade() {
                app.session_activated(row.index());
            }
        });
        self.connect_session_pagination(&page.scroller.vadjustment());
    }

    /// The sessions the filters, source and search leave, in list order.
    pub fn filtered_sessions(&self) -> Vec<UploadSession> {
        let hidden_sessions = self.hidden_sessions();
        let show_hidden = self.show_hidden_sessions();
        self.with_state(|state| {
            let query = LocalSessionQuery::new(&state.session_search);
            merge_local_sessions(&state.sessions, &state.local_sessions)
                .into_iter()
                .filter(|row| {
                    (show_hidden || !hidden_sessions.contains(&row.key()))
                        && query.matches(
                            row,
                            row.upload
                                .as_ref()
                                .map(|s| SessionUploadState::of(s, state.status.as_ref())),
                        )
                })
                .filter_map(|row| row.upload)
                .collect()
        })
    }

    pub fn render_sessions(&self) {
        self.render_transcript_controls();
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions;
        self.render_session_controls(page);
        self.render_setup_cards(page);
        let layout = self.live_session_columns();
        let visible = layout.visible();
        if page
            .header
            .first_child()
            .is_none_or(|child| child.widget_name() != "session-selection-header")
        {
            let leading = hbox(16, &[]);
            leading.set_widget_name("session-selection-header");
            leading.set_size_request(60, -1);
            let weak = self.downgrade();
            let select = button("✓", &["flat"], move || {
                if let Some(app) = weak.upgrade() {
                    if let Some(shell) = app.shell() {
                        let page = &shell.pages.sessions;
                        if page.list.selected_rows().len() == page.keys.borrow().len() {
                            app.clear_session_selection();
                        } else {
                            page.list.select_all();
                        }
                    }
                }
            });
            widgets::name(&select, "Select all visible sessions");
            // The Mac's 16-point checkbox mark, filled when every shown row
            // is selected; a click does not leave a focus ring on it.
            select.add_css_class("select-all-check");
            select.set_focus_on_click(false);
            select.set_valign(gtk::Align::Center);
            select.set_halign(gtk::Align::Center);
            leading.append(&select);
            page.header.prepend(&leading);
        }
        let mut previous: Option<gtk::Widget> = page.header.first_child();
        for column in &layout.order {
            let (_, frame, _) = page
                .column_frames
                .iter()
                .find(|(id, ..)| id == column)
                .unwrap();
            frame.set_visible(visible.contains(column));
            page.header.reorder_child_after(frame, previous.as_ref());
            previous = Some(frame.clone().upcast());
        }
        page.apply_column_widths(&layout);
        let sort = page.sort.get();
        for (column, button, arrow) in &page.sort_headers {
            let Some(column) = column.sort_column() else {
                continue;
            };
            let selected = sort.column == column;
            update_sort_indicator(sort, column, button, arrow);
            let next = if selected {
                !sort.ascending
            } else {
                column.starts_ascending()
            };
            button.set_tooltip_text(Some(&format!(
                "{}: click to sort {}",
                column.title(),
                if next { "ascending" } else { "descending" }
            )));
            widgets::name(
                button,
                &format!(
                    "Sort by {}, {}",
                    column.title(),
                    if selected {
                        if sort.ascending {
                            "Ascending"
                        } else {
                            "Descending"
                        }
                    } else {
                        "Not sorted"
                    }
                ),
            );
        }
        let hidden_sessions = self.hidden_sessions();
        let show_hidden = self.show_hidden_sessions();
        let activity = self
            .with_state(|state| SessionActivityIndex::new(&state.archived_agents, &state.roster));
        self.reconcile_native_session_titles();
        let rows = self.with_state(|state| {
            let query = LocalSessionQuery::new(&state.session_search);
            let data = page
                .search_data
                .borrow_mut()
                .get(&state.sessions, &state.local_sessions);
            let mut rows = data
                .rows
                .iter()
                .cloned()
                .map(|row| titles::with_optimistic_title(state, row))
                .filter(|row| {
                    (show_hidden || !hidden_sessions.contains(&row.key()))
                        && query.matches(
                            row,
                            row.upload
                                .as_ref()
                                .map(|s| SessionUploadState::of(s, state.status.as_ref())),
                        )
                })
                .collect::<Vec<_>>();
            page.sort.get().sort(
                &mut rows,
                |row| Some(activity.activity(row).into()),
                |row| row.relay.as_ref().map(|s| state.presence_of(s).is_on()),
                |row| {
                    row.upload.as_ref().map(|s| {
                        !state.stopping.contains(&session_key(s))
                            && (s.included || state.requesting.contains(&session_key(s)))
                    })
                },
            );
            rows
        });
        let (selection, read_only, requesting, stopping, status) = self.with_state(|state| {
            (
                state.session_selection.clone(),
                state.sessions_read_only(),
                state.requesting.clone(),
                state.stopping.clone(),
                state.status.clone(),
            )
        });
        let drawn: Vec<DrawnRow> = rows
            .iter()
            .map(|session| {
                let key = session.key();
                let (presence, relay_error, can_relay) = self.with_state(|state| {
                    let presence = session.relay.as_ref().map(|s| state.presence_of(s));
                    let error = session
                        .relay
                        .as_ref()
                        .and_then(|s| state.relay_errors.get(&s.target.key()).cloned())
                        .or_else(|| state.upload_errors.get(&key).cloned());
                    let can = session
                        .relay
                        .as_ref()
                        .is_some_and(|s| state.can_toggle(s, state.presence_of(s)));
                    (presence, error, can)
                });
                DrawnRow {
                    activity: activity.activity(session),
                    state: session
                        .upload
                        .as_ref()
                        .map(|s| SessionUploadState::of(s, status.as_ref())),
                    presence,
                    relay_error,
                    can_relay: can_relay && !hidden_sessions.contains(&key),
                    hidden: hidden_sessions.contains(&key),
                    requesting: requesting.contains(&key),
                    stopping: stopping.contains(&key),
                    read_only,
                    theme: widgets::color("text"),
                    session: session.clone(),
                }
            })
            .collect();
        // The list is rebuilt only when a row changed: a status poll leaves
        // its scroll position, focus and an open menu alone.
        if *page.drawn.borrow() != drawn {
            let adjustment = page.scroller.vadjustment();
            let position = adjustment.value();
            page.drawing.set(true);
            while let Some(row) = page.list.row_at_index(0) {
                page.list.remove(&row);
            }
            let mut groups: Vec<(String, Vec<&DrawnRow>)> = Vec::new();
            for row in &drawn {
                let label = match page.grouping.get() {
                    1 => source_name(row.session.source()),
                    2 => {
                        let project = row.session.project();
                        if project.is_empty() {
                            "No project".into()
                        } else {
                            project
                        }
                    }
                    3 => row
                        .state
                        .map(|s| s.title())
                        .unwrap_or(SessionUploadState::Discovering.title())
                        .into(),
                    4 => local_session_week(row.session.updated()),
                    _ => String::new(),
                };
                if let Some(group) = groups.iter_mut().find(|(key, _)| *key == label) {
                    group.1.push(row);
                } else {
                    groups.push((label, vec![row]));
                }
            }
            page.group_checks.borrow_mut().clear();
            let mut keys = Vec::new();
            let mut active = Vec::new();
            for (label, rows) in groups {
                if page.grouping.get() != 0 {
                    let group_key = format!("{}:{label}", page.grouping.get());
                    let collapsed = page.collapsed.borrow().contains(&group_key);
                    let header = hbox(10, &[]);
                    header.append(&icon(
                        if collapsed {
                            "pan-end-symbolic"
                        } else {
                            "pan-down-symbolic"
                        },
                        12,
                    ));
                    if page.grouping.get() == 1 {
                        header.append(&agent_badge(rows[0].session.source(), 24));
                    } else {
                        header.append(&icon(
                            if page.grouping.get() == 4 {
                                "x-office-calendar-symbolic"
                            } else if page.grouping.get() == 2 {
                                "folder-symbolic"
                            } else {
                                "view-list-symbolic"
                            },
                            24,
                        ));
                    }
                    header.append(&text(&label, &["row-title"]));
                    header.append(&widgets::spacer());
                    header.append(&text(
                        &format!(
                            "{} {}",
                            rows.len(),
                            if rows.len() == 1 {
                                "session"
                            } else {
                                "sessions"
                            }
                        ),
                        &["group-count"],
                    ));
                    let holder = gtk::ListBoxRow::new();
                    holder.add_css_class("session-group-holder");
                    holder.set_selectable(false);
                    holder.set_activatable(false);
                    let weak = self.downgrade();
                    let toggle = button("", &["flat", "session-group-collapse"], move || {
                        if let Some(app) = weak.upgrade() {
                            if let Some(shell) = app.shell() {
                                let page = &shell.pages.sessions;
                                let mut groups = page.collapsed.borrow_mut();
                                if !groups.remove(&group_key) {
                                    groups.insert(group_key.clone());
                                }
                                page.drawn.borrow_mut().clear();
                            }
                            app.render_sessions();
                        }
                    });
                    toggle.set_child(Some(&header));
                    toggle.set_widget_name(&format!("session-group {label}"));
                    toggle.set_tooltip_text(Some(&format!(
                        "{} {label}",
                        if collapsed { "Expand" } else { "Collapse" }
                    )));
                    widgets::name(
                        &toggle,
                        &format!(
                            "{label}, {} sessions, {}",
                            rows.len(),
                            if collapsed { "collapsed" } else { "expanded" }
                        ),
                    );
                    toggle.set_hexpand(true);
                    let group_keys: Vec<String> =
                        rows.iter().map(|row| row.session.key()).collect();
                    let check = gtk::CheckButton::new();
                    check.set_widget_name(&format!("select-session-group {label}"));
                    widgets::name(&check, &format!("Select sessions in {label}"));
                    check.set_active(group_keys.iter().all(|key| selection.contains(key)));
                    check.set_valign(gtk::Align::Center);
                    widgets::action_cursor(&check);
                    let selected_keys = group_keys.clone();
                    let weak = self.downgrade();
                    check.connect_toggled(move |check| {
                        let Some(app) = weak.upgrade() else {
                            return;
                        };
                        let Some(shell) = app.shell() else {
                            return;
                        };
                        let page = &shell.pages.sessions;
                        if page.drawing.get() {
                            return;
                        }
                        let on = check.is_active();
                        app.update_state(|state| {
                            for key in &selected_keys {
                                if on {
                                    state.session_selection.insert(key.clone());
                                } else {
                                    state.session_selection.remove(key);
                                }
                            }
                        });
                        page.drawing.set(true);
                        for (index, key) in page.keys.borrow().iter().enumerate() {
                            if selected_keys.contains(key) {
                                if let Some(row) = page.list.row_at_index(index as i32) {
                                    if on {
                                        page.list.select_row(Some(&row));
                                    } else {
                                        page.list.unselect_row(&row);
                                    }
                                }
                            }
                        }
                        page.drawing.set(false);
                        app.render_selection_bar();
                    });
                    page.group_checks
                        .borrow_mut()
                        .push((check.clone(), group_keys));
                    let group_header = hbox(10, &["local-session-group"]);
                    group_header.append(&check);
                    group_header.append(&toggle);
                    holder.set_child(Some(&group_header));
                    page.list.append(&holder);
                    keys.push(String::new());
                    if collapsed {
                        continue;
                    }
                }
                for (index, row) in rows.into_iter().enumerate() {
                    let key = row.session.key();
                    let (widget, times) = self.session_list_row(row);
                    active.extend(times);
                    if index % 2 == 0 {
                        widget.add_css_class("striped");
                    }
                    page.list.append(&widget);
                    if selection.contains(&key) {
                        page.list.select_row(Some(&widget));
                    }
                    keys.push(key);
                }
            }
            *page.keys.borrow_mut() = keys;
            *page.active.borrow_mut() = active;
            *page.drawn.borrow_mut() = drawn;
            page.drawing.set(false);
            glib::idle_add_local_once(move || adjustment.set_value(position));
        }
        self.refresh_session_title_cells();
        let now = super::now_ms();
        for (label, moment) in page.active.borrow().iter() {
            let age = relative_ms(*moment, now);
            label.set_text(&age);
            label.set_tooltip_text(Some(&exact_ms(*moment)));
        }

        let (loaded, loading, preparing, query, error) = self.with_state(|state| {
            (
                page.search_data
                    .borrow_mut()
                    .get(&state.sessions, &state.local_sessions)
                    .rows
                    .len(),
                state.refreshing_sessions,
                state.account().phase.as_deref() == Some("preparing_local_sessions"),
                state.session_search.clone(),
                state.session_error.clone(),
            )
        });
        page.count.set_text(&format!(
            "{} {} on this machine",
            rows.len(),
            if rows.len() == 1 {
                "session"
            } else {
                "sessions"
            }
        ));
        page.preparing.set_visible(preparing);
        clear(&page.empty);
        if rows.is_empty() {
            if loading {
                let spinner = gtk::Spinner::new();
                spinner.start();
                page.empty.append(&spinner);
            }
            page.empty.append(
                &text(
                    if loaded == 0 {
                        "No sessions found yet"
                    } else {
                        "No sessions match these filters."
                    },
                    &["secondary"],
                )
                .centered(),
            );
            if loaded == 0 {
                page.empty.append(
                    &text(
                        "Local sessions appear here as they are discovered.",
                        &["caption"],
                    )
                    .centered(),
                );
            }
            if !query.is_empty() {
                page.empty.append(&button(
                    "Clear search and filters",
                    &[],
                    self.on(|app| app.set_session_search("")),
                ));
            }
        }
        page.empty.set_visible(rows.is_empty());
        page.error.set_text(error.as_deref().unwrap_or_default());
        page.error.set_tooltip_text(error.as_deref());
        page.error.set_visible(error.is_some());
        self.render_selection_bar();
        // Re-check after layout, including when filtering leaves too few rows
        // to scroll or a background refresh was in flight at the end of the list.
        let weak = self.downgrade();
        glib::idle_add_local_once(move || {
            if let Some(app) = weak.upgrade() {
                app.load_more_sessions_if_needed();
            }
        });
    }

    pub(super) fn refresh_saved_view_indicator(&self) {
        if let Some(shell) = self.shell() {
            if let Some(toolbar) = shell.pages.sessions.toolbar.borrow().as_ref() {
                toolbar.update_saved_view(self);
            }
        }
    }

    pub fn set_session_grouping(&self, index: u32) {
        if let Some(shell) = self.shell() {
            shell.pages.sessions.grouping.set(index);
            shell.pages.sessions.drawn.borrow_mut().clear();
        }
        self.render_sessions();
    }

    pub(super) fn set_session_query_filter(&self, field: &str, value: &str) {
        let query = self.with_state(|state| {
            LocalSessionQuery::new(&state.session_search).applying_filter(field, value)
        });
        self.set_session_search(&query);
    }

    pub(super) fn render_session_controls(&self, page: &SessionsPage) {
        let (search, data) = self.with_state(|state| {
            (
                state.session_search.clone(),
                page.search_data
                    .borrow_mut()
                    .get(&state.sessions, &state.local_sessions),
            )
        });
        if page.search.text().as_str() != search {
            page.syncing_search.set(true);
            page.search.set_text(&search);
            page.syncing_search.set(false);
        }
        let query = LocalSessionQuery::new(&search);
        let error = query.error();
        page.search_error
            .set_text(error.as_deref().unwrap_or_default());
        page.search_error.set_visible(error.is_some());
        if page.toolbar.borrow().is_none() {
            let toolbar = SessionControls::build(self, &page.search);
            if let Some(shell) = self.shell() {
                shell.header_search.append(&toolbar.root);
                shell.header_search.append(&page.transcript.heading);
                shell.header_grouping.append(&page.controls);
            }
            let columns =
                super::session_columns::SessionColumnControls::build(self, &toolbar.display);
            page.controls.append(&columns.button);
            *page.column_controls.borrow_mut() = Some(columns);
            *page.toolbar.borrow_mut() = Some(toolbar);
        }
        if let Some(columns) = page.column_controls.borrow().as_ref() {
            columns.update(&self.session_columns(), self.show_hidden_sessions());
        }
        if let Some(toolbar) = page.toolbar.borrow().as_ref() {
            toolbar.update(
                self,
                &query,
                &data.sources,
                &data.projects,
                page.grouping.get(),
            );
        }
    }

    fn session_list_row(
        &self,
        drawn: &DrawnRow,
    ) -> (gtk::ListBoxRow, Vec<(gtk::Label, Option<i64>)>) {
        let session = &drawn.session;
        let key = session.key();
        let title = session.title();
        let directory = session
            .upload
            .as_ref()
            .and_then(|s| s.cwd.clone())
            .or_else(|| session.relay.as_ref().and_then(|s| s.directory.clone()))
            .unwrap_or_default();
        let content = hbox(16, &[]);
        widgets::pad(&content, 0, Some(12), None);
        content.set_size_request(-1, 64);
        let details = hbox(16, &[]);
        details.set_hexpand(true);
        let words = vbox(3, &[]);
        words.set_hexpand(true);
        let title_label = text(&title, &["row-title"]).ellipsized();
        words.append(&title_label);
        let metadata = session.execution_details();
        let subtitle = text(&metadata, &["caption", "secondary"]).ellipsized();
        subtitle.set_tooltip_text(Some(&metadata));
        words.append(&super::agent_names::subtitle(session, &key, subtitle));
        if let Some(error) = &drawn.relay_error {
            words.append(&text(error, &["warn", "caption"]).ellipsized());
        }
        details.append(&words);
        let project = session.project();
        let project = text(
            if project.is_empty() { "—" } else { &project },
            &["caption"],
        )
        .ellipsized();

        let active = text(
            &relative_ms(session.updated(), super::now_ms()),
            &["caption"],
        );

        let created = text(
            &relative_ms(session.created_at(), super::now_ms()),
            &["caption"],
        );
        let weak = self.downgrade();
        let selected = session.clone();
        let open = button("", &["session-open"], move || {
            if let Some(app) = weak.upgrade() {
                app.open_local_session(selected.clone());
            }
        });
        open.set_child(Some(&details));
        open.set_hexpand(true);
        open.set_tooltip_text(Some("Open session"));
        let upload_status = if drawn.stopping {
            "Deleting…"
        } else if drawn.requesting {
            SessionUploadState::Preparing.icon_title()
        } else {
            drawn
                .state
                .map(|state| state.icon_title())
                .unwrap_or(SessionUploadState::Discovering.icon_title())
        };
        widgets::name(
            &open,
            &format!("Open session: {title}, upload status: {upload_status}"),
        );
        open.set_widget_name(&format!("open-session {key}"));

        let presence = drawn.presence.unwrap_or(Presence::Off);
        let weak = self.downgrade();
        let local = session.relay.clone();
        let relay = button("", &["flat", "message-control"], move || {
            if let (Some(app), Some(local)) = (weak.upgrade(), &local) {
                let on = app.with_state(|state| state.presence_of(local).is_on());
                app.toggle_relay(local, !on);
            }
        });
        relay.set_valign(gtk::Align::Center);
        relay.set_halign(gtk::Align::Center);
        relay.set_sensitive(drawn.can_relay);
        relay.set_widget_name(&format!("receive-messages {key}"));
        relay.add_css_class(presence.message_class());
        let status = hbox(6, &[]);
        status.append(&widgets::glyph(
            presence.message_symbol(),
            14,
            presence.message_class(),
        ));
        status.append(&text(presence.message_status(), &["caption"]));
        relay.set_child(Some(&status));
        widgets::name(
            &relay,
            &format!("Receive messages: {title}, {}", presence.message_status()),
        );
        let help = if drawn.can_relay {
            presence.message_help()
        } else if let Some(local) = &session.relay {
            if local.live {
                "Connect a workspace to receive messages."
            } else {
                "Start this session to receive messages."
            }
        } else {
            "Start this session in a supported harness to receive messages."
        };
        relay.set_tooltip_text(Some(help));
        let relay_holder = gtk::CenterBox::new();
        relay_holder.set_center_widget(Some(&relay));
        let holder = gtk::CenterBox::new();
        let upload_control = vbox(2, &[]);
        upload_control.set_halign(gtk::Align::Center);
        upload_control.set_valign(gtk::Align::Center);
        upload_control.append(&status_cell(
            drawn.state.unwrap_or(SessionUploadState::Discovering),
            drawn.requesting,
            drawn.stopping,
        ));
        upload_control.append(&text(upload_status, &["caption"]));
        holder.set_center_widget(Some(&upload_control));
        let checkbox = gtk::CheckButton::new();
        widgets::action_cursor(&checkbox);
        checkbox.set_focus_on_click(false);
        checkbox.set_widget_name(&format!("select-session {key}"));
        checkbox.set_size_request(20, -1);
        checkbox.set_active(self.with_state(|state| state.session_selection.contains(&key)));
        widgets::name(&checkbox, &format!("Select {title}"));
        content.append(&checkbox);
        content.append(&agent_badge(session.source(), 24));
        let layout = self.live_session_columns();
        for column in layout.visible() {
            let widget: gtk::Widget = match column {
                SessionColumn::Session => open.clone().upcast(),
                SessionColumn::Relay => relay_holder.clone().upcast(),
                SessionColumn::Upload => holder.clone().upcast(),
                _ => {
                    let label = match column {
                        SessionColumn::Project => project.clone(),
                        SessionColumn::Updated => active.clone(),
                        SessionColumn::Harness => {
                            text(&source_name(session.source()), &["caption"])
                        }
                        SessionColumn::Directory => text(
                            if directory.is_empty() {
                                "—"
                            } else {
                                &directory
                            },
                            &["caption"],
                        )
                        .ellipsized(),
                        SessionColumn::SessionID => text(
                            &session
                                .upload
                                .as_ref()
                                .map(|s| s.session_id.clone())
                                .unwrap_or_else(|| {
                                    session.relay.as_ref().unwrap().target.id.clone()
                                }),
                            &["caption", "mono"],
                        )
                        .ellipsized(),
                        SessionColumn::Status => text(drawn.activity, &["caption"]),
                        SessionColumn::Model => {
                            text(&session.model_name(), &["caption"]).ellipsized()
                        }
                        SessionColumn::Reasoning => {
                            text(session.reasoning(), &["caption"]).ellipsized()
                        }
                        SessionColumn::Created => created.clone(),
                        _ => unreachable!(),
                    };
                    label.set_tooltip_text(Some(&match column {
                        SessionColumn::Updated => exact_ms(session.updated()),
                        SessionColumn::Created => exact_ms(session.created_at()),
                        _ => label.text().to_string(),
                    }));
                    let weak = self.downgrade();
                    let selected = session.clone();
                    let cell = button("", &["session-open"], move || {
                        if let Some(app) = weak.upgrade() {
                            app.open_local_session(selected.clone());
                        }
                    });
                    widgets::name(&cell, &format!("Open session: {title}"));
                    if column == SessionColumn::Harness {
                        let identity = hbox(8, &[]);
                        identity.append(&agent_badge(session.source(), 20));
                        identity.append(&label);
                        cell.set_child(Some(&identity));
                    } else {
                        cell.set_child(Some(&label));
                    }
                    cell.upcast()
                }
            };
            widget.set_widget_name(&format!("session-cell {} {key}", column.id()));
            // Keep existing control names used by automation and accessibility.
            if column == SessionColumn::Session {
                widget.set_widget_name(&format!("open-session {key}"));
            }
            widget.set_hexpand(true);
            let frame = session_column_frame(&widget, layout.width(column));
            frame.set_widget_name(&widget.widget_name());
            frame.set_hexpand(layout.expanding_column() == Some(column));
            content.append(&frame);
        }
        let row = gtk::ListBoxRow::new();
        crate::linux_app::ui::widgets::action_cursor(&row);
        row.add_css_class("session-row");
        if drawn.hidden {
            row.add_css_class("session-hidden");
        }
        row.set_child(Some(&content));
        let weak_row = row.downgrade();
        checkbox.connect_toggled(move |check| {
            if let Some(row) = weak_row.upgrade() {
                if let Some(list) = row.parent().and_downcast::<gtk::ListBox>() {
                    if check.is_active() {
                        list.select_row(Some(&row));
                    } else {
                        list.unselect_row(&row);
                    }
                }
            }
        });
        let weak_check = checkbox.downgrade();
        row.connect_state_flags_changed(move |row, _| {
            if let Some(check) = weak_check.upgrade() {
                check.set_active(row.is_selected());
            }
        });
        // Claim only the row's non-control surface before GtkListBox can treat
        // a click in a cell gap as a selection change. Controls keep their events.
        let click = gtk::GestureClick::new();
        click.set_name(Some("session-row-open"));
        click.set_button(1);
        click.set_propagation_phase(gtk::PropagationPhase::Capture);
        let pending = std::rc::Rc::new(Cell::new(None));
        let hit_row = row.downgrade();
        let hit_check = checkbox.downgrade();
        let pressed_action = pending.clone();
        click.connect_pressed(move |gesture, presses, x, y| {
            pressed_action.set(None);
            if presses != 1 {
                return;
            }
            if let (Some(row), Some(check)) = (hit_row.upgrade(), hit_check.upgrade()) {
                if within_control(
                    row.pick(x, y, gtk::PickFlags::INSENSITIVE),
                    row.upcast_ref(),
                ) {
                    return;
                }
                let selection_lane = check
                    .compute_bounds(&row)
                    .is_some_and(|bounds| x <= f64::from(bounds.x() + bounds.width()) + 8.0);
                pressed_action.set(Some(selection_lane));
                gesture.set_state(gtk::EventSequenceState::Claimed);
            }
        });
        let weak = self.downgrade();
        let click_check = checkbox.downgrade();
        let clicked_session = session.clone();
        let released_action = pending.clone();
        click.connect_released(move |_, presses, _, _| {
            if presses != 1 {
                return;
            }
            match released_action.take() {
                Some(true) => {
                    if let Some(check) = click_check.upgrade() {
                        check.set_active(!check.is_active());
                    }
                }
                Some(false) => {
                    if let Some(app) = weak.upgrade() {
                        app.open_local_session(clicked_session.clone());
                    }
                }
                None => {}
            }
        });
        click.connect_stopped(move |_| pending.set(None));
        row.add_controller(click);
        let weak = self.downgrade();
        let pressed = row.downgrade();
        on_press(&row, move |button, x, y| {
            if let (3, Some(app), Some(row)) = (button, weak.upgrade(), pressed.upgrade()) {
                app.session_menu(&row, x, y);
            }
        });
        (
            row,
            vec![(active, session.updated()), (created, session.created_at())],
        )
    }

    fn session_selection_changed(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions;
        if page.drawing.get() {
            return;
        }
        let keys = page.keys.borrow().clone();
        let selected: BTreeSet<String> = page
            .list
            .selected_rows()
            .iter()
            .filter_map(|row| keys.get(row.index() as usize).cloned())
            .collect();
        // Rows a filter hides stay selected.
        self.update_state(|state| {
            state.session_selection.retain(|key| !keys.contains(key));
            state.session_selection.extend(selected);
        });
        self.render_selection_bar();
    }

    /// The selected sessions, those a filter hides included.
    fn selected_sessions(&self) -> Vec<UploadSession> {
        self.with_state(|state| {
            state
                .sessions
                .iter()
                .filter(|session| state.session_selection.contains(&session_key(session)))
                .cloned()
                .collect()
        })
    }

    pub fn clear_session_selection(&self) {
        self.update_state(|state| state.session_selection.clear());
        if let Some(shell) = self.shell() {
            let page = &shell.pages.sessions;
            page.drawing.set(true);
            page.list.unselect_all();
            page.drawing.set(false);
        }
        self.render_selection_bar();
    }

    fn render_selection_bar(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions;
        page.drawing.set(true);
        for (check, keys) in page.group_checks.borrow().iter() {
            check.set_active(
                self.with_state(|state| {
                    keys.iter().all(|key| state.session_selection.contains(key))
                }),
            );
        }
        page.drawing.set(false);
        if let Some(select) = page
            .header
            .first_child()
            .filter(|leading| leading.widget_name() == "session-selection-header")
            .and_then(|leading| leading.first_child())
        {
            // Group headings have an empty key and cannot be selected.
            let shown = page
                .keys
                .borrow()
                .iter()
                .filter(|key| !key.is_empty())
                .count();
            if shown > 0 && page.list.selected_rows().len() == shown {
                select.add_css_class("checked");
            } else {
                select.remove_css_class("checked");
            }
        }
        let bar = &page.selection_bar;
        clear(bar);
        let rows = self.selected_sessions();
        let (requesting, read_only, preparing, busy) = self.with_state(|state| {
            (
                state.requesting.len(),
                state.sessions_read_only(),
                state.account().phase.as_deref() == Some("preparing_local_sessions"),
                state.busy,
            )
        });
        let message_sessions = self.with_state(|state| {
            state
                .local_sessions
                .iter()
                .filter(|session| {
                    let key = session
                        .target
                        .upload_key()
                        .unwrap_or_else(|| session.target.key());
                    state.session_selection.contains(&key)
                        && !self.session_hidden(&key)
                        && state.can_toggle(session, state.presence_of(session))
                })
                .cloned()
                .collect::<Vec<_>>()
        });
        let selected_count = self.with_state(|state| state.session_selection.len());
        if selected_count == 0 && requesting == 0 {
            page.selection_revealer.set_reveal_child(false);
            return;
        }
        let selected_keys =
            self.with_state(|state| state.session_selection.iter().cloned().collect::<Vec<_>>());
        let shown = page.keys.borrow().clone();
        let hidden = rows
            .iter()
            .filter(|session| !shown.contains(&session_key(session)))
            .count();
        let uploadable: Vec<String> = rows
            .iter()
            .filter(|session| {
                (!session.included
                    || self.with_state(|state| state.stopping.contains(&session_key(session))))
                    && !self.session_hidden(&session_key(session))
            })
            .map(session_key)
            .collect();
        let included: Vec<String> = rows
            .iter()
            .filter(|session| {
                session.included
                    || self.with_state(|state| state.requesting.contains(&session_key(session)))
            })
            .map(session_key)
            .collect();
        let description = if requesting > 0 {
            "Upload requested · Follow progress in the Upload column.".to_string()
        } else if preparing {
            "Uploads unlock when indexing finishes.".to_string()
        } else if read_only && !busy {
            "All sessions upload automatically.".to_string()
        } else {
            let mut line = format!("{} selected", grouped(selected_count));
            if hidden > 0 {
                line.push_str(&format!(" · {hidden} hidden by filters"));
            }
            line
        };
        let words = text(&description, &["secondary"]);
        words.set_hexpand(true);
        bar.append(&words);
        let messaging_on = !message_sessions.is_empty()
            && self.with_state(|state| {
                message_sessions
                    .iter()
                    .all(|session| state.presence_of(session).is_on())
            });
        let messaging = gtk::Switch::new();
        messaging.set_widget_name("bulk-messaging");
        widgets::name(&messaging, "Messaging");
        messaging.set_active(messaging_on);
        messaging.set_sensitive(!message_sessions.is_empty());
        messaging.set_valign(gtk::Align::Center);
        let action = self.on(move |app| {
            for session in &message_sessions {
                app.toggle_relay(session, !messaging_on);
            }
        });
        messaging.connect_state_set(move |_, _| {
            action();
            glib::Propagation::Stop
        });
        bar.append(&text("Messaging", &[]));
        bar.append(&messaging);

        let upload_on = !selected_keys.is_empty()
            && selected_keys.iter().all(|key| {
                rows.iter().any(|session| {
                    session_key(session) == *key
                        && self.with_state(|state| {
                            !state.stopping.contains(key)
                                && (session.included || state.requesting.contains(key))
                        })
                })
            });
        let upload = gtk::Switch::new();
        upload.set_widget_name("bulk-upload");
        widgets::name(&upload, "Upload");
        upload.set_active(upload_on);
        upload.set_sensitive(
            !read_only
                && if upload_on {
                    !included.is_empty()
                } else {
                    !uploadable.is_empty()
                },
        );
        upload.set_valign(gtk::Align::Center);
        let action = self.on(move |app| {
            if upload_on {
                app.request_upload_change(included.clone(), false);
            } else {
                app.change_uploads(uploadable.clone(), true);
            }
        });
        let resetting = Cell::new(false);
        upload.connect_state_set(move |switch, _| {
            if resetting.replace(true) {
                return glib::Propagation::Stop;
            }
            switch.set_active(upload_on);
            resetting.set(false);
            action();
            glib::Propagation::Stop
        });
        bar.append(&text("Upload", &[]));
        bar.append(&upload);
        for (title, hide) in [("Hide", true), ("Unhide", false)] {
            let keys: Vec<_> = selected_keys
                .iter()
                .filter(|key| {
                    self.session_hidden(key) != hide
                        && !self.with_state(|state| state.hiding_sessions.contains(*key))
                })
                .cloned()
                .collect();
            if !keys.is_empty() {
                let action = button(
                    title,
                    &["flat", "selection-action"],
                    self.on(move |app| app.set_sessions_hidden(keys.clone(), hide)),
                );
                let content = hbox(6, &[]);
                content.append(&text(title, &[]));
                content.append(&icon(
                    if hide {
                        "view-conceal-symbolic"
                    } else {
                        "view-reveal-symbolic"
                    },
                    14,
                ));
                action.set_child(Some(&content));
                bar.append(&action);
            }
        }
        bar.set_visible(true);
        page.selection_revealer.set_reveal_child(true);
    }

    fn session_menu(&self, row: &gtk::ListBoxRow, x: f64, y: f64) {
        let items = self.session_menu_items(row);
        if !items.is_empty() {
            menu(row, Some((x, y)), items);
        }
    }

    /// A right-click's menu. Inside the selection it acts on the whole
    /// selection, rows hidden by filters included; on a row outside it, it
    /// acts on that row alone and leaves the selection as it is.
    pub fn session_menu_items(&self, row: &gtk::ListBoxRow) -> MenuItems {
        let rows = if row.is_selected() {
            self.selected_sessions()
        } else {
            let Some(shell) = self.shell() else {
                return Vec::new();
            };
            let Some(key) = shell
                .pages
                .sessions
                .keys
                .borrow()
                .get(row.index() as usize)
                .cloned()
            else {
                return Vec::new();
            };
            self.with_state(|state| {
                state
                    .sessions
                    .iter()
                    .filter(|session| session_key(session) == key)
                    .cloned()
                    .collect()
            })
        };
        let read_only = self.with_state(|state| state.sessions_read_only());
        let uploadable: Vec<String> = rows
            .iter()
            .filter(|session| !session.included && !self.session_hidden(&session_key(session)))
            .map(session_key)
            .collect();
        let included: Vec<String> = rows
            .iter()
            .filter(|session| session.included)
            .map(session_key)
            .collect();
        let mut items: MenuItems = Vec::new();
        let visibility_keys = if row.is_selected() {
            self.with_state(|state| state.session_selection.iter().cloned().collect::<Vec<_>>())
        } else {
            self.shell()
                .and_then(|shell| {
                    shell
                        .pages
                        .sessions
                        .keys
                        .borrow()
                        .get(row.index() as usize)
                        .cloned()
                })
                .into_iter()
                .collect()
        };
        for (title, hide) in [("Hide session", true), ("Unhide session", false)] {
            let keys: Vec<_> = visibility_keys
                .iter()
                .filter(|key| {
                    self.session_hidden(key) != hide
                        && !self.with_state(|state| state.hiding_sessions.contains(*key))
                })
                .cloned()
                .collect();
            if !keys.is_empty() {
                items.push((
                    title.into(),
                    Some(Box::new(
                        self.on(move |app| app.set_sessions_hidden(keys.clone(), hide)),
                    )),
                ));
            }
        }

        if !uploadable.is_empty() {
            let keys = uploadable.clone();
            items.push((
                format!("Upload {}", sessions_noun(uploadable.len())),
                (!read_only).then(|| {
                    Box::new(self.on(move |app| app.change_uploads(keys.clone(), true))) as Callback
                }),
            ));
        }
        if !included.is_empty() {
            let keys = included.clone();
            items.push((
                format!("Delete cloud copies for {}", sessions_noun(included.len())),
                (!read_only).then(|| {
                    Box::new(self.on(move |app| app.request_upload_change(keys.clone(), false)))
                        as Callback
                }),
            ));
        }
        if let [session] = rows.as_slice() {
            if SessionUploadState::of(session, None) == SessionUploadState::Uploaded {
                if !items.is_empty() {
                    items.push(("-".into(), None));
                }
                let session = session.clone();
                items.push((
                    "Open in Cloud".into(),
                    Some(Box::new(self.on(move |app| app.open_cloud(&session)))),
                ));
            }
        }
        items
    }

    fn session_activated(&self, index: i32) {
        let Some(key) = self.shell().and_then(|shell| {
            shell
                .pages
                .sessions
                .keys
                .borrow()
                .get(index as usize)
                .cloned()
        }) else {
            return;
        };
        let session = self.with_state(|state| {
            merge_local_sessions(&state.sessions, &state.local_sessions)
                .into_iter()
                .find(|row| row.key() == key)
        });
        if let Some(session) = session {
            self.open_local_session(session);
        }
    }

    /// Each session has an independent request loop; the newest intent is
    /// reflected immediately and serialized behind any in-flight call for it.
    /// Confirmation leaves the switch and all other rows interactive until accepted.
    pub fn request_upload_change(&self, keys: Vec<String>, include: bool) {
        if include {
            self.change_uploads(keys, true);
            return;
        }
        let generation = self.with_state(|state| state.generation);
        let (title, detail) = if keys.len() == 1 {
            ("Delete cloud copy?", "This removes the uploaded copy of this session and its subagents from Cloud and stops future uploads. Your local history stays on this machine. Turn Upload on again to upload a new copy.")
        } else {
            ("Delete cloud copies?", "This removes the selected cloud copies and stops future uploads. Your local history stays on this machine.")
        };
        let answer =
            self.confirm(Confirmation::new(title, detail, "Delete from Cloud").destructive());
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            if let (true, Some(app)) = (answer.await, weak.upgrade()) {
                if app.with_state(|state| state.generation) == generation {
                    app.change_uploads(keys, false);
                }
            }
        });
    }

    pub fn change_uploads(&self, keys: Vec<String>, include: bool) {
        let keys: Vec<_> = keys
            .into_iter()
            .filter(|key| !include || !self.session_hidden(key))
            .collect();
        if keys.is_empty() || self.with_state(|state| state.sessions_read_only()) {
            return;
        }
        let start = self.update_state(|state| {
            let mut start = Vec::new();
            for key in keys {
                state.upload_errors.remove(&key);
                if include {
                    state.requesting.insert(key.clone());
                    state.stopping.remove(&key);
                } else {
                    state.stopping.insert(key.clone());
                    state.requesting.remove(&key);
                }
                if state.busy_uploads.insert(key.clone()) {
                    start.push(key);
                }
            }
            state.upload_selection_revision += 1;
            start
        });
        self.render_sessions();
        for key in start {
            self.drive_upload(key, false);
        }
    }

    fn drive_upload(&self, key: String, reconcile: bool) {
        let (include, confirmed) = self.with_state(|state| {
            (
                state.requesting.contains(&key),
                state
                    .sessions
                    .iter()
                    .find(|s| session_key(s) == key)
                    .map(|s| s.included),
            )
        });
        // Upload exclusion does not prove the Cloud copy was deleted.
        if include && !reconcile && confirmed == Some(true) {
            self.finish_upload(&key);
            return;
        }
        let params = SessionKeysParams {
            session_keys: vec![key.clone()],
        };
        let finished = move |app: &App, error: Option<crate::linux_app::bridge::CoreError>| {
            let again = app.update_state(|state| {
                let changed = state.requesting.contains(&key) != include;
                if let Some(error) = error {
                    if !changed {
                        state.upload_errors.insert(key.clone(), error.message);
                    }
                } else {
                    state.upload_selection_revision += 1;
                    if let Some(row) = state.sessions.iter_mut().find(|s| session_key(s) == key) {
                        row.included = include;
                        row.status = if include {
                            crate::relay::contract::account::UploadShareStatus::Shared
                        } else {
                            crate::relay::contract::account::UploadShareStatus::NotShared
                        };
                    }
                    // Keep the bulk selection so the next switch click applies to the same rows.
                }
                changed
            });
            if again {
                app.drive_upload(key, true);
            } else {
                app.finish_upload(&key);
            }
        };
        if include {
            self.view_call::<method::UploaderSessionsInclude>(params, move |app, result| {
                finished(app, result.err())
            });
        } else {
            self.view_call::<method::UploaderSessionsDelete>(params, move |app, result| {
                finished(app, result.err())
            });
        }
    }

    fn finish_upload(&self, key: &str) {
        self.update_state(|state| {
            state.busy_uploads.remove(key);
            state.requesting.remove(key);
            state.stopping.remove(key);
        });
        self.render_sessions();
        self.refresh_uploader(true);
    }

    /// An uploaded session's page in Agent Relay Cloud.
    pub fn open_cloud(&self, session: &UploadSession) {
        let site = self.with_state(|state| state.account().site_url.unwrap_or_default());
        if let Some(url) = cloud_session_url(&site, &session.session_id) {
            self.inner.desktop.open_uri(&url);
        }
    }

    fn load_more_sessions_if_needed(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = &shell.pages.sessions;
        if self.page() != super::state::Page::Sessions
            || !page.table.is_visible()
            || !page.scroller.is_mapped()
            || page.drawing.get()
        {
            return;
        }
        let adjustment = page.scroller.vadjustment();
        if adjustment.page_size() <= 0.0
            || adjustment.value() + adjustment.page_size() + 200.0 < adjustment.upper()
        {
            return;
        }
        let load = self.update_state(|state| {
            if !state.connected()
                || state.busy
                || state.refreshing_sessions
                || state.sessions_refreshed.is_none()
                || state.account().phase.as_deref() == Some("preparing_local_sessions")
                || state.sessions.len() < state.session_limit
            {
                return false;
            }
            state.session_limit += 500;
            true
        });
        if load {
            self.refresh_uploader(true);
        }
    }

    /// Reading, collecting and uploading as a checklist.
    pub(super) fn stages_view(&self) -> gtk::Box {
        let (stages, busy, action_error) = self.with_state(|state| {
            let account = state.account();
            let capture = account.progress.as_ref();
            let preparing = account.phase.as_deref() == Some("preparing_local_sessions")
                || capture.is_some_and(capture_is_active);
            let summary = state
                .status
                .as_ref()
                .map(|status| UploadSummary::new(status, &state.sessions, state.requesting.len()));
            let stages = upload_stages(
                !state.sessions.is_empty() || state.sessions_refreshed.is_some(),
                state.sessions.len(),
                state
                    .sessions
                    .iter()
                    .filter(|session| session.included)
                    .count(),
                preparing,
                capture,
                state.status.as_ref(),
                summary.as_ref(),
                state.pending_stage_action(),
            );
            (stages, state.busy, state.upload_action_error.clone())
        });
        let holder = vbox(12, &[]);
        for stage in stages {
            let row = hbox(10, &[]);
            let (glyph, class) = stage_glyph(stage.state);
            let image = icon(glyph, 14);
            image.add_css_class(class);
            image.set_valign(gtk::Align::Start);
            row.append(&image);
            let words = vbox(4, &[]);
            words.set_hexpand(true);
            let line = hbox(8, &[]);
            let title = text(stage.title, &["settings-row-title"]);
            title.set_hexpand(true);
            line.append(&title);
            if stage.state == StageState::Active {
                let bar = gtk::ProgressBar::new();
                bar.set_size_request(80, -1);
                bar.set_valign(gtk::Align::Center);
                widgets::name(&bar, stage.title);
                match stage.fraction {
                    Some(fraction) => bar.set_fraction(fraction),
                    None => {
                        bar.pulse();
                        let weak = bar.downgrade();
                        glib::timeout_add_local(Duration::from_millis(150), move || {
                            match weak.upgrade() {
                                Some(bar) => {
                                    bar.pulse();
                                    glib::ControlFlow::Continue
                                }
                                None => glib::ControlFlow::Break,
                            }
                        });
                    }
                }
                line.append(&bar);
            }
            words.append(&line);
            words.append(&text(&stage.detail, &["caption"]).wrapped());
            if let Some(action) = stage.action {
                words.append(&self.stage_action(action, busy, action_error.as_deref()));
            }
            row.append(&words);
            holder.append(&row);
        }
        holder
    }
}

impl App {
    fn live_session_columns(&self) -> SessionColumnLayout {
        self.shell()
            .and_then(|shell| {
                shell
                    .pages
                    .sessions
                    .resizing
                    .borrow()
                    .as_ref()
                    .map(|(_, _, layout)| layout.clone())
            })
            .unwrap_or_else(|| self.session_columns())
    }
}
