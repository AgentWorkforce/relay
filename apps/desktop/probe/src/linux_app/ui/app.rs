//! The application: lifecycle, core events, sign-in, links, the tray and
//! dialogs, laid out like the Mac app (`docs/workspace-layout.md`).
//!
//! Everything it shows comes from the core: the `status` snapshot and
//! events, and the results of contract methods. Every action is a contract
//! method. The app itself only draws, opens links and notifications, copies
//! to the clipboard, and manages its own systemd user service and updates.

use super::desktop::{Answer, Confirmation, Desktop};

mod connection;
use super::shell::Shell;
use super::state::{Page, Pane, PendingConnect, State, View, ViewKey};
use super::theme::{Styling, Theme};
use super::tray::Tray;
use super::widgets::{self, hbox, text, vbox, LabelStyle};
use crate::linux_app::bridge::{Bridge, BridgeEvent, BridgeOptions, CoreError};
use crate::linux_app::install::InstallKind;
use crate::linux_app::models::{
    diagnostics_report, inbound_default_offer, sign_in_detail, sign_in_heading, InboundOffer,
    INBOUND_DEFAULT_PREF, STARTUP_TIMEOUT_MESSAGE, STARTUP_TITLE,
};
use crate::linux_app::prefs::Preferences;
use crate::linux_app::service::UserService;
use crate::relay::account::{Flow, SignInRequest};
use crate::relay::contract::account::SignInLink;
use crate::relay::contract::agents::SettingsChange;
use crate::relay::contract::connection::CoreNotification;
use crate::relay::contract::directory::LinkParams;
use crate::relay::contract::{method, Method, NoParams};
use crate::relay::links::DeepLink;
use crate::relay::state::{AccountAction, SignInState, Status};
use crate::relay::telemetry::{
    TelemetryFailure, TelemetryOperation, TelemetryOutcome, TelemetrySurface,
};
use crate::relay::uploader::SharingMode;
use gtk::{gio, glib, prelude::*};
use gtk4 as gtk;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// The application id: the D-Bus name, the desktop entry and the
/// notifications' sender.
pub const APP_ID: &str = "com.agentrelay.desktop";
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const FIRST_UPDATE_CHECK: Duration = Duration::from_secs(20);
const UPDATE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// Something the app does, run by name: a read run again, an action.
pub type Action = fn(&App);

/// What the app is built from.
pub struct Options {
    pub bridge: BridgeOptions,
    /// Where the bridge, the tray and blocking work run.
    pub runtime: tokio::runtime::Handle,
    pub prefs: Preferences,
    pub service: Arc<dyn UserService>,
    pub desktop: Rc<dyn Desktop>,
    pub tray: Box<dyn Tray>,
    pub install_kind: InstallKind,
    /// Capy is used on this computer: Sessions offers to set it up.
    pub capy_installed: bool,
    /// The window the app draws in; it is never destroyed, only hidden.
    pub window: gtk::Window,
}

pub(super) struct Inner {
    pub(super) state: RefCell<State>,
    pub(super) bridge: Bridge,
    pub(super) runtime: tokio::runtime::Handle,
    pub(super) prefs: RefCell<Preferences>,
    pub(super) service: Arc<dyn UserService>,
    pub(super) desktop: Rc<dyn Desktop>,
    pub(super) capy_installed: bool,
    pub(super) tray: Box<dyn Tray>,
    pub(super) styling: Styling,
    pub(super) window: gtk::Window,
    /// The signed-in shell, while the connected view shows.
    pub(super) shell: RefCell<Option<Rc<Shell>>>,
    /// The sign-in progress screen's heading, detail, code and browser
    /// button.
    signing: RefCell<Option<(gtk::Label, gtk::Label, gtk::Label, gtk::Button)>>,
    /// Reads in flight by name, each with the ticket of the call that owns
    /// the entry, and the read to run again once each ends.
    in_flight: RefCell<HashMap<&'static str, u64>>,
    next_ticket: Cell<u64>,
    rerun: RefCell<HashMap<&'static str, Action>>,
    pub(super) incoming_changes: Cell<usize>,
    pub(super) claude_delivery_changes: Cell<usize>,
    /// Settings are being drawn: switches set while drawing change nothing.
    pub(super) updating: Cell<bool>,
    timers_started: Cell<bool>,
    pub(super) search_telemetry: RefCell<HashMap<TelemetrySurface, glib::SourceId>>,
}

/// The app. Cheap to clone; every clone is the same app. Lives on the GTK
/// main thread.
#[derive(Clone)]
pub struct App {
    pub(super) inner: Rc<Inner>,
}

/// An [`App`] a callback holds without keeping it alive.
#[derive(Clone)]
pub struct WeakApp(Weak<Inner>);

impl WeakApp {
    pub fn upgrade(&self) -> Option<App> {
        self.0.upgrade().map(|inner| App { inner })
    }
}

impl App {
    /// Builds the app and starts following the core.
    pub fn new(options: Options) -> App {
        let (bridge, events) = Bridge::start(options.bridge, &options.runtime);
        let styling = Styling::start(options.prefs.appearance());
        let app = App {
            inner: Rc::new(Inner {
                state: RefCell::new(State::new(options.install_kind)),
                bridge,
                runtime: options.runtime,
                prefs: RefCell::new(options.prefs),
                service: options.service,
                desktop: options.desktop,
                capy_installed: options.capy_installed,
                tray: options.tray,
                styling,
                window: options.window,
                shell: RefCell::new(None),
                signing: RefCell::new(None),
                in_flight: RefCell::default(),
                next_ticket: Cell::new(0),
                rerun: RefCell::default(),
                incoming_changes: Cell::new(0),
                claude_delivery_changes: Cell::new(0),
                updating: Cell::new(false),
                timers_started: Cell::new(false),
                search_telemetry: RefCell::default(),
            }),
        };
        let weak = app.downgrade();
        app.inner.styling.on_change(move |theme| {
            if let Some(app) = weak.upgrade() {
                app.theme_changed(theme);
            }
        });
        app.theme_changed(app.inner.styling.theme());
        app.inner.window.set_title(Some("Agent Relay"));
        app.inner.window.set_default_size(
            crate::linux_app::models::DEFAULT_WINDOW_WIDTH,
            crate::linux_app::models::DEFAULT_WINDOW_HEIGHT,
        );
        app.inner.window.set_size_request(980, 650);
        app.inner.window.set_hide_on_close(true);
        app.follow(events);
        app.render();
        app.refresh_service();
        app
    }

    pub fn downgrade(&self) -> WeakApp {
        WeakApp(Rc::downgrade(&self.inner))
    }

    /// A callback that runs `action` on the app while it lives.
    pub(super) fn on(&self, action: impl Fn(&App) + 'static) -> impl Fn() + 'static {
        let weak = self.downgrade();
        move || {
            if let Some(app) = weak.upgrade() {
                action(&app);
            }
        }
    }

    // What tests and the shell read.

    pub fn window(&self) -> &gtk::Window {
        &self.inner.window
    }

    pub fn bridge(&self) -> &Bridge {
        &self.inner.bridge
    }

    /// Reads the window's state.
    pub fn with_state<T>(&self, read: impl FnOnce(&State) -> T) -> T {
        read(&self.inner.state.borrow())
    }

    pub fn view(&self) -> Option<View> {
        self.with_state(|state| state.view)
    }

    pub fn page(&self) -> Page {
        self.with_state(|state| state.page)
    }

    /// The signed-in shell, while it shows.
    pub fn shell(&self) -> Option<Rc<Shell>> {
        self.inner.shell.borrow().clone()
    }

    pub fn styling(&self) -> &Styling {
        &self.inner.styling
    }

    pub fn prefs(&self) -> std::cell::Ref<'_, Preferences> {
        self.inner.prefs.borrow()
    }

    /// The reads in flight, by name.
    pub fn in_flight(&self) -> HashSet<&'static str> {
        self.inner.in_flight.borrow().keys().copied().collect()
    }

    // Lifecycle.

    // The command line of this instance or a later launch: `ui::launch`.

    pub fn activate(&self) {
        if !self.with_state(|state| state.background_requested) {
            self.show_window();
        }
        if !self.inner.timers_started.replace(true) {
            self.start_timers();
        }
    }

    fn start_timers(&self) {
        let weak = self.downgrade();
        glib::timeout_add_local(POLL_INTERVAL, move || match weak.upgrade() {
            Some(app) => {
                app.poll();
                glib::ControlFlow::Continue
            }
            None => glib::ControlFlow::Break,
        });
        // Both follow the preference when they fire, so turning it on or
        // off takes effect without a restart.
        glib::timeout_add_local_once(FIRST_UPDATE_CHECK, self.on(|app| app.check_updates(false)));
        let weak = self.downgrade();
        glib::timeout_add_local(UPDATE_INTERVAL, move || match weak.upgrade() {
            Some(app) => {
                app.check_updates(false);
                glib::ControlFlow::Continue
            }
            None => glib::ControlFlow::Break,
        });
    }

    /// Stops following the core. The core keeps agents connected after
    /// the app quits unless the person turned that off.
    pub fn shutdown(&self) {
        let keep_core = self.prefs().keeps_agents_connected_after_quit();
        self.inner
            .runtime
            .block_on(self.inner.bridge.quit(keep_core));
    }

    /// The actions the tray, notifications and keyboard shortcuts reach.
    pub fn install_actions(&self, application: &gtk::Application) {
        let simple: [(&str, Action); 13] = [
            ("show", |app| app.show_window()),
            ("agents", |app| app.go(Page::Sessions)),
            ("sessions", |app| app.go(Page::Sessions)),
            ("settings", |app| app.go(Page::Settings(Pane::General))),
            ("account", |app| app.go(Page::Settings(Pane::Account))),
            ("pause", |app| app.set_paused(true)),
            ("resume", |app| app.set_paused(false)),
            ("refresh", |app| app.refresh_page()),
            ("find", |app| app.focus_search()),
            ("message", |app| app.show_message_composer("")),
            ("check-updates", |app| app.check_updates(true)),
            ("sign-in", |app| app.sign_in(false, None)),
            ("quit", |app| app.quit()),
        ];
        for (name, run) in simple {
            let action = gio::SimpleAction::new(name, None);
            let run = self.on(run);
            action.connect_activate(move |_, _| run());
            application.add_action(&action);
        }
        let open_link = gio::SimpleAction::new("open-link", Some(glib::VariantTy::STRING));
        let weak = self.downgrade();
        open_link.connect_activate(move |_, value| {
            if let (Some(app), Some(url)) = (weak.upgrade(), value.and_then(|value| value.str())) {
                app.open_url(url);
            }
        });
        application.add_action(&open_link);
        for (action, accels) in [
            ("app.refresh", "<Control>r"),
            ("app.find", "<Control>f"),
            ("app.settings", "<Control>comma"),
            ("app.message", "<Control>n"),
            ("app.quit", "<Control>q"),
        ] {
            application.set_accels_for_action(action, &[accels]);
        }
    }

    pub fn quit(&self) {
        self.inner.desktop.quit();
    }

    pub fn show_window(&self) {
        self.update_state(|state| state.background_requested = false);
        self.inner.window.present();
    }

    fn theme_changed(&self, theme: Theme) {
        let palette = match theme {
            Theme::Light => &super::theme::LIGHT,
            Theme::Dark => &super::theme::DARK,
        };
        widgets::set_palette(palette);
        // Marks are drawn in the theme's colors when built: rebuild what
        // shows them.
        if self.with_state(|state| state.connected()) {
            self.render_page();
            if let Some(shell) = self.shell() {
                shell
                    .sessions_button
                    .set_child(Some(&widgets::header_brand()));
            }
        }
    }

    // Calls.

    /// Calls `M` on the core; `done` runs on the main thread with the
    /// answer.
    pub(super) fn call<M>(
        &self,
        params: M::Params,
        done: impl FnOnce(&App, Result<M::Result, CoreError>) + 'static,
    ) where
        M: Method + 'static,
        M::Params: Send + 'static,
        M::Result: Send + 'static,
    {
        let bridge = self.inner.bridge.clone();
        let answer = self
            .inner
            .runtime
            .spawn(async move { bridge.call::<M>(params).await });
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            let result = answer
                .await
                .unwrap_or_else(|_| Err(CoreError::unavailable()));
            if let Some(app) = weak.upgrade() {
                done(&app, result);
            }
        });
    }

    /// Calls `M` for the account view shown now. An answer that arrives
    /// after that view is gone is dropped, so nothing it would start (a
    /// refresh, an error) lands in the next account's view.
    pub(super) fn view_call<M>(
        &self,
        params: M::Params,
        done: impl FnOnce(&App, Result<M::Result, CoreError>) + 'static,
    ) where
        M: Method + 'static,
        M::Params: Send + 'static,
        M::Result: Send + 'static,
    {
        let generation = self.with_state(|state| state.generation);
        self.call::<M>(params, move |app, result| {
            if app.with_state(|state| state.generation) == generation {
                done(app, result);
            }
        });
    }

    /// Calls `M` as the read named `name`; asked again while it is in
    /// flight, `again` runs once that answer arrives, since the core may
    /// have changed the listing after the first read began.
    pub(super) fn once<M>(
        &self,
        name: &'static str,
        params: M::Params,
        again: Action,
        done: impl FnOnce(&App, Result<M::Result, CoreError>) + 'static,
    ) where
        M: Method + 'static,
        M::Params: Send + 'static,
        M::Result: Send + 'static,
    {
        if !self.inner.bridge.offers(M::NAME) {
            return;
        }
        if self.inner.in_flight.borrow().contains_key(name) {
            self.inner.rerun.borrow_mut().insert(name, again);
            return;
        }
        // The read ends and any re-read asked for runs whatever the view
        // did meanwhile; only the answer's use belongs to the view that
        // asked. A view change mid-read used to leave the name in flight
        // for good, so no later read of it ever started. The entry belongs
        // to this call by ticket: a read that outlives a newer one of its
        // name never ends the newer one, or takes its re-read.
        let ticket = self.inner.next_ticket.get() + 1;
        self.inner.next_ticket.set(ticket);
        self.inner.in_flight.borrow_mut().insert(name, ticket);
        let generation = self.with_state(|state| state.generation);
        self.call::<M>(params, move |app, result| {
            let owns = app.inner.in_flight.borrow().get(name) == Some(&ticket);
            if owns {
                app.inner.in_flight.borrow_mut().remove(name);
            }
            if app.with_state(|state| state.generation) == generation {
                done(app, result);
            }
            if owns {
                let follow_up = app.inner.rerun.borrow_mut().remove(name);
                if let Some(follow_up) = follow_up {
                    follow_up(app);
                }
            }
        });
    }

    /// Runs blocking `work` off the main thread; `done` gets its answer on
    /// it.
    pub(super) fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
        done: impl FnOnce(&App, T) + 'static,
    ) {
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            let Ok(value) = gio::spawn_blocking(work).await else {
                return;
            };
            if let Some(app) = weak.upgrade() {
                done(&app, value);
            }
        });
    }

    pub(super) fn confirm(&self, confirmation: Confirmation) -> Answer {
        self.inner.desktop.confirm(&self.inner.window, confirmation)
    }

    // The core.

    fn follow(&self, mut events: mpsc::Receiver<BridgeEvent>) {
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            while let Some(event) = events.recv().await {
                let Some(app) = weak.upgrade() else {
                    return;
                };
                app.on_event(event);
            }
        });
    }

    fn on_event(&self, event: BridgeEvent) {
        match event {
            BridgeEvent::Connected => self.on_connection(true, None),
            BridgeEvent::Disconnected { error } => self.on_connection(false, error),
            BridgeEvent::Status(snapshot) => self.on_status(*snapshot),
            // A delivery: Recent Messages reads the log again.
            BridgeEvent::Activity(_) => {
                if self.with_state(|state| state.connected()) {
                    self.refresh_activity();
                }
            }
            BridgeEvent::Invalidated(invalidation) => self.invalidated(invalidation.what),
            BridgeEvent::Notify(notification) => self.notify(&notification),
            BridgeEvent::SignIn(report) => self.sign_in_link(report.link),
        }
    }

    /// A snapshot newer than any before.
    pub fn on_status(&self, snapshot: Status) {
        let (before, first, renewed) = self.update_state(|state| {
            let previous_account = state.account();
            let before = state
                .snapshot
                .as_ref()
                .map(|snapshot| snapshot.account.state);
            state.snapshot = Some(snapshot);
            state.core_connected = true;
            let renewed = state.settle_renewal(before);
            let first = !std::mem::replace(&mut state.launch_recorded, true);
            let account = state.account();
            if previous_account.workspace_id != account.workspace_id
                || previous_account.person.as_ref().map(|person| &person.id)
                    != account.person.as_ref().map(|person| &person.id)
                || (account.state == SignInState::SignedOut
                    && before != Some(SignInState::SignedOut))
            {
                state.relaycast_upgrade = None;
                state.last_relaycast_upgrade_at = None;
                state.request_identity_revision = state.request_identity_revision.wrapping_add(1);
                state.request_identity_started_at_ms =
                    chrono::Utc::now().timestamp_millis().max(0) as u64;
            }
            match account.state {
                SignInState::Denied | SignInState::Expired | SignInState::Error => {
                    state.sign_in_error = account.error.clone();
                }
                SignInState::SignedOut => {}
                _ => state.sign_in_error = None,
            }
            if account.state != SignInState::PendingApproval && !state.connecting_workspace() {
                state.sign_in_link = None;
            }
            if state.connect_requested && state.has_workspace() {
                state.connect_requested = false;
            }
            if state.starting_sign_in
                && (Some(account.state) != state.sign_in_from || state.sign_in_answered)
            {
                // The snapshot shows where the attempt stands; its state
                // guards from here.
                state.starting_sign_in = false;
            }
            if state.signing_out && state.sign_out_answered && !state.account_present() {
                state.signing_out = false;
            }
            (before, first, renewed)
        });
        if first {
            self.record(
                TelemetryOperation::AppLaunch,
                TelemetryOutcome::Started,
                None,
            );
            self.load_settings();
        }
        self.render();
        if self.with_state(|state| state.connected()) {
            // A renewal approved in the browser keeps the page it began on.
            if !renewed
                && before.is_some_and(State::signing_in)
                && self.with_state(|state| state.account_state()) == SignInState::SignedIn
            {
                self.go(Page::Sessions);
            }
            if renewed {
                // The connected view is kept, so `render` rebuilt nothing:
                // redraw the cards, which read their overviews again.
                self.relay_changed();
            }
            self.render_chrome();
            if matches!(self.page(), Page::Settings(_)) && !self.inner.updating.get() {
                self.render_settings();
            }
        }
        let links = self.update_state(|state| std::mem::take(&mut state.pending_links));
        for url in links {
            self.open_link(&url);
        }
    }

    fn invalidated(&self, what: crate::relay::state::Listing) {
        use crate::relay::state::Listing;
        if !self.with_state(|state| state.connected()) {
            return;
        }
        match what {
            Listing::Uploader => {
                let sessions = self.page() == Page::Sessions;
                self.refresh_uploader(sessions);
            }
            Listing::Sessions => self.refresh_local(),
            Listing::Agents => {
                self.refresh_agents();
                self.refresh_local();
            }
            Listing::Fleet => self.refresh_fleet(),
            Listing::Roster | Listing::People => self.refresh_people(),
            Listing::Incoming => self.refresh_incoming(),
            // An agent changed a setting (`PATCH /settings`).
            Listing::Settings => self.load_settings(),
            Listing::Activity => {
                self.refresh_activity();
                self.refresh_claude_delivery();
            }
            Listing::Messages => self.refresh_chats(),
            // Skip chat and projects are not read by this window.
            Listing::Chat | Listing::Projects => {}
        }
        // A session, worker or reply changing can change whether a followed
        // conversation's recipient runs and what became of its message.
        if matches!(
            what,
            Listing::Sessions | Listing::Fleet | Listing::Roster | Listing::Messages
        ) {
            self.follow_recipients();
        }
    }

    pub fn notify(&self, notification: &CoreNotification) {
        self.inner.desktop.notify(notification);
    }

    /// A link from a notification: the app's own links are parsed by the
    /// core; web links open in the browser.
    pub fn open_url(&self, url: &str) {
        if url.starts_with("agentrelay://") || url.starts_with("agentrelay-dev://") {
            self.open_link(url);
        } else if web_link(url) {
            self.inner.desktop.open_uri(url);
        }
    }

    // Which screen.

    /// Shows the screen the state calls for.
    pub fn render(&self) {
        let (view, key) = self.with_state(State::view_for);
        let (previous, previous_key) =
            self.with_state(|state| (state.view, state.view_key.clone()));
        // Any other screen, the disconnect screen included, replaces the
        // account's view: what it showed and the calls it made are dropped.
        // A sign-out that fails comes back to a freshly read view.
        if previous == Some(View::Connected) && view != View::Connected {
            self.forget_account_view();
        }
        if Some(view) != previous || key != previous_key {
            let entering = Some(view) != previous;
            self.update_state(|state| {
                state.view = Some(view);
                state.view_key = key.clone();
            });
            match (view, key) {
                (View::Loading, ViewKey::Loading { error }) => self.show_loading(error.as_deref()),
                (View::Loading, _) => self.show_loading(None),
                (View::SigningOut, _) => {
                    self.show_progress(
                        "Disconnecting this computer…",
                        "Uploads are stopping safely.",
                        false,
                    );
                }
                (View::SigningIn, _) => self.show_signing_in(),
                (View::ChoosingWorkspace, _) => self.show_workspace_picker(),
                (View::SignIn, _) => {
                    self.show_sign_in();
                    if entering {
                        self.refresh_preview();
                    }
                }
                (View::Connected, _) => {
                    if entering {
                        self.show_connected();
                        self.refresh_all();
                    }
                }
            }
        }
        if view == View::SigningIn {
            self.update_signing_in();
        }
        self.update_tray();
    }

    fn replace(&self, content: &impl IsA<gtk::Widget>) {
        self.inner.signing.borrow_mut().take();
        // The window decoration follows the welcome split (theme.rs).
        if content.has_css_class("welcome") {
            self.inner.window.add_css_class("welcome");
        } else {
            self.inner.window.remove_css_class("welcome");
        }
        self.inner.window.set_child(Some(content));
    }

    // Signed out: the Mac's split welcome — a dark brand panel and a quiet
    // light sign-in panel.

    fn welcome(&self, panel: &gtk::Box) -> gtk::Box {
        let root = hbox(0, &["welcome"]);
        // The brand panel and the sign-in panel share the window evenly.
        root.set_homogeneous(true);
        let splash = vbox(0, &["signin-splash"]);
        splash.set_hexpand(true);
        let brand = hbox(12, &[]);
        brand.append(&widgets::brand(34));
        brand.append(&widgets::wordmark(26));
        let middle = vbox(0, &[]);
        middle.set_vexpand(true);
        middle.set_valign(gtk::Align::Center);
        middle.append(&brand);
        let harnesses = hbox(20, &[]);
        harnesses.set_margin_top(36);
        // Windows lacks the harnesses that are Unix-only tools, so its
        // sign-in screen shows only the ones it has.
        let badges: &[&str] = if cfg!(windows) {
            &["codex", "claude", "cursor"]
        } else {
            &[
                "codex", "claude", "cursor", "opencode", "grok", "muse", "devin",
            ]
        };
        for source in badges.iter().copied() {
            let tint = if source == "muse" {
                "#4091ff"
            } else {
                "#ffffff"
            };
            let badge = widgets::agent_badge_with_tint(source, 40, Some(tint));
            badge.add_css_class("harness");
            harnesses.append(&badge);
        }
        middle.append(&harnesses);
        splash.append(&middle);
        root.append(&splash);
        let surface = vbox(0, &["signin-panel"]);
        surface.set_hexpand(true);
        panel.set_valign(gtk::Align::Center);
        panel.set_halign(gtk::Align::Center);
        panel.set_vexpand(true);
        panel.set_size_request(360, -1);
        widgets::pad(panel, 40, None, None);
        surface.append(panel);
        let site = self.with_state(|state| state.account().site_url);
        if let Some(site) = site.filter(|site| !site.contains("agentrelay.com")) {
            let dev = text("Development", &["secondary"]).centered();
            dev.set_tooltip_text(Some(&site));
            dev.set_margin_bottom(20);
            surface.append(&dev);
        }
        root.append(&surface);
        root
    }

    fn show_progress(&self, heading: &str, detail: &str, cancel: bool) {
        let panel = vbox(24, &[]);
        panel.append(&widgets::loading_bars());
        let heading_label = text(heading, &["signin-title"]).wrapped().centered();
        let detail_label = text(detail, &["secondary", "signin-subtitle"])
            .wrapped()
            .centered();
        let code_label = text("", &["settings-row-title"]).centered().copyable();
        panel.append(&heading_label);
        panel.append(&detail_label);
        panel.append(&code_label);
        let open_browser = widgets::button(
            "Open browser",
            &["primary"],
            self.on(App::open_approval_again),
        );
        if cancel {
            let actions = hbox(10, &[]);
            actions.set_homogeneous(true);
            actions.append(&widgets::button(
                "Cancel",
                &[],
                self.on(App::cancel_sign_in),
            ));
            actions.append(&open_browser);
            panel.append(&actions);
        }
        self.replace(&self.welcome(&panel));
        *self.inner.signing.borrow_mut() =
            cancel.then_some((heading_label, detail_label, code_label, open_browser));
    }

    fn show_loading(&self, error: Option<&str>) {
        let panel = vbox(24, &[]);
        match error {
            Some(error) => {
                panel.append(&text("Let’s get you connected.", &["signin-title"]).wrapped());
                panel.append(&text(error, &["secondary", "signin-subtitle"]).wrapped());
                panel.append(&widgets::labeled_button(
                    "Try again",
                    "view-refresh-symbolic",
                    &["primary"],
                    self.on(App::retry_core),
                ));
                let copy = widgets::button(
                    "Copy diagnostics",
                    &["link"],
                    self.on(|app| {
                        widgets::copy_to_clipboard(&diagnostics_report(&app.diagnostics()))
                    }),
                );
                copy.set_halign(gtk::Align::Start);
                panel.append(&copy);
            }
            None => {
                let heading = hbox(12, &[]);
                let reconnecting = self.with_state(|state| state.launch_recorded);
                heading.append(&text(
                    if reconnecting {
                        "Reconnecting"
                    } else {
                        STARTUP_TITLE
                    },
                    &["signin-title"],
                ));
                let bars = widgets::loading_bars_scaled(0.5);
                bars.set_hexpand(true);
                bars.set_halign(gtk::Align::End);
                bars.set_valign(gtk::Align::Center);
                heading.append(&bars);
                panel.append(&heading);
                super::startup_detail::add(&panel, reconnecting);
                let weak_panel = panel.downgrade();
                glib::timeout_add_local_once(
                    Duration::from_secs(20),
                    self.on(move |app| {
                        // A replaced panel is a different attempt. Its timer must
                        // not overwrite a later retry, error, or ready screen.
                        if weak_panel
                            .upgrade()
                            .is_some_and(|panel| panel.root().is_some())
                            && app.with_state(|state| {
                                state.snapshot.is_none() && state.core_error.is_none()
                            })
                        {
                            app.update_state(|state| {
                                state.core_error = Some(STARTUP_TIMEOUT_MESSAGE.into())
                            });
                            app.render();
                        }
                    }),
                );
            }
        }
        self.replace(&self.welcome(&panel));
    }

    fn retry_core(&self) {
        self.update_state(|state| state.core_error = None);
        self.show_loading(None);
        let service = self.inner.service.clone();
        self.blocking(move || service.start(), |app, _| app.inner.bridge.restart());
    }

    fn refresh_preview(&self) {
        if !self
            .inner
            .bridge
            .offers(method::UploaderSessionsPreview::NAME)
        {
            return;
        }
        let params = crate::relay::contract::account::PreviewParams {
            limit: None,
            refresh: false,
        };
        self.call::<method::UploaderSessionsPreview>(params, |app, result| {
            let count = result.map(|preview| preview.sessions.len()).unwrap_or(0);
            app.update_state(|state| state.preview_count = count);
        });
    }

    /// The sign-in screen.
    pub fn show_sign_in(&self) {
        let (account, error, starting) = self.with_state(|state| {
            let account = state.account();
            let error = state.sign_in_error.clone().or(account.error.clone());
            (account, error, state.starting_sign_in)
        });
        let panel = vbox(28, &[]);
        panel.append(&text("Get your agents on the relay", &["signin-title"]).wrapped());
        let google = gtk::Button::new();
        crate::linux_app::ui::widgets::action_cursor(&google);
        google.add_css_class("google");
        let content = hbox(12, &[]);
        content.set_halign(gtk::Align::Center);
        content.append(&google_glyph(18));
        content.append(&gtk::Label::new(Some("Sign in with Google")));
        google.set_child(Some(&content));
        widgets::name(&google, "Sign in with Google");
        google.set_sensitive(self.inner.bridge.offers(method::AccountSignIn::NAME) && !starting);
        let sign_in = self.on(|app| app.sign_in(false, None));
        google.connect_clicked(move |_| sign_in());
        panel.append(&google);
        if account.action == Some(AccountAction::AcknowledgeUninspectedSchedules) {
            let anyway = widgets::button(
                "Continue anyway",
                &[],
                self.on(|app| app.sign_in(true, None)),
            );
            anyway.set_tooltip_text(Some(
                "Sign in although an earlier uploader's schedules could not be checked",
            ));
            anyway.set_sensitive(!starting);
            panel.append(&anyway);
        }
        if let Some(error) = error {
            panel.append(&text(&error, &["error"]).wrapped());
        }
        self.replace(&self.welcome(&panel));
    }

    /// Opens the browser account chooser, sharing only the sessions chosen in
    /// My sessions, as the Mac does.
    pub fn sign_in(&self, acknowledge_uninspected_schedules: bool, workspace: Option<String>) {
        let account_state = self.with_state(|state| state.account_state());
        if self.with_state(|state| state.starting_sign_in)
            || State::signing_in(account_state)
            || account_state == SignInState::SignedIn
        {
            return;
        }
        let pending = self.with_state(|state| state.pending_connect.clone());
        let params = SignInRequest {
            site_url: pending.as_ref().map(|pending| pending.site_url.clone()),
            workspace: pending
                .as_ref()
                .map(|pending| pending.workspace_id.clone())
                .or(workspace),
            sharing: SharingMode::Selected,
            acknowledge_uninspected_schedules,
            flow: Some(Flow::Browser),
        };
        self.apply_inbound_default();
        let request = self.update_state(|state| {
            state.sign_in_error = None;
            state.sign_in_link = None;
            state.sign_in_requests += 1;
            state.starting_sign_in = true;
            state.sign_in_answered = false;
            state.sign_in_from = Some(account_state);
            state.sign_in_requests
        });
        self.render();
        self.call::<method::AccountSignIn>(params, move |app, result| {
            if app.with_state(|state| state.sign_in_requests) != request {
                return;
            }
            match result {
                Err(error) => {
                    app.update_state(|state| {
                        state.starting_sign_in = false;
                        state.sign_in_error = Some(error.message);
                    });
                    app.render();
                }
                Ok(report) => {
                    let started = State::signing_in(report.account.state)
                        || report.account.state == SignInState::SignedIn;
                    app.update_state(|state| {
                        state.pending_connect = None;
                        state.sign_in_answered = true;
                        if !started {
                            // The core started no attempt: nothing is left
                            // to wait for.
                            state.starting_sign_in = false;
                        }
                    });
                    if !started {
                        app.render();
                    }
                    app.sign_in_link(report.link);
                }
            }
        });
    }

    /// Signs in again in the browser while this computer stays connected:
    /// the core keeps a new session for Cloud calls such as session
    /// summaries, and uploads carry on.
    pub fn renew_sign_in(&self) {
        let start = self.update_state(|state| {
            if state.account_state() != SignInState::SignedIn || state.renew_requested {
                return false;
            }
            state.renew_requested = true;
            true
        });
        if !start {
            return;
        }
        self.relay_changed();
        let params = SignInRequest {
            site_url: None,
            workspace: None,
            sharing: SharingMode::New,
            acknowledge_uninspected_schedules: false,
            flow: Some(Flow::Browser),
        };
        self.call::<method::AccountSignIn>(params, |app, result| match result {
            Ok(report) if report.account.state == SignInState::PendingApproval => {
                app.sign_in_link(report.link);
            }
            Ok(_) => {
                // The core already holds a usable session: read again.
                app.update_state(|state| {
                    state.settle_renewal(Some(SignInState::PendingApproval));
                    state.renew_requested = false;
                });
                app.relay_changed();
            }
            Err(error) => {
                app.update_state(|state| {
                    state.renew_requested = false;
                    state.sign_in_error = Some(error.message);
                });
                app.relay_changed();
            }
        });
    }

    pub fn inbound_default_offer(&self) -> Option<InboundOffer> {
        let offered = self
            .inner
            .prefs
            .borrow()
            .get(INBOUND_DEFAULT_PREF)
            .is_some_and(crate::linux_app::truthy)
            || !self.inner.bridge.offers(method::SettingsSet::NAME);
        self.with_state(|state| inbound_default_offer(state.settings.as_ref(), offered))
    }

    /// First-run setup, once: the box checked applies the default (`accept`
    /// unless the user already chose a value; the core keeps `hold` and
    /// refuses against a managed setting), unticked turns direct delivery
    /// off (`hold`), which the core records as the user's choice.
    fn apply_inbound_default(&self) {
        match self.inbound_default_offer() {
            None => {}
            Some(InboundOffer::Managed(_)) => self.mark_inbound_offered(),
            Some(InboundOffer::Offer) => {
                let change = SettingsChange {
                    direct_delivery_default: Some(true),
                    ..SettingsChange::default()
                };
                self.call::<method::SettingsSet>(change, |app, result| {
                    // The offer is used up only once applied: a failed write
                    // (an unreadable settings file) is offered again at the
                    // next sign-in, and Settings names the failure
                    // meanwhile.
                    match result {
                        Err(error) => {
                            app.update_state(|state| state.inbound_error = Some(error.message))
                        }
                        Ok(settings) => {
                            app.mark_inbound_offered();
                            app.update_state(|state| {
                                state.inbound_error = None;
                                state.settings_read(settings);
                            });
                        }
                    }
                    app.settings_changed();
                });
            }
        }
    }

    fn mark_inbound_offered(&self) {
        // A preference that cannot be saved holds for this run.
        let _ = self
            .inner
            .prefs
            .borrow_mut()
            .set(INBOUND_DEFAULT_PREF, serde_json::Value::Bool(true));
    }

    /// A `sign_in` event (or `account.sign_in`'s answer): the link waiting
    /// for approval, opened once.
    fn sign_in_link(&self, link: SignInLink) {
        let url = link
            .verification_url_complete
            .clone()
            .or(link.verification_url.clone())
            .filter(|url| web_link(url));
        let open = self.update_state(|state| {
            if link.verification_url.is_some() {
                state.sign_in_link = Some(link);
            }
            url.filter(|url| state.opened_links.insert(url.clone()))
        });
        if let Some(url) = open {
            self.open_approval_url(&url);
        }
        self.update_signing_in();
    }

    pub fn open_approval_again(&self) {
        let url = self.with_state(|state| {
            state.sign_in_link.as_ref().and_then(|link| {
                link.verification_url_complete
                    .clone()
                    .or(link.verification_url.clone())
            })
        });
        if let Some(url) = url.filter(|url| web_link(url)) {
            self.open_approval_url(&url);
        }
    }

    fn show_workspace_picker(&self) {
        let account = self.with_state(|state| state.account());
        let panel = vbox(28, &[]);
        panel.append(&text("Choose your workspace", &["signin-title"]).wrapped());
        if let Some(email) = account.person.and_then(|person| person.email) {
            panel.append(&text(&format!("Signed in as {email}"), &["secondary"]).wrapped());
        }
        for workspace in account.workspace_choices.unwrap_or_default() {
            let label = match workspace.organization_name {
                Some(org) => format!("{} — {org}", workspace.name),
                None => workspace.name,
            };
            panel.append(&widgets::button(
                &label,
                &[],
                self.on(move |app| {
                    app.call::<method::AccountSelectWorkspace>(
                        crate::relay::contract::account::ConnectWorkspaceParams {
                            workspace_id: workspace.id.clone(),
                        },
                        |app, result| {
                            if let Err(error) = result {
                                app.show_error(&error.message);
                            }
                        },
                    );
                }),
            ));
        }
        panel.append(&widgets::button(
            "Cancel",
            &["flat"],
            self.on(App::cancel_sign_in),
        ));
        self.replace(&self.welcome(&panel));
    }

    fn show_signing_in(&self) {
        self.show_progress(
            "Continue in your browser",
            "Your browser will open to Agent Relay.",
            true,
        );
    }

    /// The sign-in progress screen's heading, detail and code.
    pub fn signing_labels(&self) -> Option<(String, String, String)> {
        self.inner
            .signing
            .borrow()
            .as_ref()
            .map(|(heading, detail, code, _)| {
                (
                    heading.text().into(),
                    detail.text().into(),
                    code.text().into(),
                )
            })
    }

    fn update_signing_in(&self) {
        if self.view() != Some(View::SigningIn) {
            return;
        }
        let Some((heading, detail, code, open_browser)) = self.inner.signing.borrow().clone()
        else {
            return;
        };
        let (account, link) = self.with_state(|state| {
            (
                state.account(),
                state.sign_in_link.clone().unwrap_or_default(),
            )
        });
        let waiting = account.state == SignInState::PendingApproval;
        heading.set_text(if waiting {
            "Continue in your browser"
        } else {
            sign_in_heading(&account)
        });
        detail.set_text(&sign_in_detail(&account, &link));
        code.set_text(
            &link
                .user_code
                .as_deref()
                .map(|code| format!("Code: {code}"))
                .unwrap_or_default(),
        );
        open_browser.set_visible(waiting);
        open_browser.set_sensitive(link.verification_url.is_some());
    }

    pub fn cancel_sign_in(&self) {
        self.update_state(|state| {
            // An `account.sign_in` answer still on its way belongs to the
            // cancelled attempt.
            state.sign_in_requests += 1;
            state.starting_sign_in = false;
            state.pending_connect = None;
            state.sign_in_error = None;
            state.sign_in_link = None;
        });
        self.call::<method::AccountSignInCancel>(NoParams {}, |_, _| {});
    }

    // Signed in.

    fn show_connected(&self) {
        let shell = Shell::build(self);
        self.replace(&shell.root);
        *self.inner.shell.borrow_mut() = Some(shell);
        self.render_chrome();
        self.render_page();
    }

    /// Draws the page shown.
    pub fn render_page(&self) {
        let Some(shell) = self.shell() else {
            return;
        };
        if !self.with_state(|state| state.connected()) {
            return;
        }
        let page = self.page();
        shell.page_stack.set_visible_child_name(page.stack_name());
        let error = self.with_state(|state| state.page_error.clone());
        shell.page_error.set_tooltip_text(error.as_deref());
        shell.page_error.set_visible(error.is_some());
        match page {
            Page::Agents => self.render_agents(),
            Page::Sessions => self.render_sessions(),
            Page::Team => self.render_team(),
            Page::Messages => self.render_messages(),
            Page::Settings(_) => self.render_settings(),
        }
    }

    pub fn refresh_page(&self) {
        match self.page() {
            Page::Sessions => {
                self.refresh_uploader(true);
                self.refresh_local();
            }
            Page::Agents | Page::Team => self.refresh_relay(),
            Page::Messages => {
                if let Some(shown) = self.shown_chat() {
                    self.refresh_chat(&shown);
                }
            }
            Page::Settings(Pane::Relay) => {
                self.load_settings();
                self.refresh_incoming();
                self.refresh_claude_delivery();
                self.refresh_local();
            }
            Page::Settings(Pane::General) => {
                self.load_settings();
                self.refresh_service();
            }
            Page::Settings(_) => self.load_settings(),
        }
    }

    fn poll(&self) {
        let ticks = self.update_state(|state| {
            state.poll_ticks = (state.poll_ticks + 1) % 6;
            state.poll_ticks
        });
        if !self.with_state(|state| state.connected()) {
            return;
        }
        let visible = self.inner.window.is_visible();
        let page = self.page();
        if visible || ticks == 0 {
            self.refresh_request_log();
            self.refresh_uploader(visible && page == Page::Sessions);
        }
        // The roster has no push: it is read every 30 s while a page shows
        // it.
        if ticks == 0 && (!visible || !matches!(page, Page::Settings(_))) {
            self.refresh_people();
        }
        if visible && ticks == 0 && page == Page::Settings(Pane::Relay) {
            self.refresh_incoming();
            self.refresh_claude_delivery();
        }
    }

    // Account.

    pub fn confirm_workspace_sign_out(&self) {
        if self.with_state(|state| state.busy || state.signing_out) {
            return;
        }
        let name = self.with_state(|state| state.workspace_name());
        let answer = self.confirm(Confirmation::new(
            "Sign out to switch workspace?",
            &format!("Uploads stop and stay tied to {name}. Sign back in to that workspace to resume without uploading existing history again."),
            "Sign out",
        ).destructive());
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            if answer.await {
                if let Some(app) = weak.upgrade() {
                    app.sign_out();
                }
            }
        });
    }

    pub fn confirm_logout(&self) {
        if self.with_state(|state| state.busy || state.signing_out) {
            return;
        }
        let answer = self.confirm(
            Confirmation::new(
                "Log out of Agent Relay?",
                "Uploads stop and you will need to sign in again to reconnect.",
                "Log out",
            )
            .destructive(),
        );
        let weak = self.downgrade();
        glib::spawn_future_local(async move {
            if answer.await {
                if let Some(app) = weak.upgrade() {
                    app.sign_out();
                }
            }
        });
    }

    fn sign_out(&self) {
        self.update_state(|state| {
            state.signing_out = true;
            state.sign_out_answered = false;
        });
        self.render();
        self.call::<method::AccountSignOut>(NoParams {}, |app, result| {
            app.update_state(|state| {
                state.sign_out_answered = true;
                state.sign_in_error = result.as_ref().err().map(|error| {
                    format!(
                        "Could not finish disconnecting. Uploads may still be running. Sign in again to retry cleanup. {}",
                        error.message
                    )
                });
                // Signed out, the disconnect screen stays until the snapshot
                // no longer shows the account, which arrives on the event
                // stream and may trail this answer.
                if result.is_err() || !state.account_present() {
                    state.signing_out = false;
                }
            });
            app.render();
        });
    }

    // Links.

    /// An `agentrelay://` link: the core parses it.
    pub fn open_link(&self, url: &str) {
        if self.with_state(|state| state.snapshot.is_none()) {
            self.update_state(|state| state.pending_links.push(url.to_string()));
            return;
        }
        let Ok(parsed) = url::Url::parse(url) else {
            self.show_error("That Agent Relay connection link is invalid.");
            return;
        };
        let mut params = LinkParams {
            url: url.to_string(),
            site_url: None,
        };
        if parsed.scheme() == "agentrelay-dev" {
            // A development link names its own site; the core checks it.
            params.site_url = parsed
                .query_pairs()
                .find(|(key, _)| key == "site")
                .map(|(_, value)| value.into_owned())
                .or_else(|| self.with_state(|state| state.account().site_url));
        }
        self.call::<method::LinksParse>(params, |app, result| match result {
            Ok(DeepLink::Message { endpoint, .. }) => {
                app.show_window();
                app.show_message_composer(&endpoint);
            }
            Ok(DeepLink::Connect {
                site_url,
                workspace_id,
                ..
            }) => app.connect_link(PendingConnect {
                site_url,
                workspace_id,
            }),
            Err(_) => {
                app.record(
                    TelemetryOperation::ConnectionLink,
                    TelemetryOutcome::Failed,
                    Some(TelemetryFailure::InvalidConnection),
                );
                app.show_error("This connection link is not for this Agent Relay app. Download the app from the same site and try again.");
            }
        });
    }

    fn connect_link(&self, link: PendingConnect) {
        let (account, signing_out) = self.with_state(|state| (state.account(), state.signing_out));
        if account.state == SignInState::SignedIn {
            let current = account.workspace_id.unwrap_or_default().to_lowercase();
            if !current.is_empty() && current != link.workspace_id.to_lowercase() {
                self.record(
                    TelemetryOperation::ConnectionLink,
                    TelemetryOutcome::Failed,
                    Some(TelemetryFailure::WorkspaceConflict),
                );
                // Going to Account clears the page's error, so the error
                // follows it.
                self.go(Page::Settings(Pane::Account));
                self.show_error("This app is connected to another account or workspace. Log out in Account before connecting a different workspace.");
            } else {
                self.record(
                    TelemetryOperation::ConnectionLink,
                    TelemetryOutcome::Succeeded,
                    None,
                );
            }
            return;
        }
        if State::signing_in(account.state) || signing_out {
            self.show_error(
                "Finish or cancel the current operation before opening another connection link.",
            );
            return;
        }
        self.record(
            TelemetryOperation::ConnectionLink,
            TelemetryOutcome::Succeeded,
            None,
        );
        self.update_state(|state| {
            state.pending_connect = Some(link);
            state.sign_in_error = None;
        });
        self.render();
        self.show_window();
    }

    // Dialogs.

    /// Says what went wrong: in the status bar in the signed-in window,
    /// else in a dialog over a shown window.
    pub fn show_error(&self, message: &str) {
        let visible = self.inner.window.is_visible();
        if visible && self.with_state(|state| state.connected()) && self.shell().is_some() {
            self.update_state(|state| state.page_error = Some(message.to_string()));
            if let Some(shell) = self.shell() {
                shell.page_error.set_tooltip_text(Some(message));
                shell.page_error.set_visible(true);
            }
        } else if visible {
            self.inner
                .desktop
                .inform(&self.inner.window, "Agent Relay hit a problem", message);
        }
    }
}

/// Whether `url` is a web page: only those go to the browser.
pub(super) fn web_link(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// A plain four-arc approximation of the Google mark: no artwork files.
fn google_glyph(size: i32) -> gtk::DrawingArea {
    let area = gtk::DrawingArea::new();
    area.set_content_width(size);
    area.set_content_height(size);
    area.set_valign(gtk::Align::Center);
    area.set_draw_func(move |_, context, _, _| {
        let size = size as f64;
        let line = size * 0.24;
        let radius = (size - line) / 2.0;
        let center = size / 2.0;
        context.set_line_width(line);
        let tau = 2.0 * std::f64::consts::PI;
        for (start, end, (red, green, blue)) in [
            (0.0, 0.16, (0.259, 0.522, 0.957)),
            (0.16, 0.45, (0.204, 0.659, 0.325)),
            (0.45, 0.66, (0.984, 0.737, 0.020)),
            (0.66, 0.95, (0.918, 0.263, 0.208)),
        ] {
            context.set_source_rgb(red, green, blue);
            context.arc(center, center, radius, start * tau, end * tau);
            let _ = context.stroke();
        }
        context.set_source_rgb(0.259, 0.522, 0.957);
        context.rectangle(center, center - line / 2.0, radius + line / 2.0, line);
        let _ = context.fill();
    });
    area
}
