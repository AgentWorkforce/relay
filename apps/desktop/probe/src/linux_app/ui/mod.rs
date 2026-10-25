//! The Linux app's GTK 4 window (`agent-relay` built with the `gtk`
//! feature): a native view of the relay core's state, laid out like the Mac
//! app.
//!
//! | Module | Owns |
//! |---|---|
//! | `app` | The application: lifecycle, core events, sign-in, links, the tray's actions, dialogs |
//! | `state` | What the window shows, as data: the screen, navigation, the core's answers |
//! | `shell` | The rail, sidebar, top bar and status bar |
//! | `relay` | The listings every surface shares, and switching sessions on the relay |
//! | `settings_page` | Every Settings pane, the background service and software updates |
//! | `pages` | The four pages' roots in the page stack, and what they keep across redraws |
//! | `agents_page` | My agents: sessions and their relay switch, details and tools, fleet workers, agents on other machines; the roster rows, overview card and banners Team reuses |
//! | `capy_spawn` | Cloud-backed Capy thread creation and first-turn binding status |
//! | `sessions_page` | My sessions: upload stages, the sessions list, uploading and stopping |
//! | `transcript` | Local conversation reader with Markdown, code, and expandable tool activity |
//! | `spawn_join` | A spawned agent's live transcript and message box, and opening its session |
//! | `spawn_take_over` | Taking a spawned Claude over: stopping it headless and resuming it in Terminal |
//! | `team_page` | Team: a card per teammate with their agents on the relay |
//! | `messages` | Messages: conversations, delivery and reply notes; Recent Messages |
//! | `widgets` | Shared rows, banners, settings rows, avatars, marks and dots |
//! | `theme` | The light and dark palettes and following the desktop's color scheme |
//! | `tray` | The tray menu, served as a StatusNotifierItem (a notification-area icon on Windows) |
//! | `desktop` | Links, notifications, dialogs and quitting |
//!
//! # Threads
//!
//! GTK owns the process's main thread, and every widget and the app's
//! [`state::State`] live there, in one `Rc<RefCell<..>>` no other thread
//! touches. The bridge and the tray run on a tokio runtime's worker threads.
//! A call is spawned on that runtime and its `JoinHandle` awaited by a
//! future on the GLib main context (`glib::spawn_future_local`); the
//! bridge's event receiver and the tray's action receiver are drained the
//! same way. tokio's handles and channels need no tokio context to be
//! awaited, so the main loop polls them directly. Blocking work
//! (`systemctl`, update downloads, avatars) runs on GLib's blocking pool
//! (`gio::spawn_blocking`) and is awaited the same way. Answers therefore
//! always land on the main thread, between GTK events.

mod agent_names;
mod agent_settings_rows;
pub mod agents_page;
pub mod app;
mod appearance_preview;
mod capy_spawn;
mod core_settings;
pub mod desktop;
mod launch;
pub mod messages;
pub mod pages;
mod relay;
mod relay_rows;
mod saved_session_views;
mod session_columns;
mod session_controls;
mod session_titles;
pub mod sessions_page;
mod settings_claude_delivery;
mod settings_claude_folders;
mod settings_incoming;
pub mod settings_page;
mod settings_spawn;
mod setup_cards;
pub mod shell;
pub mod spawn_join;
mod spawn_take_over;
mod startup_detail;
pub mod state;
pub mod team_page;
pub mod theme;
pub mod transcript;
pub mod tray;
mod upload_actions;
pub mod widgets;

pub use app::{App, Options, APP_ID};

use crate::linux_app::bridge::BridgeOptions;
use crate::linux_app::install;
use crate::linux_app::prefs::{self, Preferences};
#[cfg(windows)]
use crate::linux_app::service::LogonTask as BackgroundService;
#[cfg(not(windows))]
use crate::linux_app::service::Systemd as BackgroundService;
use gtk::{gio, glib, prelude::*};
use gtk4 as gtk;
use std::cell::RefCell;
use std::process::ExitCode;
use std::rc::Rc;
use std::sync::Arc;

/// Now, in milliseconds since the epoch.
pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Runs the window until the person quits.
pub fn run() -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("agent-relay")
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Agent Relay could not start: {error}.");
            return ExitCode::FAILURE;
        }
    };
    let application =
        gtk::Application::new(Some(APP_ID), gio::ApplicationFlags::HANDLES_COMMAND_LINE);
    let app: Rc<RefCell<Option<App>>> = Rc::default();
    // A tray app: closing the window hides it, and the app runs on. Only
    // the first instance holds itself: `startup` runs there alone, so a
    // later launch hands its command line over and exits.
    let hold: Rc<RefCell<Option<gio::ApplicationHoldGuard>>> = Rc::default();
    let handle = runtime.handle().clone();
    application.connect_startup({
        let app = app.clone();
        let hold = hold.clone();
        move |application| {
            glib::set_prgname(Some("agent-relay"));
            glib::set_application_name("Agent Relay");
            match start(application, &handle) {
                Ok(started) => {
                    *app.borrow_mut() = Some(started);
                    *hold.borrow_mut() = Some(application.hold());
                }
                Err(error) => {
                    eprintln!("Agent Relay could not start: {error}");
                    application.quit();
                }
            }
        }
    });
    application.connect_command_line({
        let app = app.clone();
        move |_, command_line| {
            let arguments: Vec<String> = command_line
                .arguments()
                .iter()
                .skip(1)
                .map(|argument| argument.to_string_lossy().into_owned())
                .collect();
            if let Some(app) = app.borrow().as_ref() {
                app.command_line(&arguments);
            }
            glib::ExitCode::SUCCESS
        }
    });
    application.connect_activate({
        let app = app.clone();
        move |_| {
            if let Some(app) = app.borrow().as_ref() {
                app.activate();
            }
        }
    });
    application.connect_shutdown({
        let app = app.clone();
        move |_| {
            if let Some(app) = app.borrow_mut().take() {
                app.shutdown();
            }
        }
    });
    #[cfg(windows)]
    allow_first_instance_to_come_forward();
    // The launch names its version and executable for an instance already
    // running: a later version takes over from an older one (`App::command_line`).
    let mut arguments: Vec<String> = std::env::args().collect();
    if let Ok(exe) = crate::linux_app::install::current_exe() {
        arguments.extend(crate::linux_app::launch::launch_arguments(
            crate::VERSION,
            &exe,
        ));
    }
    let code = application.run_with_args(&arguments);
    drop(hold.borrow_mut().take());
    drop(runtime);
    ExitCode::from(code)
}

/// Lets the first instance bring its window forward when this launch hands
/// it a command line. Windows gives the foreground only to the process the
/// person just started, so without this the first instance's `present()`
/// would flash its taskbar button instead of raising the window.
#[cfg(windows)]
fn allow_first_instance_to_come_forward() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
    // SAFETY: a plain call with a constant; failure only leaves the
    // window behind others.
    unsafe {
        AllowSetForegroundWindow(ASFW_ANY);
    }
}

fn start(application: &gtk::Application, runtime: &tokio::runtime::Handle) -> anyhow::Result<App> {
    let home = crate::relay::paths::home()?;
    let exe = install::current_exe()?;
    let service = Arc::new(BackgroundService::default());
    let bridge = BridgeOptions::standard(
        &home,
        |name| std::env::var(name).ok(),
        install::current_bundled_probe(),
        service.clone(),
    )?;
    let window = gtk::ApplicationWindow::new(application);
    // The decoration continues the global header's color (theme.rs).
    window.add_css_class("workspace");
    // The Agent Relay mark in the taskbar and window switcher. An install
    // ships it in its icon theme; a build from a checkout finds the mark in
    // the repository instead of GTK's own icon. It is a themed icon there
    // (`hicolor/scalable/apps`): GTK makes the window's icon list from the
    // sizes the theme reports, and reports none for an unthemed one.
    if let Some(display) = gtk::gdk::Display::default() {
        let icons = gtk::IconTheme::for_display(&display);
        if !icons.has_icon("agent-relay") {
            icons.add_search_path(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/resources/windows/icons/dev"
            ));
        }
    }
    window.set_icon_name(Some("agent-relay"));
    let (actions, mut chosen) = tokio::sync::mpsc::unbounded_channel();
    let tray = system_tray(runtime, actions);
    let app = App::new(Options {
        bridge,
        runtime: runtime.clone(),
        prefs: Preferences::load(prefs::default_path()?),
        service,
        desktop: Rc::new(desktop::System::new(application)),
        tray,
        install_kind: install::install_kind(&exe),
        capy_installed: crate::linux_app::capy_installed(&home),
        window: window.upcast(),
    });
    app.install_actions(application);
    let weak = app.downgrade();
    glib::spawn_future_local(async move {
        while let Some(action) = chosen.recv().await {
            match weak.upgrade() {
                Some(app) => app.tray_action(action),
                None => return,
            }
        }
    });
    Ok(app)
}

#[cfg(target_os = "linux")]
fn system_tray(
    runtime: &tokio::runtime::Handle,
    actions: tokio::sync::mpsc::UnboundedSender<tray::TrayAction>,
) -> Box<dyn tray::Tray> {
    let loader = gtk::gdk_pixbuf::PixbufLoader::new();
    loader.set_size(64, 64);
    let icon = loader
        .write(widgets::art::MARK)
        .and_then(|_| loader.close())
        .ok()
        .and_then(|_| loader.pixbuf())
        .and_then(|pixbuf| tray::pixmap(&pixbuf))
        .into_iter()
        .collect();
    Box::new(tray::StatusNotifier::start(runtime, icon, actions))
}

#[cfg(windows)]
fn system_tray(
    _runtime: &tokio::runtime::Handle,
    actions: tokio::sync::mpsc::UnboundedSender<tray::TrayAction>,
) -> Box<dyn tray::Tray> {
    let loader = gtk::gdk_pixbuf::PixbufLoader::new();
    loader.set_size(32, 32);
    let mark = loader
        .write(widgets::art::MARK)
        .and_then(|_| loader.close())
        .ok()
        .and_then(|_| loader.pixbuf())
        .and_then(|pixbuf| tray::rgba(&pixbuf));
    Box::new(tray::NotificationArea::start(mark, actions))
}

#[cfg(not(any(target_os = "linux", windows)))]
fn system_tray(
    _runtime: &tokio::runtime::Handle,
    _actions: tokio::sync::mpsc::UnboundedSender<tray::TrayAction>,
) -> Box<dyn tray::Tray> {
    Box::new(tray::NoTray)
}

mod session_visibility;
