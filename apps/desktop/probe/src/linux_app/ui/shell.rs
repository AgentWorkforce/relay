//! One global header with workspace, session search, and account menus.
//! Settings alone has contextual navigation below the header.

use super::app::{Action, App};
use super::pages::Pages;
use super::settings_page::SettingsPage;
use super::state::{AgentScope, Page, Pane, Section, TeamPick};
use super::widgets::{
    self, avatar, clear, hbox, icon, section_title, sidebar_row, text, vbox, with_dot, Dot,
    LabelStyle, RowExtras,
};
use crate::linux_app::models::{LocalSessionQuery, SessionFilter};
use gtk::prelude::*;
use gtk4 as gtk;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

mod menus;
mod upgrade_notice;

/// The shell's widgets that change after it is built.
pub struct Shell {
    pub root: gtk::Box,
    pub sessions_button: gtk::Button,
    pub header: gtk::Box,
    pub header_search: gtk::Box,
    pub settings_back: gtk::Button,
    pub update_button: gtk::Button,
    pub account_button: gtk::Button,
    pub sidebar: gtk::Box,
    pub header_grouping: gtk::Box,
    pub sidebar_rows: gtk::Box,
    pub topbar: gtk::Box,
    pub topbar_separator: gtk::Separator,
    /// The top bar's search field and the page it searches.
    pub topbar_search: RefCell<Option<(gtk::SearchEntry, Page)>>,
    pub(super) syncing_agent_search: Cell<bool>,
    pub page_error: gtk::Label,
    pub page_stack: gtk::Stack,
    pub status_dot: Dot,
    pub status_text: gtk::Label,
    pub session_summary: gtk::Box,
    pub pause_button: gtk::Button,
    pub upgrade_notice: gtk::Box,
    /// The notice's title and message, set for its reason.
    pub upgrade_text: (gtk::Label, gtk::Label),
    pub relay_count_text: gtk::Label,
    pub settings: SettingsPage,
    pub pages: Pages,
}

impl Shell {
    pub fn build(app: &App) -> Rc<Shell> {
        let root = vbox(0, &[]);
        let body = hbox(0, &[]);
        body.set_vexpand(true);
        root.append(&body);

        // Its 24-point gutters are CSS padding, so the band runs edge to edge.
        let header = hbox(6, &["global-header"]);
        let sessions_button = gtk::Button::new();
        sessions_button.add_css_class("flat");
        sessions_button.add_css_class("header-brand");
        sessions_button.set_cursor_from_name(Some("default"));
        sessions_button.set_child(Some(&widgets::header_brand()));
        sessions_button.set_size_request(-1, 44);
        sessions_button.set_margin_end(14);
        sessions_button.set_valign(gtk::Align::Center);
        widgets::name(&sessions_button, "Sessions");
        let home = app.on(|app| app.open_section(Section::Mine));
        sessions_button.connect_clicked(move |_| home());
        header.append(&sessions_button);
        let header_search = hbox(0, &[]);
        header_search.set_hexpand(true);
        header_search.set_valign(gtk::Align::Center);
        header.append(&header_search);
        let settings_back = super::transcript::back_to_sessions_button();
        let back_home = app.on(|app| app.open_section(Section::Mine));
        settings_back.connect_clicked(move |_| back_home());
        header.insert_child_after(&settings_back, Some(&sessions_button));
        let header_grouping = hbox(0, &[]);
        header_grouping.set_valign(gtk::Align::Center);
        header.append(&header_grouping);
        let account_button = gtk::Button::new();
        account_button.add_css_class("flat");
        account_button.add_css_class("header-account");
        account_button.set_size_request(52, 52);
        account_button.set_valign(gtk::Align::Center);
        widgets::action_cursor(&account_button);
        let menu = app.on(App::show_account_menu);
        account_button.connect_clicked(move |_| menu());
        header.append(&account_button);
        root.prepend(&gtk::Separator::new(gtk::Orientation::Horizontal));
        root.prepend(&header);

        let sidebar = vbox(0, &["sidebar"]);
        sidebar.set_size_request(244, -1);
        sidebar.set_hexpand(false);
        let sidebar_rows = vbox(2, &[]);
        widgets::pad(&sidebar_rows, 10, None, None);
        sidebar.append(&widgets::scrolled(&sidebar_rows));
        body.append(&sidebar);

        let main = vbox(0, &[]);
        main.set_hexpand(true);
        let topbar = hbox(12, &["topbar"]);
        // 28 points, the Mac's, which lines the title up with the page below.
        topbar.set_margin_start(28);
        topbar.set_margin_end(28);
        main.append(&topbar);
        let topbar_separator = gtk::Separator::new(gtk::Orientation::Horizontal);
        main.append(&topbar_separator);

        let page_stack = gtk::Stack::new();
        page_stack.set_transition_type(gtk::StackTransitionType::None);
        page_stack.set_vexpand(true);
        let pages = Pages::build();
        for (name, page) in pages.named() {
            page_stack.add_named(&page, Some(name));
        }
        app.connect_sessions_page(&pages.sessions, &root);
        app.connect_messages_page(&pages.messages);
        let settings = SettingsPage::build();
        page_stack.add_named(&settings.scroller, Some("settings"));
        main.append(&page_stack);
        body.append(&main);

        let (upgrade_notice, upgrade_text) = upgrade_notice::build(app);
        root.append(&upgrade_notice);

        root.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        let (bar, status_dot, status_text, pause_button, relay_count_text) = status_bar(app);
        let update_button = widgets::icon_button(
            "folder-download-symbolic",
            "Update available",
            &["status-icon"],
            app.on(App::update_action),
        );
        update_button.set_widget_name("status-update");
        pages.sessions.count.set_margin_start(8);
        pages.sessions.count.set_margin_end(8);
        let session_summary = hbox(4, &[]);
        session_summary.append(&pages.sessions.count);
        session_summary.append(&pages.sessions.preparing);
        bar.insert_child_after(&session_summary, bar.first_child().as_ref());
        bar.insert_child_after(&update_button, Some(&session_summary));
        let page_error = text("⚠ Needs attention", &["warn"]);
        page_error.set_visible(false);
        page_error.set_margin_start(8);
        page_error.set_margin_end(8);
        let error_click = gtk::GestureClick::new();
        let error_app = app.clone();
        let error_label = page_error.clone();
        error_click
            .connect_released(move |_, _, _, _| error_app.show_status_problems(&error_label));
        page_error.add_controller(error_click);
        bar.prepend(&page_error);
        root.append(&bar);
        Rc::new(Shell {
            root,
            sessions_button,
            header,
            header_search,
            settings_back,
            update_button,
            account_button,
            sidebar,
            header_grouping,
            sidebar_rows,
            topbar,
            topbar_separator,
            topbar_search: RefCell::new(None),
            syncing_agent_search: Cell::new(false),
            page_error,
            page_stack,
            status_dot,
            status_text,
            session_summary,
            pause_button,
            upgrade_notice,
            upgrade_text,
            relay_count_text,
            settings,
            pages,
        })
    }
}

/// Whether the keyboard focus is in `widget` or one of its children (a
/// search entry's text).
fn focused_within(widget: &impl IsA<gtk::Widget>) -> bool {
    widget
        .root()
        .and_then(|root| root.focus())
        .is_some_and(|focus| focus == *widget.as_ref() || focus.is_ancestor(widget))
}

fn status_bar(app: &App) -> (gtk::Box, Dot, gtk::Label, gtk::Button, gtk::Label) {
    // Its 6-point insets are CSS padding, so the bar's color reaches the edges.
    let bar = hbox(4, &["statusbar"]);
    let status_button = gtk::Button::new();
    crate::linux_app::ui::widgets::action_cursor(&status_button);
    let status = hbox(6, &[]);
    let status_dot = Dot::new(6);
    status.append(&status_dot.widget);
    let status_text = text("Checking uploads", &[]);
    status.append(&status_text);
    status_button.set_child(Some(&status));
    status_button.set_widget_name("app-status");
    status_button.set_tooltip_text(Some("App status · View in Diagnostics"));
    let status_app = app.clone();
    status_button.connect_clicked(move |button| status_app.show_status_problems(button));
    bar.append(&status_button);
    let pause_button = widgets::icon_button(
        "media-playback-pause-symbolic",
        "Pause messages and uploads",
        &["status-icon"],
        app.on(App::toggle_pause),
    );
    if let Some(glyph) = pause_button.child().and_downcast::<gtk::Image>() {
        glyph.set_pixel_size(10);
    }
    bar.append(&pause_button);
    bar.append(&widgets::spacer());
    let relay_count_button = gtk::Button::new();
    crate::linux_app::ui::widgets::action_cursor(&relay_count_button);
    let counted = hbox(6, &[]);
    counted.append(&icon("network-wireless-symbolic", 12));
    let relay_count_text = text("Live Agents on Relay: 0", &[]);
    counted.append(&relay_count_text);
    relay_count_button.set_child(Some(&counted));
    relay_count_button.set_tooltip_text(Some("Show live sessions on the relay"));
    let on_relay = app.on(|app| {
        app.set_session_search("is:active is:on-relay");
        app.open_section(Section::Mine);
    });
    relay_count_button.connect_clicked(move |_| on_relay());
    bar.append(&relay_count_button);
    (bar, status_dot, status_text, pause_button, relay_count_text)
}

impl App {
    // Navigation.

    pub fn open_section(&self, section: Section) {
        if section == Section::Mine {
            if let Some(shell) = self.shell() {
                shell.pages.sessions.transcript.back.emit_clicked();
            }
        }
        self.go(section.home());
    }

    /// Shows `page`.
    pub fn go(&self, page: Page) {
        // SearchEntry debounces search-changed. Save its current text before
        // navigation destroys the entry and cancels that pending notification.
        let pending = self.shell().and_then(|shell| {
            shell
                .topbar_search
                .borrow()
                .as_ref()
                .map(|(entry, page)| (entry.text().to_string(), *page))
        });
        if let Some((query, searched)) = pending {
            self.update_state(|state| match searched {
                Page::Sessions => state.session_search = query,
                Page::Agents | Page::Team => state.agent_search = query,
                _ => {}
            });
        }
        self.show_window();
        self.update_state(|state| {
            if state.page != page {
                if page != Page::Settings(Pane::Diagnostics) {
                    state.page_error = None;
                }
                // A switched row holds its section only while the same
                // list shows.
                state.held_sections.clear();
                state.copied.clear();
            }
            state.page = page;
        });
        if !self.with_state(|state| state.connected()) || self.shell().is_none() {
            return;
        }
        self.render_chrome();
        self.render_page();
        self.refresh_page();
    }

    /// My agents, narrowed to `scope`.
    pub fn go_scope(&self, scope: AgentScope) {
        self.update_state(|state| {
            if state.agent_scope != scope {
                state.held_sections.clear();
            }
            state.agent_scope = scope;
        });
        self.go(Page::Agents);
    }

    /// My sessions, narrowed to `filter`.
    pub fn go_sessions(&self, filter: SessionFilter) {
        let query = self.update_state(|state| {
            state.session_filter = filter;
            let value = match filter {
                SessionFilter::All => "",
                SessionFilter::Pending => "in-progress",
                SessionFilter::Uploaded => "uploaded",
                SessionFilter::Local => "local",
            };
            LocalSessionQuery::new(&state.session_search).setting("upload", value)
        });
        self.set_session_search(&query);
        self.go(Page::Sessions);
    }

    pub fn toggle_source(&self, source: &str) {
        let query = self.update_state(|state| {
            let query = LocalSessionQuery::new(&state.session_search);
            state.session_source = if query.value("harness") == Some(source) {
                None
            } else {
                Some(source.to_string())
            };
            query.setting(
                "harness",
                state.session_source.as_deref().unwrap_or_default(),
            )
        });
        self.set_session_search(&query);
        self.render_sidebar();
    }

    pub fn select_person(&self, pick: TeamPick) {
        self.update_state(|state| state.team_pick = pick);
        self.render_sidebar();
        self.render_topbar();
        self.render_page();
    }

    // Rendering.

    /// The shared header, settings navigation, page heading and status bar.
    pub fn render_chrome(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let section = self.page().section();
        shell.sidebar.set_visible(section == Section::Settings);
        shell
            .settings_back
            .set_visible(section == Section::Settings);

        shell
            .update_button
            .set_visible(self.with_state(|state| state.update_available()));
        let reading_session = shell.pages.sessions.transcript.root.get_visible();
        shell
            .session_summary
            .set_visible(self.page() == Page::Sessions && !reading_session);
        if let Some(search) = shell.header_search.first_child() {
            search.set_visible(section != Section::Settings && !reading_session);
        }
        shell
            .pages
            .sessions
            .transcript
            .heading
            .set_visible(section != Section::Settings && reading_session);
        shell
            .header_grouping
            .set_visible(section != Section::Settings && !reading_session);
        self.render_sidebar();
        self.render_topbar();
        self.render_status_bar();
        self.render_account_button(&shell);
    }

    pub fn render_sidebar(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let rows = &shell.sidebar_rows;
        clear(rows);
        let page = self.page();
        match page.section() {
            Section::Mine | Section::Team => {}
            Section::Settings => {
                let update = self.with_state(|state| state.update_available());
                for (index, (title, panes)) in Pane::GROUPS.iter().enumerate() {
                    let heading = section_title(title);
                    heading.set_margin_top(if index == 0 { 0 } else { 14 });
                    rows.append(&heading);
                    for pane in panes.iter().copied() {
                        rows.append(&sidebar_row(
                            pane.title(),
                            RowExtras {
                                icon: Some(pane.icon()),
                                selected: page == Page::Settings(pane),
                                badge: (pane == Pane::About && update).then_some("Update"),
                                ..RowExtras::default()
                            },
                            self.on(move |app| app.go(Page::Settings(pane))),
                        ));
                    }
                }
            }
        }
    }

    /// The page's title, the sidebar filter narrowing it, and its subtitle.
    pub fn page_title(&self) -> (&'static str, Option<String>, &'static str) {
        let page = self.page();
        let scope = self.with_state(|state| match page {
            Page::Agents if state.agent_scope != AgentScope::All => {
                Some(state.agent_scope.title().to_string())
            }
            Page::Team => match &state.team_pick {
                TeamPick::Everyone => None,
                TeamPick::Unowned => Some("Other live agents".to_string()),
                TeamPick::Person(hash) => state
                    .people
                    .iter()
                    .find(|person| &person.identity_hash == hash)
                    .map(|person| person.name.clone()),
            },
            _ => None,
        });
        (page.title(), scope, page.subtitle())
    }

    pub fn render_topbar(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let page = self.page();
        shell.topbar.set_visible(page != Page::Sessions);
        shell.topbar_separator.set_visible(page != Page::Sessions);
        // A status refresh must not take the search field from someone
        // typing; only the same page's search keeps it, since another page
        // has its own query.
        let typing = shell
            .topbar_search
            .borrow()
            .as_ref()
            .filter(|(entry, searched)| *searched == page && focused_within(entry))
            .map(|(entry, _)| (entry.text().to_string(), entry.position()));
        // Retired entries can still deliver a debounced search-changed signal.
        // Invalidate their identity before removing them from the widget tree.
        shell.topbar_search.borrow_mut().take();
        clear(&shell.topbar);
        let (title, scope, subtitle) = self.page_title();
        let words = vbox(2, &[]);
        words.set_valign(gtk::Align::Center);
        words.set_hexpand(true);
        let line = hbox(6, &[]);
        line.append(&text(title, &["page-title"]));
        if let Some(scope) = scope {
            let chevron = icon("go-next-symbolic", 9);
            chevron.add_css_class("tertiary");
            line.append(&chevron);
            line.append(&text(&scope, &["page-scope"]));
        }
        words.append(&line);
        words.append(&text(subtitle, &["page-subtitle"]).ellipsized());
        shell.topbar.append(&words);
        let actions = hbox(8, &[]);
        actions.set_valign(gtk::Align::Center);
        let search = match page {
            Page::Agents | Page::Team => {
                if self.with_state(|state| state.refreshing_relay) {
                    let spinner = gtk::Spinner::new();
                    spinner.start();
                    actions.append(&spinner);
                }
                let search = gtk::SearchEntry::new();
                search.set_placeholder_text(Some(if page == Page::Agents {
                    "Search my agents"
                } else {
                    "Search team agents"
                }));
                search.set_text(&self.with_state(|state| state.agent_search.clone()));
                let weak = self.downgrade();
                search.connect_search_changed(move |entry| {
                    if let Some(app) = weak.upgrade() {
                        app.agent_search_changed(entry);
                    }
                });
                actions.append(&search);
                actions.append(&widgets::labeled_button(
                    "Message",
                    "mail-message-new-symbolic",
                    &["primary"],
                    self.on(|app| app.show_message_composer("")),
                ));
                let more = widgets::icon_button("view-more-symbolic", "More", &["icon"], || {});
                let weak = self.downgrade();
                more.connect_clicked(move |button| {
                    if let Some(app) = weak.upgrade() {
                        app.relay_menu(button);
                    }
                });
                actions.append(&more);
                Some(search)
            }
            Page::Sessions => {
                let search = shell.pages.sessions.search.clone();
                let query = self.with_state(|state| state.session_search.clone());
                if search.text().as_str() != query {
                    shell.pages.sessions.syncing_search.set(true);
                    search.set_text(&query);
                    shell.pages.sessions.syncing_search.set(false);
                }
                Some(search)
            }
            _ => None,
        };
        if matches!(page, Page::Agents | Page::Team) {
            actions.append(&widgets::labeled_button(
                "Open Cloud",
                "external-link-symbolic",
                &["flat"],
                self.on(|app| {
                    let site = app.with_state(|state| {
                        state
                            .account()
                            .site_url
                            .unwrap_or_else(|| "https://agentrelay.com".into())
                    });
                    if let Some(url) = crate::linux_app::models::cloud_session_url(&site, "_") {
                        app.open_url(url.trim_end_matches("/_"));
                    }
                }),
            ));
        }
        shell.topbar.append(&actions);
        if let (Some(search), Some((typed, caret))) = (&search, typing) {
            // The entry reports a change after a short delay: carry over
            // what it holds, not only what it has reported.
            search.set_text(&typed);
            search.grab_focus();
            search.set_position(caret);
        }
        *shell.topbar_search.borrow_mut() = search.map(|search| (search, page));
    }

    pub fn set_session_search(&self, value: &str) {
        let changed = self.update_state(|state| {
            let changed = state.session_search != value;
            state.session_search = value.to_string();
            changed
        });
        if changed {
            if let Some(shell) = self.shell() {
                if let Some((search, Page::Sessions)) = shell.topbar_search.borrow().as_ref() {
                    if search.text().as_str() != value {
                        shell.pages.sessions.syncing_search.set(true);
                        search.set_text(value);
                        shell.pages.sessions.syncing_search.set(false);
                    }
                }
                // Commit query, chips and checks before doing any session-table work.
                self.render_session_controls(&shell.pages.sessions);
                shell.pages.sessions.schedule_search_results(self);
            }
        }
    }

    pub fn focus_search(&self) {
        if let Some(shell) = self.shell() {
            if let Some((search, page)) = shell.topbar_search.borrow().as_ref() {
                if *page == Page::Sessions {
                    shell.pages.sessions.open_search();
                }
                search.grab_focus();
            }
        }
    }

    pub(super) fn status_problems(&self) -> Vec<String> {
        self.with_state(|state| {
            let mut problems = Vec::new();
            for problem in [
                state.session_error.clone(),
                state.core_error.clone(),
                state.page_error.clone(),
                state.relay_problem(),
                state.upload_action_error.clone(),
                state
                    .status
                    .as_ref()
                    .filter(|status| status.stage == crate::relay::uploader::Stage::NeedsAttention)
                    .map(|status| {
                        status
                            .detail
                            .clone()
                            .unwrap_or_else(|| status.headline.clone())
                    }),
                state.relay_load_error.clone(),
                state.incoming_error.clone(),
            ]
            .into_iter()
            .flatten()
            .chain(state.upload_errors.values().cloned())
            {
                if !problem.is_empty() && !problems.contains(&problem) {
                    problems.push(problem);
                }
            }
            problems
        })
    }

    pub fn show_status_problems(&self, _anchor: &impl IsA<gtk::Widget>) {
        if self.with_state(|state| state.request_failure.is_some()) {
            self.open_failed_request();
        } else if !self.status_problems().is_empty() {
            self.update_state(|state| state.selected_request = None);
            if let Some(shell) = self.shell() {
                shell.settings.scroller.vadjustment().set_value(0.0);
            }
            self.go(Page::Settings(Pane::Diagnostics));
        } else {
            self.open_section(Section::Mine);
        }
    }

    pub fn render_status_bar(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let upgrade = self.with_state(|state| state.relaycast_upgrade.clone());
        upgrade_notice::render(&shell.upgrade_notice, &shell.upgrade_text, upgrade.as_ref());
        let (status, color, paused, checked, on_relay) = self.with_state(|state| {
            (
                state.upload_status_text(),
                state.upload_status_color(),
                state.is_paused(),
                state.status.is_some(),
                state
                    .local_sessions
                    .iter()
                    .filter(|session| session.live && session.registration.is_some())
                    .count(),
            )
        });
        let failure = self.with_state(|state| state.request_failure.clone());
        let problems = self.status_problems();
        let label = failure
            .as_ref()
            .map(crate::relay::request_log::RequestEntry::failure_summary)
            .unwrap_or_else(|| {
                if problems.is_empty() {
                    status
                } else {
                    "Needs attention".into()
                }
            });
        shell.status_text.set_text(&label);
        shell.status_dot.set(
            Some(if failure.is_some() || !problems.is_empty() {
                widgets::Color::Orange
            } else {
                color
            }),
            true,
        );
        shell.pause_button.set_child(Some(&icon(
            if paused {
                "media-playback-start-symbolic"
            } else {
                "media-playback-pause-symbolic"
            },
            // The Mac's 9-point glyph in a 22-point square.
            10,
        )));
        let tip = if paused {
            "Resume messages and uploads"
        } else {
            "Pause messages and uploads"
        };
        shell.pause_button.set_tooltip_text(Some(tip));
        widgets::name(&shell.pause_button, tip);
        shell.pause_button.set_sensitive(checked);
        shell
            .relay_count_text
            .set_text(&format!("Live Agents on Relay: {on_relay}"));
    }

    fn person(&self) -> (String, Option<String>, Option<String>) {
        self.with_state(|state| {
            let person = state.account().person.unwrap_or_default();
            let email = person.email.filter(|email| !email.is_empty());
            let name = person
                .name
                .filter(|name| !name.is_empty())
                .or(email.clone())
                .unwrap_or_else(|| "Signed in".into());
            (name, email, person.avatar_url)
        })
    }

    fn render_account_button(&self, shell: &Shell) {
        let (name, email, avatar_url) = self.person();
        let dot = Dot::colored(9, self.with_state(|state| state.connection().color));
        let account = self.with_state(|state| state.account());
        if account.workspace_count.unwrap_or(0) > 1 {
            let stack = gtk::Fixed::new();
            stack.set_size_request(40, 40);
            stack.set_widget_name("workspace-avatar-stack");
            let workspace = avatar(
                &self.with_state(|state| state.workspace_name()),
                account.workspace_avatar_url.as_deref(),
                26,
            );
            workspace.add_css_class("workspace-avatar-picture");
            stack.put(&workspace, 0.0, 0.0);
            let user = with_dot(&avatar(&name, avatar_url.as_deref(), 28), &dot);
            user.add_css_class("stacked-user-avatar");
            stack.put(&user, 12.0, 12.0);
            stack.set_halign(gtk::Align::Center);
            stack.set_valign(gtk::Align::Center);
            shell.account_button.set_child(Some(&stack));
        } else {
            let user = with_dot(&avatar(&name, avatar_url.as_deref(), 30), &dot);
            user.set_halign(gtk::Align::Center);
            user.set_valign(gtk::Align::Center);
            shell.account_button.set_child(Some(&user));
        }
        let email = email.unwrap_or_else(|| "Signed in".into());
        shell
            .account_button
            .set_tooltip_text(Some(&format!("Signed in as {email}")));
        widgets::name(
            &shell.account_button,
            &format!("Account: signed in as {email}"),
        );
    }

    fn show_account_menu(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        let (name, email, avatar_url) = self.person();
        let has_name = self.with_state(|state| {
            state
                .account()
                .person
                .and_then(|person| person.name)
                .is_some_and(|name| !name.is_empty())
        });
        let popover = gtk::Popover::new();
        popover.set_parent(&shell.account_button);
        popover.set_position(gtk::PositionType::Bottom);
        let content = vbox(6, &[]);
        widgets::pad(&content, 14, None, None);
        content.set_size_request(270, -1);
        let who = hbox(10, &[]);
        who.append(&avatar(&name, avatar_url.as_deref(), 34));
        let words = vbox(2, &[]);
        if has_name {
            words.append(&text(&name, &["settings-row-title"]));
        }
        // Plain secondary text, as on the Mac: still selectable with the
        // mouse to copy, but never focused, so opening the menu does not
        // select it.
        let email_label = text(email.as_deref().unwrap_or("Signed in"), &["caption"]).copyable();
        email_label.set_widget_name("account-email");
        email_label.set_focusable(false);
        email_label.set_focus_on_click(false);
        words.append(&email_label);
        who.append(&words);
        content.append(&who);
        let (connection, workspace) =
            self.with_state(|state| (state.connection(), state.workspace_name()));
        let line = hbox(6, &[]);
        line.append(&Dot::colored(6, connection.color).widget);
        let words = text(
            &if connection.healthy {
                format!("Signed in · {workspace}")
            } else {
                connection.help
            },
            &["caption"],
        )
        .wrapped();
        words.set_hexpand(true);
        line.append(&words);
        content.append(&line);
        content.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        if self.with_state(|state| state.account().workspace_count.unwrap_or(0) > 1) {
            let weak = popover.downgrade();
            let run = self.on(App::confirm_workspace_sign_out);
            content.append(&widgets::labeled_button(
                "Switch workspace…",
                "view-grid-symbolic",
                &["flat"],
                move || {
                    if let Some(popover) = weak.upgrade() {
                        popover.popdown();
                    }
                    run();
                },
            ));
            content.append(&gtk::Separator::new(gtk::Orientation::Horizontal));
        }
        if self.with_state(|state| state.update_available()) {
            let weak = popover.downgrade();
            let open = self.on(|app| app.go(Page::Settings(Pane::About)));
            content.append(&widgets::labeled_button(
                "Update available",
                "software-update-available-symbolic",
                &["flat"],
                move || {
                    if let Some(popover) = weak.upgrade() {
                        popover.popdown();
                    }
                    open();
                },
            ));
        }
        let actions: [(&str, &str, &str, Action); 2] = [
            ("Settings…", "emblem-system-symbolic", "", |app| {
                app.go(Page::Settings(Pane::General))
            }),
            (
                "Log out…",
                "system-log-out-symbolic",
                "destructive",
                App::confirm_logout,
            ),
        ];
        let mut settings_item = None;
        for (title, icon_name, class, run) in actions {
            let run = self.on(run);
            let weak = popover.downgrade();
            let item = widgets::labeled_button(title, icon_name, &["flat", class], move || {
                if let Some(popover) = weak.upgrade() {
                    popover.popdown();
                }
                run();
            });
            if let Some(child) = item.child() {
                child.set_halign(gtk::Align::Start);
            }
            content.append(&item);
            settings_item.get_or_insert_with(|| item.clone());
        }
        popover.set_child(Some(&content));
        widgets::unparent_when_closed(&popover);
        popover.popup();
        // The first command takes the focus, never the email above it.
        if let Some(item) = settings_item {
            item.grab_focus();
        }
    }
}
