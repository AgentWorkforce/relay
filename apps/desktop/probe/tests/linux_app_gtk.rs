//! The GTK window against an in-process fake core: what it shows comes from
//! the snapshot and method results, and every action is a contract call.
//!
//! GTK runs on the process's main thread, which libtest never gives a test,
//! so this target has its own `main` (`harness = false` in `Cargo.toml`): it
//! runs each case in turn on the main thread, pumping the GLib main loop as
//! the app's own loop would, while the fake core and the bridge run on a
//! tokio runtime. It needs a display: on Linux CI it runs under `xvfb-run -a`.
//! `cargo test --features gtk --test linux_app_gtk -- NAME` runs the cases
//! whose name contains `NAME`. The four pages' cases are in `pages`.

use agent_relay_probe::linux_app::bridge::BridgeOptions;
use agent_relay_probe::linux_app::fake_core::{self, Answer, FakeCore};
use agent_relay_probe::linux_app::install::InstallKind;
use agent_relay_probe::linux_app::models::{
    AGENT_CHANGES_TITLE, AUTO_JOIN_GENERAL_DETAIL, AUTO_JOIN_GENERAL_JOINED_DETAIL,
    AUTO_JOIN_GENERAL_TITLE, AUTO_JOIN_GENERAL_TURN_ON_HELP, INBOUND_DEFAULT_PREF,
    SHOW_RELAY_MESSAGES_DETAIL, SHOW_RELAY_MESSAGES_TITLE, SHOW_RELAY_MESSAGES_TURN_ON_HELP,
};
use agent_relay_probe::linux_app::prefs::{Appearance, Preferences};
use agent_relay_probe::linux_app::service::{ServiceStart, ServiceState, UserService};
use agent_relay_probe::linux_app::ui::desktop::{Answer as Reply, Confirmation, Desktop};
use agent_relay_probe::linux_app::ui::settings_page::SettingRow;
use agent_relay_probe::linux_app::ui::state::{AgentScope, Page, Pane, Section, View};
use agent_relay_probe::linux_app::ui::theme::{self, Theme};
use agent_relay_probe::linux_app::ui::tray::{self, Tray, TrayEntry, TrayModel};
use agent_relay_probe::linux_app::ui::widgets::{buttons, labels, walk};
use agent_relay_probe::linux_app::ui::{App, Options};
use agent_relay_probe::relay::contract::agents::SettingsChange;
use agent_relay_probe::relay::contract::connection::CoreNotification;
use agent_relay_probe::relay::contract::{method, reader, Method};
use agent_relay_probe::relay::outbox::Mode;
use agent_relay_probe::relay::protocol::{ErrorKind, RpcError};
use agent_relay_probe::relay::uploader::SharingMode;
use gtk::{glib, prelude::*};
use gtk4 as gtk;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::panic::AssertUnwindSafe;
use std::process::ExitCode;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

#[path = "linux_app_gtk/pages.rs"]
mod pages;
#[path = "linux_app_gtk/take_over.rs"]
mod take_over;

// What the fake core answers.

fn uploader() -> Value {
    json!({
        "stage": "uploading", "stage_message": null, "running": true, "paused": false,
        "sharing_mode": "selected", "upgrading": false, "directory": "/tmp/install",
        "collector_replacing": false, "collector_outdated": false, "needs_start": false,
        "journal_full": false, "stalled": false,
        "delivery": {"bootstrap_complete": true, "pending_records": 2, "acknowledged_records": 6,
                     "skipped_records": 0, "quarantined_records": 0, "unqueued_changes": 0},
        "sessions": {"total": 2, "shared": 1, "excluded": 0},
    })
}

fn upload_row(
    source: &str,
    id: &str,
    title: &str,
    cwd: &str,
    included: bool,
    status: &str,
) -> Value {
    json!({"source": source, "session_id": id, "title": title, "cwd": cwd, "git_branch": null,
           "first_activity_ms": null, "last_activity_ms": null, "is_agent": false,
           "included": included, "status": status})
}

fn sessions() -> Value {
    json!({"sharing_mode": "selected", "sessions": [
        upload_row("codex", "one", "Fix login", "/w/api", true, "uploaded"),
        upload_row("claude", "two", "Docs", "/w/web", false, "not_shared"),
    ]})
}

fn local_session(kind: &str, id: &str, title: &str, live: bool, registration: Value) -> Value {
    json!({"target": {"kind": kind, "id": id}, "title": title, "project": "api", "directory": null,
           "live": live, "updated_at_ms": null, "registration": registration,
           "suggested_name": "api-work"})
}

fn local() -> Value {
    json!({"sessions": [
        local_session("codex", "thread-1", "API work", true, Value::Null),
        local_session("claude-terminal", "c-2", "Web", true,
                      json!({"name": "web", "address": "web@desk", "added_by_session": false,
                             "push": {"state": "live"}})),
        local_session("codex", "gone", "Old", false,
                      json!({"name": "old", "address": "old@desk", "added_by_session": false,
                             "push": null})),
    ]})
}

fn agents() -> Value {
    json!({"agents": [
        {"name": "web", "address": "web@desk", "added_by_session": false, "delivery_error": null,
         "integrations": [], "push": {"state": "live"}, "registered_at": "2026-10-01T00:00:00Z",
         "reply_with_final_answer": null, "target": {"kind": "claude-terminal", "id": "c-2"},
         "title": "Web", "webhook": null},
    ]})
}

fn worker(id: &str, name: &str, state: &str, generation: Value) -> Value {
    json!({"id": id, "name": name, "provider": "codex", "provider_label": "Codex", "model": null,
           "runtime_kind": null, "session_id": null, "channels": [], "generation": generation,
           "state": state, "pending_messages": 0, "last_activity_ms": null, "target": null})
}

fn fleet() -> Value {
    json!({"brokers": [{"node_id": "node-1", "name": "desk", "workers": [
        worker("node-1|builder", "builder", "working", json!("g7")),
        worker("node-1|legacy", "legacy", "idle", Value::Null),
    ]}]})
}

fn people() -> Value {
    json!({"people": [
        {"name": "Ada", "avatar_url": null, "identity_hash": "h-ada", "is_self": true},
        {"name": "Bo", "avatar_url": null, "identity_hash": "h-bo", "is_self": false},
    ]})
}

fn roster_agent(
    name: &str,
    address: &str,
    place: &str,
    liveness: &str,
    host: Value,
    owner: &str,
    mine: bool,
) -> Value {
    json!({"name": name, "address": address, "kind": "agent", "where": place, "status": "active",
           "liveness": liveness, "last_seen_ms": null, "description": "", "host": host,
           "owner_hash": owner, "session_id": null, "is_self": mine})
}

fn roster() -> Value {
    let mut remote = roster_agent(
        "remote",
        "remote@laptop",
        "other_desktop",
        "live",
        json!("laptop"),
        "h-ada",
        true,
    );
    remote["provider"] = json!("grok");
    let mut napper = roster_agent(
        "napper",
        "napper@cloud",
        "cloud",
        "idle",
        Value::Null,
        "h-bo",
        false,
    );
    napper["status"] = json!("idle");
    json!({"agents": [
        roster_agent("builder", "builder@desk", "this_computer", "live", json!("desk"), "h-ada", true),
        remote,
        roster_agent("bos", "bos@cloud", "cloud", "live", Value::Null, "h-bo", false),
        napper,
        roster_agent("gone", "gone@cloud", "cloud", "offline", Value::Null, "h-bo", false),
    ], "unread_statuses": [], "fetched_at_ms": 0})
}

/// `roster.get`'s answer for `web@desk`: `liveness` none is no such agent.
fn recipient(liveness: Option<&str>, message: Option<&str>, known: bool) -> Value {
    let agent = liveness.map(|liveness| {
        roster_agent(
            "web",
            "web@desk",
            "other_desktop",
            liveness,
            json!("desk"),
            "h-bo",
            false,
        )
    });
    json!({"known": known, "agent": agent, "message": message})
}

fn sent(recipient: Value, message_id: &str) -> Value {
    json!({"message_id": message_id, "conversation_id": "c", "to": "web@desk", "recipient": recipient})
}

fn overview_with(requests: Value) -> Answer {
    Answer::with(move |params| {
        let requests = requests.clone();
        async move {
            Ok(json!({"sessionId": params["session_id"], "requests": requests, "analyses": []}))
        }
    })
}

fn settings() -> Value {
    json!({"allow_self_registration": true, "auto_activate": false, "direct_delivery": false,
           "analytics_enabled": true, "grok_leader": false, "opencode_plugin": false,
           "devin_direct_delivery": false,
           "claude_config_dirs": [{"path": "/srv/m/.claude", "origin": "default", "shared": true},
                                  {"path": "/srv/m/.seclaude", "origin": "running", "shared": true},
                                  {"path": "/opt/claude", "origin": "added", "shared": true}],
           "claude_cloud_sessions": false,
           "claude_session_hook": false, "show_relay_messages": false,
           "auto_join_general": false, "agent_changes": []})
}

fn incoming() -> Value {
    json!({"can_approve": true, "error": null, "state": "connected",
           "held": [{"id": "h1", "sender_name": "Bo", "text": "May I?", "thread_id": "th",
                     "enqueued_at_ms": 0, "expires_at_ms": 0}],
           "threads": [{"id": "th", "title": "Release", "project": "api", "open": true,
                        "shared": true, "mode": "hold", "allows_unrestricted": false}]})
}

fn claude_delivery() -> Value {
    json!({"restricted": true,
           "sessions": [{"id": "c-2", "agent": "web", "title": "Web", "direct": false}],
           "allowed_senders": [{"address": "ada@desk", "name": "Ada"}],
           "held": [{"id": "del-1", "agent": "web", "session_id": "c-2",
                      "sender": "bo@desk", "sender_name": "Bo", "text": "Please review",
                      "held_at_ms": 0}]})
}

fn pending_report() -> Value {
    let mut report =
        fake_core::snapshot(json!({"state": "pending_approval", "phase": "waiting_for_browser"}))
            ["account"]
            .clone();
    report["verification_url"] = json!("https://agentrelay.com/device");
    report["verification_url_complete"] = json!("https://agentrelay.com/device?code=AB");
    report["user_code"] = json!("AB");
    report["expires_at"] = Value::Null;
    report["interval"] = Value::Null;
    report
}

fn workspace_snapshot() -> Value {
    let mut state = fake_core::signed_in();
    state["workspace"]["state"] = json!("found");
    state["workspace"]["workspace_name"] = json!("Acme");
    state["workspace"]["workspace_id"] = json!("rw");
    state
}

/// Each answer as the app's reader reads it, so a fixture that drifted from
/// the contract fails here rather than as a silent unreadable answer.
fn check<M: Method>(value: Value) -> Value {
    if let Err(error) = reader::result::<M>(value.clone()) {
        panic!("{} fixture does not fit the contract: {error:?}", M::NAME);
    }
    value
}

fn answer(core: &FakeCore) {
    core.answer("diagnostics.requests", json!({"entries": []}));
    core.answer("telemetry.record", json!({}));
    core.answer(
        "uploader.sessions.preview",
        json!({"sessions": [upload_row("codex", "p", "", "/w", false, "not_shared")]}),
    );
    core.answer("settings.get", check::<method::SettingsGet>(settings()));
    core.answer(
        "settings.set",
        Answer::with(|params| async move {
            let mut values = settings();
            if let (Some(values), Value::Object(changes)) = (values.as_object_mut(), params) {
                for (key, value) in changes {
                    if key == "claude_config_dirs" {
                        // The core lists the added folders after the others.
                        let mut folders = vec![
                            json!({"path": "/srv/m/.claude", "origin": "default", "shared": true}),
                        ];
                        folders.extend(
                            value.as_array().into_iter().flatten().map(
                                |path| json!({"path": path, "origin": "added", "shared": true}),
                            ),
                        );
                        values.insert(key, Value::Array(folders));
                    } else if key == "claude_config_dir" {
                        let folders = values["claude_config_dirs"].as_array_mut().unwrap();
                        for folder in folders {
                            if folder["path"] == value["path"] {
                                folder["shared"] = value["shared"].clone();
                            }
                        }
                    } else if key != "direct_delivery_default" {
                        values.insert(key, value);
                    }
                }
            }
            Ok(values)
        }),
    );
    core.answer("login_item.status", json!({"enabled": true}));
    core.answer("login_item.set", json!({}));
    core.answer(
        "account.sign_in",
        check::<method::AccountSignIn>(pending_report()),
    );
    core.answer("account.sign_in.cancel", json!({}));
    core.answer("account.sign_out", json!({}));
    let mut workspace = workspace_snapshot()["workspace"].clone();
    workspace["verification"] = json!("verified");
    core.answer("account.connect_workspace", workspace.clone());
    core.answer(
        "uploader.status",
        check::<method::UploaderStatus>(uploader()),
    );
    core.answer(
        "uploader.sessions.list",
        check::<method::UploaderSessionsList>(sessions()),
    );
    core.answer(
        "uploader.sharing.set",
        Answer::with(|params| async move { Ok(json!({"sharing_mode": params["mode"]})) }),
    );
    core.answer("uploader.pause", json!({"paused": true}));
    core.answer("uploader.resume", json!({"paused": false}));
    core.answer("sessions.list", check::<method::SessionsList>(local()));
    core.answer("agents.list", check::<method::AgentsList>(agents()));
    core.answer(
        "agents.register",
        json!({"name": "api-work", "address": "api-work@desk", "already_registered": false}),
    );
    core.answer("agents.unregister", json!({}));
    core.answer("fleet.list", check::<method::FleetList>(fleet()));
    core.answer(
        "capy.projects.list",
        check::<method::CapyProjectsList>(json!({
            "projects": [{"id": "project_1", "name": "Agent Relay"}],
            "truncated": false,
            "next_cursor": null
        })),
    );
    core.answer(
        "capy.threads.spawn",
        check::<method::CapyThreadsSpawn>(json!({
            "thread_id": "jam_01THREAD", "title": "Review", "status": "running",
            "binding": {"state": "pending"}
        })),
    );
    core.answer(
        "capy.threads.get",
        check::<method::CapyThreadsGet>(json!({
            "thread_id": "jam_01THREAD", "title": "Review", "status": "running",
            "binding": {"state": "bound", "agent": "capy-01thread"}
        })),
    );
    core.answer("people.list", check::<method::PeopleList>(people()));
    core.answer("roster.list", check::<method::RosterList>(roster()));
    core.answer(
        "incoming.status",
        check::<method::IncomingStatus>(incoming()),
    );
    core.answer("incoming.share", json!({}));
    core.answer("incoming.approve", json!({"approved": true}));
    core.answer("incoming.reject", json!({"rejected": true}));
    core.answer(
        "claude_delivery.status",
        check::<method::ClaudeDeliveryStatus>(claude_delivery()),
    );
    core.answer("claude_delivery.restrict", json!({}));
    core.answer("claude_delivery.session", json!({}));
    core.answer("claude_delivery.sender", json!({}));
    core.answer("claude_delivery.approve", json!({"changed": true}));
    core.answer("claude_delivery.dismiss", json!({"changed": true}));
    core.answer(
        "links.parse",
        json!({"kind": "connect", "site_url": "https://agentrelay.com",
               "account_id": "acct", "workspace_id": "ws-1"}),
    );
    core.answer(
        "uploader.sessions.include",
        check::<method::UploaderSessionsInclude>(json!({"updated": 1})),
    );
    core.answer(
        "uploader.sessions.exclude",
        check::<method::UploaderSessionsExclude>(json!({"updated": 1})),
    );
    core.answer(
        "uploader.compact",
        check::<method::UploaderCompact>(json!({"removed_records": 3})),
    );
    core.answer(
        "uploader.retry",
        check::<method::UploaderRetry>(json!({"retried": true})),
    );
    core.answer(
        "agents.rename",
        check::<method::AgentsRename>(json!({"name": "webby", "address": "webby@desk"})),
    );
    core.answer(
        "agents.test_message",
        check::<method::AgentsTestMessage>(json!({"message_id": "t1"})),
    );
    core.answer("agents.reply_setting", json!({}));
    core.answer(
        "agents.webhook.create",
        check::<method::AgentsWebhookCreate>(
            json!({"created": true, "id": "w1", "secret": "s3cret", "url": "https://hooks/w1"}),
        ),
    );
    core.answer(
        "agents.webhook.revoke",
        check::<method::AgentsWebhookRevoke>(json!({"already_deleted": false})),
    );
    core.answer(
        "agents.integrations.subscribe",
        check::<method::AgentsIntegrationsSubscribe>(
            json!({"subscribed": true, "provider": "github", "resource": "acme/api"}),
        ),
    );
    core.answer(
        "activity.list",
        check::<method::ActivityList>(json!({"activity": [
            {"agent": "web", "at_ms": 1, "detail": null, "outcome": "injected", "preview": "hi",
             "sender": "bo", "settlement": null},
        ]})),
    );
    core.answer("fleet.release", json!({}));
    core.answer("sessions.overview.get", overview_with(json!([])));
    core.answer("sessions.overview.request", json!({}));
    core.answer(
        "sessions.overview.events",
        Answer::with(|params| async move {
            Ok(json!({"sessionId": params["session_id"], "events": []}))
        }),
    );
    core.answer(
        "messages.history",
        check::<method::MessagesHistory>(json!({"identity": "ada", "messages": [
            {"id": "m1", "sender": "web", "sender_id": null, "sender_address": "web@desk",
             "text": "hello", "created_at": "2026-09-30T10:00:00Z", "thread_id": null,
             "mine": false},
        ]})),
    );
    core.answer(
        "messages.send",
        check::<method::MessagesSend>(sent(recipient(Some("live"), Some("queued"), true), "m2")),
    );
    core.answer(
        "roster.get",
        check::<method::RosterGet>(recipient(Some("live"), None, true)),
    );
}

/// No systemd: the unit is installed and running.
#[derive(Default)]
struct FakeService {
    calls: Mutex<Vec<&'static str>>,
}

impl UserService for FakeService {
    fn state(&self) -> ServiceState {
        ServiceState {
            installed: true,
            enabled: true,
            active: true,
        }
    }

    fn start(&self) -> ServiceStart {
        self.calls.lock().unwrap().push("start");
        ServiceStart::NotEnabled
    }

    fn enable(&self) -> Result<(), String> {
        self.calls.lock().unwrap().push("enable");
        Ok(())
    }

    fn stop(&self) -> Result<(), String> {
        self.calls.lock().unwrap().push("stop");
        Ok(())
    }

    fn disable(&self) -> Result<(), String> {
        self.calls.lock().unwrap().push("disable");
        Ok(())
    }
}

/// A desktop that records what the app asked of it and answers every
/// question with `answer`.
struct FakeDesktop {
    codex_installed: Cell<bool>,
    opened: RefCell<Vec<String>>,
    notified: RefCell<Vec<CoreNotification>>,
    asked: RefCell<Vec<Confirmation>>,
    answer: Cell<bool>,
    quit: Cell<bool>,
}

impl Desktop for FakeDesktop {
    fn has_uri_handler(&self, scheme: &str) -> bool {
        scheme == "codex" && self.codex_installed.get()
    }
    fn open_terminal(&self, command: &str) -> Result<(), String> {
        self.opened.borrow_mut().push(command.to_string());
        Ok(())
    }
    fn open_uri(&self, uri: &str) -> bool {
        self.opened.borrow_mut().push(uri.to_string());
        true
    }

    fn notify(&self, notification: &CoreNotification) {
        self.notified.borrow_mut().push(notification.clone());
    }

    fn confirm(&self, _parent: &gtk::Window, confirmation: Confirmation) -> Reply {
        self.asked.borrow_mut().push(confirmation);
        let answer = self.answer.get();
        Box::pin(async move { answer })
    }

    fn inform(&self, _parent: &gtk::Window, _title: &str, _detail: &str) {}

    fn quit(&self) {
        self.quit.set(true);
    }
}

/// The tray's latest menu, as a test sees it.
#[derive(Clone, Default)]
struct RecordingTray(Rc<RefCell<TrayModel>>);

impl Tray for RecordingTray {
    fn show(&self, model: TrayModel) {
        *self.0.borrow_mut() = model;
    }
}

struct Case {
    tray: RecordingTray,
    runtime: tokio::runtime::Handle,
    core: FakeCore,
    app: App,
    desktop: Rc<FakeDesktop>,
    service: Arc<FakeService>,
    prefs_path: std::path::PathBuf,
    _directory: tempfile::TempDir,
}

impl Case {
    /// The app, signed out, on its sign-in screen.
    fn new(runtime: &tokio::runtime::Runtime) -> Case {
        Case::with(runtime, |_| {})
    }

    fn with(runtime: &tokio::runtime::Runtime, prepare: impl FnOnce(&FakeCore)) -> Case {
        Case::build(runtime, prepare, false)
    }

    /// The app on a computer where Capy is used.
    fn with_capy(runtime: &tokio::runtime::Runtime) -> Case {
        Case::build(runtime, |_| {}, true)
    }

    fn build(
        runtime: &tokio::runtime::Runtime,
        prepare: impl FnOnce(&FakeCore),
        capy_installed: bool,
    ) -> Case {
        // Short enough for a socket path on macOS; Windows has no /tmp.
        let directory = tempfile::Builder::new()
            .prefix("gtk")
            .tempdir_in(if cfg!(windows) {
                std::env::temp_dir()
            } else {
                std::path::PathBuf::from("/tmp")
            })
            .unwrap();
        let socket = directory.path().join("core.sock");
        let core = runtime.block_on(async { FakeCore::start(&socket).unwrap() });
        answer(&core);
        prepare(&core);
        let prefs_path = directory.path().join("desktop.json");
        let mut prefs = Preferences::load(prefs_path.clone());
        prefs.set_automatically_checks_for_updates(false).unwrap();
        let desktop = Rc::new(FakeDesktop {
            codex_installed: Cell::new(true),
            opened: RefCell::default(),
            notified: RefCell::default(),
            asked: RefCell::default(),
            answer: Cell::new(true),
            quit: Cell::new(false),
        });
        let service = Arc::new(FakeService::default());
        let tray = RecordingTray::default();
        let app = App::new(Options {
            bridge: BridgeOptions {
                socket,
                host: None,
                service: None,
            },
            runtime: runtime.handle().clone(),
            prefs,
            service: service.clone(),
            desktop: desktop.clone(),
            tray: Box::new(tray.clone()),
            install_kind: InstallKind::Source,
            capy_installed,
            window: gtk::Window::new(),
        });
        let case = Case {
            tray,
            runtime: runtime.handle().clone(),
            core,
            app,
            desktop,
            service,
            prefs_path,
            _directory: directory,
        };
        case.pump(|case| case.app.view() == Some(View::SignIn));
        case
    }

    /// Runs the main loop until `until` holds; fails after ten seconds.
    #[track_caller]
    fn pump(&self, until: impl Fn(&Case) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            dispatch_one();
            if until(self) {
                return;
            }
        }
        panic!(
            "timed out waiting for the app at {}; window mapped={} active={}",
            std::panic::Location::caller(),
            self.app.window().is_mapped(),
            self.app.window().is_active()
        );
    }

    /// Runs whatever the last action started.
    fn settle(&self) {
        let end = Instant::now() + Duration::from_millis(300);
        while Instant::now() < end {
            dispatch_one();
        }
    }

    fn called(&self, method: &str) -> Vec<Value> {
        self.core.called(method)
    }

    fn set_state(&self, state: Value) {
        self.runtime.block_on(self.core.set_state(state));
    }

    fn emit(&self, topic: &str, data: Value) {
        self.runtime.block_on(self.core.emit(topic, data));
    }

    fn answer(&self, method: &str, answer: impl Into<Answer>) {
        self.core.answer(method, answer);
    }

    fn sign_in(&self) {
        self.set_state(workspace_snapshot());
        self.pump(|case| {
            case.app.with_state(|state| {
                state.connected()
                    && state.status.is_some()
                    && state.sessions.len() == 2
                    && state.local_sessions.len() == 3
                    && !state.people.is_empty()
                    && !state.brokers.is_empty()
            })
        });
        self.settle();
    }

    fn window_labels(&self) -> Vec<String> {
        labels(self.app.window())
    }

    fn checks(&self) -> Vec<gtk::CheckButton> {
        let mut found = Vec::new();
        walk(self.app.window().upcast_ref(), &mut |widget| {
            if let Some(check) = widget.downcast_ref::<gtk::CheckButton>() {
                found.push(check.clone());
            }
        });
        found
    }

    fn settings_labels(&self) -> Vec<String> {
        labels(&self.app.shell().unwrap().settings.column)
    }

    /// The core turned direct delivery on by default.
    fn on_by_default(&self) {
        self.pump(|case| case.app.with_state(|state| state.settings.is_some()));
        self.settle();
        self.app.update_state(|state| {
            if let Some(settings) = state.settings.as_mut() {
                settings.direct_delivery = Some(true);
            }
        });
        self.app.show_sign_in();
    }

    fn offered(&self) -> bool {
        Preferences::load(self.prefs_path.clone())
            .get(INBOUND_DEFAULT_PREF)
            .is_some_and(|value| value == &Value::Bool(true))
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        self.app.shutdown();
        self.runtime.block_on(self.core.stop());
        self.app.window().destroy();
        let end = Instant::now() + Duration::from_millis(300);
        while Instant::now() < end {
            dispatch_one();
        }
    }
}

/// Dispatches one ready main-loop source, or waits briefly when none is.
/// One at a time: a shown window that animates (a spinner, a pulsing bar)
/// has its next frame due again by the time a slow renderer finishes the
/// last one (Mesa's software rasterizer on CI's arm64 runner), so the loop
/// never runs dry and every caller checks its own condition and deadline
/// between sources.
fn dispatch_one() {
    if !glib::MainContext::default().iteration(false) {
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn fail(kind: ErrorKind, message: &str) -> Answer {
    Answer::Fail(RpcError::new(kind, message))
}

// The harness.

/// A main loop that never runs dry, as a shown window animating under a slow
/// renderer keeps it, still lets the case see its condition.
fn pumping_ends_while_the_loop_stays_busy(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    let busy = glib::idle_add_local(|| glib::ControlFlow::Continue);
    let done = Rc::new(Cell::new(false));
    let flag = done.clone();
    glib::timeout_add_local_once(Duration::from_millis(50), move || flag.set(true));
    case.pump(|_| done.get());
    busy.remove();
}

// Look.

fn workspace_menu_offers_sign_out_to_switch(runtime: &tokio::runtime::Runtime) {
    for count in [None, Some(0), Some(1), Some(2)] {
        let case = Case::new(runtime);
        let mut state = workspace_snapshot();
        state["account"]["workspace_name"] = json!("Upload workspace");
        state["account"]["workspace_count"] = json!(count);
        state["workspace"]["workspace_name"] = json!("Different relay");
        case.set_state(state);
        case.pump(|case| case.app.shell().is_some());
        case.app.show_window();
        case.settle();
        let shell = case.app.shell().unwrap();
        // State delivery and a short settle do not guarantee a native frame
        // has allocated the header on CI's software renderer.
        case.pump(|_| shell.header.is_mapped() && shell.header.height() > 0);
        let multiple = count.unwrap_or(0) > 1;
        assert_eq!(
            shell.header.height(),
            64,
            "Both avatar arrangements keep one header height"
        );
        assert_eq!(
            shell.account_button.child().unwrap().widget_name() == "workspace-avatar-stack",
            multiple
        );
        shell.account_button.emit_clicked();
        case.settle();
        let mut popovers = Vec::new();
        walk(shell.account_button.upcast_ref(), &mut |widget| {
            if let Some(popover) = widget.downcast_ref::<gtk::Popover>() {
                popovers.push(popover.clone());
            }
        });
        let popover = &popovers[0];
        assert_eq!(
            !buttons(popover, "Switch workspace…").is_empty(),
            multiple,
            "Workspace switching must be hidden for unknown or single-workspace accounts"
        );
        case.app.render_chrome();
        assert!(popover.is_visible(), "Refresh preserves the account menu");
        if multiple {
            buttons(popover, "Switch workspace…")[0].emit_clicked();
            case.pump(|case| !case.called("account.sign_out").is_empty());
            assert_eq!(
                case.desktop.asked.borrow().last().unwrap().title,
                "Sign out to switch workspace?"
            );
        } else {
            popover.popdown();
            case.settle();
        }
    }
}

fn stylesheets_and_marks_load(runtime: &tokio::runtime::Runtime) {
    for theme in [Theme::Light, Theme::Dark] {
        let provider = gtk::CssProvider::new();
        let errors = Rc::new(RefCell::new(Vec::new()));
        let seen = errors.clone();
        provider.connect_parsing_error(move |_, section, error| {
            seen.borrow_mut().push(format!("{section}: {error}"));
        });
        theme::load_css(&provider, &theme::css(theme));
        assert_eq!(
            *errors.borrow(),
            Vec::<String>::new(),
            "{theme:?} stylesheet"
        );
    }
    let case = Case::new(runtime);
    let mut pictures = Vec::new();
    walk(case.app.window().upcast_ref(), &mut |widget| {
        if let Some(picture) = widget.downcast_ref::<gtk::Picture>() {
            pictures.push(picture.clone());
        }
    });
    // The mark, the wordmark and seven harness marks on the welcome splash
    // (three on Windows, which lacks the Unix-only harnesses).
    let harnesses = if cfg!(windows) { 3 } else { 7 };
    assert_eq!(pictures.len(), 2 + harnesses, "every artwork rasterizes");
    let mut devin_logo = false;
    walk(case.app.window().upcast_ref(), &mut |widget| {
        if widget.widget_name() == "agent-mark-devin" {
            devin_logo = true;
        }
    });
    assert_eq!(
        devin_logo,
        cfg!(unix),
        "Devin uses its bundled logo on the welcome splash"
    );
    let wordmark = pictures[1].paintable().unwrap();
    assert!(wordmark.intrinsic_width() > wordmark.intrinsic_height() * 3);
}

// Signed out.

fn usage_telemetry_tracks_navigation_and_debounces_search(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Team);
    case.app.set_agent_search("private query");
    case.app.set_agent_search("private query revised");
    case.pump(|case| {
        case.called("telemetry.record")
            .iter()
            .any(|e| e["operation"] == "search")
    });
    case.app.set_agent_search("");
    case.app.go(Page::Settings(Pane::General));
    case.app.go(Page::Settings(Pane::General));
    case.app.show_message_composer("");
    case.pump(|case| {
        case.called("telemetry.record")
            .iter()
            .any(|e| e["operation"] == "message_composer")
    });
    case.settle();
    case.settle();
    let events = case.called("telemetry.record");
    let searches: Vec<_> = events
        .iter()
        .filter(|e| e["operation"] == "search")
        .collect();
    assert_eq!(searches.len(), 1, "{events:?}");
    assert_eq!(searches[0]["surface"], "team");
    assert_eq!(
        events
            .iter()
            .filter(|e| e["operation"] == "settings")
            .count(),
        1
    );
    assert!(events
        .iter()
        .any(|e| e["operation"] == "page_view" && e["surface"] == "team"));
    assert!(!serde_json::to_string(&events).unwrap().contains("private"));
}

fn destination_search_applied_before_navigation_is_recorded(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Team);
    case.app.set_agent_search("private old page");
    case.app.set_session_search("private destination");
    case.app.go(Page::Sessions);
    case.pump(|case| {
        case.called("telemetry.record")
            .iter()
            .any(|event| event["operation"] == "search")
    });
    let deadline = Instant::now() + Duration::from_millis(100);
    case.pump(|_| Instant::now() >= deadline);
    let searches: Vec<_> = case
        .called("telemetry.record")
        .into_iter()
        .filter(|event| event["operation"] == "search")
        .collect();
    assert_eq!(searches.len(), 1);
    assert_eq!(searches[0]["surface"], "sessions");
}

fn navigation_cancels_pending_search_usage_even_after_returning(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    for page in [Page::Sessions, Page::Agents, Page::Team] {
        case.app.go(page);
        if page == Page::Sessions {
            case.app.set_session_search("private sessions");
        } else {
            case.app.set_agent_search(&format!("private {page:?}"));
        }
        case.app.go(Page::Settings(Pane::General));
        case.app.go(page); // Returning must not revive the cancelled debounce.
    }
    case.app.set_agent_search("private composer transition");
    case.app.show_message_composer("");
    case.app.go(Page::Team);
    let deadline = Instant::now() + Duration::from_millis(650);
    case.pump(|_| Instant::now() >= deadline);
    assert!(!case
        .called("telemetry.record")
        .iter()
        .any(|event| event["operation"] == "search"));
}

fn signed_out_shows_sign_in_and_records_the_launch(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.pump(|case| case.app.with_state(|state| state.preview_count == 1));
    // The record is a call of its own, so wait for it to reach the core.
    case.pump(|case| !case.called("telemetry.record").is_empty());
    let launch = &case.called("telemetry.record")[0];
    assert_eq!(
        (&launch["operation"], &launch["outcome"]),
        (&json!("app_launch"), &json!("started"))
    );
    assert!(case
        .window_labels()
        .contains(&"Get your agents on the relay".to_string()));
    assert!(!buttons(case.app.window(), "Sign in with Google").is_empty());
}

fn first_run_shows_only_sign_in_and_preserves_delivery_default(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.on_by_default();
    let shown = case.window_labels();
    assert!(!shown.contains(&"Deliver relayed messages to Claude Code directly".to_string()));
    assert!(!shown.contains(&"Sets \"crossSessionInbound\": \"accept\" in ~/.claude/settings.json unless you already chose a value.".to_string()));
    let checks = case.checks();
    assert!(checks.is_empty());
    case.app.sign_in(false, None);
    case.pump(|case| !case.called("settings.set").is_empty());
    assert_eq!(
        case.called("settings.set")[0],
        json!({"direct_delivery_default": true})
    );
    case.pump(Case::offered);
    // Offered once: a later sign-in screen shows no box.
    case.app.show_sign_in();
    assert!(case.checks().is_empty());
}

fn an_explicit_hold_shows_no_box(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.pump(|case| case.app.with_state(|state| state.settings.is_some()));
    case.settle();
    assert!(case.checks().is_empty());
    case.app.sign_in(false, None);
    case.pump(|case| !case.called("account.sign_in").is_empty());
    case.settle();
    assert!(case.called("settings.set").is_empty());
}

fn a_failed_first_run_default_is_offered_again(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.on_by_default();
    case.answer(
        "settings.set",
        fail(
            ErrorKind::Refused,
            "Your Claude settings file is not valid JSON.",
        ),
    );
    case.app.sign_in(false, None);
    case.pump(|case| case.app.with_state(|state| state.inbound_error.is_some()));
    assert_eq!(
        case.app
            .with_state(|state| state.inbound_error.clone())
            .unwrap(),
        "Your Claude settings file is not valid JSON."
    );
    assert!(!case.offered());
}

fn a_sign_in_before_the_settings_arrive_still_applies_the_default(
    runtime: &tokio::runtime::Runtime,
) {
    let case = Case::new(runtime);
    case.settle();
    case.app.update_state(|state| state.settings = None);
    case.app.sign_in(false, None);
    case.pump(|case| !case.called("settings.set").is_empty());
    assert_eq!(
        case.called("settings.set")[0],
        json!({"direct_delivery_default": true})
    );
}

fn first_run_keeps_managed_settings_out_of_sign_in(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.on_by_default();
    case.app.update_state(|state| {
        state.settings.as_mut().unwrap().direct_delivery_managed = Some("hold".into())
    });
    case.app.show_sign_in();
    assert!(case.checks().is_empty());
    assert!(!case.window_labels().contains(&"Your organization's managed settings set crossSessionInbound to hold, so Claude Code asks before showing each message. Ask your admin to change it.".to_string()));
    case.app.sign_in(false, None);
    case.pump(|case| !case.called("account.sign_in").is_empty());
    case.settle();
    assert!(case.called("settings.set").is_empty());
}

fn sign_in_uses_the_browser_with_new_sessions_shared_as_on_the_mac(
    runtime: &tokio::runtime::Runtime,
) {
    let case = Case::new(runtime);
    case.app.sign_in(false, None);
    case.pump(|case| !case.desktop.opened.borrow().is_empty());
    case.emit("sign_in", check::<method::AccountSignIn>(pending_report()));
    case.set_state(fake_core::snapshot(
        json!({"state": "pending_approval", "phase": "waiting_for_browser"}),
    ));
    case.pump(|case| case.app.view() == Some(View::SigningIn));
    case.settle();
    assert_eq!(
        *case.desktop.opened.borrow(),
        vec!["https://agentrelay.com/device?code=AB".to_string()]
    );
    let request = &case.called("account.sign_in")[0];
    assert_eq!(
        (&request["sharing"], &request["flow"]),
        (&json!("selected"), &json!("browser"))
    );
    let (heading, _, code) = case.app.signing_labels().unwrap();
    assert_eq!(
        (heading.as_str(), code.as_str()),
        ("Continue in your browser", "Code: AB")
    );
    case.app.open_approval_again();
    assert_eq!(case.desktop.opened.borrow().len(), 2);
    case.app.cancel_sign_in();
    // Calls use independent connections: seeing cancellation does not mean
    // the earlier browser-usage calls have reached the core yet.
    case.pump(|case| {
        !case.called("account.sign_in.cancel").is_empty()
            && case
                .called("telemetry.record")
                .iter()
                .filter(|event| {
                    event["operation"] == "browser_approval" && event["outcome"] == "succeeded"
                })
                .count()
                >= 2
    });
    // Cancellation belongs to the core; the UI must not double-count it.
    assert!(!case
        .called("telemetry.record")
        .iter()
        .any(|event| event["operation"] == "sign_in" && event["outcome"] == "cancelled"));
    assert_eq!(
        case.called("telemetry.record")
            .iter()
            .filter(
                |event| event["operation"] == "browser_approval" && event["outcome"] == "succeeded"
            )
            .count(),
        2
    );
}

fn native_workspace_picker_sends_the_selected_id(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.answer("account.select_workspace", json!({}));
    case.set_state(fake_core::snapshot(json!({
        "state":"preparing", "phase":"selecting_workspace",
        "person":{"id":"u","email":"ada@example.com"},
        "workspace_choices":[{"id":"a","name":"Alpha","organization_name":"Company"},{"id":"b","name":"Beta","organization_name":null}]
    })));
    case.pump(|case| case.app.view() == Some(View::ChoosingWorkspace));
    assert!(case
        .window_labels()
        .iter()
        .any(|label| label == "Choose your workspace"));
    buttons(case.app.window(), "Beta")[0].emit_clicked();
    case.pump(|case| !case.called("account.select_workspace").is_empty());
    assert_eq!(
        case.called("account.select_workspace")[0]["workspace_id"],
        "b"
    );
    assert!(case.called("account.sign_in").is_empty());
}

fn signed_out_offers_only_google_sign_in(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    assert!(buttons(case.app.window(), "Use another account").is_empty());
    assert_eq!(buttons(case.app.window(), "Sign in with Google").len(), 1);
    buttons(case.app.window(), "Sign in with Google")[0].emit_clicked();
    case.pump(|case| !case.called("account.sign_in").is_empty());
    assert_eq!(case.called("account.sign_in")[0]["flow"], "browser");
}

fn a_refused_sign_in_shows_the_cores_sentence(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.answer(
        "account.sign_in",
        fail(ErrorKind::CloudFailed, "Agent Relay could not be reached."),
    );
    case.app.sign_in(false, None);
    case.pump(|case| {
        case.app.with_state(|state| {
            state.sign_in_error.as_deref() == Some("Agent Relay could not be reached.")
        })
    });
    assert_eq!(case.app.view(), Some(View::SignIn));
    assert!(case
        .window_labels()
        .contains(&"Agent Relay could not be reached.".to_string()));
}

fn unchecked_schedules_offer_continue_anyway(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.set_state(fake_core::snapshot(json!({"state": "error",
        "error": "Older upload schedules could not be inspected.",
        "action": "acknowledge_uninspected_schedules"})));
    case.pump(|case| !buttons(case.app.window(), "Continue anyway").is_empty());
    buttons(case.app.window(), "Continue anyway")[0].emit_clicked();
    case.pump(|case| !case.called("account.sign_in").is_empty());
    assert_eq!(
        case.called("account.sign_in")[0]["acknowledge_uninspected_schedules"],
        json!(true)
    );
}

// The shell.

fn signed_in_lands_on_local_sessions(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    assert_eq!(case.app.page(), Page::Sessions);
    let shell = case.app.shell().unwrap();
    assert_eq!(shell.page_stack.visible_child_name().unwrap(), "sessions");
    assert!(!shell.sidebar.is_visible());
    assert!(shell.header.is_ancestor(&shell.root));
    assert!(shell.account_button.is_ancestor(&shell.header));
    assert!(shell.sessions_button.is_ancestor(&shell.header));
    let rows = labels(&shell.pages.sessions.list);
    assert!(rows.contains(&"Active".into()));
    assert!(rows.contains(&"API work".into()));
    assert!(rows.contains(&"Web".into()));
    assert!(!labels(&shell.pages.sessions.root).contains(&"Active agents".into()));
    assert!(
        shell
            .pages
            .sessions
            .search
            .ancestor(gtk::Popover::static_type())
            .is_some(),
        "The query input belongs to the search panel"
    );
    assert!(labels(&shell.header_search).contains(&"/".to_string()));
    assert!(buttons(&shell.header, "All sessions").is_empty());
    assert!(buttons(&shell.header, "On relay").is_empty());
    assert!(shell
        .pages
        .sessions
        .controls
        .is_ancestor(&shell.header_grouping));
    assert!(!shell.topbar.is_visible());
    assert!(!shell.topbar_separator.is_visible());
    assert!(!labels(&shell.topbar).contains(&"Open Cloud".to_string()));
    let rows = labels(&shell.pages.sessions.root);
    assert!(rows.contains(&"Messages".into()));
    assert!(rows.contains(&"Upload".into()));
    assert!(!rows.contains(&"Other machines".into()));
    assert_eq!(shell.status_text.text(), "Uploading…");
}

fn message_filters_preserve_query_and_sort(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    buttons(&page.root, "Session")[0].emit_clicked();
    let all = page.row_keys();
    assert!(all.contains(&"codex:thread-1".into()));
    // Exercise actual menu choices, not a second hidden scope.
    buttons(&shell.header_search, "Receives messages")[0].emit_clicked();
    case.settle();
    let enabled = page.row_keys();
    assert_eq!(
        enabled
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        ["claude:c-2".to_string(), "codex:gone".to_string()]
            .into_iter()
            .collect(),
        "Confirmed registrations include offline sessions"
    );
    buttons(&shell.header_search, "Does not receive messages")[0].emit_clicked();
    case.settle();
    assert_eq!(
        page.row_keys(),
        all.iter()
            .filter(|id| !enabled.contains(id))
            .cloned()
            .collect::<Vec<_>>()
    );
    assert!(!case
        .app
        .with_state(|state| state.session_search.contains("is:on-relay")));
    // Toggling the selected choice off restores the complete list and sort.
    buttons(&shell.header_search, "Does not receive messages")[0].emit_clicked();
    case.settle();
    assert_eq!(page.row_keys(), all);
    case.app.set_session_search("title:API is:active ");
    case.settle();
    buttons(&shell.header_search, "Receives messages")[0].emit_clicked();
    case.settle();
    assert!(page.row_keys().is_empty());
    buttons(&shell.header_search, "Does not receive messages")[0].emit_clicked();
    case.settle();
    assert_eq!(page.row_keys(), vec!["codex:thread-1".to_string()]);
    assert!(case
        .app
        .with_state(|state| state.session_search.contains("title:API is:active")));
}

fn header_layout_and_avatar_navigation(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.show_window();
    let shell = case.app.shell().unwrap();
    for (name, appearance) in [("dark", Appearance::Dark), ("light", Appearance::Light)] {
        case.app.set_appearance(appearance);
        for width in [980, 1200] {
            case.app.window().set_default_size(width, 780);
            if cfg!(windows) {
                // GDK's Win32 backend does not resize a shown window to a
                // new default size; it applies it when the window maps.
                case.app.window().set_visible(false);
                case.app.window().present();
            }
            case.settle();
            assert_eq!(shell.header.height(), 64, "One shared header height");
            assert!(
                shell.header_search.width() > 250,
                "The header reserves usable search space"
            );
            assert!(
                shell.root.width() <= width,
                "Header content must not widen the window: actual={}, requested={width}",
                shell.root.width()
            );
            if let Ok(dir) = std::env::var("SETTINGS_RENDER_DIR") {
                std::fs::create_dir_all(&dir).unwrap();
                let paintable = gtk::WidgetPaintable::new(Some(case.app.window()));
                let snapshot = gtk::Snapshot::new();
                paintable.snapshot(
                    &snapshot,
                    case.app.window().width() as f64,
                    case.app.window().height() as f64,
                );
                let node = snapshot
                    .to_node()
                    .expect("The mapped shell has a render node");
                let texture = case
                    .app
                    .window()
                    .renderer()
                    .unwrap()
                    .render_texture(&node, None);
                texture
                    .save_to_png(
                        std::path::Path::new(&dir).join(format!("sessions-gtk-{name}-{width}.png")),
                    )
                    .unwrap();
            }
        }
    }
    shell.sessions_button.grab_focus();
    let controllers = shell.root.observe_controllers();
    let shortcut = (0..controllers.n_items())
        .filter_map(|index| controllers.item(index))
        .filter_map(|item| item.downcast::<gtk::EventControllerKey>().ok())
        .find(|controller| controller.name().as_deref() == Some("session-search-shortcut"))
        .unwrap();
    assert!(
        shortcut.emit_by_name::<bool>(
            "key-pressed",
            &[
                &gtk::gdk::Key::slash,
                &0u32,
                &gtk::gdk::ModifierType::empty()
            ]
        ),
        "The search shortcut works while a global header control is focused"
    );
    let mut search_menus = Vec::new();
    walk(shell.header_search.upcast_ref(), &mut |widget| {
        if let Some(menu) = widget.downcast_ref::<gtk::MenuButton>() {
            search_menus.push(menu.clone());
        }
    });
    assert!(search_menus[0].popover().unwrap().is_visible());
    search_menus[0].popdown();
    case.settle();
    shell.account_button.emit_clicked();
    case.settle();
    let mut popovers = Vec::new();
    walk(shell.account_button.upcast_ref(), &mut |widget| {
        if let Some(popover) = widget.downcast_ref::<gtk::Popover>() {
            popovers.push(popover.clone());
        }
    });
    let account_menu = &popovers[0];
    assert!(!buttons(account_menu, "Log out…").is_empty());
    assert!(buttons(account_menu, "Start Capy thread…").is_empty());
    buttons(account_menu, "Settings…")[0].emit_clicked();
    assert_eq!(case.app.page(), Page::Settings(Pane::General));
    assert!(!shell.header_search.first_child().unwrap().is_visible());
    case.app.render_sessions();
    shell.settings_back.emit_clicked();
    assert_eq!(case.app.page(), Page::Sessions);
    assert!(shell.header_search.first_child().unwrap().is_visible());

    for page in [Page::Agents, Page::Team] {
        case.app.go(page);
        case.settle();
        let mut more = None;
        walk(shell.topbar.upcast_ref(), &mut |widget| {
            if let Some(button) = widget.downcast_ref::<gtk::Button>() {
                if button.tooltip_text().as_deref() == Some("More") {
                    more = Some(button.clone());
                }
            }
        });
        let more = more.expect("Relay page overflow menu");
        more.emit_clicked();
        case.settle();
        let mut popover = None;
        walk(more.upcast_ref(), &mut |widget| {
            if let Some(menu) = widget.downcast_ref::<gtk::Popover>() {
                popover = Some(menu.clone());
            }
        });
        let popover = popover.expect("Opened relay page overflow menu");
        assert!(popover.is_visible());
        assert!(!buttons(&popover, "Refresh").is_empty());
        assert!(!buttons(&popover, "Relay Settings…").is_empty());
        assert!(buttons(&popover, "Start Capy thread…").is_empty());
        buttons(&popover, "Relay Settings…")[0].emit_clicked();
        assert_eq!(case.app.page(), Page::Settings(Pane::Relay));
    }
}

fn settings_and_back_to_sessions_navigate(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    case.app.open_section(Section::Settings);
    assert_eq!(case.app.page(), Page::Settings(Pane::General));
    assert!(shell.sidebar.is_visible());
    assert!(shell.topbar.is_visible());
    assert!(shell.topbar_separator.is_visible());
    assert!(shell.settings_back.is_visible());
    assert!(shell.settings_back.is_ancestor(&shell.header));
    assert!(buttons(&shell.sidebar, "Back to sessions").is_empty());
    shell.settings_back.emit_clicked();
    assert!(!shell.settings_back.is_visible());
    assert_eq!(case.app.page(), Page::Sessions);
    assert!(!shell.sidebar.is_visible());
    assert!(!shell.topbar.is_visible());
    assert!(!shell.topbar_separator.is_visible());
}

fn paired_reads_asked_again_mid_read_each_read_once_more(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let methods = [
        "people.list",
        "roster.list",
        "settings.get",
        "login_item.status",
    ];
    let counts = |case: &Case| methods.map(|method| case.called(method).len());
    let before = counts(&case);
    // The second ask lands while the first reads are in flight.
    case.app.refresh_people();
    case.app.load_settings();
    case.app.refresh_people();
    case.app.load_settings();
    // Every read is asked twice, so each reads at least twice; settling then
    // shows none reads a third time.
    case.pump(|case| {
        counts(case)
            .iter()
            .zip(before)
            .all(|(after, before)| after - before >= 2)
    });
    case.settle();
    let after = counts(&case);
    for ((method, before), after) in methods.iter().zip(before).zip(after) {
        assert_eq!(after - before, 2, "{method} read {} times", after - before);
    }
}

fn the_status_bar_pauses_and_the_core_invalidating_refreshes(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.pump(|case| !case.app.with_state(|state| state.busy));
    case.app.shell().unwrap().pause_button.emit_clicked();
    case.pump(|case| !case.called("uploader.pause").is_empty());
    case.settle();
    let before = case.called("uploader.status").len();
    case.emit("invalidated", json!({"what": "uploader"}));
    case.pump(|case| case.called("uploader.status").len() > before);
}

fn typing_in_search_survives_a_status_refresh(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let search = shell.topbar_search.borrow().as_ref().unwrap().0.clone();
    search.grab_focus();
    search.set_text("we");
    search.set_position(2);
    case.pump(|_| search.root().and_then(|root| root.focus()).is_some());
    case.app.render_topbar();
    let replaced = shell.topbar_search.borrow().as_ref().unwrap().0.clone();
    assert_eq!(replaced, search); // The list toolbar keeps the actual entry alive.
    assert_eq!((replaced.text().as_str(), replaced.position()), ("we", 2));
    // Returning from Settings keeps the local session query.
    case.app.go(Page::Settings(Pane::General));
    case.app.go(Page::Sessions);
    let sessions = shell.topbar_search.borrow().as_ref().unwrap().0.clone();
    assert_eq!(sessions.text(), "we");
}

fn the_tray_opens_the_summarized_pages(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let hidden = case.app.hidden_sessions();
    let model = case.app.with_state(|state| tray::menu(state, &hidden));
    let action = |prefix: &str| {
        model
            .entries
            .iter()
            .find_map(|entry| match entry {
                TrayEntry::Item(label, action) if label.starts_with(prefix) => Some(action.clone()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("the tray shows {prefix}"))
    };
    case.app.tray_action(action("Receiving messages: "));
    assert_eq!(
        case.app
            .with_state(|state| (state.page, state.session_search.clone())),
        (Page::Sessions, "is:active is:on-relay".to_string())
    );
    assert!(case.called("agents.register").is_empty());
    case.app.tray_action(action("All sessions"));
    assert_eq!(
        case.app
            .with_state(|state| (state.page, state.session_search.clone())),
        (Page::Sessions, String::new())
    );
}

fn the_tray_counts_follow_show_hidden(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    // Uploaded and Not uploaded together count every row the list shows.
    let shown = |case: &Case| -> usize {
        case.tray
            .0
            .borrow()
            .entries
            .iter()
            .filter_map(|entry| match entry {
                TrayEntry::Item(label, _) if label.contains("ploaded: ") => {
                    label.rsplit(": ").next()?.parse::<usize>().ok()
                }
                _ => None,
            })
            .sum()
    };
    let all = shown(&case);
    case.app
        .set_sessions_hidden(vec!["codex:thread-1".into()], true);
    case.pump(|case| shown(case) == all - 1);
    case.app.set_show_hidden_sessions(true);
    assert_eq!(
        shown(&case),
        all,
        "showing hidden sessions counts them again"
    );
    case.app.set_show_hidden_sessions(false);
    assert_eq!(shown(&case), all - 1);
}

// Settings.

fn turning_on_the_service_is_confirmed_with_its_defaults(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.desktop.answer.set(false);
    case.app.enable_service();
    case.settle();
    assert!(!case.service.calls.lock().unwrap().contains(&"enable"));
    assert!(case.desktop.asked.borrow()[0]
        .detail
        .contains("direct delivery"));
}

fn keeping_agents_connected_after_quitting_can_be_turned_off(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::General));
    case.pump(|case| case.app.with_state(|state| state.service_state.is_some()));
    let keeps = |case: &Case| {
        Preferences::load(case.prefs_path.clone()).keeps_agents_connected_after_quit()
    };
    assert!(keeps(&case));
    assert!(case
        .settings_labels()
        .contains(&"Keep agents connected after quitting".to_string()));

    // The running service would keep them connected: turning it off is asked.
    case.desktop.answer.set(false);
    case.app.change_keep_connected(false);
    case.settle();
    assert_eq!(
        case.desktop.asked.borrow()[0].title,
        "Turn off the background service?"
    );
    assert!(!case.service.calls.lock().unwrap().contains(&"disable"));
    assert!(keeps(&case));

    case.desktop.answer.set(true);
    case.app.change_keep_connected(false);
    case.pump(|case| !keeps(case));
    assert!(case.service.calls.lock().unwrap().contains(&"disable"));

    // Turning it back on asks nothing.
    case.app.change_keep_connected(true);
    assert!(keeps(&case));
    assert_eq!(case.desktop.asked.borrow().len(), 2);
}

fn general_settings_come_from_the_core(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::General));
    case.pump(|case| {
        case.app.with_state(|state| {
            state.login_item == Some(true)
                && state.settings.is_some()
                && state.service_state.is_some()
        })
    });
    case.app.change_autostart(false);
    case.pump(|case| !case.called("login_item.set").is_empty());
    assert_eq!(case.called("login_item.set")[0], json!({"enabled": false}));
    case.app.set_setting(
        SettingsChange {
            analytics_enabled: Some(false),
            ..SettingsChange::default()
        },
        SettingRow::Pane,
    );
    case.pump(|case| !case.called("settings.set").is_empty());
    assert_eq!(
        case.called("settings.set")[0],
        json!({"analytics_enabled": false})
    );
    case.settle();
    let labels = case.settings_labels();
    assert!(labels.contains(&"Appearance".to_string()));
    assert!(labels.contains(&"Match system".to_string()));
    assert!(!labels.contains(&"Background service".to_string()));
    assert!(!labels.contains(&"Stop and Quit…".to_string()));
    assert!(!case.service.calls.lock().unwrap().contains(&"stop"));
}

fn session_history_retention_is_previewed_but_disabled(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    let mut kept = settings();
    kept["history_retention_days"] = json!(30);
    case.answer("settings.get", check::<method::SettingsGet>(kept));
    case.answer(
        "settings.set",
        Answer::with(|params| async move {
            let mut values = settings();
            values["history_retention_days"] = params["history_retention_days"].clone();
            Ok(values)
        }),
    );
    case.sign_in();
    case.app.go(Page::Settings(Pane::General));
    let choice = || {
        let mut found = None;
        walk(
            case.app.shell().unwrap().settings.column.upcast_ref(),
            &mut |widget| {
                if widget.widget_name() == "history-retention" {
                    found = widget.downcast_ref::<gtk::DropDown>().cloned();
                }
            },
        );
        found
    };
    case.pump(|_| choice().is_some());
    let choice = choice().unwrap();
    assert_eq!(choice.selected(), 1, "30 days unless changed");
    assert!(!choice.is_sensitive(), "retention is not enforced yet");
    let labels = case.settings_labels();
    assert!(
        labels.contains(&"Session history".to_string()),
        "{labels:?}"
    );
    assert!(labels.contains(&"Keep session history (coming soon)".to_string()));
    assert!(labels.contains(
        &"Automatic history removal is not available yet. Agent Relay keeps local session history until you remove it yourself.".to_string()
    ));
    render_session_history(&case, "session-history-gtk-30-days-default");
}

/// With `SETTINGS_RENDER_DIR` set, saves the General pane scrolled to
/// Session history as `<name>.png`, for the change's description.
fn render_session_history(case: &Case, name: &str) {
    let Ok(dir) = std::env::var("SETTINGS_RENDER_DIR") else {
        return;
    };
    case.app.show_window();
    case.app.window().set_default_size(1100, 900);
    case.settle();
    let adjustment = case.app.shell().unwrap().settings.scroller.vadjustment();
    adjustment.set_value(adjustment.upper());
    case.settle();
    std::fs::create_dir_all(&dir).unwrap();
    let window = case.app.window();
    let paintable = gtk::WidgetPaintable::new(Some(window));
    let snapshot = gtk::Snapshot::new();
    paintable.snapshot(&snapshot, window.width() as f64, window.height() as f64);
    let node = snapshot
        .to_node()
        .expect("The mapped shell has a render node");
    window
        .renderer()
        .unwrap()
        .render_texture(&node, None)
        .save_to_png(std::path::Path::new(&dir).join(format!("{name}.png")))
        .unwrap();
}

/// A core without the setting shows no row for it.
fn session_history_retention_is_absent_in_older_cores(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::General));
    case.pump(|case| case.app.with_state(|state| state.settings.is_some()));
    case.settle();
    let labels = case.settings_labels();
    assert!(!labels.contains(&"Keep session history (coming soon)".to_string()));
}

fn appearance_is_remembered(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::General));
    let column = case.app.shell().unwrap().settings.column.clone();
    buttons(&column, "Dark")[0].emit_clicked();
    assert_eq!(
        Preferences::load(case.prefs_path.clone()).appearance(),
        Appearance::Dark
    );
    assert_eq!(case.app.styling().choice(), Appearance::Dark);
    assert_eq!(case.app.styling().theme(), Theme::Dark);
    case.app.set_appearance(Appearance::System);
}

fn a_spawned_agent_is_joined_and_taken_over(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::LocalSessionRow;
    const SESSION: &str = "0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d";
    let spawned = |kind: &str, id: &str, name: &str, spawn: Value| {
        let registration = json!({"name": name, "address": format!("{name}@desk-desktop"),
                                  "added_by_session": false, "push": null, "spawn": spawn});
        let mut session = local_session(kind, id, "Fix CI", true, registration);
        session["directory"] = json!("/work/api");
        session
    };
    let case = Case::with(runtime, |core| {
        core.answer(
            "sessions.list",
            check::<method::SessionsList>(json!({"sessions": [
                spawned("claude-terminal", SESSION, "c1",
                        json!({"harness": "claude", "can_take_over": true, "taken_over": false})),
                spawned("codex", "thread-9", "x1",
                        json!({"harness": "codex", "can_take_over": false, "taken_over": false})),
                spawned("grok", "grok-7", "g1",
                        json!({"harness": "grok", "can_take_over": false, "taken_over": false})),
            ]})),
        );
        core.answer(
            "sessions.transcript",
            check::<method::SessionsTranscript>(json!({"entries": [], "next_cursor": null})),
        );
        core.answer(
            "agents.transcript",
            check::<method::AgentsTranscript>(json!({"entries": [
                {"id": "0.0", "role": "user", "kind": "text", "text": "Fix CI",
                 "image_path": null, "timestamp_ms": 1, "truncated": false},
            ], "next_cursor": null, "follow_cursor": {"ts_ms": 0, "id": 40}})),
        );
        core.answer(
            "agents.take_over",
            check::<method::AgentsTakeOver>(json!({"name": "c1",
                "target": {"kind": "claude-terminal", "id": SESSION},
                "directory": "/work/api", "interrupted": false})),
        );
    });
    // `sign_in` waits for the default three local sessions; this case lists
    // only its three spawned agents.
    case.set_state(workspace_snapshot());
    case.pump(|case| {
        case.app.with_state(|state| {
            state.connected() && state.status.is_some() && state.local_sessions.len() == 3
        })
    });
    let session = |id: &str| {
        case.app.with_state(|state| {
            state
                .local_sessions
                .iter()
                .find(|session| session.target.id == id)
                .cloned()
        })
    };
    case.app.go(Page::Sessions);
    case.app.open_local_session(LocalSessionRow {
        upload: None,
        relay: session(SESSION),
    });
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions.transcript;
    // Joined: its own output is its transcript, followed live, with a
    // message box; it is never resumed beside the headless agent.
    case.pump(|case| !case.called("agents.transcript").is_empty());
    assert_eq!(case.called("agents.transcript")[0]["name"], "c1");
    assert!(case.called("sessions.transcript").is_empty());
    assert!(!page.open.is_visible());
    assert!(page.join.take_over.is_visible());
    assert_eq!(
        page.join.take_over.label().as_deref(),
        Some("Take over in Terminal")
    );
    assert!(page.join.composer.is_visible());
    assert!(page.join.send.has_css_class("primary"));
    assert_eq!(
        page.join.entry.placeholder_text().as_deref(),
        Some("Message @c1")
    );
    case.pump(|case| case.called("agents.transcript").len() >= 2);
    assert_eq!(
        case.called("agents.transcript")[1]["cursor"],
        json!({"ts_ms": 0, "id": 40})
    );
    // Taken over: asked first, then resumed in Terminal in its folder.
    page.join.take_over.emit_clicked();
    case.pump(|case| !case.called("agents.take_over").is_empty());
    assert_eq!(
        case.desktop.asked.borrow().last().unwrap().title,
        "Take over @c1?"
    );
    assert_eq!(case.called("agents.take_over")[0]["interrupt"], false);
    let resume = format!("cd -- '/work/api' && claude --resume '{SESSION}'");
    case.pump(|case| case.desktop.opened.borrow().contains(&resume));
    // A spawned Codex thread opens live in Codex, never in Terminal.
    case.app.open_local_session(LocalSessionRow {
        upload: None,
        relay: session("thread-9"),
    });
    case.pump(|case| case.called("sessions.transcript").len() >= 2);
    let reads = case.called("sessions.transcript");
    assert_eq!(reads[0]["following"], false);
    assert_eq!(reads[1]["following"], true);
    assert!(reads[1].get("cursor").is_none_or(Value::is_null));
    page.refresh.emit_clicked();
    case.pump(|case| case.called("sessions.transcript").len() > reads.len());
    assert_eq!(
        case.called("sessions.transcript")[reads.len()]["following"],
        false
    );
    assert!(!page.join.take_over.is_visible());
    assert!(page.join.composer.is_visible());
    assert_eq!(page.open.label().as_deref(), Some("Open in Codex"));
    assert_eq!(
        page.join.note.text(),
        agent_relay_probe::linux_app::models::SPAWN_CODEX_HOSTED
    );
    page.open.emit_clicked();
    assert_eq!(
        case.desktop.opened.borrow().last().unwrap(),
        "codex://threads/thread-9"
    );
    case.desktop.codex_installed.set(false);
    case.app.open_local_session(LocalSessionRow {
        upload: None,
        relay: session("thread-9"),
    });
    assert_eq!(page.open.label().as_deref(), Some("Open in Codex"));
    let opened = case.desktop.opened.borrow().len();
    page.open.emit_clicked();
    assert_eq!(case.desktop.opened.borrow().len(), opened);
    assert_eq!(case.app.page(), Page::Sessions);
    // A spawned Grok session has no app to open it live: it is never resumed
    // in Terminal beside the leader that runs it. Another session's draft is
    // not carried over to it.
    page.join.entry.set_text("for x1");
    case.app.open_local_session(LocalSessionRow {
        upload: None,
        relay: session("grok-7"),
    });
    assert!(!page.open.is_visible());
    assert!(!page.join.take_over.is_visible());
    assert!(page.join.composer.is_visible());
    assert_eq!(page.join.entry.text(), "");
    assert_eq!(
        page.join.note.text(),
        agent_relay_probe::linux_app::models::SPAWN_HOSTED
    );
}

fn session_opening_settings_route_clicks(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::LocalSessionRow;
    use agent_relay_probe::linux_app::prefs::SessionOpenPreference;
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::Opening));
    assert!(case
        .settings_labels()
        .contains(&"Codex is installed".into()));
    assert!(case.settings_labels().contains(
        &"Claude Desktop handoff isn’t supported on Linux. Sessions open in Terminal.".into()
    ));
    let choose = |selection| {
        let mut found = None;
        walk(case.app.window().upcast_ref(), &mut |widget| {
            if widget.widget_name() == "session-opening-codex" {
                found = widget.downcast_ref::<gtk::DropDown>().cloned();
            }
        });
        found.unwrap().set_selected(selection);
    };
    choose(1);
    assert_eq!(
        Preferences::load(case.prefs_path.clone()).session_opening("codex"),
        SessionOpenPreference::Terminal
    );
    let row = LocalSessionRow {
        upload: Some(
            serde_json::from_value(upload_row(
                "codex",
                "one",
                "Fix login",
                "/w/api",
                true,
                "uploaded",
            ))
            .unwrap(),
        ),
        relay: None,
    };
    case.app.go(Page::Sessions);
    case.app.open_local_session(row.clone());
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions.transcript;
    assert!(page.view_web.is_visible());
    page.view_web.emit_clicked();
    let site = case
        .app
        .with_state(|state| state.account().site_url.unwrap());
    assert_eq!(
        case.desktop.opened.borrow().last(),
        agent_relay_probe::linux_app::models::cloud_session_url(&site, "one").as_ref()
    );
    assert_eq!(page.open.label().as_deref(), Some("Open in Terminal"));
    page.open.emit_clicked();
    assert_eq!(
        case.desktop.opened.borrow().last().unwrap(),
        "cd -- '/w/api' && codex resume 'one'"
    );
    case.app.go(Page::Settings(Pane::Opening));
    assert_eq!(case.app.page(), Page::Settings(Pane::Opening));
    choose(0);
    case.desktop.codex_installed.set(false);
    buttons(&shell.settings.column, "Check installed apps")[0].emit_clicked();
    assert!(case
        .settings_labels()
        .contains(&"Codex isn’t installed. Sessions open in Terminal.".into()));
    case.app.go(Page::Sessions);
    case.app.open_local_session(row.clone());
    assert_eq!(page.open.label().as_deref(), Some("Open in Terminal"));
    page.open.emit_clicked();
    assert_eq!(
        case.desktop.opened.borrow().last().unwrap(),
        "cd -- '/w/api' && codex resume 'one'"
    );
    case.desktop.codex_installed.set(true);
    case.app.open_local_session(row);
    assert_eq!(page.open.label().as_deref(), Some("Open in Codex"));
    assert_eq!(page.open.tooltip_text().as_deref(), Some("Open in Codex"));
    page.open.emit_clicked();
    assert_eq!(
        case.desktop.opened.borrow().last().unwrap(),
        "codex://threads/one"
    );
    case.app.open_local_session(LocalSessionRow {
        upload: Some(
            serde_json::from_value(upload_row(
                "claude",
                "two",
                "Docs",
                "/w/web",
                false,
                "not_shared",
            ))
            .unwrap(),
        ),
        relay: None,
    });
    assert!(!page.view_web.is_visible());
    assert!(case.called("uploader.sessions.include").is_empty());
}

fn capacity_notice_names_the_plan_and_opens_billing(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let mut free = workspace_snapshot();
    free["workspace"]["workspace_plan"] = json!("free");
    case.set_state(free);
    case.pump(|case| {
        case.app.with_state(|state| {
            state.snapshot.as_ref().is_some_and(|snapshot| {
                snapshot.workspace.workspace_plan.as_deref() == Some("free")
            })
        })
    });
    case.app.show_window();
    // As the request log records an SDK error: Relaycast's plan fields do
    // not survive the SDK, so the plan comes from workspace verification.
    let busy = |id: &str| {
        json!({
            "id": id, "started_at_ms": chrono::Utc::now().timestamp_millis(),
            "service": "Relaycast", "method": "SDK:send_dm", "endpoint": "https://cast.agentrelay.com/v1/dm",
            "request": "{}",
            "response": "{\"error_code\":\"workspace_busy\",\"message\":\"Workspace write capacity is busy; retry with backoff\",\"request_id\":null,\"attempts\":3,\"retry_after_ms\":2000}",
            "status": 429, "duration_ms": 5046, "failed": true
        })
    };
    case.core.answer(
        "diagnostics.requests",
        json!({"entries": [busy("busy-1"), busy("busy-2")]}),
    );
    case.app.refresh_request_log();
    case.pump(|case| !case.app.with_state(|state| state.reading_requests));
    assert!(
        case.app
            .with_state(|state| state.relaycast_upgrade.is_none()),
        "Two busy answers are ordinary contention"
    );
    case.core.answer(
        "diagnostics.requests",
        json!({"entries": [busy("busy-1"), busy("busy-2"), busy("busy-3")]}),
    );
    case.app.refresh_request_log();
    case.pump(|case| {
        case.app
            .with_state(|state| state.relaycast_upgrade.is_some())
    });
    let shell = case.app.shell().unwrap();
    assert!(shell.upgrade_notice.is_visible());
    let texts = labels(&shell.upgrade_notice);
    assert!(texts.contains(&"Workspace at capacity".into()));
    assert!(texts.contains(&"Your team is using all of the Free plan’s write capacity, so messages may be delayed while Agent Relay retries. Upgrade to raise your workspace’s capacity.".into()));
    let site = case
        .app
        .with_state(|state| state.account().site_url.unwrap());
    buttons(&shell.upgrade_notice, "Review upgrade")[0].emit_clicked();
    assert_eq!(
        case.desktop.opened.borrow().last(),
        agent_relay_probe::linux_app::models::relaycast_billing_url(
            &site,
            &agent_relay_probe::linux_app::models::RelaycastUpgradeReason::Capacity {
                plan: "free".into()
            },
        )
        .as_ref()
    );
    assert!(!shell.upgrade_notice.is_visible());
}

fn quota_notice_opens_billing_and_suppresses_repeats(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.show_window();
    let quota = |id: &str| {
        json!({"entries": [{
            "id": id, "started_at_ms": chrono::Utc::now().timestamp_millis(),
            "service": "Relaycast", "method": "GET", "endpoint": "https://cast.agentrelay.com/v1/workspace",
            "request": "null", "response": "{\"error_code\":\"plan_limit_exceeded\"}",
            "status": 429, "duration_ms": 244, "failed": true
        }]})
    };
    case.core.answer("diagnostics.requests", quota("quota-1"));
    case.app.refresh_request_log();
    case.pump(|case| {
        case.app
            .with_state(|state| state.relaycast_upgrade.is_some())
    });
    let shell = case.app.shell().unwrap();
    assert!(shell.upgrade_notice.is_visible());
    assert!(labels(&shell.upgrade_notice).contains(&"Agent Relay plan limit reached".into()));
    let site = case
        .app
        .with_state(|state| state.account().site_url.unwrap());
    buttons(&shell.upgrade_notice, "Review upgrade")[0].emit_clicked();
    assert_eq!(
        case.desktop.opened.borrow().last(),
        agent_relay_probe::linux_app::models::relaycast_billing_url(
            &site,
            &agent_relay_probe::linux_app::models::RelaycastUpgradeReason::PlanLimit,
        )
        .as_ref()
    );
    assert!(!shell.upgrade_notice.is_visible());
    case.core.answer("diagnostics.requests", quota("quota-2"));
    case.app.refresh_request_log();
    case.pump(|case| !case.app.with_state(|state| state.reading_requests));
    assert!(!shell.upgrade_notice.is_visible());
}

fn quota_notice_resets_on_workspace_change(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let quota = |id: &str| json!({"entries":[{"id":id,"started_at_ms":chrono::Utc::now().timestamp_millis(),"service":"Relaycast","method":"GET","endpoint":"https://cast.agentrelay.com/v1/workspace","request":"null","response":"{\"error_code\":\"plan_limit_exceeded\"}","status":429,"failed":true}]});
    case.core
        .answer("diagnostics.requests", quota("identity-quota-1"));
    case.app.refresh_request_log();
    case.pump(|case| !case.app.with_state(|state| state.reading_requests));
    assert!(case
        .app
        .with_state(|state| state.relaycast_upgrade.is_some()));
    let mut next = workspace_snapshot();
    next["account"]["workspace_id"] = json!("another-workspace");
    case.set_state(next);
    case.pump(|case| {
        case.app.with_state(|state| {
            state.account().workspace_id.as_deref() == Some("another-workspace")
        })
    });
    assert!(
        !case
            .app
            .with_state(|state| state.relaycast_upgrade.is_some()),
        "Previous workspace's notice must clear"
    );
    case.core
        .answer("diagnostics.requests", quota("identity-quota-2"));
    case.app.refresh_request_log();
    case.pump(|case| !case.app.with_state(|state| state.reading_requests));
    assert!(
        case.app
            .with_state(|state| state.relaycast_upgrade.is_some()),
        "Fresh quota must not inherit the old workspace cooldown"
    );
}

fn quota_notice_ignores_old_workspace_poll(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    case.core.answer("diagnostics.requests", Answer::with(move |_| {
        let gate = gate.clone();
        async move {
            gate.notified().await;
            Ok(json!({"entries":[{"id":"held-quota","started_at_ms":chrono::Utc::now().timestamp_millis(),"service":"Relaycast","method":"GET","endpoint":"https://cast.agentrelay.com/v1/workspace","request":"null","response":"{\"error_code\":\"plan_limit_exceeded\"}","status":429,"failed":true}]}))
        }
    }));
    case.app.refresh_request_log();
    case.pump(|case| !case.called("diagnostics.requests").is_empty());
    let mut next = workspace_snapshot();
    next["account"]["workspace_id"] = json!("another-workspace");
    case.set_state(next);
    case.pump(|case| {
        case.app.with_state(|state| {
            state.account().workspace_id.as_deref() == Some("another-workspace")
        })
    });
    release.notify_one();
    case.pump(|case| !case.app.with_state(|state| state.reading_requests));
    assert!(
        !case
            .app
            .with_state(|state| state.relaycast_upgrade.is_some()),
        "Delayed old-workspace poll must not reopen its notice"
    );
}

fn quota_notice_ignores_unseen_pre_identity_entry(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let old_started_at_ms = chrono::Utc::now().timestamp_millis() - 1000;
    let mut next = workspace_snapshot();
    next["account"]["workspace_id"] = json!("another-workspace");
    case.set_state(next);
    case.pump(|case| {
        case.app.with_state(|state| {
            state.account().workspace_id.as_deref() == Some("another-workspace")
        })
    });
    let quota = |id: &str, started: i64| json!({"entries":[{"id":id,"started_at_ms":started,"service":"Relaycast","method":"GET","endpoint":"https://cast.agentrelay.com/v1/workspace","request":"null","response":"{\"error_code\":\"plan_limit_exceeded\"}","status":429,"failed":true}]});
    case.core.answer(
        "diagnostics.requests",
        quota("unseen-old-quota", old_started_at_ms),
    );
    case.app.refresh_request_log();
    case.pump(|case| !case.app.with_state(|state| state.reading_requests));
    assert!(
        !case
            .app
            .with_state(|state| state.relaycast_upgrade.is_some()),
        "Unseen pre-identity log entry cannot belong to the new workspace"
    );
    case.core.answer(
        "diagnostics.requests",
        quota("new-workspace-quota", chrono::Utc::now().timestamp_millis()),
    );
    case.app.refresh_request_log();
    case.pump(|case| !case.app.with_state(|state| state.reading_requests));
    assert!(case
        .app
        .with_state(|state| state.relaycast_upgrade.is_some()));
}

fn request_failures_link_to_exact_entry(runtime: &tokio::runtime::Runtime) {
    let case = Case::with(runtime, |core| {
        let mut status = uploader();
        status["stage"] = json!("up_to_date");
        status["delivery"]["pending_records"] = json!(0);
        core.answer("uploader.status", status);
    });
    case.sign_in();
    case.app.show_window();
    case.settle();
    let entry = json!({"id":"failure-42", "started_at_ms":123, "service":"Relaycast", "method":"GET",
        "endpoint":"https://cast.agentrelay.com/v1/workspace", "request":"null", "response":"workspace unavailable",
        "status":503, "duration_ms":40, "failed":true});
    let mut entries = (0..30)
        .map(|index| {
            json!({"id":format!("success-{index}"), "started_at_ms":456,
        "service":"Cloud", "method":"GET", "endpoint":"https://agentrelay.com/api/workspace",
        "request":"null", "response":"{}", "status":200, "duration_ms":10, "failed":false})
        })
        .collect::<Vec<_>>();
    entries.push(entry);
    case.core
        .answer("diagnostics.requests", json!({"entries":entries}));
    case.app.refresh_request_log();
    case.pump(|case| case.app.with_state(|state| state.request_failure.is_some()));
    let shell = case.app.shell().unwrap();
    assert_eq!(shell.status_text.text(), "Agent Relay request failed");
    assert!(shell.status_dot.widget.has_css_class("dot-orange"));
    let status_button = shell
        .status_text
        .ancestor(gtk::Button::static_type())
        .unwrap()
        .downcast::<gtk::Button>()
        .unwrap();
    assert_eq!(status_button.widget_name(), "app-status");
    status_button.emit_clicked();
    assert_eq!(case.app.page(), Page::Settings(Pane::Diagnostics));
    assert_eq!(
        case.app.with_state(|state| state
            .selected_request
            .as_ref()
            .map(|entry| entry.id.clone())),
        Some("failure-42".into())
    );
    let mut expanded = false;
    walk(shell.settings.column.upcast_ref(), &mut |widget| {
        if widget.widget_name() == "failure-42" {
            expanded = widget
                .downcast_ref::<gtk::Expander>()
                .unwrap()
                .is_expanded();
        }
    });
    assert!(expanded);
    assert!(!case
        .settings_labels()
        .iter()
        .any(|text| text.contains("Recent Relaycast")));
    case.pump(|case| {
        case.app
            .shell()
            .unwrap()
            .settings
            .scroller
            .vadjustment()
            .value()
            > 100.0
    });
    let available_width = shell.settings.scroller.width();
    assert!(
        shell.settings.column.width() >= available_width - 60,
        "Diagnostics must fill the available width"
    );
    case.app.refresh_request_log();
    case.pump(|case| !case.app.with_state(|state| state.reading_requests));
    assert_eq!(shell.status_text.text(), "Uploads up to date");
    assert!(shell.status_dot.widget.has_css_class("dot-green"));
    case.core
        .answer("diagnostics.requests", json!({"entries":[]}));
    case.app.refresh_request_log();
    case.pump(|case| {
        case.app
            .with_state(|state| state.request_entries.is_empty())
    });
    assert!(case
        .settings_labels()
        .iter()
        .any(|text| text.contains("workspace unavailable")));
    walk(shell.settings.column.upcast_ref(), &mut |widget| {
        if widget.widget_name() == "failure-42" {
            let row = widget.downcast_ref::<gtk::Expander>().unwrap();
            let label = row.label_widget().unwrap();
            assert!(
                label.width() >= row.width() - 50,
                "The clickable header must span the request row"
            );
            row.emit_by_name::<()>("activate", &[]);
            assert!(!row.is_expanded());
            row.emit_by_name::<()>("activate", &[]);
            assert!(row.is_expanded());
        }
    });
    case.core.answer(
        "diagnostics.requests",
        json!({"entries":[{
            "id":"identity-403", "started_at_ms":789, "service":"Cloud", "method":"PUT",
            "endpoint":"https://agentrelay.com/cloud/api/v1/workspaces/ws/messaging/desktop-identities",
            "request":"{}", "response":"{}", "status":403, "duration_ms":20, "failed":true
        }]}),
    );
    case.app.refresh_request_log();
    case.pump(|case| case.app.with_state(|state| state.request_failure.is_some()));
    assert_eq!(shell.status_text.text(), "Agents couldn't link to Cloud");
}

fn about_copies_diagnostics_without_secrets(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::About));
    assert!(case.settings_labels().contains(&"Check now".to_string()));
    assert!(!case
        .settings_labels()
        .contains(&"Diagnostic report".to_string()));
    case.app.go(Page::Settings(Pane::Diagnostics));
    let shown = case.settings_labels();
    assert!(
        shown.contains(&"Diagnostic report".to_string()),
        "{shown:?}"
    );
    assert!(shown.contains(&"Open log file".to_string()));
    let column = case.app.shell().unwrap().settings.column.clone();
    let expanders = || {
        let mut found = Vec::new();
        walk(column.upcast_ref(), &mut |widget| {
            if let Some(expander) = widget.downcast_ref::<gtk::Expander>() {
                found.push(expander.clone());
            }
        });
        found
    };
    assert_eq!(expanders().len(), 3);
    expanders()[0].set_expanded(true);
    case.app.render_settings();
    assert!(
        expanders()[0].is_expanded(),
        "Refreshing preserves the section being read"
    );
    assert!(!shown.contains(&"Check now".to_string()));
    let report = agent_relay_probe::linux_app::models::diagnostics_report(&case.app.diagnostics());
    assert!(report.contains("Running · starts at login"), "{report}");
    assert!(!report.contains("ada@example.com"));
}

// ShowRelayMessagesTests (wording, off by default, settings.set).
fn show_relay_messages_hidden_and_turn_on(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| case.app.with_state(|state| state.settings.is_some()));
    case.settle();
    let shown = case.settings_labels();
    for title in [SHOW_RELAY_MESSAGES_TITLE, SHOW_RELAY_MESSAGES_DETAIL] {
        assert!(shown.contains(&title.to_string()), "{title} in {shown:?}");
    }
    assert_eq!(SHOW_RELAY_MESSAGES_TITLE, "Show me relay messages in full");
    assert_eq!(
        SHOW_RELAY_MESSAGES_DETAIL,
        "Relay messages are hidden from you, or shown as a short pointer in a terminal. The agent still gets each one in full and can reply."
    );
    let on = buttons(case.app.window(), "Turn On")
        .into_iter()
        .find(|button| button.tooltip_text().as_deref() == Some(SHOW_RELAY_MESSAGES_TURN_ON_HELP))
        .expect("the show relay messages row has Turn On");
    on.emit_clicked();
    case.pump(|case| !case.called("settings.set").is_empty());
    assert_eq!(
        case.called("settings.set")[0],
        json!({"show_relay_messages": true})
    );
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.show_relay_messages)
                == Some(true)
        })
    });
}

// AutoJoinGeneralTests (wording, off by default, settings.set) and the
// agents' changes, read again when the core says an agent changed a setting.
fn auto_join_general_turns_on_and_agent_changes_show(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| case.app.with_state(|state| state.settings.is_some()));
    case.settle();
    let shown = case.settings_labels();
    for title in [AUTO_JOIN_GENERAL_TITLE, AUTO_JOIN_GENERAL_DETAIL] {
        assert!(shown.contains(&title.to_string()), "{title} in {shown:?}");
    }
    assert_eq!(AUTO_JOIN_GENERAL_TITLE, "New agents join #general");
    assert!(
        !shown.contains(&AGENT_CHANGES_TITLE.to_string()),
        "none yet"
    );
    let on = buttons(case.app.window(), "Turn On")
        .into_iter()
        .find(|button| button.tooltip_text().as_deref() == Some(AUTO_JOIN_GENERAL_TURN_ON_HELP))
        .expect("the #general row has Turn On");
    on.emit_clicked();
    case.pump(|case| !case.called("settings.set").is_empty());
    assert_eq!(
        case.called("settings.set")[0],
        json!({"auto_join_general": true})
    );
    case.pump(|case| {
        case.app.with_state(|state| {
            state.settings.as_ref().and_then(|s| s.auto_join_general) == Some(true)
        })
    });
    // An agent turns it on through the session socket: the core invalidates
    // the settings, and Settings reads them again and lists the change.
    let mut changed = settings();
    changed["auto_join_general"] = json!(true);
    changed["agent_changes"] = json!([{"at": "2026-10-16T12:02:00Z", "by": "api",
        "key": "auto_join_general", "from": "false", "to": "true"}]);
    case.answer("settings.get", check::<method::SettingsGet>(changed));
    let reads = case.called("settings.get").len();
    case.emit("invalidated", json!({"what": "settings"}));
    case.pump(|case| case.called("settings.get").len() > reads);
    // The Turn On reply already shows it joined; wait for the re-read's
    // record of the agent's change.
    case.pump(|case| {
        case.settings_labels()
            .contains(&AGENT_CHANGES_TITLE.to_string())
    });
    let shown = case.settings_labels();
    assert!(
        shown.contains(&AUTO_JOIN_GENERAL_JOINED_DETAIL.to_string()),
        "{shown:?}"
    );
    assert!(
        shown.contains(&AGENT_CHANGES_TITLE.to_string()),
        "{shown:?}"
    );
    assert!(
        shown
            .iter()
            .any(|line| line.starts_with("api changed auto_join_general from false to true")),
        "{shown:?}"
    );
}

// OpenClawToolsCopyTests (wording, the row under OpenClaw's, Connect opens
// the consent page, the row follows the login until it is connected).
fn openclaw_agents_connect_agent_relay_tools(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::{
        OPENCLAW_TITLE, OPENCLAW_TOOLS_CONNECTED, OPENCLAW_TOOLS_NOT_CONNECTED,
        OPENCLAW_TOOLS_TITLE, OPENCLAW_TOOLS_WAITING,
    };
    let case = Case::new(runtime);
    let mut on = settings();
    on["openclaw_gateway"] = json!(true);
    case.answer("settings.get", check::<method::SettingsGet>(on));
    case.answer(
        "openclaw.relay_tools.status",
        check::<method::OpenclawRelayToolsStatus>(
            json!({"state": "not_connected", "detail": null}),
        ),
    );
    let consent = "https://agentrelay.com/oauth/authorize?state=0123456789abcdef";
    case.answer(
        "openclaw.relay_tools.connect",
        check::<method::OpenclawRelayToolsConnect>(
            json!({"state": "waiting", "authorization_url": consent}),
        ),
    );
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| {
        case.settings_labels()
            .contains(&OPENCLAW_TOOLS_NOT_CONNECTED.to_string())
    });
    let shown = case.settings_labels();
    let title = shown.iter().position(|label| label == OPENCLAW_TOOLS_TITLE);
    let openclaw = shown.iter().position(|label| label == OPENCLAW_TITLE);
    assert!(openclaw < title, "below OpenClaw's row: {shown:?}");
    let connect = buttons(&case.app.shell().unwrap().settings.column, "Connect");
    assert_eq!(connect.len(), 1);
    assert!(connect[0].has_css_class("primary"));
    // The login waits for the browser; the row reads the status again
    // until it is connected.
    case.answer(
        "openclaw.relay_tools.status",
        check::<method::OpenclawRelayToolsStatus>(json!({"state": "waiting", "detail": null})),
    );
    connect[0].emit_clicked();
    case.pump(|case| case.desktop.opened.borrow().contains(&consent.to_string()));
    case.pump(|case| {
        case.settings_labels()
            .contains(&OPENCLAW_TOOLS_WAITING.to_string())
    });
    let again = buttons(&case.app.shell().unwrap().settings.column, "Open Again");
    assert_eq!(again.len(), 1);
    assert!(!again[0].has_css_class("primary"));
    case.answer(
        "openclaw.relay_tools.status",
        check::<method::OpenclawRelayToolsStatus>(json!({"state": "connected", "detail": null})),
    );
    case.pump(|case| {
        case.settings_labels()
            .contains(&OPENCLAW_TOOLS_CONNECTED.to_string())
    });
    assert!(buttons(&case.app.shell().unwrap().settings.column, "Open Again").is_empty());
}

/// A failed Connect keeps the row and its button, with why under it, as on
/// the Mac.
fn a_failed_openclaw_tools_connect_keeps_the_row(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::OPENCLAW_TOOLS_NOT_CONNECTED;
    let case = Case::new(runtime);
    let mut on = settings();
    on["openclaw_gateway"] = json!(true);
    case.answer("settings.get", check::<method::SettingsGet>(on));
    case.answer(
        "openclaw.relay_tools.status",
        check::<method::OpenclawRelayToolsStatus>(
            json!({"state": "not_connected", "detail": null}),
        ),
    );
    let failed = "OpenClaw couldn't finish signing in. Try Connect again.";
    case.answer(
        "openclaw.relay_tools.connect",
        Answer::fail(ErrorKind::Refused, failed),
    );
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| {
        case.settings_labels()
            .contains(&OPENCLAW_TOOLS_NOT_CONNECTED.to_string())
    });
    // The read after the failure never answers: the row must not wait for
    // it to show the error and the button.
    case.answer(
        "openclaw.relay_tools.status",
        Answer::with(|_| async { std::future::pending::<Result<Value, RpcError>>().await }),
    );
    let reads = case.called("openclaw.relay_tools.status").len();
    buttons(&case.app.shell().unwrap().settings.column, "Connect")[0].emit_clicked();
    case.pump(|case| case.settings_labels().contains(&failed.to_string()));
    let shown = case.settings_labels();
    assert!(
        shown.contains(&OPENCLAW_TOOLS_NOT_CONNECTED.to_string()),
        "{shown:?}"
    );
    let connect = buttons(&case.app.shell().unwrap().settings.column, "Connect");
    assert_eq!(connect.len(), 1, "the button stays");
    assert!(connect[0].is_sensitive());
    // The status is asked again after the failure.
    case.pump(|case| case.called("openclaw.relay_tools.status").len() > reads);
}

/// An OpenClaw Gateway older than 2026.8.1 cannot limit relay sessions:
/// its row says so while it is on, naming the version, and not otherwise.
fn an_old_openclaw_says_relay_sessions_are_not_limited(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::{openclaw_unlimited_notice, OPENCLAW_TITLE};
    let notice = openclaw_unlimited_notice("2026.3.13");
    let case = Case::new(runtime);
    let mut old = settings();
    old["openclaw_gateway"] = json!(true);
    old["openclaw_unlimited_version"] = json!("2026.3.13");
    case.answer("settings.get", check::<method::SettingsGet>(old.clone()));
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| case.settings_labels().contains(&OPENCLAW_TITLE.to_string()));
    case.pump(|case| case.settings_labels().contains(&notice));
    // Turned off, the Gateway is not used: nothing to warn about.
    old["openclaw_gateway"] = json!(false);
    case.answer("settings.get", check::<method::SettingsGet>(old.clone()));
    let reads = case.called("settings.get").len();
    case.emit("invalidated", json!({"what": "settings"}));
    case.pump(|case| case.called("settings.get").len() > reads);
    case.pump(|case| !case.settings_labels().contains(&notice));
    // A Gateway that limits them: no notice.
    old["openclaw_gateway"] = json!(true);
    old.as_object_mut()
        .unwrap()
        .remove("openclaw_unlimited_version");
    case.answer("settings.get", check::<method::SettingsGet>(old));
    let reads = case.called("settings.get").len();
    case.emit("invalidated", json!({"what": "settings"}));
    case.pump(|case| case.called("settings.get").len() > reads);
    case.settle();
    let shown = case.settings_labels();
    assert!(shown.contains(&OPENCLAW_TITLE.to_string()), "{shown:?}");
    assert!(
        !shown
            .iter()
            .any(|line| line.contains("can't limit relay sessions")),
        "{shown:?}"
    );
}

fn spawned_agents_have_an_optional_cap(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    let mut spawning = settings();
    spawning["accept_spawns"] = json!(true);
    spawning["spawn_max_agents"] = json!(0);
    case.answer("settings.get", check::<method::SettingsGet>(spawning));
    case.answer(
        "settings.set",
        Answer::with(|params| async move {
            let mut values = settings();
            values["accept_spawns"] = json!(true);
            values["spawn_max_agents"] = params["spawn_max_agents"].clone();
            Ok(values)
        }),
    );
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    let cap = || {
        let mut found = None;
        walk(
            case.app.shell().unwrap().settings.column.upcast_ref(),
            &mut |widget| {
                if let Some(entry) = widget.downcast_ref::<gtk::Entry>() {
                    if entry.placeholder_text().as_deref() == Some("No limit") {
                        found = Some(entry.clone());
                    }
                }
            },
        );
        found
    };
    case.pump(|_| cap().is_some());
    let entry = cap().unwrap();
    assert_eq!(entry.text(), "");
    entry.grab_focus();
    entry.set_text("1");
    case.app.render_settings();
    case.settle();
    assert!(
        case.called("settings.set").is_empty(),
        "redraw must not save a partial cap"
    );
    assert_eq!(
        cap().unwrap().text(),
        "1",
        "redraw preserves the unsaved text"
    );
    let entry = cap().unwrap();
    entry.set_text("12");
    entry.emit_activate();
    case.pump(|case| {
        case.called("settings.set")
            .iter()
            .any(|v| v["spawn_max_agents"] == 12)
    });
    // The cap reads as 12 from the click; the next save waits for the
    // core's answer to this one.
    case.pump(|case| {
        case.app.with_state(|state| {
            state.settings.as_ref().and_then(|s| s.spawn_max_agents) == Some(12)
                && !state.spawn_cap.saving
        })
    });
    let entry = cap().unwrap();
    entry.set_text("");
    let save = buttons(&entry.parent().unwrap(), "Save");
    assert_eq!(save.len(), 1);
    assert!(save[0].has_css_class("primary"));
    save[0].emit_clicked();
    case.pump(|case| {
        case.called("settings.set")
            .iter()
            .any(|v| v["spawn_max_agents"] == 0)
    });
    // The optimistic value appears before the save answers. Wait until the
    // field accepts another submission before trying the refused change.
    case.pump(|case| {
        case.app.with_state(|state| {
            state.settings.as_ref().and_then(|s| s.spawn_max_agents) == Some(0)
                && !state.spawn_cap.saving
        })
    });
    case.answer(
        "settings.set",
        fail(ErrorKind::Refused, "Could not save the cap."),
    );
    let entry = cap().unwrap();
    entry.set_text("2");
    entry.emit_activate();
    case.pump(|case| {
        case.settings_labels()
            .contains(&"Could not save the cap.".to_string())
    });
    assert_eq!(cap().unwrap().text(), "", "failed save restores no limit");
}

fn spawned_agents_can_let_teammates_spawn_here(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::{SPAWN_TEAMMATES_DETAIL, SPAWN_TEAMMATES_TITLE};
    let case = Case::new(runtime);
    let mut spawning = settings();
    spawning["accept_spawns"] = json!(true);
    spawning["spawn_allow_teammates"] = json!(false);
    case.answer(
        "settings.get",
        check::<method::SettingsGet>(spawning.clone()),
    );
    // What the core answers once teammates are let in.
    spawning["spawn_allow_teammates"] = json!(true);
    case.answer("settings.set", check::<method::SettingsSet>(spawning));
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| {
        case.settings_labels()
            .contains(&SPAWN_TEAMMATES_TITLE.to_string())
    });
    assert!(case
        .settings_labels()
        .contains(&SPAWN_TEAMMATES_DETAIL.to_string()));
    // The switch on the row that names it.
    let mut found = Vec::new();
    walk(
        case.app.shell().unwrap().settings.column.upcast_ref(),
        &mut |widget| {
            if let Some(switch) = widget.downcast_ref::<gtk::Switch>() {
                // The switch sits in its holder (with its spinner while a
                // change is on its way) on its row.
                let row = switch
                    .parent()
                    .and_then(|holder| holder.parent())
                    .expect("a switch sits on its row");
                if labels(&row).contains(&SPAWN_TEAMMATES_TITLE.to_string()) {
                    found.push(switch.clone());
                }
            }
        },
    );
    assert_eq!(found.len(), 1, "one teammates switch");
    assert!(!found[0].is_active(), "off unless turned on");
    found[0].set_active(true);
    case.pump(|case| !case.called("settings.set").is_empty());
    assert_eq!(
        case.called("settings.set")[0],
        json!({"spawn_allow_teammates": true})
    );
    // A failed claim says why under the toggle, with Retry.
    let mut failing = workspace_snapshot();
    failing["spawn"] = json!({"state": "live", "node_name": "test-desktop",
        "harnesses": ["codex"], "error": null,
        "claim": {"state": "failed", "note": "Agent Relay could not be reached."}});
    case.answer(
        "spawn.claim.retry",
        check::<method::SpawnClaimRetry>(json!({})),
    );
    case.set_state(failing);
    let line = "Not claimed yet: no agent can be spawned on this computer through Agent Relay Cloud until it is. Agent Relay could not be reached.";
    case.pump(|case| case.settings_labels().contains(&line.to_string()));
    let retry = buttons(&case.app.shell().unwrap().settings.column, "Retry");
    assert_eq!(retry.len(), 1);
    assert!(retry[0].has_css_class("primary"));
    retry[0].emit_clicked();
    case.pump(|case| !case.called("spawn.claim.retry").is_empty());
}

fn relay_settings_deliver_directly_and_answer_incoming(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| {
        case.app
            .with_state(|state| state.incoming.is_some() && state.claude_delivery.is_some())
    });
    case.settle();
    let approvals = || {
        let mut found = None;
        walk(
            case.app.shell().unwrap().settings.column.upcast_ref(),
            &mut |widget| {
                if let Some(expander) = widget.downcast_ref::<gtk::Expander>() {
                    if expander.label().as_deref() == Some("Claude Code message approvals") {
                        found = Some(expander.clone());
                    }
                }
            },
        );
        found.expect("Claude approvals disclosure")
    };
    assert!(!approvals().is_expanded());
    approvals().set_expanded(true);
    case.app.render_settings();
    assert!(
        approvals().is_expanded(),
        "keep approvals open across refreshes"
    );
    approvals().set_expanded(false);
    case.app.render_settings();
    assert!(
        !approvals().is_expanded(),
        "keep approvals collapsed across refreshes"
    );
    approvals().set_expanded(true);

    let shown = case.settings_labels();
    for title in [
        "Workspace from your Agent Relay account",
        "Claude Code delivery",
        "Claude Code message approvals",
        "Only allowed members may deliver directly",
        "Approve once",
        "Always allow",
        "Dismiss",
        "Claude Code activation",
        "A Claude Code session stays off the relay until you put it on. Turn this on to add a SessionStart hook to each Claude login's settings.json. When a session is not on the relay, the hook has Claude ask you whether to put it on the relay and under what name. Nothing is registered unless you say yes.",
        "Grok sessions",
        "OpenCode sessions",
        "Devin sessions",
        "Release",
        "Claude Code folders",
        "/srv/m/.seclaude",
        "Seen on a running session",
        "/opt/claude",
        "Added here",
        "Claude Code cloud sessions",
        "Also upload your claude.ai cloud sessions, read with the Claude Code login in ~/.claude while that folder is shared.",
    ] {
        assert!(shown.contains(&title.to_string()), "{title} in {shown:?}");
    }
    // The added folder's row is removable. The approvals section may also
    // have a Remove button for an allowed sender, so identify the folder by
    // the full-path tooltip on its row.
    let remove = buttons(case.app.window(), "Remove")
        .into_iter()
        .find(|button| {
            let mut ancestor = button.clone().upcast::<gtk::Widget>().parent();
            while let Some(widget) = ancestor {
                if widget.tooltip_text().as_deref() == Some("/opt/claude") {
                    return true;
                }
                ancestor = widget.parent();
            }
            false
        })
        .expect("the added Claude folder has a Remove button");
    remove.emit_clicked();
    case.pump(|case| !case.called("settings.set").is_empty());
    assert_eq!(
        case.called("settings.set")[0],
        json!({"claude_config_dirs": []})
    );
    case.pump(|case| !case.settings_labels().contains(&"/opt/claude".to_string()));
    // Only ~/.seclaude is shared: the default folder is turned off.
    case.app.share_claude_folder("/srv/m/.claude", false);
    case.pump(|case| case.called("settings.set").len() > 1);
    assert_eq!(
        case.called("settings.set")[1],
        json!({"claude_config_dir": {"path": "/srv/m/.claude", "shared": false}})
    );
    case.pump(|case| {
        case.settings_labels()
            .contains(&"Default · Not shared".to_string())
    });
    case.app.set_claude_cloud_sessions(true);
    case.pump(|case| case.called("settings.set").len() > 2);
    assert_eq!(
        case.called("settings.set")[2],
        json!({"claude_cloud_sessions": true})
    );
    case.app.confirm_direct_delivery();
    case.pump(|case| case.called("settings.set").len() > 3);
    assert_eq!(
        case.called("settings.set")[3],
        json!({"direct_delivery": true})
    );
    case.app.confirm_grok_leader();
    // The setting reads as on from the confirmation; the core's call follows.
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.grok_leader)
                == Some(true)
        })
    });
    case.pump(|case| case.called("settings.set").len() > 4);
    assert_eq!(case.called("settings.set")[4], json!({"grok_leader": true}));
    case.app.set_setting(
        SettingsChange {
            opencode_plugin: Some(true),
            ..SettingsChange::default()
        },
        SettingRow::OpenCodePlugin,
    );
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.opencode_plugin)
                == Some(true)
        })
    });
    case.pump(|case| case.called("settings.set").len() > 5);
    assert_eq!(
        case.called("settings.set")[5],
        json!({"opencode_plugin": true})
    );
    case.app.set_setting(
        SettingsChange {
            claude_session_hook: Some(true),
            ..SettingsChange::default()
        },
        SettingRow::ClaudeSessionHook,
    );
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.claude_session_hook)
                == Some(true)
        })
    });
    case.pump(|case| case.called("settings.set").len() > 6);
    assert_eq!(
        case.called("settings.set")[6],
        json!({"claude_session_hook": true})
    );
    case.settle();
    assert!(case.settings_labels().contains(
        &"Agent Relay's SessionStart hook is in each Claude login's settings.json. When a session is not on the relay, the hook has Claude ask you whether to put it on the relay and under what name. Nothing is registered unless you say yes.".to_string()
    ));
    case.app.set_setting(
        SettingsChange {
            devin_direct_delivery: Some(true),
            ..SettingsChange::default()
        },
        SettingRow::DevinDelivery,
    );
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .settings
                .as_ref()
                .and_then(|settings| settings.devin_direct_delivery)
                == Some(true)
        })
    });
    case.pump(|case| case.called("settings.set").len() > 7);
    assert_eq!(
        case.called("settings.set")[7],
        json!({"devin_direct_delivery": true})
    );
    case.settle();
    assert!(case.settings_labels().contains(
        &"Agent Relay's hooks are in ~/.config/devin/config.json. Messages reach a Devin session mid-turn and when its turn ends. Start Devin sessions that were open before it was on again.".to_string()
    ));
    case.app.decide_held("h1", true);
    case.pump(|case| !case.called("incoming.approve").is_empty());
    assert_eq!(case.called("incoming.approve")[0], json!({"id": "h1"}));
    case.app.share_thread("th", Some(Mode::Auto), true);
    case.pump(|case| !case.called("incoming.share").is_empty());
    assert_eq!(
        case.called("incoming.share")[0],
        json!({"thread_id": "th", "mode": "auto", "allows_unrestricted": true})
    );
}

fn claude_delivery_refresh_reports_and_clears_errors(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.answer(
        "claude_delivery.status",
        fail(ErrorKind::StoreFailed, "Could not read choices."),
    );
    case.app.refresh_claude_delivery();
    case.pump(|case| {
        case.app.with_state(|state| {
            state.claude_delivery_error.as_deref() == Some("Could not read choices.")
        })
    });

    case.answer(
        "claude_delivery.status",
        check::<method::ClaudeDeliveryStatus>(claude_delivery()),
    );
    case.app.refresh_claude_delivery();
    case.pump(|case| {
        case.app
            .with_state(|state| state.claude_delivery_error.is_none())
    });
}

fn claude_delivery_refusal_survives_reconciliation(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| case.app.with_state(|state| state.claude_delivery.is_some()));
    case.settle();
    case.answer(
        "claude_delivery.restrict",
        fail(ErrorKind::Refused, "Could not save."),
    );
    let reads = case.called("claude_delivery.status").len();
    case.app.update_state(|state| {
        state
            .settings_details_open
            .insert("settings.claude-message-approvals".into());
    });
    case.app.render_settings();
    let mut restriction = None;
    walk(
        case.app.shell().unwrap().settings.column.upcast_ref(),
        &mut |widget| {
            if let Some(check) = widget.downcast_ref::<gtk::CheckButton>() {
                if check.label().as_deref() == Some("Only allowed members may deliver directly") {
                    restriction = Some(check.clone());
                }
            }
        },
    );
    restriction.expect("restriction control").set_active(false);
    case.pump(|case| case.called("claude_delivery.status").len() > reads);
    case.settle();
    case.app.with_state(|state| {
        assert!(state.claude_delivery.as_ref().unwrap().restricted);
        assert_eq!(
            state.claude_delivery_error.as_deref(),
            Some("Could not save.")
        );
    });
}

fn connecting_the_account_workspace(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.connect_workspace();
    case.pump(|case| !case.called("account.connect_workspace").is_empty());
    assert_eq!(
        case.called("account.connect_workspace")[0],
        json!({"workspace_id": "0f8fad5b-d9cb-469f-a165-70867728950e"})
    );
}

fn changing_the_sharing_policy_is_confirmed(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::Sharing));
    case.app.change_sharing(SharingMode::All);
    case.pump(|case| !case.called("uploader.sharing.set").is_empty());
    assert_eq!(
        case.called("uploader.sharing.set")[0],
        json!({"mode": "all"})
    );
    assert_eq!(case.desktop.asked.borrow().len(), 1);
}

fn the_account_pane_names_who_is_signed_in(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::Account));
    let shown = case.settings_labels();
    assert!(shown.contains(&"Ada".to_string()));
    assert!(shown.contains(&"ada@example.com".to_string()));
    assert!(!shown.contains(&"Reset all sessions…".to_string()));
    assert!(!shown.contains(&"Open log file".to_string()));
}

// Links and notifications.

fn a_connection_link_signs_in_to_its_workspace(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.app.open_link(
        "agentrelay://connect?site=https%3A%2F%2Fagentrelay.com&account=acct&workspace=ws-1",
    );
    case.pump(|case| case.app.with_state(|state| state.pending_connect.is_some()));
    assert!(case.called("links.parse")[0]["url"]
        .as_str()
        .unwrap()
        .starts_with("agentrelay://connect"));
    case.app.sign_in(false, None);
    case.pump(|case| !case.called("account.sign_in").is_empty());
    let request = &case.called("account.sign_in")[0];
    assert_eq!(
        (&request["site_url"], &request["workspace"]),
        (&json!("https://agentrelay.com"), &json!("ws-1"))
    );
}

fn a_link_to_another_workspace_shows_why_on_the_account(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Agents);
    case.app.open_link(
        "agentrelay://connect?site=https%3A%2F%2Fagentrelay.com&account=acct&workspace=ws-1",
    );
    case.pump(|case| case.app.page() == Page::Settings(Pane::Account));
    case.settle();
    let error = case.app.with_state(|state| state.page_error.clone());
    assert!(error
        .unwrap()
        .starts_with("This app is connected to another account or workspace."));
    let shell = case.app.shell().unwrap();
    assert!(shell.page_error.is_visible());
    assert_eq!(shell.page_error.text(), "⚠ Needs attention");
    assert!(shell
        .page_error
        .tooltip_text()
        .unwrap()
        .starts_with("This app is connected to another account or workspace."));
}

fn a_link_that_arrives_before_the_core_waits_for_it(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.app.update_state(|state| state.snapshot = None);
    case.app.open_link(
        "agentrelay://connect?site=https%3A%2F%2Fagentrelay.com&account=acct&workspace=ws-1",
    );
    case.settle();
    assert!(case.called("links.parse").is_empty());
    case.set_state(fake_core::snapshot(json!({})));
    case.pump(|case| case.app.with_state(|state| state.pending_connect.is_some()));
}

fn a_message_link_opens_messages_to_its_agent(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.answer(
        "links.parse",
        json!({"kind": "message", "endpoint": "web@desk", "address": true}),
    );
    case.sign_in();
    case.app.go(Page::Team);
    case.settle();
    let before = case.called("telemetry.record").len();
    case.app.open_link("agentrelay://message?to=web%40desk");
    case.pump(|case| case.app.page() == Page::Messages);
    assert_eq!(case.app.shown_chat().as_deref(), Some("web@desk"));
    assert_eq!(case.app.open_chats(), ["web@desk"]);
    case.app.go(Page::Settings(Pane::General));
    case.pump(|case| {
        case.called("telemetry.record")
            .iter()
            .any(|event| event["operation"] == "settings")
    });
    case.settle();
    let events = case.called("telemetry.record");
    let events = &events[before..];
    let surfaces: Vec<_> = events
        .iter()
        .filter(|event| event["operation"] == "page_view")
        .map(|event| event["surface"].as_str().unwrap())
        .collect();
    assert_eq!(surfaces, ["messages", "settings_general"]);
    assert_eq!(
        events
            .iter()
            .filter(|event| event["operation"] == "message_composer")
            .count(),
        1
    );
}

fn notify_events_become_notifications(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.emit(
        "notify",
        json!({"title": "Message from @bo", "body": "Hi", "link": null}),
    );
    case.pump(|case| !case.desktop.notified.borrow().is_empty());
    assert_eq!(case.desktop.notified.borrow()[0].title, "Message from @bo");
}

// Signing out.

fn sign_out_returns_to_sign_in(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.confirm_logout();
    case.pump(|case| case.app.view() == Some(View::SigningOut));
    case.pump(|case| !case.called("account.sign_out").is_empty());
    case.set_state(fake_core::snapshot(json!({})));
    case.pump(|case| case.app.view() == Some(View::SignIn));
    case.app.with_state(|state| {
        assert!(state.status.is_none());
        assert!(state.local_sessions.is_empty() && state.brokers.is_empty());
        assert!(!state.refreshing_uploader);
    });
    // A refresh still in flight for the old account no longer blocks the
    // next account's.
    assert!(case.app.in_flight().is_empty());
}

fn sign_out_shows_no_connected_view_before_the_snapshot_leaves(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.confirm_logout();
    case.pump(|case| case.app.with_state(|state| state.sign_out_answered));
    case.settle();
    // Answered, but the snapshot still shows the account.
    assert_eq!(case.app.view(), Some(View::SigningOut));
    case.set_state(fake_core::snapshot(json!({})));
    case.pump(|case| case.app.view() == Some(View::SignIn));
    assert!(!case.app.with_state(|state| state.signing_out));
}

fn a_core_that_drops_after_a_sign_out_answers_shows_where_the_account_stands(
    runtime: &tokio::runtime::Runtime,
) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.confirm_logout();
    case.pump(|case| case.app.with_state(|state| state.sign_out_answered));
    assert_eq!(case.app.view(), Some(View::SigningOut));
    case.app.on_connection(false, None);
    assert!(!case.app.with_state(|state| state.signing_out));
    assert_eq!(case.app.view(), Some(View::Loading));
    assert_eq!(
        case.app.with_state(|state| state.connection().label),
        "Reconnecting"
    );
    // The core comes back still showing the account.
    case.app
        .on_status(reader::result::<method::StatusGet>(workspace_snapshot()).unwrap());
    assert_eq!(case.app.view(), Some(View::Connected));
}

fn a_failed_sign_out_returns_to_the_account(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.answer(
        "account.sign_out",
        fail(ErrorKind::CloudFailed, "Cloud is down."),
    );
    case.app.confirm_logout();
    case.pump(|case| case.app.with_state(|state| state.sign_out_answered));
    case.pump(|case| case.app.view() == Some(View::Connected));
    assert!(case
        .app
        .with_state(|state| state.sign_in_error.clone())
        .unwrap()
        .contains("Cloud is down."));
}

fn leaving_the_account_for_a_new_approval_forgets_its_view(runtime: &tokio::runtime::Runtime) {
    let case = Case::with(runtime, |core| {
        core.answer(
            "roster.list",
            fail(ErrorKind::CloudFailed, "Roster unavailable."),
        );
        core.answer(
            "people.list",
            fail(ErrorKind::CloudFailed, "People unavailable."),
        );
        core.answer(
            "sessions.list",
            fail(ErrorKind::CloudFailed, "Sessions unavailable."),
        );
    });
    case.set_state(workspace_snapshot());
    case.pump(|case| {
        case.app.with_state(|state| {
            state.roster_error.is_some()
                && state.people_error.is_some()
                && state.relay_load_error.is_some()
        })
    });
    let generation = case.app.with_state(|state| state.generation);
    case.set_state(fake_core::snapshot(
        json!({"state": "pending_approval", "phase": "waiting_for_browser"}),
    ));
    case.pump(|case| case.app.view() == Some(View::SigningIn));
    case.app.with_state(|state| {
        assert_eq!(state.generation, generation + 1);
        assert!(state.local_sessions.is_empty());
        // Nothing the old account's reads said is kept.
        assert_eq!(
            (
                &state.people_error,
                &state.roster_error,
                &state.relay_load_error
            ),
            (&None, &None, &None)
        );
    });
    assert!(case.app.in_flight().is_empty());
}

fn cached_sessions_appear_while_upload_status_is_held(runtime: &tokio::runtime::Runtime) {
    let release = Arc::new(Notify::new());
    let case = Case::new(runtime);
    let gate = release.clone();
    case.answer(
        "uploader.status",
        Answer::with(move |_| {
            let gate = gate.clone();
            async move {
                gate.notified().await;
                Ok(json!({"running":true,"paused":false}))
            }
        }),
    );
    case.set_state(workspace_snapshot());
    case.pump(|case| case.app.with_state(|state| !state.sessions.is_empty()));
    case.app.with_state(|state| {
        assert!(
            state.refreshing_uploader,
            "history must arrive before status finishes"
        );
        assert!(!state.refreshing_sessions);
    });
    let before = case.called("uploader.sessions.list").len();
    case.app.refresh_uploader(true);
    case.pump(|case| {
        case.called("uploader.sessions.list").len() > before
            && case.app.with_state(|state| !state.refreshing_sessions)
    });
    assert!(
        case.app.with_state(|state| state.refreshing_uploader),
        "later history refreshes must also bypass the held status request"
    );
    release.notify_waiters();
    case.settle();
}

fn a_mutation_answered_after_sign_out_starts_nothing_for_the_next_account(
    runtime: &tokio::runtime::Runtime,
) {
    let held = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let case = Case::new(runtime);
    case.sign_in();
    {
        let (held, release) = (held.clone(), release.clone());
        case.answer(
            "agents.register",
            Answer::with(move |_| {
                let (held, release) = (held.clone(), release.clone());
                async move {
                    held.notify_one();
                    release.notified().await;
                    Ok(json!({"name": "api-work", "address": "api-work@desk", "already_registered": false}))
                }
            }),
        );
    }
    let session = case.app.with_state(|state| {
        state
            .local_sessions
            .iter()
            .find(|session| session.target.key() == "codex:thread-1")
            .unwrap()
            .clone()
    });
    case.app.toggle_relay(&session, true);
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), held.notified())
            .await
            .unwrap()
    });
    case.app.confirm_logout();
    case.set_state(fake_core::snapshot(json!({})));
    case.pump(|case| case.app.view() == Some(View::SignIn));
    let lists = (
        case.called("sessions.list").len(),
        case.called("agents.list").len(),
    );
    release.notify_one();
    case.settle();
    case.settle();
    // The answer belonged to the account that left: no follow-up read
    // starts, and nothing holds a read for the next sign-in.
    assert_eq!(
        (
            case.called("sessions.list").len(),
            case.called("agents.list").len()
        ),
        lists
    );
    assert!(case.app.in_flight().is_empty());
    assert!(case.app.with_state(|state| state.busy_targets.is_empty()));
}

// Signing in again.

fn sign_in_starts_once_until_the_snapshot_shows_it(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.app.sign_in(false, None);
    case.app.sign_in(false, None);
    // The answer opens the approval page.
    case.pump(|case| !case.desktop.opened.borrow().is_empty());
    // Answered; the snapshot still says signed out.
    case.app.sign_in(false, None);
    case.settle();
    assert_eq!(case.called("account.sign_in").len(), 1);
    case.set_state(fake_core::snapshot(
        json!({"state": "pending_approval", "phase": "waiting_for_browser"}),
    ));
    case.pump(|case| case.app.view() == Some(View::SigningIn));
    assert!(!case.app.with_state(|state| state.starting_sign_in));
    case.app.cancel_sign_in();
    case.set_state(fake_core::snapshot(json!({})));
    case.pump(|case| case.app.view() == Some(View::SignIn));
    case.app.sign_in(false, None);
    case.pump(|case| case.called("account.sign_in").len() == 2);
}

fn a_sign_in_the_core_does_not_start_can_be_retried(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    // The core answers with the account as it is: no attempt runs.
    let mut report = fake_core::snapshot(json!({}))["account"].clone();
    for key in [
        "verification_url",
        "verification_url_complete",
        "user_code",
        "expires_at",
        "interval",
    ] {
        report[key] = Value::Null;
    }
    case.answer("account.sign_in", check::<method::AccountSignIn>(report));
    case.app.sign_in(false, None);
    case.pump(|case| !case.called("account.sign_in").is_empty());
    case.pump(|case| !case.app.with_state(|state| state.starting_sign_in));
    case.app.sign_in(false, None);
    case.pump(|case| case.called("account.sign_in").len() == 2);
}

fn sign_in_does_not_wait_for_session_discovery(runtime: &tokio::runtime::Runtime) {
    let case = Case::with(runtime, |core| {
        core.answer(
            "sessions.list",
            Answer::with(|_| async { std::future::pending().await }),
        );
    });
    assert_eq!(case.app.view(), Some(View::SignIn));
    assert!(case
        .window_labels()
        .contains(&"Sign in with Google".to_string()));
}

fn a_core_that_goes_away_is_shown(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    runtime.block_on(case.core.stop());
    case.pump(|case| case.app.view() == Some(View::Loading));
    assert!(case.window_labels().contains(&"Reconnecting".to_string()));
}

fn a_signed_in_core_restart_keeps_the_workspace(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let generation = case.app.with_state(|state| state.generation);
    runtime.block_on(case.core.stop());
    case.pump(|case| !case.app.with_state(|state| state.core_connected));
    assert_eq!(case.app.view(), Some(View::Connected));
    assert!(Rc::ptr_eq(&shell, &case.app.shell().unwrap()));
    assert!(case.app.with_state(|state| state.generation) > generation);
    assert!(case.app.in_flight().is_empty());
    assert_eq!(
        case.app.with_state(|state| state.account_state()),
        agent_relay_probe::relay::state::SignInState::SignedIn
    );
    assert_eq!(
        case.app.with_state(|state| state.connection().label),
        "Reconnecting"
    );
}

fn an_interrupted_incoming_change_warns_before_retry(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.answer(
        "incoming.share",
        Answer::with(|_| async { std::future::pending().await }),
    );
    case.app.share_thread("thread-1", Some(Mode::Auto), true);
    case.pump(|case| !case.called("incoming.share").is_empty());
    runtime.block_on(case.core.stop());
    case.pump(|case| !case.app.with_state(|state| state.core_connected));
    assert!(case
        .app
        .with_state(|state| state.incoming_error.clone())
        .is_some_and(|message| message.contains("Check whether the action completed")));
}

type Test = fn(&tokio::runtime::Runtime);

fn closed_popover_retains_parent_only_until_idle(_: &tokio::runtime::Runtime) {
    let parent = gtk::Button::new();
    let weak_parent = parent.downgrade();
    let popover = gtk::Popover::new();
    popover.set_parent(&parent);
    agent_relay_probe::linux_app::ui::widgets::unparent_when_closed(&popover);
    popover.emit_by_name::<()>("closed", &[]);
    drop(parent);
    assert!(
        weak_parent.upgrade().is_some(),
        "Deferred cleanup must keep the parent alive"
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    while popover.parent().is_some() {
        assert!(
            Instant::now() < deadline,
            "Closed menu must eventually unparent"
        );
        dispatch_one();
    }
    assert!(
        weak_parent.upgrade().is_none(),
        "No parent/popover reference cycle may remain after cleanup"
    );
}

fn libtest_arguments_select_cases(_: &tokio::runtime::Runtime) {
    let parse = |line: &str| Arguments::parse(line.split_whitespace().map(String::from));
    let threads = parse("--test-threads 1 --nocapture sign_in");
    assert_eq!(threads.filters, ["sign_in"]);
    assert!(threads.selects("sign_in_starts_once_until_the_snapshot_shows_it"));
    assert!(!threads.selects("stylesheets_and_marks_load"));

    let skip = parse("--skip sign_in --skip=sign_out");
    assert!(skip.filters.is_empty());
    assert!(skip.selects("stylesheets_and_marks_load"));
    assert!(!skip.selects("a_failed_sign_out_returns_to_the_account"));
    assert!(!skip.selects("sign_in_starts_once_until_the_snapshot_shows_it"));

    let exact = parse("--exact sign_in --format pretty");
    assert_eq!(exact.filters, ["sign_in"]);
    assert!(!exact.selects("sign_in_starts_once_until_the_snapshot_shows_it"));
    assert!(parse("").selects("anything"));
}

const TESTS: &[(&str, Test)] = &[
    (
        "take_over_survives_switching_transcripts",
        take_over::switching_transcripts,
    ),
    (
        "closed_popover_retains_parent_only_until_idle",
        closed_popover_retains_parent_only_until_idle,
    ),
    (
        "quota_notice_ignores_unseen_pre_identity_entry",
        quota_notice_ignores_unseen_pre_identity_entry,
    ),
    (
        "quota_notice_ignores_old_workspace_poll",
        quota_notice_ignores_old_workspace_poll,
    ),
    (
        "quota_notice_resets_on_workspace_change",
        quota_notice_resets_on_workspace_change,
    ),
    (
        "quota_notice_opens_billing_and_suppresses_repeats",
        quota_notice_opens_billing_and_suppresses_repeats,
    ),
    (
        "capacity_notice_names_the_plan_and_opens_billing",
        capacity_notice_names_the_plan_and_opens_billing,
    ),
    (
        "libtest_arguments_select_cases",
        libtest_arguments_select_cases,
    ),
    (
        "pumping_ends_while_the_loop_stays_busy",
        pumping_ends_while_the_loop_stays_busy,
    ),
    ("stylesheets_and_marks_load", stylesheets_and_marks_load),
    (
        "destination_search_applied_before_navigation_is_recorded",
        destination_search_applied_before_navigation_is_recorded,
    ),
    (
        "navigation_cancels_pending_search_usage_even_after_returning",
        navigation_cancels_pending_search_usage_even_after_returning,
    ),
    (
        "usage_telemetry_tracks_navigation_and_debounces_search",
        usage_telemetry_tracks_navigation_and_debounces_search,
    ),
    (
        "workspace_menu_offers_sign_out_to_switch",
        workspace_menu_offers_sign_out_to_switch,
    ),
    (
        "signed_out_shows_sign_in_and_records_the_launch",
        signed_out_shows_sign_in_and_records_the_launch,
    ),
    (
        "first_run_shows_only_sign_in_and_preserves_delivery_default",
        first_run_shows_only_sign_in_and_preserves_delivery_default,
    ),
    (
        "an_explicit_hold_shows_no_box",
        an_explicit_hold_shows_no_box,
    ),
    (
        "a_failed_first_run_default_is_offered_again",
        a_failed_first_run_default_is_offered_again,
    ),
    (
        "a_sign_in_before_the_settings_arrive_still_applies_the_default",
        a_sign_in_before_the_settings_arrive_still_applies_the_default,
    ),
    (
        "first_run_keeps_managed_settings_out_of_sign_in",
        first_run_keeps_managed_settings_out_of_sign_in,
    ),
    (
        "signed_out_offers_only_google_sign_in",
        signed_out_offers_only_google_sign_in,
    ),
    (
        "sign_in_uses_the_browser_with_new_sessions_shared_as_on_the_mac",
        sign_in_uses_the_browser_with_new_sessions_shared_as_on_the_mac,
    ),
    (
        "a_refused_sign_in_shows_the_cores_sentence",
        a_refused_sign_in_shows_the_cores_sentence,
    ),
    (
        "unchecked_schedules_offer_continue_anyway",
        unchecked_schedules_offer_continue_anyway,
    ),
    (
        "signed_in_lands_on_local_sessions",
        signed_in_lands_on_local_sessions,
    ),
    (
        "header_layout_and_avatar_navigation",
        header_layout_and_avatar_navigation,
    ),
    (
        "message_filters_preserve_query_and_sort",
        message_filters_preserve_query_and_sort,
    ),
    (
        "settings_and_back_to_sessions_navigate",
        settings_and_back_to_sessions_navigate,
    ),
    (
        "paired_reads_asked_again_mid_read_each_read_once_more",
        paired_reads_asked_again_mid_read_each_read_once_more,
    ),
    (
        "the_status_bar_pauses_and_the_core_invalidating_refreshes",
        the_status_bar_pauses_and_the_core_invalidating_refreshes,
    ),
    (
        "typing_in_search_survives_a_status_refresh",
        typing_in_search_survives_a_status_refresh,
    ),
    (
        "the_tray_opens_the_summarized_pages",
        the_tray_opens_the_summarized_pages,
    ),
    (
        "the_tray_counts_follow_show_hidden",
        the_tray_counts_follow_show_hidden,
    ),
    (
        "turning_on_the_service_is_confirmed_with_its_defaults",
        turning_on_the_service_is_confirmed_with_its_defaults,
    ),
    (
        "keeping_agents_connected_after_quitting_can_be_turned_off",
        keeping_agents_connected_after_quitting_can_be_turned_off,
    ),
    (
        "general_settings_come_from_the_core",
        general_settings_come_from_the_core,
    ),
    ("appearance_is_remembered", appearance_is_remembered),
    (
        "session_opening_settings_route_clicks",
        session_opening_settings_route_clicks,
    ),
    (
        "a_spawned_agent_is_joined_and_taken_over",
        a_spawned_agent_is_joined_and_taken_over,
    ),
    (
        "request_failures_link_to_exact_entry",
        request_failures_link_to_exact_entry,
    ),
    (
        "about_copies_diagnostics_without_secrets",
        about_copies_diagnostics_without_secrets,
    ),
    (
        "relay_settings_deliver_directly_and_answer_incoming",
        relay_settings_deliver_directly_and_answer_incoming,
    ),
    (
        "show_relay_messages_hidden_and_turn_on",
        show_relay_messages_hidden_and_turn_on,
    ),
    (
        "auto_join_general_turns_on_and_agent_changes_show",
        auto_join_general_turns_on_and_agent_changes_show,
    ),
    (
        "openclaw_agents_connect_agent_relay_tools",
        openclaw_agents_connect_agent_relay_tools,
    ),
    (
        "a_failed_openclaw_tools_connect_keeps_the_row",
        a_failed_openclaw_tools_connect_keeps_the_row,
    ),
    (
        "spawned_agents_have_an_optional_cap",
        spawned_agents_have_an_optional_cap,
    ),
    (
        "session_history_retention_is_previewed_but_disabled",
        session_history_retention_is_previewed_but_disabled,
    ),
    (
        "session_history_retention_is_absent_in_older_cores",
        session_history_retention_is_absent_in_older_cores,
    ),
    (
        "spawned_agents_can_let_teammates_spawn_here",
        spawned_agents_can_let_teammates_spawn_here,
    ),
    (
        "an_old_openclaw_says_relay_sessions_are_not_limited",
        an_old_openclaw_says_relay_sessions_are_not_limited,
    ),
    (
        "claude_delivery_refusal_survives_reconciliation",
        claude_delivery_refusal_survives_reconciliation,
    ),
    (
        "claude_delivery_refresh_reports_and_clears_errors",
        claude_delivery_refresh_reports_and_clears_errors,
    ),
    (
        "connecting_the_account_workspace",
        connecting_the_account_workspace,
    ),
    (
        "changing_the_sharing_policy_is_confirmed",
        changing_the_sharing_policy_is_confirmed,
    ),
    (
        "the_account_pane_names_who_is_signed_in",
        the_account_pane_names_who_is_signed_in,
    ),
    (
        "a_connection_link_signs_in_to_its_workspace",
        a_connection_link_signs_in_to_its_workspace,
    ),
    (
        "a_link_to_another_workspace_shows_why_on_the_account",
        a_link_to_another_workspace_shows_why_on_the_account,
    ),
    (
        "a_link_that_arrives_before_the_core_waits_for_it",
        a_link_that_arrives_before_the_core_waits_for_it,
    ),
    (
        "a_message_link_opens_messages_to_its_agent",
        a_message_link_opens_messages_to_its_agent,
    ),
    (
        "notify_events_become_notifications",
        notify_events_become_notifications,
    ),
    (
        "native_workspace_picker_sends_the_selected_id",
        native_workspace_picker_sends_the_selected_id,
    ),
    ("sign_out_returns_to_sign_in", sign_out_returns_to_sign_in),
    (
        "sign_out_shows_no_connected_view_before_the_snapshot_leaves",
        sign_out_shows_no_connected_view_before_the_snapshot_leaves,
    ),
    (
        "a_core_that_drops_after_a_sign_out_answers_shows_where_the_account_stands",
        a_core_that_drops_after_a_sign_out_answers_shows_where_the_account_stands,
    ),
    (
        "a_failed_sign_out_returns_to_the_account",
        a_failed_sign_out_returns_to_the_account,
    ),
    (
        "leaving_the_account_for_a_new_approval_forgets_its_view",
        leaving_the_account_for_a_new_approval_forgets_its_view,
    ),
    (
        "cached_sessions_appear_while_upload_status_is_held",
        cached_sessions_appear_while_upload_status_is_held,
    ),
    (
        "a_mutation_answered_after_sign_out_starts_nothing_for_the_next_account",
        a_mutation_answered_after_sign_out_starts_nothing_for_the_next_account,
    ),
    (
        "sign_in_starts_once_until_the_snapshot_shows_it",
        sign_in_starts_once_until_the_snapshot_shows_it,
    ),
    (
        "a_sign_in_the_core_does_not_start_can_be_retried",
        a_sign_in_the_core_does_not_start_can_be_retried,
    ),
    (
        "sign_in_does_not_wait_for_session_discovery",
        sign_in_does_not_wait_for_session_discovery,
    ),
    (
        "a_core_that_goes_away_is_shown",
        a_core_that_goes_away_is_shown,
    ),
    (
        "a_signed_in_core_restart_keeps_the_workspace",
        a_signed_in_core_restart_keeps_the_workspace,
    ),
    (
        "an_interrupted_incoming_change_warns_before_retry",
        an_interrupted_incoming_change_warns_before_retry,
    ),
];

fn main() -> ExitCode {
    let arguments = Arguments::parse(std::env::args().skip(1));
    let selected: Vec<&(&str, Test)> = TESTS
        .iter()
        .chain(pages::TESTS)
        .filter(|(name, _)| arguments.selects(name))
        .collect();
    // GTK's Win32 IME context leaves its window-message filter behind when
    // it is freed ("gtk_im_context_ime_message_filter: assertion failed"),
    // and after a few dozen cases a message reaches it and the harness dies
    // with STATUS_FATAL_USER_CALLBACK_EXCEPTION. The cases type no CJK text.
    if cfg!(windows) && std::env::var_os("GTK_IM_MODULE").is_none() {
        std::env::set_var("GTK_IM_MODULE", "gtk-im-context-simple");
    }
    if let Err(error) = gtk::init() {
        eprintln!("linux_app_gtk needs a display: {error}");
        return ExitCode::FAILURE;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    println!("\nrunning {} tests", selected.len());
    let mut failed = Vec::new();
    for (name, test) in selected.iter().copied() {
        let started = Instant::now();
        let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| test(&runtime)));
        let took = started.elapsed().as_secs_f64();
        match outcome {
            Ok(()) => println!("test {name} ... ok ({took:.2}s)"),
            Err(_) => {
                println!("test {name} ... FAILED ({took:.2}s)");
                failed.push(*name);
            }
        }
    }
    let passed = selected.len() - failed.len();
    if failed.is_empty() {
        println!("\ntest result: ok. {passed} passed; 0 failed\n");
        ExitCode::SUCCESS
    } else {
        println!("\nfailures:\n    {}\n", failed.join("\n    "));
        println!(
            "test result: FAILED. {passed} passed; {} failed\n",
            failed.len()
        );
        ExitCode::FAILURE
    }
}

/// libtest's command line, as far as this harness honours it: name filters,
/// `--skip` and `--exact`. Its other flags are accepted and ignored, along
/// with the value of each one that takes a value.
#[derive(Debug, Default, PartialEq)]
struct Arguments {
    filters: Vec<String>,
    skips: Vec<String>,
    exact: bool,
}

impl Arguments {
    /// libtest flags followed by a separate value.
    const VALUED: [&'static str; 6] = [
        "--test-threads",
        "--format",
        "--color",
        "--logfile",
        "--shuffle-seed",
        "-Z",
    ];

    fn parse(arguments: impl IntoIterator<Item = String>) -> Arguments {
        let mut parsed = Arguments::default();
        let mut arguments = arguments.into_iter();
        while let Some(argument) = arguments.next() {
            if argument == "--skip" {
                parsed.skips.extend(arguments.next());
            } else if let Some(skip) = argument.strip_prefix("--skip=") {
                parsed.skips.push(skip.to_owned());
            } else if argument == "--exact" {
                parsed.exact = true;
            } else if Self::VALUED.contains(&argument.as_str()) {
                arguments.next();
            } else if !argument.starts_with('-') {
                parsed.filters.push(argument);
            }
        }
        parsed
    }

    fn matches(&self, name: &str, pattern: &str) -> bool {
        if self.exact {
            name == pattern
        } else {
            name.contains(pattern)
        }
    }

    fn selects(&self, name: &str) -> bool {
        (self.filters.is_empty() || self.filters.iter().any(|filter| self.matches(name, filter)))
            && !self.skips.iter().any(|skip| self.matches(name, skip))
    }
}
