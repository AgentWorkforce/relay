//! My agents, My sessions, Team and Messages against the fake core.

use super::*;
use agent_relay_probe::linux_app::models::{OverviewStatus, SharingModeText, CAPY_WAITING};
use agent_relay_probe::linux_app::ui::agents_page::{within_control, Outcome};
use agent_relay_probe::linux_app::ui::state::TeamPick;
use agent_relay_probe::relay::fleet::{BrokerListing, WorkerRow};
use agent_relay_probe::relay::people::MessageState;

/// The widgets under `root` named `name`.
fn named<W: IsA<gtk::Widget>>(root: &impl IsA<gtk::Widget>, name: &str) -> Vec<W> {
    let mut found = Vec::new();
    walk(root.upcast_ref(), &mut |widget| {
        if widget.widget_name() == name {
            if let Some(widget) = widget.downcast_ref::<W>() {
                found.push(widget.clone());
            }
        }
    });
    found
}

/// The widgets of type `W` under `root`.
fn widgets<W: IsA<gtk::Widget>>(root: &impl IsA<gtk::Widget>) -> Vec<W> {
    let mut found = Vec::new();
    walk(root.upcast_ref(), &mut |widget| {
        if let Some(widget) = widget.downcast_ref::<W>() {
            found.push(widget.clone());
        }
    });
    found
}

/// The first label under `root` reading `value`.
fn label_named(root: &impl IsA<gtk::Widget>, value: &str) -> Option<gtk::Label> {
    let mut found = None;
    walk(root.upcast_ref(), &mut |widget| {
        if let Some(label) = widget.downcast_ref::<gtk::Label>() {
            if found.is_none() && label.text() == value {
                found = Some(label.clone());
            }
        }
    });
    found
}

/// Holds a method's answers until `release` is notified; `held` is
/// notified as each call arrives.
fn held_answer(held: Arc<Notify>, release: Arc<Notify>, value: Value) -> Answer {
    Answer::with(move |_| {
        let (held, release, value) = (held.clone(), release.clone(), value.clone());
        async move {
            held.notify_one();
            release.notified().await;
            Ok(value)
        }
    })
}

impl Case {
    /// The laptop can only be selected once its roster response is applied.
    fn wait_for_laptop_roster(&self) {
        self.pump(|case| {
            case.app.with_state(|state| {
                state
                    .roster
                    .iter()
                    .any(|agent| agent.host.as_deref() == Some("laptop"))
            })
        });
    }

    fn agents_labels(&self) -> Vec<String> {
        labels(&self.app.shell().unwrap().pages.agents.column)
    }

    fn relay_switch(&self, key: &str) -> Option<gtk::Switch> {
        named(
            &self.app.shell().unwrap().pages.agents.column,
            &format!("relay-switch {key}"),
        )
        .into_iter()
        .next()
    }

    /// Opens a conversation and waits for its recipient.
    fn open_conversation(
        &self,
        endpoint: &str,
    ) -> Rc<agent_relay_probe::linux_app::ui::messages::Chat> {
        self.app.open_chat(endpoint);
        self.pump(|case| {
            case.app
                .chat(endpoint)
                .is_some_and(|chat| chat.state.borrow().recipient.is_some())
        });
        self.app.chat(endpoint).unwrap()
    }

    /// `roster.get` calls for `endpoint`.
    fn lookups(&self, endpoint: &str) -> usize {
        let (key, value) = match endpoint.strip_prefix('@') {
            Some(name) => ("to", name),
            None if endpoint.contains('@') => ("address", endpoint),
            None => ("to", endpoint),
        };
        self.called("roster.get")
            .iter()
            .filter(|params| params[key] == json!(value))
            .count()
    }

    /// Runs the main loop for `seconds`.
    fn wait(&self, seconds: u64) {
        let end = Instant::now() + Duration::from_secs(seconds);
        while Instant::now() < end {
            self.settle();
        }
    }
}

fn delivery(chat: &agent_relay_probe::linux_app::ui::messages::Chat) -> String {
    chat.delivery.text().to_string()
}

// My agents.

fn capy_content(window: &gtk::Window) -> gtk::Widget {
    window.child().expect("Capy spawn content")
}

fn capy_thread_spawn_is_persisted_and_follows_binding(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    let binding_held = Arc::new(Notify::new());
    let release_binding = Arc::new(Notify::new());
    case.answer(
        "capy.threads.get",
        held_answer(
            binding_held,
            release_binding.clone(),
            json!({
                "thread_id": "jam_01THREAD", "title": "Review", "status": "running",
                "binding": {"state": "bound", "agent": "capy-01thread"}
            }),
        ),
    );
    case.sign_in();
    case.app.go(Page::Agents);
    case.app.show_window();
    case.pump(|case| case.app.window().is_mapped());
    case.app.show_capy_spawn();
    case.pump(|case| !case.called("capy.projects.list").is_empty());
    let window = case.app.capy_spawn_window().expect("Capy spawn window");
    let content = capy_content(&window);
    let start = buttons(&content, "Start").remove(0);
    case.pump(|_| start.is_sensitive());
    let task: gtk::TextView = widgets(&content).remove(0);
    task.buffer().set_text("Review pull request 455");
    start.emit_clicked();
    case.pump(|case| !case.called("capy.threads.spawn").is_empty());

    let operation = Preferences::load(case.prefs_path.clone())
        .capy_spawn_operation("0f8fad5b-d9cb-469f-a165-70867728950e")
        .expect("operation saved before the request");
    assert_eq!(operation.task, "Review pull request 455");
    assert_eq!(operation.project_id, "project_1");
    assert!(operation.client_request_id.starts_with("relay-desktop-"));
    assert_eq!(
        case.called("capy.threads.spawn")[0]["client_request_id"],
        json!(operation.client_request_id)
    );
    case.pump(|_| {
        labels(&content).contains(&CAPY_WAITING.to_owned())
            && labels(&content).contains(&"Thread  jam_01THREAD".to_owned())
    });
    case.pump(|case| !case.called("capy.threads.get").is_empty());
    release_binding.notify_one();
    case.pump(|_| labels(&content).contains(&"Running on the relay".to_owned()));
    assert!(labels(&content).contains(&"@capy-01thread".to_owned()));
    buttons(&content, "Message").remove(0).emit_clicked();
    case.settle();
    assert_eq!(case.app.page(), Page::Messages);
}

fn capy_binding_error_is_visible_and_retryable(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.answer(
        "capy.threads.get",
        Answer::fail(
            ErrorKind::CloudFailed,
            "Capy status is temporarily unavailable.",
        ),
    );
    case.sign_in();
    case.app.go(Page::Agents);
    case.app.show_window();
    case.pump(|case| case.app.window().is_mapped());
    case.app.show_capy_spawn();
    case.pump(|case| !case.called("capy.projects.list").is_empty());
    let window = case.app.capy_spawn_window().expect("Capy spawn window");
    let content = capy_content(&window);
    let start = buttons(&content, "Start").remove(0);
    case.pump(|_| start.is_sensitive());
    let task: gtk::TextView = widgets(&content).remove(0);
    task.buffer().set_text("Review pull request 458");
    start.emit_clicked();
    case.pump(|case| !case.called("capy.threads.spawn").is_empty());
    case.wait(3);

    assert!(labels(&content).contains(&"Capy status is temporarily unavailable.".to_owned()));
    window.close();
    case.settle();
    let release_projects = Arc::new(Notify::new());
    case.answer("capy.projects.list", {
        let release_projects = release_projects.clone();
        Answer::with(move |_| {
            let release_projects = release_projects.clone();
            async move {
                release_projects.notified().await;
                Err(RpcError::new(
                    ErrorKind::CloudFailed,
                    "Capy projects are temporarily unavailable.",
                ))
            }
        })
    });
    case.app.show_capy_spawn();
    case.pump(|case| {
        case.called("capy.projects.list").len() == 2 && case.called("capy.threads.get").len() >= 2
    });
    release_projects.notify_one();
    case.settle();
    let window = case.app.capy_spawn_window().expect("restored Capy window");
    let content = capy_content(&window);
    assert!(labels(&content).contains(&"Capy status is temporarily unavailable.".to_owned()));
    assert!(!labels(&content).contains(&"Capy projects are temporarily unavailable.".to_owned()));
    let retry = buttons(&content, "Check again").remove(0);
    assert!(retry.is_visible());
    case.answer(
        "capy.threads.get",
        check::<method::CapyThreadsGet>(json!({
            "thread_id": "jam_01THREAD", "title": "Review", "status": "running",
            "binding": {"state": "bound", "agent": "capy-01thread"}
        })),
    );
    retry.emit_clicked();
    case.pump(|_| labels(&content).contains(&"Running on the relay".to_owned()));
    assert_eq!(case.called("capy.threads.spawn").len(), 1);
}

fn my_agents_lists_sessions_and_switches_them_on_the_relay(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Agents);
    case.app.toggle_session_details("codex:thread-1");
    assert!(case
        .agents_labels()
        .contains(&"Set Name & Retry".to_string()));
    case.app.toggle_session_details("codex:thread-1");
    // The ended thread keeps its registration but is not listed.
    assert!(case.relay_switch("codex:gone").is_none());
    let api = case
        .relay_switch("codex:thread-1")
        .expect("API work's switch");
    assert!(!api.is_active());
    assert!(case
        .relay_switch("claude-terminal:c-2")
        .unwrap()
        .is_active());
    let mut registered = local();
    registered["sessions"][0]["registration"] = json!({"name": "api-work",
        "address": "api-work@desk", "added_by_session": false, "push": {"state": "live"}});
    case.answer("sessions.list", registered);
    case.app.register_session_with_name(
        agent_relay_probe::relay::store::Target {
            kind: agent_relay_probe::relay::store::SessionKind::Codex,
            id: "thread-1".into(),
        },
        "  @@API-Work@  ".into(),
    );
    case.pump(|case| !case.called("agents.register").is_empty());
    assert_eq!(
        case.called("agents.register")[0]["target"],
        json!({"kind": "codex", "id": "thread-1"})
    );
    assert_eq!(case.called("agents.register")[0]["name"], json!("api-work"));
    case.pump(|case| case.app.with_state(|state| state.busy_targets.is_empty()));
    case.settle();
    // A switched row holds its section until the list changes.
    let shown = case.agents_labels();
    let position = |title: &str| shown.iter().position(|label| label == title).unwrap();
    assert!(
        position("Not on the relay") < position("API work"),
        "{shown:?}"
    );
    assert!(case.relay_switch("codex:thread-1").unwrap().is_active());
    case.app.go_scope(AgentScope::OnRelay);
    let shown = case.agents_labels();
    assert!(shown.contains(&"API work".to_string()), "{shown:?}");
    assert!(
        !shown.contains(&"Not on the relay".to_string()),
        "{shown:?}"
    );
    // Turning a session off releases its name.
    let web = case.app.with_state(|state| state.local_sessions[1].clone());
    case.app.toggle_relay(&web, false);
    case.pump(|case| !case.called("agents.unregister").is_empty());
    assert_eq!(case.called("agents.unregister")[0], json!({"name": "web"}));
    // The core still lists it: the change ends with the core's answer
    // rather than sending it again.
    case.pump(|case| case.app.with_state(|state| state.busy_targets.is_empty()));
    case.settle();
    assert_eq!(case.called("agents.unregister").len(), 1);
}

fn agent_details_and_tools_call_the_core(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Agents);
    // A press on a row's details chevron is the chevron's: the row neither
    // copies the name nor toggles the session, which would redraw the list
    // and drop the chevron's click.
    let column = case.app.shell().unwrap().pages.agents.column.clone();
    let chevron = descendants(column.upcast_ref())
        .into_iter()
        .find(|widget| {
            widget.is::<gtk::Button>() && widget.tooltip_text().as_deref() == Some("Show details")
        })
        .expect("a details chevron");
    let row = std::iter::successors(chevron.parent(), |widget| widget.parent())
        .find(|widget| widget.has_css_class("row"))
        .expect("the chevron's row");
    assert!(within_control(chevron.first_child(), &row));
    let title = descendants(&row)
        .into_iter()
        .find(|widget| widget.is::<gtk::Label>())
        .expect("the row's title");
    assert!(!within_control(Some(title), &row));
    case.app.toggle_session_details("claude-terminal:c-2");
    let shown = case.agents_labels();
    for fact in ["web@desk", "Claude Code", "Agent overview"] {
        assert!(shown.contains(&fact.to_string()), "{fact} in {shown:?}");
    }
    let tools = case
        .app
        .agent_tools("claude-terminal:c-2")
        .expect("the agent's tools");
    tools.name_entry.set_text("@Webby");
    tools.rename();
    case.pump(|case| !case.called("agents.rename").is_empty());
    assert_eq!(
        case.called("agents.rename")[0],
        json!({"name": "web", "new_name": "webby"})
    );
    case.pump(|_| !tools.working());
    assert_eq!(
        tools.status("rename"),
        Some((
            Outcome::Ok,
            "Now @webby. Messages already sent to @web still arrive.".into()
        ))
    );
    tools.message.set_text("Rerun CI");
    tools.send();
    case.pump(|case| !case.called("agents.test_message").is_empty());
    assert_eq!(
        case.called("agents.test_message")[0],
        json!({"name": "web", "text": "Rerun CI"})
    );
    case.pump(|_| !tools.working());
    assert_eq!(tools.message.text(), "");
    tools.resource.set_text("acme/api");
    tools.subscribe();
    case.pump(|case| !case.called("agents.integrations.subscribe").is_empty());
    assert_eq!(
        case.called("agents.integrations.subscribe")[0],
        json!({"name": "web", "provider": "github", "resource": "acme/api"})
    );
    case.pump(|_| !tools.working());
    tools.create_webhook();
    case.pump(|_| tools.secret().as_deref() == Some("s3cret"));
    // Typed text and the token survive a redraw.
    tools.message.set_text("draft");
    case.app.render_page();
    let kept = case.app.agent_tools("claude-terminal:c-2").unwrap();
    assert!(Rc::ptr_eq(&kept, &tools));
    assert_eq!(kept.message.text(), "draft");
    // The overview is read for the session on the relay.
    case.pump(|case| !case.called("sessions.overview.get").is_empty());
    assert_eq!(
        case.called("sessions.overview.get")[0],
        json!({"session_id": "c-2"})
    );
}

fn an_agent_runs_one_tool_call_at_a_time_and_rereads_after_it(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Agents);
    case.app.toggle_session_details("claude-terminal:c-2");
    let tools = case.app.agent_tools("claude-terminal:c-2").unwrap();
    case.settle();
    let (held, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    case.answer(
        "agents.rename",
        held_answer(
            held.clone(),
            release.clone(),
            json!({"name": "webby", "address": "webby@desk"}),
        ),
    );
    tools.name_entry.set_text("webby");
    tools.rename();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), held.notified())
            .await
            .unwrap()
    });
    // Another tool waits for the rename.
    tools.revoke();
    tools.create_webhook();
    case.settle();
    assert!(case.called("agents.webhook.revoke").is_empty());
    assert!(case.called("agents.webhook.create").is_empty());
    let lists = case.called("agents.list").len();
    release.notify_one();
    case.pump(|_| !tools.working());
    // The change done, the agents are read again.
    case.pump(|case| case.called("agents.list").len() > lists);
    // The replies picker keeps the choice being saved while it saves.
    let mut pickers = Vec::new();
    // A collapsed expander holds its content outside the widget tree.
    walk(&tools.expander.child().unwrap(), &mut |widget| {
        if let Some(picker) = widget.downcast_ref::<gtk::DropDown>() {
            pickers.push(picker.clone());
        }
    });
    let replies = pickers[0].clone();
    assert_eq!(replies.selected(), 0);
    case.answer(
        "agents.reply_setting",
        held_answer(held.clone(), release.clone(), json!({})),
    );
    replies.set_selected(1);
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), held.notified())
            .await
            .unwrap()
    });
    assert!(tools.working());
    assert_eq!(replies.selected(), 1);
    assert_eq!(
        case.called("agents.reply_setting").last(),
        Some(&json!({"name": "web", "enabled": true}))
    );
    release.notify_one();
    case.pump(|_| !tools.working());
}

fn another_machines_agents_are_its_on_the_relay_list(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.wait_for_laptop_roster();
    case.app.go(Page::Agents);
    case.app.go_scope(AgentScope::OnRelay);
    case.app.set_agents_machine("laptop");
    case.settle();
    let shown = case.agents_labels();
    assert!(shown.contains(&"On the relay".to_string()));
    assert!(
        shown.iter().any(|label| label.contains("remote")),
        "{shown:?}"
    );
    assert!(!shown.contains(&"On other machines".to_string()));
    assert!(!shown
        .iter()
        .any(|label| label.contains("None of your sessions are on the relay")));
    // The row carries the harness mark the registering desktop recorded.
    let column = case.app.shell().unwrap().pages.agents.column.clone();
    let mut marks = Vec::new();
    walk(column.upcast_ref(), &mut |widget| {
        if let Some(mark) = widget.widget_name().strip_prefix("agent-mark-") {
            marks.push(mark.to_string());
        }
    });
    assert_eq!(marks, ["grok"]);
    // A machine with nothing of yours says so, naming it.
    case.app.set_agents_machine("desk");
    case.settle();
    assert!(case
        .agents_labels()
        .iter()
        .any(|label| label.contains("from desk")));
    // Back to every machine: other machines keep their own section.
    case.app.set_agents_machine("");
    case.app.go_scope(AgentScope::All);
    case.settle();
    assert!(case
        .agents_labels()
        .contains(&"On other machines".to_string()));
}

fn an_untitled_session_matches_its_shown_title(runtime: &tokio::runtime::Runtime) {
    let case = Case::with(runtime, |core| {
        let mut sessions = local();
        sessions["sessions"][0]["title"] = json!("");
        core.answer("sessions.list", check::<method::SessionsList>(sessions));
    });
    case.sign_in();
    case.app.go(Page::Agents);
    case.app.set_agent_search("untitled");
    case.settle();
    assert!(case
        .agents_labels()
        .contains(&"Untitled session".to_string()));
}

fn a_machine_filter_ends_with_its_machine(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.wait_for_laptop_roster();
    case.app.go(Page::Agents);
    case.app.set_agents_machine("laptop");
    case.app.set_team_machine("laptop");
    case.settle();
    let machines = |case: &Case| {
        case.app
            .with_state(|state| (state.agents_machine.clone(), state.team_machine.clone()))
    };
    assert_eq!(machines(&case), ("laptop".into(), "laptop".into()));
    // The machine leaves: each picker reads All machines and narrows nothing.
    case.app.update_state(|state| {
        state.roster.clear();
        state.brokers.clear();
    });
    case.app.render_page();
    case.app.go(Page::Team);
    assert_eq!(machines(&case), (String::new(), String::new()));
    // Leaving the account forgets the machine it narrowed to.
    case.app.set_agents_machine("laptop");
    case.app.set_team_machine("laptop");
    case.app.update_state(|state| state.forget_account_view());
    assert_eq!(machines(&case), (String::new(), String::new()));
}

fn fleet_release_is_generation_checked(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Agents);
    let broker = case.app.with_state(|state| state.brokers[0].clone());
    let (builder, legacy) = (broker.workers[0].clone(), broker.workers[1].clone());
    case.app.release(&broker, &legacy);
    case.settle();
    assert!(case.called("fleet.release").is_empty());
    case.app.release(&broker, &builder);
    case.pump(|case| !case.called("fleet.release").is_empty());
    assert_eq!(
        case.called("fleet.release")[0],
        json!({"node_id": "node-1", "name": "builder", "generation": "g7"})
    );
    let menu = case.app.fleet_menu(&broker, &legacy);
    let release = menu.iter().find(|(label, _)| label == "Release…").unwrap();
    assert!(
        release.1.is_none(),
        "a worker without a generation is not released"
    );
}

fn a_worker_without_an_id_is_released_under_its_row_key(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Agents);
    let broker: BrokerListing =
        serde_json::from_value(json!({"node_id": "node-9", "name": "desk", "workers": []}))
            .unwrap();
    let worker: WorkerRow =
        serde_json::from_value(worker("", "solo", "idle", json!("g1"))).unwrap();
    case.app.release(&broker, &worker);
    assert!(case
        .app
        .with_state(|state| state.releasing.contains("node-9|solo")));
    case.pump(|case| !case.called("fleet.release").is_empty());
}

fn a_refresh_asked_for_mid_read_reads_again(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Agents);
    // The page's own read ends first, so the count below is settled and the
    // first refresh starts a read of its own rather than queueing behind it.
    case.pump(|case| !case.app.in_flight().contains("local"));
    case.settle();
    let before = case.called("sessions.list").len();
    case.app.refresh_local();
    case.app.refresh_local();
    case.pump(|case| case.called("sessions.list").len() >= before + 2);
}

fn recent_messages_show_deliveries(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Agents);
    case.app.show_activity();
    case.pump(|case| {
        case.app
            .activity_rows()
            .is_some_and(|rows| labels(&rows).contains(&"@bo → @web".to_string()))
    });
    // A delivery event reads the log again.
    let before = case.called("activity.list").len();
    case.emit("invalidated", json!({"what": "activity"}));
    case.pump(|case| case.called("activity.list").len() > before);
    case.app.shell().unwrap().pages.messages.close_all();
}

// Team.

fn team_shows_a_card_per_teammate(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Team);
    let column = case.app.shell().unwrap().pages.team.column.clone();
    case.pump(|_| labels(&column).contains(&"Bo".to_string()));
    let shown = labels(&column);
    assert!(shown.contains(&"bos@cloud".to_string()));
    assert!(!shown.contains(&"remote@laptop".to_string()));
    // Running agents are offered, idle ones dimmed; offline ones are not.
    assert!(!shown.contains(&"gone@cloud".to_string()));
    let opacity = |address: &str| {
        label_named(&column, address)
            .and_then(|label| label.parent())
            .map(|words| words.opacity())
    };
    assert_eq!(opacity("napper@cloud"), Some(0.6));
    assert_eq!(opacity("bos@cloud"), Some(1.0));
    case.app.select_person(TeamPick::Person("h-bo".into()));
    assert!(labels(&case.app.shell().unwrap().topbar).contains(&"Bo".to_string()));
    // A people read redraws the page.
    case.answer(
        "people.list",
        json!({"people": [
            {"name": "Ada", "avatar_url": null, "identity_hash": "h-ada", "is_self": true},
            {"name": "Bo Brown", "avatar_url": null, "identity_hash": "h-bo", "is_self": false},
        ]}),
    );
    case.emit("invalidated", json!({"what": "people"}));
    case.pump(|_| labels(&column).contains(&"Bo Brown".to_string()));
}

// My sessions.

fn capy_setup_card_copies_the_prompt_and_hides_for_good(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::{
        CAPY_SETUP_COPIED, CAPY_SETUP_MESSAGE, CAPY_SETUP_PROMPT, CAPY_SETUP_TITLE,
    };
    let card = |case: &Case| case.app.shell().unwrap().pages.sessions.capy_setup.clone();
    let without = Case::new(runtime);
    without.sign_in();
    without.app.go(Page::Sessions);
    assert!(!card(&without).is_visible());
    assert!(labels(&card(&without)).is_empty());
    drop(without);

    let case = Case::with_capy(runtime);
    case.sign_in();
    case.app.go(Page::Sessions);
    let shown = labels(&card(&case));
    assert!(card(&case).is_visible());
    assert!(shown.contains(&"Capy detected".to_string()), "{shown:?}");
    assert!(shown.contains(&CAPY_SETUP_MESSAGE.to_string()), "{shown:?}");
    assert!(!shown.contains(&CAPY_SETUP_COPIED.to_string()), "{shown:?}");
    let set_up = buttons(&card(&case), "Set up in Capy");
    assert_eq!(set_up.len(), 1);
    set_up[0].emit_clicked();
    case.pump(|case| labels(&card(case)).contains(&CAPY_SETUP_COPIED.to_string()));
    assert_eq!(
        case.desktop.opened.borrow().last().map(String::as_str),
        Some("https://capy.ai")
    );
    let copied = std::rc::Rc::new(std::cell::RefCell::new(None));
    let received = copied.clone();
    card(&case)
        .clipboard()
        .read_text_async(None::<&gtk::gio::Cancellable>, move |result| {
            *received.borrow_mut() = Some(result.unwrap().unwrap().to_string())
        });
    case.pump(|_| copied.borrow().is_some());
    assert_eq!(copied.borrow().as_deref(), Some(CAPY_SETUP_PROMPT));
    // A redraw keeps the card and its confirmation.
    case.app.render_sessions();
    assert!(labels(&card(&case)).contains(&CAPY_SETUP_COPIED.to_string()));

    buttons(&card(&case), "Not now")[0].emit_clicked();
    case.pump(|case| !labels(&card(case)).contains(&CAPY_SETUP_TITLE.to_string()));
    assert!(!card(&case).is_visible());
    assert!(Preferences::load(case.prefs_path.clone()).capy_setup_dismissed());
}

fn devin_setup_card_turns_the_hooks_on_or_hides_for_good(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::{DEVIN_SETUP_MESSAGE, DEVIN_SETUP_TITLE};
    let card = |case: &Case| case.app.shell().unwrap().pages.sessions.devin_setup.clone();
    // The core reports Devin's hooks off: the card offers them.
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Sessions);
    case.pump(|case| labels(&card(case)).contains(&DEVIN_SETUP_TITLE.to_string()));
    assert!(card(&case).is_visible());
    assert!(labels(&card(&case)).contains(&DEVIN_SETUP_MESSAGE.to_string()));
    buttons(&card(&case), "Turn On")[0].emit_clicked();
    case.pump(|case| !case.called("settings.set").is_empty());
    assert_eq!(
        case.called("settings.set")[0],
        json!({"devin_direct_delivery": true})
    );
    case.pump(|case| !card(case).is_visible());
    assert!(!Preferences::load(case.prefs_path.clone()).devin_setup_dismissed());
    drop(case);

    // A refusal shows under the card, which stays.
    let case = Case::new(runtime);
    case.answer(
        "settings.set",
        Answer::fail(
            ErrorKind::Refused,
            "~/.config/devin/config.json cannot be written",
        ),
    );
    case.sign_in();
    case.app.go(Page::Sessions);
    case.pump(|case| card(case).is_visible());
    buttons(&card(&case), "Turn On")[0].emit_clicked();
    case.pump(|case| {
        labels(&card(case)).contains(&"~/.config/devin/config.json cannot be written".to_string())
    });
    assert!(card(&case).is_visible());
    drop(case);

    // Not now hides it for good, changing nothing.
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Sessions);
    case.pump(|case| card(case).is_visible());
    buttons(&card(&case), "Not now")[0].emit_clicked();
    case.pump(|case| !card(case).is_visible());
    assert!(Preferences::load(case.prefs_path.clone()).devin_setup_dismissed());
    assert!(case.called("settings.set").is_empty());
    case.app.render_sessions();
    assert!(!card(&case).is_visible());
}

fn sessions_show_uploads_and_mutate_through_the_core(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Sessions);
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let badge = buttons(&shell.root, "Live Agents on Relay: 1")
        .into_iter()
        .next()
        .expect("live relay agents badge");
    for start_page in [Page::Sessions, Page::Settings(Pane::Account)] {
        case.app
            .set_session_search("title:NoSuchSession is:off-relay");
        case.app.go(start_page);
        badge.emit_clicked();
        case.settle();
        assert_eq!(case.app.with_state(|state| state.page), Page::Sessions);
        assert_eq!(
            case.app.with_state(|state| state.session_search.clone()),
            "is:active is:on-relay"
        );
        let shown = labels(&page.list);
        assert!(shown.contains(&"Web".into()));
        assert!(
            !shown.contains(&"Old".into()),
            "Offline registrations are not live agents"
        );
        assert!(!shown.contains(&"API work".into()));
        assert!(!shown.contains(&"Fix login".into()));
    }
    case.app.set_session_search("");
    case.settle();
    let keys = page.row_keys();
    assert_eq!(keys.len(), 5);
    assert!(keys.contains(&"codex:one".into()));
    assert!(keys.contains(&"claude:two".into()));
    assert!(keys.contains(&"codex:thread-1".into()));
    let relay: gtk::Button = named(&page.root, "receive-messages codex:thread-1").remove(0);
    assert!(relay.is_sensitive());
    assert_eq!(
        case.called("uploader.sessions.list")[0],
        json!({"limit": 500})
    );
    assert!(!page.progress.is_visible());
    let shown = labels(&page.list);
    for label in ["Fix login", "Docs"] {
        assert!(shown.contains(&label.to_string()), "{label} in {shown:?}");
    }
    let uploaded = page.row("codex:one").expect("uploaded session row");
    assert!(shown.contains(&"Uploaded".into()));
    assert!(!shown.contains(&"Not uploading".into()));
    let icon = descendants(uploaded.upcast_ref())
        .into_iter()
        .find(|widget| widget.has_css_class("session-status-icon"))
        .expect("compact status icon");
    assert_eq!(icon.width_request(), 28);
    assert!(named::<gtk::Switch>(&page.root, "upload-switch codex:one").is_empty());
    let select = named::<gtk::CheckButton>(&page.root, "select-session codex:one").remove(0);
    assert!(!select.is_active());
    assert!(named::<gtk::Button>(&page.root, "sort-session-Upload status").is_empty());
    assert_eq!(icon.tooltip_text().as_deref(), Some("Uploaded"));
    assert_eq!(icon.first_child().unwrap().opacity(), 0.8);
    let local = page.row("claude:two").unwrap();
    assert!(descendants(local.upcast_ref()).iter().any(|widget| widget
        .tooltip_text()
        .is_some_and(|text| text == "Local only")));
    // A redraw with nothing changed keeps the rows, and so the scroll
    // position and an open menu.
    let first = page.list.row_at_index(0);
    case.app.render_page();
    assert_eq!(page.list.row_at_index(0), first);
    // Selecting both offers each change for the rows it applies to.
    named::<gtk::CheckButton>(&page.root, "select-session codex:one")[0].set_active(true);
    named::<gtk::CheckButton>(&page.root, "select-session claude:two")[0].set_active(true);
    assert_eq!(page.list.selected_rows().len(), 2);
    let bar = labels(&page.selection_bar);
    for label in ["2 selected", "Messaging", "Upload", "Hide"] {
        assert!(bar.contains(&label.to_string()), "{label} in {bar:?}");
    }
    assert!(!bar.contains(&"Clear".to_string()));
    assert!(!bar.contains(&"Enable Messages".to_string()));
    let upload = named::<gtk::Switch>(&page.selection_bar, "bulk-upload").remove(0);
    assert!(
        !upload.is_active(),
        "Mixed upload states must display as off"
    );
    let mut all_uploaded = sessions();
    all_uploaded["sessions"][1]["included"] = json!(true);
    case.answer("uploader.sessions.list", all_uploaded);
    upload.emit_by_name::<bool>("state-set", &[&true]);
    case.pump(|case| !case.called("uploader.sessions.include").is_empty());
    assert_eq!(
        case.called("uploader.sessions.include")[0],
        json!({"session_keys": ["claude:two"]})
    );
    case.pump(|case| {
        case.app
            .with_state(|state| !state.busy && state.requesting.is_empty())
    });
    let upload = named::<gtk::Switch>(&page.selection_bar, "bulk-upload").remove(0);
    assert_eq!(
        case.app.with_state(|state| state.session_selection.len()),
        2,
        "Uploading must preserve the selection for the next toggle"
    );
    assert!(upload.is_active(), "Both selected rows now upload");
    case.desktop.answer.set(true);
    case.answer(
        "uploader.sessions.delete",
        check::<method::UploaderSessionsDelete>(json!({"updated": 1})),
    );
    let mut all_local = sessions();
    all_local["sessions"][0]["included"] = json!(false);
    case.answer("uploader.sessions.list", all_local);
    upload.emit_by_name::<bool>("state-set", &[&false]);
    case.pump(|case| case.called("uploader.sessions.delete").len() == 2);
    let mut deleted: Vec<String> = case
        .called("uploader.sessions.delete")
        .iter()
        .flat_map(|call| {
            serde_json::from_value::<Vec<String>>(call["session_keys"].clone()).unwrap()
        })
        .collect();
    deleted.sort();
    assert_eq!(deleted, vec!["claude:two", "codex:one"]);
    case.pump(|case| case.app.with_state(|state| state.busy_uploads.is_empty()));
    assert!(
        case.app.with_state(|state| state.upload_errors.is_empty()),
        "Cloud deletion must succeed, not merely finish: {:?}",
        case.app.with_state(|state| state.upload_errors.clone())
    );
    assert!(!named::<gtk::Switch>(&page.selection_bar, "bulk-upload")[0].is_active());
    assert_eq!(
        case.app.with_state(|state| state.session_selection.len()),
        2,
        "Deleting cloud copies preserves selection for the next toggle"
    );
}

fn search_animation_closes_and_reopens_without_stale_dismissal(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.show_window();
    let shell = case.app.shell().unwrap();
    let menu: gtk::MenuButton = named(&shell.header_search, "session-filters").remove(0);
    let popover = menu.popover().unwrap();
    case.pump(|_| menu.is_mapped() && menu.width() > 0);
    case.app.focus_search();
    case.settle();
    assert!(popover.is_visible());
    assert!(!popover.has_css_class("search-collapsed"));
    named::<gtk::Button>(&popover, "session-search-close")[0].emit_clicked();
    assert!(popover.has_css_class("search-collapsed"));
    // The same shortcut path reverses a pending close, without needing native focus.
    case.app.focus_search();
    case.settle();
    assert!(
        popover.is_visible(),
        "A stale closing timer must not dismiss reopened search"
    );
    assert!(!popover.has_css_class("search-collapsed"));
    named::<gtk::Button>(&popover, "session-search-close")[0].emit_clicked();
    case.pump(|_| !popover.is_visible());
}

fn session_filter_popover_matches_macos_interactions(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let filters: gtk::MenuButton =
        named(&case.app.shell().unwrap().header_search, "session-filters").remove(0);
    let popover = filters.popover().unwrap();
    assert!(popover.is_autohide(), "Outside clicks dismiss search");
    assert!(
        !popover.has_arrow(),
        "Search expands over its bar without a callout arrow"
    );
    case.app.show_window();
    // Keys are delivered directly to the controller. Assert focus within this
    // window, not global desktop activation (which another app can own).
    // https://docs.gtk.org/gtk4/method.Widget.is_focus.html
    case.pump(|_| filters.is_mapped() && filters.width() > 0);
    case.app.focus_search();
    case.pump(|_| popover.is_visible());
    assert!(labels(&popover).contains(&"Harnesses".into()));
    assert!(labels(&popover).contains(&"Status".into()));
    assert!(labels(&popover).contains(&"Projects".into()));
    let before_keys = page.row_keys();
    let before_first_row = page.list.first_child();
    case.app.set_session_search("is:active harness:codex");
    assert_eq!(page.search.text(), "is:active harness:codex");
    assert_eq!(
        named::<gtk::Button>(
            &case.app.shell().unwrap().header_search,
            "session-filter-chip-1"
        )
        .len(),
        1,
        "Chips update synchronously before result work"
    );
    let codex = buttons(&popover, "Codex")[0]
        .child()
        .unwrap()
        .last_child()
        .unwrap();
    assert_eq!(codex.opacity(), 1.0, "Selection checks update immediately");
    assert_eq!(
        page.row_keys(),
        before_keys,
        "Editing must not synchronously filter the table"
    );
    assert_eq!(
        page.list.first_child(),
        before_first_row,
        "Keep the existing table during the editing turn"
    );
    case.app.set_session_search("harness:claude");
    case.app.set_session_search("harness:codex");
    assert_eq!(page.search.text(), "harness:codex");
    case.pump(|_| {
        !page.row_keys().is_empty() && page.row_keys().iter().all(|key| key.starts_with("codex:"))
    });
    case.app.set_session_search("");
    case.settle();
    let keyboard = (0..popover.observe_controllers().n_items())
        .filter_map(|index| popover.observe_controllers().item(index))
        .filter_map(|controller| controller.downcast::<gtk::EventControllerKey>().ok())
        .find(|controller| controller.name().as_deref() == Some("session-search-navigation"))
        .unwrap();
    keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Down,
            &0u32,
            &gtk::gdk::ModifierType::empty(),
        ],
    );
    let hovered = buttons(&popover, "Claude")[0].clone();
    assert!(hovered.is_focus());
    keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Right,
            &0u32,
            &gtk::gdk::ModifierType::empty(),
        ],
    );
    assert_eq!(page.search.text(), "harness:claude ");
    assert!(
        hovered.is_focus(),
        "Right Arrow retains the same highlighted option"
    );
    keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Right,
            &0u32,
            &gtk::gdk::ModifierType::empty(),
        ],
    );
    assert_eq!(
        page.search.text(),
        "harness:claude ",
        "Repeated Right Arrow does not deselect"
    );

    keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Left,
            &0u32,
            &gtk::gdk::ModifierType::empty(),
        ],
    );
    assert!(page.search.text().is_empty());
    assert!(
        hovered.is_focus(),
        "Left Arrow removes the filter without moving highlight"
    );
    keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Left,
            &0u32,
            &gtk::gdk::ModifierType::empty(),
        ],
    );
    assert!(
        page.search.text().is_empty(),
        "Repeated Left Arrow does not add the option back"
    );
    case.app.set_session_search("harness:codex is:active");
    buttons(&popover, "Inactive")[0].emit_clicked();
    assert_eq!(page.search.text(), "harness:codex is:inactive ");
    let active_check = buttons(&popover, "Active")[0]
        .child()
        .unwrap()
        .last_child()
        .unwrap();
    let inactive_check = buttons(&popover, "Inactive")[0]
        .child()
        .unwrap()
        .last_child()
        .unwrap();
    assert_eq!(active_check.opacity(), 0.0);
    assert_eq!(inactive_check.opacity(), 1.0);
    buttons(&popover, "Active")[0].emit_clicked();
    assert_eq!(page.search.text(), "harness:codex is:active ");
    assert_eq!(active_check.opacity(), 1.0);
    assert_eq!(inactive_check.opacity(), 0.0);
    case.app.set_session_search("");
    case.app.set_session_search("ap");
    keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Down,
            &0u32,
            &gtk::gdk::ModifierType::empty(),
        ],
    );
    assert!(buttons(&popover, "api")[0].is_focus());
    let highlighted_project = buttons(&popover, "api")[0].clone();
    keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Right,
            &0u32,
            &gtk::gdk::ModifierType::empty(),
        ],
    );
    assert_eq!(
        page.search.text(),
        "project:api ",
        "Right Arrow replaces the partial text with the highlighted filter"
    );
    assert!(
        popover.is_visible(),
        "Right Arrow keeps search open for more filters"
    );
    assert!(
        highlighted_project.is_focus(),
        "Completion keeps the same item highlighted"
    );
    for _ in 0..30 {
        for (key, expected) in [
            (gtk::gdk::Key::Left, ""),
            (gtk::gdk::Key::Right, "project:api "),
        ] {
            keyboard.emit_by_name::<bool>(
                "key-pressed",
                &[&key, &0u32, &gtk::gdk::ModifierType::empty()],
            );
            assert_eq!(page.search.text(), expected);
            assert!(
                highlighted_project.is_focus(),
                "Rapid arrows retain the target"
            );
        }
    }
    keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Left,
            &0u32,
            &gtk::gdk::ModifierType::empty(),
        ],
    );
    assert!(page.search.text().is_empty());
    assert!(popover.is_visible());
    case.app.set_session_search("ap");
    keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Down,
            &0u32,
            &gtk::gdk::ModifierType::empty(),
        ],
    );
    keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Return,
            &0u32,
            &gtk::gdk::ModifierType::empty(),
        ],
    );
    assert_eq!(
        page.search.text(),
        "project:api ",
        "Enter commits the highlighted project, not the typed fragment"
    );
    case.pump(|_| !popover.is_visible());
    filters.popup();
    case.app.set_session_search("plain words");
    page.search.grab_focus();
    page.search.emit_activate();
    assert_eq!(
        page.search.text(),
        "plain words",
        "Enter without suggestion navigation preserves free text"
    );
    case.pump(|_| !popover.is_visible());
    filters.popup();
    case.app.set_session_search("");
    case.app.set_session_search("har");
    case.settle();
    buttons(&popover, "Codex")[0].emit_clicked();
    assert_eq!(page.search.text(), "harness:codex ");
    case.app.set_session_search("");
    case.settle();
    buttons(&popover, "Active")[0].emit_clicked();
    case.settle();
    assert!(
        popover.is_visible(),
        "Like macOS, selecting a filter keeps the same popover open"
    );
    let current: gtk::MenuButton =
        named(&case.app.shell().unwrap().header_search, "session-filters").remove(0);
    assert_eq!(
        current, filters,
        "Updating results must preserve the focused control"
    );
    case.app.render_sessions();
    assert!(
        popover.is_visible(),
        "Background refresh must not dismiss the menu"
    );
    buttons(&popover, "Codex")[0].emit_clicked();
    assert_eq!(page.search.text().trim_end(), "is:active harness:codex");
    case.settle();
    assert_eq!(page.row_keys(), ["codex:thread-1"]);
    assert_eq!(page.count.text(), "1 session on this machine");
    let shell = case.app.shell().unwrap();
    assert_eq!(
        page.count.parent(),
        Some(shell.session_summary.clone().upcast())
    );
    assert!(
        page.error.parent().is_none(),
        "Errors are shown through status details"
    );
    case.app
        .update_state(|state| state.session_error = Some("History upgrade needs attention".into()));
    case.app.render_status_bar();
    assert_eq!(shell.status_text.text(), "Needs attention");
    let status_button = shell
        .status_text
        .ancestor(gtk::Button::static_type())
        .unwrap()
        .downcast::<gtk::Button>()
        .unwrap();
    status_button.emit_clicked();
    assert_eq!(case.app.page(), Page::Settings(Pane::Diagnostics));
    assert!(labels(&shell.settings.column)
        .iter()
        .any(|text| text.contains("History upgrade needs attention")));
    assert_eq!(buttons(&shell.settings.column, "Copy details").len(), 1);
    case.app.update_state(|state| state.session_error = None);
    case.app.go(Page::Sessions);
    if cfg!(windows) {
        // Hiding the header's surface closes an open popover on Win32 (GTK
        // keeps it open on Linux), so leaving Sessions closed the panel.
        case.pump(|_| !popover.is_visible());
        filters.popup();
        case.settle();
    }

    assert_eq!(
        shell.session_summary.parent(),
        shell
            .status_text
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
    );
    let clear: gtk::Button = named(
        &case.app.shell().unwrap().header_search,
        "session-search-clear",
    )
    .remove(0);
    assert!(clear.is_visible());
    assert_eq!(clear.tooltip_text().as_deref(), Some("clear search"));
    clear.emit_clicked();
    assert!(page.search.text().is_empty());
    assert!(!clear.is_visible());
    assert!(
        popover.is_visible(),
        "Clearing must not activate or dismiss the search trigger"
    );
    case.app.set_session_search("is:active harness:codex");
    case.settle();
    buttons(&popover, "Claude")[0].emit_clicked();
    assert_eq!(
        page.search.text(),
        "is:active harness:codex harness:claude "
    );
    assert!(page.row_keys().contains(&"codex:thread-1".to_string()));
    buttons(&popover, "Codex")[0].emit_clicked();
    assert_eq!(page.search.text(), "is:active harness:claude ");
    buttons(&popover, "Claude")[0].emit_clicked();
    assert_eq!(page.search.text(), "is:active ");
    case.app.set_session_search("is:active harness:codex");
    case.settle();
    buttons(&popover, "Last 7 days")[0].emit_clicked();
    assert!(page.search.text().contains("updated:>="));
    assert!(popover.is_visible());
    buttons(&popover, "Any date")[0].emit_clicked();
    assert_eq!(page.search.text().trim_end(), "is:active harness:codex");
    named::<gtk::Button>(&popover, "session-search-close")[0].emit_clicked();
    assert!(
        popover.has_css_class("search-collapsed"),
        "Closing collapses the panel toward its search bar"
    );
    case.settle();
    assert!(!popover.is_visible());
    case.app
        .set_session_search("fix harness:codex harness:claude -is:inactive project:\"my project\"");
    case.settle();
    let chip: gtk::Button = named(
        &case.app.shell().unwrap().header_search,
        "session-filter-chip-1",
    )
    .remove(0);
    chip.emit_clicked();
    assert_eq!(
        page.search.text(),
        "fix harness:claude -is:inactive project:\"my project\""
    );
    assert!(
        !popover.is_visible(),
        "Removing a chip must not open the search panel"
    );
    assert!(
        named::<gtk::Button>(
            &case.app.shell().unwrap().header_search,
            "session-filter-chip-2"
        )
        .len()
            == 1,
        "Exclusions are removable chips too"
    );
    case.settle();
    let bar: gtk::Box = named(
        &case.app.shell().unwrap().header_search,
        "session-search-bar",
    )
    .remove(0);
    assert!(
        bar.width() > page.controls.width() * 7 / 10,
        "Search fills the space beside Group by"
    );
    assert!(
        bar.allocated_height() >= 44,
        "Search has generous vertical padding: content={}, allocated={}",
        bar.height(),
        bar.allocated_height()
    );
    let clicks = (0..bar.observe_controllers().n_items())
        .filter_map(|index| bar.observe_controllers().item(index))
        .find_map(|controller| controller.downcast::<gtk::GestureClick>().ok())
        .unwrap();
    let remove: gtk::Button = named(
        &case.app.shell().unwrap().header_search,
        "session-filter-chip-1",
    )
    .remove(0);
    let chip_label = remove.parent().unwrap().first_child().unwrap();
    let label_point = chip_label
        .compute_point(&bar, &gtk::graphene::Point::new(2.0, 2.0))
        .unwrap();
    let before = page.search.text().to_string();
    clicks.emit_by_name::<()>(
        "released",
        &[&1i32, &(label_point.x() as f64), &(label_point.y() as f64)],
    );
    assert!(popover.is_visible(), "Clicking a chip label opens search");
    assert_eq!(
        page.search.text(),
        before,
        "Chip labels must not remove filters"
    );
    popover.popdown();
    case.pump(|_| !popover.is_visible());
    let remove_point = remove
        .compute_point(&bar, &gtk::graphene::Point::new(2.0, 2.0))
        .unwrap();
    clicks.emit_by_name::<()>(
        "released",
        &[
            &1i32,
            &(remove_point.x() as f64),
            &(remove_point.y() as f64),
        ],
    );
    assert!(
        !popover.is_visible(),
        "The remove target does not open search"
    );
    clicks.emit_by_name::<()>("released", &[&1i32, &3.0f64, &(-3.0f64)]);
    assert!(
        popover.is_visible(),
        "Clicking the bar padding opens search"
    );
    popover.popdown();
    clicks.emit_by_name::<()>("released", &[&1i32, &3.0f64, &(-3.0f64)]);
    case.settle();
    assert!(
        popover.is_visible(),
        "Reopening cancels an in-flight collapse"
    );
    assert!(!popover.has_css_class("search-collapsed"));
    popover.popdown();
    case.app.set_session_search("");
    case.settle();
    named::<gtk::MenuButton>(&page.controls, "session-columns")[0].popup();
    let grouping: gtk::DropDown = named(&page.controls, "session-grouping").remove(0);
    grouping.set_selected(1);
    case.settle();
    assert_eq!(grouping.selected(), 1);
    case.app.set_session_search("title:NoSuchSession");
    case.settle();
    assert!(labels(&page.empty).contains(&"No sessions match these filters.".into()));
    buttons(&page.empty, "Clear search and filters")[0].emit_clicked();
    assert!(page.search.text().is_empty());
    case.settle();
    assert_eq!(page.row_keys().len(), 5);
}

fn diagnostics_copy_details_keeps_feedback_across_redraw(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app
        .update_state(|state| state.session_error = Some("History upgrade needs attention".into()));
    case.app.go(Page::Settings(Pane::Diagnostics));
    let shell = case.app.shell().unwrap();
    let copy = buttons(&shell.settings.column, "Copy details")
        .into_iter()
        .next()
        .expect("Current problems copy button");
    copy.emit_clicked();
    assert_eq!(copy.label().as_deref(), Some("Copied"));
    let copied = std::rc::Rc::new(std::cell::RefCell::new(None));
    let received = copied.clone();
    copy.clipboard()
        .read_text_async(None::<&gtk::gio::Cancellable>, move |result| {
            *received.borrow_mut() = Some(result.unwrap().unwrap().to_string());
        });
    case.pump(|_| copied.borrow().is_some());
    assert_eq!(
        copied.borrow().as_deref(),
        Some("History upgrade needs attention")
    );
    case.app.render_settings();
    assert_eq!(
        buttons(&shell.settings.column, "Copied").len(),
        1,
        "request-log redraws keep the copy confirmation"
    );
    case.pump(|_| buttons(&shell.settings.column, "Copy details").len() == 1);
}

fn sessions_message_orb_tracks_confirmed_availability(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let control = || named::<gtk::Button>(&page.root, "receive-messages codex:thread-1").remove(0);
    let color = |class: &str| control().has_css_class(class);
    assert!(labels(&page.root).contains(&"Messages".into()));
    assert!(labels(&page.root).contains(&"Upload".into()));
    assert!(color("offline"));
    assert!(labels(&control()).contains(&"Off".into()));
    let release = Arc::new(Notify::new());
    case.answer(
        "agents.register",
        held_answer(
            Arc::new(Notify::new()),
            release.clone(),
            json!({"name":"api-work", "address":"api-work@desk", "already_registered":false}),
        ),
    );
    control().emit_clicked();
    assert!(color("connecting"));
    assert!(labels(&control()).contains(&"Connecting…".into()));
    assert!(control().is_sensitive(), "Connecting can be cancelled");
    case.pump(|case| case.called("agents.register").len() == 1);
    let mut registered = local();
    registered["sessions"][0]["registration"] = json!({"name":"api-work", "address":"api-work@desk", "added_by_session":false, "push":null});
    case.answer("sessions.list", registered.clone());
    release.notify_one();
    case.pump(|case| case.app.with_state(|state| state.busy_targets.is_empty()));
    assert!(
        color("connecting"),
        "A registration alone does not mean ready to receive"
    );
    registered["sessions"][0]["registration"]["push"] = json!({"state":"live"});
    case.answer("sessions.list", registered.clone());
    case.app.refresh_local();
    case.pump(|_| color("online"));
    assert!(labels(&control()).contains(&"Receiving".into()));
    // The agent name leads the row's second line; a rename shows its alias.
    let agent_name = || named::<gtk::Label>(&page.root, "agent-name codex:thread-1").remove(0);
    assert_eq!(agent_name().text(), "@api-work");
    registered["sessions"][0]["registration"]["alias"] = json!("reviewer");
    case.answer("sessions.list", registered);
    case.app.refresh_local();
    case.pump(|_| agent_name().text() == "@reviewer");
    assert_eq!(
        agent_name().tooltip_text().as_deref(),
        Some("Renamed from @api-work. Only @reviewer is shown and replies come from it; messages still sent to @api-work arrive here.")
    );
    let release = Arc::new(Notify::new());
    case.answer(
        "agents.unregister",
        held_answer(
            Arc::new(Notify::new()),
            release.clone(),
            json!({"removed":true}),
        ),
    );
    control().emit_clicked();
    assert!(
        color("offline"),
        "Going offline is reflected before the core answers"
    );
    assert!(labels(&control()).contains(&"Turning off…".into()));
    case.pump(|case| case.called("agents.unregister").len() == 1);
    case.answer("sessions.list", local());
    release.notify_one();
    case.pump(|case| case.app.with_state(|state| state.busy_targets.is_empty()));
    assert!(color("offline"));
}

fn sessions_upload_requests_are_independent_and_latest_click_wins(
    runtime: &tokio::runtime::Runtime,
) {
    let case = Case::new(runtime);
    case.sign_in();
    case.desktop.answer.set(true);
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let release = Arc::new(Notify::new());
    case.answer(
        "uploader.sessions.delete",
        held_answer(
            Arc::new(Notify::new()),
            release.clone(),
            json!({"updated": 1}),
        ),
    );

    case.app
        .request_upload_change(vec!["codex:one".into()], false);
    case.pump(|case| case.called("uploader.sessions.delete").len() == 1);
    assert!(!case.app.with_state(|state| state.busy));
    case.app
        .request_upload_change(vec!["claude:two".into()], true);
    case.pump(|case| case.called("uploader.sessions.include").len() == 1);
    case.app
        .request_upload_change(vec!["codex:one".into()], true);
    assert_eq!(case.called("uploader.sessions.include").len(), 1);
    let mut listed = sessions();
    listed["sessions"][1]["included"] = json!(true);
    listed["sessions"][1]["status"] = json!("shared");
    case.answer("uploader.sessions.list", listed);
    release.notify_one();
    case.pump(|case| {
        case.called("uploader.sessions.include").len() == 2
            && case.app.with_state(|state| state.busy_uploads.is_empty())
    });
    assert_eq!(
        case.called("uploader.sessions.include")[1],
        json!({"session_keys": ["codex:one"]})
    );
    assert!(case
        .app
        .with_state(|state| state.requesting.is_empty() && state.stopping.is_empty()));
}

fn sessions_failed_upload_rolls_back_only_its_row(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    case.answer(
        "uploader.sessions.include",
        fail(ErrorKind::CloudFailed, "Upload service unavailable"),
    );
    case.app.change_uploads(vec!["claude:two".into()], true);
    case.pump(|case| {
        case.app
            .with_state(|state| state.upload_errors.contains_key("claude:two"))
    });
    assert!(!case
        .app
        .with_state(|state| state.requesting.contains("claude:two")));
    assert!(labels(&page.row("codex:one").unwrap()).contains(&"Uploaded".into()));
    assert!(labels(&page.list).contains(&"Upload service unavailable".into()));
}

fn sessions_reenable_after_uncertain_delete_reaches_core(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.desktop.answer.set(true);
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let release = Arc::new(Notify::new());
    let ready = release.clone();
    case.answer(
        "uploader.sessions.delete",
        Answer::with(move |_| {
            let release = ready.clone();
            async move {
                release.notified().await;
                Err(RpcError::new(ErrorKind::CloudFailed, "Deletion reply lost"))
            }
        }),
    );
    case.app
        .request_upload_change(vec!["codex:one".into()], false);
    case.pump(|case| case.called("uploader.sessions.delete").len() == 1);
    case.app
        .request_upload_change(vec!["codex:one".into()], true);
    release.notify_one();
    case.pump(|case| case.called("uploader.sessions.include").len() == 1);
    case.pump(|case| case.app.with_state(|state| state.busy_uploads.is_empty()));
    assert!(case.app.with_state(|state| state.upload_errors.is_empty()));
}

fn sessions_upload_icon_animates_only_while_uploading(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let mut listed = sessions();
    listed["sessions"][0]["included"] = json!(true);
    listed["sessions"][0]["status"] = json!("uploading");
    case.answer("uploader.sessions.list", listed.clone());
    case.app.refresh_uploader(true);
    case.pump(|_| !named::<gtk::Widget>(&page.root, "session-upload-activity").is_empty());
    let activity = named::<gtk::Widget>(&page.root, "session-upload-activity").remove(0);
    assert_eq!(
        activity.parent().unwrap().tooltip_text().as_deref(),
        Some("Uploading…")
    );
    // Refreshing an unchanged row must keep its animation, rather than restart it.
    case.app.render_sessions();
    assert_eq!(
        named::<gtk::Widget>(&page.root, "session-upload-activity")[0],
        activity
    );
    listed["sessions"][0]["status"] = json!("uploaded");
    case.answer("uploader.sessions.list", listed);
    case.app.refresh_uploader(true);
    case.pump(|_| named::<gtk::Widget>(&page.root, "session-upload-activity").is_empty());
    let row = page.row("codex:one").unwrap();
    assert!(descendants(row.upcast_ref())
        .iter()
        .any(|widget| widget.tooltip_text().as_deref() == Some("Uploaded")));
}

fn sessions_action_cursors_follow_sensitivity(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let open: gtk::Button = named(&page.root, "open-session codex:one").remove(0);
    let header: gtk::Button = named(&page.root, "sort-session-Session").remove(0);
    let filters: gtk::MenuButton =
        named(&case.app.shell().unwrap().header_search, "session-filters").remove(0);
    let upload: gtk::CheckButton = named(&page.root, "select-session codex:one").remove(0);
    let unavailable: gtk::Button = named(&page.root, "receive-messages codex:one").remove(0);
    let row = page.row("codex:one").unwrap();
    let cursor = |widget: &gtk::Widget| {
        widget
            .cursor()
            .and_then(|cursor| cursor.name())
            .map(|name| name.to_string())
    };
    for control in [
        open.upcast_ref(),
        header.upcast_ref(),
        filters.upcast_ref(),
        upload.upcast_ref(),
        row.upcast_ref(),
    ] {
        assert_eq!(
            cursor(control).as_deref(),
            Some("pointer"),
            "{}",
            control.widget_name()
        );
    }
    assert!(!unavailable.is_sensitive());
    assert_eq!(cursor(unavailable.upcast_ref()).as_deref(), Some("default"));
    upload.set_sensitive(false);
    assert_eq!(cursor(upload.upcast_ref()).as_deref(), Some("default"));
    upload.set_sensitive(true);
    assert_eq!(cursor(upload.upcast_ref()).as_deref(), Some("pointer"));
    // Disabling the whole page also removes the action affordance from children.
    page.root.set_sensitive(false);
    assert_eq!(cursor(open.upcast_ref()).as_deref(), Some("default"));
    assert_eq!(cursor(header.upcast_ref()).as_deref(), Some("default"));
    page.root.set_sensitive(true);
    assert_eq!(cursor(open.upcast_ref()).as_deref(), Some("pointer"));
    assert_eq!(cursor(header.upcast_ref()).as_deref(), Some("pointer"));
    assert_eq!(cursor(unavailable.upcast_ref()).as_deref(), Some("default"));
}

fn sessions_sort_by_headers_and_preserve_order_on_refresh(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let title: gtk::Button = named(&page.root, "sort-session-Session").remove(0);
    title.emit_clicked();
    assert_eq!(
        page.row_keys(),
        [
            "codex:thread-1",
            "claude:two",
            "codex:one",
            "codex:gone",
            "claude:c-2"
        ]
    );
    assert!(labels(&title).contains(&"↑".into()));
    title.emit_clicked();
    let descending = vec![
        "claude:c-2",
        "codex:gone",
        "codex:one",
        "claude:two",
        "codex:thread-1",
    ];
    assert_eq!(page.row_keys(), descending);
    assert!(labels(&title).contains(&"↓".into()));
    case.app.render_sessions();
    assert_eq!(page.row_keys(), descending);
    case.app.set_session_search("harness:codex");
    case.settle();
    assert_eq!(
        page.row_keys(),
        ["codex:gone", "codex:one", "codex:thread-1"]
    );
    case.app.set_session_search("");
    case.settle();
    case.app.set_session_grouping(1);
    assert_eq!(
        page.row_keys(),
        [
            "claude:c-2",
            "claude:two",
            "codex:gone",
            "codex:one",
            "codex:thread-1"
        ]
    );
    case.app.set_session_grouping(0);
    let mut listed = sessions();
    listed["sessions"].as_array_mut().unwrap().push(upload_row(
        "codex",
        "new",
        "Zebra",
        "/w/new",
        false,
        "not_shared",
    ));
    case.answer("uploader.sessions.list", listed);
    case.app.refresh_uploader(true);
    case.pump(|_| {
        page.row_keys()
            .first()
            .is_some_and(|key| key == "codex:new")
    });
    let status: gtk::Button = named(&page.root, "sort-session-Upload").remove(0);
    status.emit_clicked();
    assert!(labels(&status).contains(&"↓".into()));
    assert!(!labels(&title).contains(&"↓".into()));
    assert!(status.tooltip_text().unwrap().contains("ascending"));
}

fn confirmed_cloud_delete_still_runs_after_hide_excludes_upload(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.set_sessions_hidden(vec!["codex:one".into()], true);
    case.pump(|case| {
        case.app
            .with_state(|state| state.hiding_sessions.is_empty())
    });
    assert_eq!(case.called("uploader.sessions.exclude").len(), 1);
    assert!(!case.app.with_state(|state| state
        .sessions
        .iter()
        .find(|row| agent_relay_probe::linux_app::models::session_key(row) == "codex:one")
        .unwrap()
        .included));
    assert!(
        case.called("uploader.sessions.delete").is_empty(),
        "Hide only excludes uploads"
    );
    case.desktop.answer.set(true);
    case.app
        .request_upload_change(vec!["codex:one".into()], false);
    case.settle();
    assert_eq!(
        case.called("uploader.sessions.delete").len(),
        1,
        "Confirmed deletion must remove the Cloud copy after Hide excluded uploads"
    );
}

fn sessions_cloud_delete_requires_confirmation(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    case.desktop.answer.set(false);
    case.app
        .request_upload_change(vec!["codex:one".into()], false);
    case.settle();
    assert!(case.called("uploader.sessions.delete").is_empty());
    assert_eq!(
        case.desktop.asked.borrow().last().unwrap().title,
        "Delete cloud copy?"
    );
    assert!(case.desktop.asked.borrow().last().unwrap().destructive);
    case.app
        .request_upload_change(vec!["codex:one".into(), "claude:two".into()], false);
    case.settle();
    {
        let confirmations = case.desktop.asked.borrow();
        let bulk = confirmations.last().unwrap();
        assert_eq!(bulk.title, "Delete cloud copies?");
        assert_eq!(bulk.detail, "This removes the selected cloud copies and stops future uploads. Your local history stays on this machine.");
        assert!(bulk.destructive);
    }
    assert!(case.called("uploader.sessions.delete").is_empty());
    // Click again with explicit consent, using the actual control.
    case.app
        .request_upload_change(vec!["codex:one".into()], true);
    case.desktop.answer.set(true);
    case.app
        .request_upload_change(vec!["codex:one".into()], false);
    case.pump(|case| !case.called("uploader.sessions.delete").is_empty());
    assert!(case.called("uploader.sessions.exclude").is_empty());
}

fn sessions_show_harness_model_and_reasoning(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let mut listed = sessions();
    listed["sessions"][0]["models"] = json!(["gpt-6"]);
    listed["sessions"][0]["reasoning_effort"] = json!("high");
    listed["sessions"][0]["first_activity_ms"] = json!(1_700_000_000_000i64);
    listed["sessions"][1]["first_activity_ms"] = json!(1_700_086_400_000i64);
    case.answer("uploader.sessions.list", listed.clone());
    case.app.refresh_uploader(true);
    case.pump(|case| {
        labels(&case.app.shell().unwrap().pages.sessions.list)
            .contains(&"gpt-6 · Codex · high reasoning".into())
    });
    let shell = case.app.shell().unwrap();
    use agent_relay_probe::linux_app::models::SessionColumn;
    let mut layout = case.app.session_columns();
    for column in [
        SessionColumn::Model,
        SessionColumn::Reasoning,
        SessionColumn::Created,
        SessionColumn::Harness,
    ] {
        layout.set_visible(column, true);
    }
    case.app.set_session_columns(layout);
    let list = &shell.pages.sessions.list;
    assert!(
        labels(&named::<gtk::Button>(list, "session-cell model codex:one")[0])
            .contains(&"gpt-6".into())
    );
    assert!(
        labels(&named::<gtk::Button>(list, "session-cell reasoning codex:one")[0])
            .contains(&"high".into())
    );
    let created = named::<gtk::Button>(list, "session-cell created codex:one").remove(0);
    assert!(labels(&created).iter().any(|label| label.ends_with("ago")));
    assert!(descendants(created.upcast_ref())
        .iter()
        .any(|widget| widget.tooltip_text().as_deref() == Some("Nov 14, 2023, 10:13:20 PM UTC")));
    for column in SessionColumn::ALL {
        let header = named::<gtk::Button>(
            &shell.pages.sessions.root,
            &format!("sort-session-{}", column.title()),
        )
        .remove(0);
        assert!(header.tooltip_text().unwrap().contains("click to sort"));
    }
    let header = named::<gtk::Button>(&shell.pages.sessions.root, "sort-session-Created").remove(0);
    header.emit_clicked();
    assert_eq!(
        &shell.pages.sessions.row_keys()[..2],
        &["claude:two", "codex:one"]
    );
    header.emit_clicked();
    assert_eq!(
        &shell.pages.sessions.row_keys()[..2],
        &["codex:one", "claude:two"]
    );
    assert!(labels(&shell.pages.sessions.list).contains(&"Claude".into()));
    case.app.set_session_grouping(1);
    assert!(labels(&shell.pages.sessions.list).contains(&"gpt-6 · Codex · high reasoning".into()));
    listed["sessions"][0]["models"] = json!(["gpt-6-mini"]);
    listed["sessions"][0]["reasoning_effort"] = json!("low");
    case.answer("uploader.sessions.list", listed);
    case.app.refresh_uploader(true);
    case.pump(|case| {
        labels(&case.app.shell().unwrap().pages.sessions.list)
            .contains(&"gpt-6-mini · Codex · low reasoning".into())
    });
}

fn sessions_paginate_on_scroll_without_controls(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let rows: Vec<Value> = (0..503)
        .map(|i| {
            upload_row(
                "codex",
                &format!("history-{i}"),
                &format!("Session {i}"),
                "/w/api",
                false,
                "not_shared",
            )
        })
        .collect();
    case.answer(
        "uploader.sessions.list",
        json!({"sharing_mode": "selected", "sessions": &rows[..500]}),
    );
    case.app.refresh_uploader(true);
    case.app.window().present();
    case.pump(|case| {
        case.app
            .with_state(|s| s.sessions.len() == 500 && !s.refreshing_uploader)
    });
    case.settle();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    assert!(buttons(&page.root, "Load more").is_empty());
    let refresh: Vec<gtk::Button> = descendants(case.app.window().upcast_ref())
        .into_iter()
        .filter_map(|w| w.downcast::<gtk::Button>().ok())
        .filter(|b| b.tooltip_text().as_deref() == Some("Refresh sessions"))
        .collect();
    assert!(refresh.is_empty());
    assert_eq!(case.app.with_state(|s| s.session_limit), 500);
    // The sign-in preview count remains populated; it must not prevent
    // pagination once the authoritative session list has arrived.
    assert!(case.app.with_state(|s| s.preview_count) > 0);
    case.answer(
        "uploader.sessions.list",
        json!({"sharing_mode": "selected", "sessions": rows}),
    );
    let scroller = page
        .list
        .ancestor(gtk::ScrolledWindow::static_type())
        .unwrap()
        .downcast::<gtk::ScrolledWindow>()
        .unwrap();
    let adjustment = scroller.vadjustment();
    // The session response arrives before GTK allocates the rebuilt table.
    // Wait for its last row and viewport, so scrolling exercises real layout.
    case.pump(|_| {
        scroller.is_mapped()
            && adjustment.page_size() > 0.0
            && page
                .list
                .row_at_index(499)
                .is_some_and(|row| row.height() > 0)
    });
    assert!(adjustment.upper() > adjustment.page_size(),
        "Allocated pagination table must overflow: upper={}, page_size={}, list_height={}, scroller_height={}",
        adjustment.upper(), adjustment.page_size(), page.list.height(), scroller.height());
    assert_eq!(
        case.app.with_state(|s| s.session_limit),
        500,
        "The first laid-out viewport must not load older history before scrolling"
    );
    adjustment.set_value(adjustment.upper() - adjustment.page_size());
    case.settle();
    case.pump(|case| {
        case.app
            .with_state(|s| s.sessions.len() == 503 && !s.refreshing_uploader)
    });
    assert_eq!(case.app.with_state(|s| s.session_limit), 1000);
    adjustment.set_value(adjustment.upper() - adjustment.page_size());
    case.settle();
    assert_eq!(case.app.with_state(|s| s.session_limit), 1000);
}

fn group_checkboxes_select_only_their_group(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let group: gtk::DropDown = named(&page.controls, "session-grouping").remove(0);
    group.set_selected(1);
    let codex = || named::<gtk::CheckButton>(&page.list, "select-session-group Codex").remove(0);
    assert!(!codex().is_active());
    codex().set_active(true);
    let selected = || case.app.with_state(|state| state.session_selection.clone());
    assert_eq!(
        selected(),
        ["codex:one", "codex:thread-1", "codex:gone"]
            .into_iter()
            .map(String::from)
            .collect()
    );
    named::<gtk::CheckButton>(&page.list, "select-session claude:two")[0].set_active(true);
    named::<gtk::CheckButton>(&page.list, "select-session codex:one")[0].set_active(false);
    assert!(
        !codex().is_active(),
        "Individual row changes update the group checkbox"
    );
    codex().set_active(true);
    assert_eq!(selected().len(), 4);
    codex().set_active(false);
    assert_eq!(selected(), ["claude:two".to_string()].into_iter().collect());
    named::<gtk::Button>(&page.list, "session-group Codex")[0].emit_clicked();
    assert!(page.row("codex:one").is_none());
    codex().set_active(true);
    assert_eq!(
        selected().len(),
        4,
        "Collapsed groups still select all their rows"
    );
    named::<gtk::Button>(&page.list, "session-group Codex")[0].emit_clicked();
    assert!(page.row("codex:one").unwrap().is_selected());
    assert!(codex().is_active());
    case.app.clear_session_selection();
    assert!(!codex().is_active());
    case.app.set_session_search("API work");
    case.settle();
    codex().set_active(true);
    assert_eq!(
        selected(),
        ["codex:thread-1".to_string()].into_iter().collect(),
        "Group selection respects the current filter"
    );
}

fn bulk_messaging_mixed_selection_turns_all_on_then_off(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    for key in ["codex:thread-1", "claude:c-2"] {
        named::<gtk::CheckButton>(&page.root, &format!("select-session {key}"))[0].set_active(true);
    }
    let messaging = named::<gtk::Switch>(&page.selection_bar, "bulk-messaging").remove(0);
    assert!(
        !messaging.is_active(),
        "Mixed messaging states display as off"
    );
    let mut registered = local();
    registered["sessions"][0]["registration"] = json!({"name":"api-work", "address":"api-work@desk", "added_by_session":false, "push":null});
    case.answer("sessions.list", registered);
    messaging.emit_by_name::<bool>("state-set", &[&true]);
    case.pump(|case| {
        !case.called("agents.register").is_empty()
            && case.app.with_state(|s| s.busy_targets.is_empty())
    });
    let messaging = named::<gtk::Switch>(&page.selection_bar, "bulk-messaging").remove(0);
    assert!(
        messaging.is_active(),
        "All selected sessions now have messaging enabled"
    );
    let mut unregistered = local();
    unregistered["sessions"][1]["registration"] = Value::Null;
    case.answer("sessions.list", unregistered);
    messaging.emit_by_name::<bool>("state-set", &[&false]);
    case.pump(|case| {
        case.called("agents.unregister").len() == 2
            && case.app.with_state(|s| s.busy_targets.is_empty())
    });
    assert!(!named::<gtk::Switch>(&page.selection_bar, "bulk-messaging")[0].is_active());
}

fn local_sessions_group_search_and_toggle_relay(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    named::<gtk::MenuButton>(&page.controls, "session-columns")[0].popup();
    let group: gtk::DropDown = named(&page.controls, "session-grouping").remove(0);
    group.set_selected(1);
    assert_eq!(page.row_keys().len(), 5);
    let shown = labels(&page.list);
    assert!(shown.contains(&"Claude".into()));
    assert!(shown.contains(&"Codex".into()));
    case.app.set_session_search("title: \"API work\"");
    case.settle();
    let filters: gtk::MenuButton =
        named(&case.app.shell().unwrap().header_search, "session-filters").remove(0);
    filters.popup();
    buttons(&filters.popover().unwrap(), "Active")[0].emit_clicked();
    case.settle();
    assert_eq!(page.row_keys(), ["codex:thread-1"]);
    assert_eq!(
        page.search.text().trim_end(),
        "title:\"API work\" is:active"
    );
    let filters: gtk::MenuButton =
        named(&case.app.shell().unwrap().header_search, "session-filters").remove(0);
    filters.popup();
    buttons(&filters.popover().unwrap(), "Uploaded")[0].emit_clicked();
    case.settle();
    assert!(page.row_keys().is_empty());
    assert_eq!(
        page.search.text().trim_end(),
        "title:\"API work\" is:active upload:uploaded"
    );
    named::<gtk::Button>(
        &case.app.shell().unwrap().header_search,
        "session-search-clear",
    )[0]
    .emit_clicked();
    case.settle();
    assert_eq!(page.row_keys().len(), 5);
    case.app
        .set_session_search("is:active harness:codex title: \"API work\"");
    case.settle();
    assert_eq!(page.row_keys(), ["codex:thread-1"]);
    case.app
        .set_session_search("is:inactive title: \"API work\"");
    case.settle();
    assert!(
        page.row_keys().is_empty(),
        "query={:?}, rows={:?}",
        case.app.with_state(|s| s.session_search.clone()),
        page.row_keys()
    );
    case.app.set_session_search("API work");
    case.settle();
    assert_eq!(page.row_keys(), ["codex:thread-1"]);
    assert!(named::<gtk::Switch>(&page.root, "upload-switch codex:thread-1").is_empty());
    let relay: gtk::Button = named(&page.root, "receive-messages codex:thread-1").remove(0);
    let mut registered = local();
    registered["sessions"][0]["registration"] = json!({"name": "api-work", "address": "api-work@desk", "added_by_session": false, "push": null});
    case.answer("sessions.list", registered);
    relay.emit_clicked();
    case.pump(|case| !case.called("agents.register").is_empty());
    assert_eq!(
        case.called("agents.register")[0]["target"],
        json!({"kind": "codex", "id": "thread-1"})
    );
    case.pump(|case| case.app.with_state(|state| state.busy_targets.is_empty()));
    let relay: gtk::Button = named(&page.root, "receive-messages codex:thread-1").remove(0);
    assert!(relay.has_css_class("connecting"));
}

fn transcript_sidebar_controls_use_the_selected_session(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.answer(
        "sessions.transcript",
        json!({"entries": [], "next_cursor": null}),
    );
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let open: gtk::Button = named(&page.list, "open-session claude:c-2").remove(0);
    open.emit_clicked();
    case.app.window().set_default_size(980, 650);
    case.app.show_window();
    case.settle();
    let rename_bounds = page
        .transcript
        .rename
        .compute_bounds(&page.transcript.root)
        .unwrap();
    let name_bounds = page
        .transcript
        .agent_name
        .compute_bounds(&page.transcript.root)
        .unwrap();
    assert!(rename_bounds.height() > 0.0);
    assert!(
        rename_bounds.y() + rename_bounds.height() < page.transcript.root.height() as f32,
        "Rename must be visible without scrolling at minimum height"
    );
    assert!(
        (rename_bounds.y() - name_bounds.y()).abs() < 4.0,
        "Name and Rename share one row"
    );
    assert!(!labels(&page.transcript.sidebar).contains(
        &"The name other agents see on Agent Relay. Your session title stays the same.".into()
    ));
    assert!(labels(&page.transcript.sidebar).contains(&"Messaging".into()));
    assert!(gtk::prelude::WidgetExt::is_visible(
        &page.transcript.agent_name
    ));
    let naming_section = page
        .transcript
        .agent_name
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    assert!(
        page.transcript.receive.is_ancestor(&naming_section),
        "Name and receive controls share Messaging"
    );
    assert_eq!(page.transcript.agent_name.text(), "web");
    page.transcript.agent_name.set_text("@Webby");
    // Background state rendering must not discard an in-progress edit.
    case.app.render_sessions();
    assert_eq!(page.transcript.agent_name.text(), "@Webby");
    let received_name = std::rc::Rc::new(std::cell::RefCell::new(None));
    page.transcript.copy_name.emit_clicked();
    let received = received_name.clone();
    page.transcript
        .copy_name
        .clipboard()
        .read_text_async(None::<&gtk::gio::Cancellable>, move |result| {
            *received.borrow_mut() = Some(result.unwrap().unwrap().to_string())
        });
    case.pump(|_| received_name.borrow().is_some());
    assert_eq!(received_name.borrow().as_deref(), Some("web"));
    let receive_bounds = page
        .transcript
        .receive
        .compute_bounds(&page.transcript.root)
        .unwrap();
    assert!(
        receive_bounds.y() < name_bounds.y(),
        "Receive messages precedes Agent name"
    );
    page.transcript.rename.emit_clicked();
    case.pump(|case| !case.called("agents.rename").is_empty());
    assert_eq!(
        case.called("agents.rename")[0],
        json!({"name":"web", "new_name":"webby"})
    );
    case.pump(|_| {
        labels(&page.transcript.root)
            .contains(&"Now @webby. Messages already sent to @web still arrive.".into())
    });
    assert!(
        labels(&shell.header_search).contains(&"Web".into()),
        "Renaming the agent preserves the session title"
    );
    assert!(case.called("uploader.sessions.include").is_empty());
    page.transcript.back.emit_clicked();
    let open: gtk::Button = named(&page.list, "open-session codex:thread-1").remove(0);
    open.emit_clicked();
    assert!(!page.transcript.receive.is_active());
    assert!(!gtk::prelude::WidgetExt::is_visible(
        &page.transcript.agent_name
    ));
    assert!(!page.transcript.copy_name.is_visible());
    page.transcript.receive.set_active(true);
    case.pump(|case| !case.called("agents.register").is_empty());
    assert_eq!(
        case.called("agents.register")[0]["target"],
        json!({"kind":"codex", "id":"thread-1"})
    );
    page.transcript.back.emit_clicked();
    let open: gtk::Button = named(&page.list, "open-session claude:two").remove(0);
    open.emit_clicked();
    assert!(!page.transcript.save.is_active());
    page.transcript.save.set_active(true);
    case.pump(|case| !case.called("uploader.sessions.include").is_empty());
    assert_eq!(
        case.called("uploader.sessions.include").last().unwrap()["session_keys"],
        json!(["claude:two"])
    );
}

fn groups_collapse_and_local_conversations_open(runtime: &tokio::runtime::Runtime) {
    use base64::Engine;
    let image = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(image.path(), base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap()).unwrap();
    let case = Case::new(runtime);
    let first_page = json!({"entries": [
        {"id": "a", "role": "user", "kind": "text", "text": "Read this locally", "timestamp_ms": 1, "truncated": false},
        {"id": "b", "role": "assistant", "kind": "text", "text": "## Answer\n**Ready**\n```rust\nlet x = 1;\n```", "timestamp_ms": 2, "truncated": false},
        {"id": "call", "role": "assistant", "kind": "tool_use", "text": "Run tests", "timestamp_ms": 3, "truncated": false},
        {"id": "c", "role": "tool_result", "kind": "tool_result", "text": "All tests passed", "timestamp_ms": 3, "truncated": false},
        {"id": "image", "role": "user", "kind": "text", "text": "", "image_path": image.path(), "timestamp_ms": 3, "truncated": false}
    ], "next_cursor": {"id": 3, "ts_ms": 3}});
    case.answer("sessions.transcript", Answer::with(move |params| {
        let page = if params["cursor"].is_object() {
            json!({"entries": [{"id":"d", "role":"assistant", "kind":"text", "text":"Last message", "timestamp_ms":4, "truncated":false}], "next_cursor":null})
        } else { first_page.clone() };
        async move { Ok(page) }
    }));
    case.sign_in();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    named::<gtk::MenuButton>(&page.controls, "session-columns")[0].popup();
    let group: gtk::DropDown = named(&page.controls, "session-grouping").remove(0);
    group.set_selected(1);
    let before = page.row_keys();
    let collapse: gtk::Button = named(&page.list, "session-group Codex").remove(0);
    collapse.emit_clicked();
    assert!(page.row_keys().iter().all(|key| !key.starts_with("codex:")));
    let collapsed = page.row_keys();
    assert_eq!(collapsed.len(), 2);
    case.app.set_session_search("API work");
    // Search commits before its debounced redraw. The count is updated after
    // rebuilding the filtered groups, even when a slow main-loop dispatch runs.
    case.pump(|_| page.count.text() == "1 session on this machine");
    assert!(page.row_keys().is_empty());
    assert!(!labels(&page.root).contains(&"Active agents".into()));
    case.app.set_session_search("");
    case.pump(|_| page.count.text() == "5 sessions on this machine");
    assert_eq!(
        page.row_keys(),
        collapsed,
        "Search preserves collapsed groups"
    );
    let expand: gtk::Button = named(&page.list, "session-group Codex").remove(0);
    expand.emit_clicked();
    assert_eq!(page.row_keys(), before);
    let open: gtk::Button = named(&page.list, "open-session codex:one").remove(0);
    open.emit_clicked();
    case.pump(|_| {
        labels(&page.transcript.messages).contains(&"Last message".into())
            || page.transcript.retry.get_visible()
    });
    assert!(!page.transcript.retry.get_visible());
    assert!(labels(&page.transcript.root).contains(&"Upload session".into()));
    assert!(labels(&page.transcript.root).contains(&"Agent name".into()));
    assert!(page.transcript.heading.is_ancestor(&shell.header_search));
    assert!(page.transcript.back.is_ancestor(&shell.header_search));
    assert!(!page.transcript.back.is_ancestor(&page.transcript.sidebar));
    assert!(page.transcript.heading.get_visible());
    assert!(!shell.header_search.first_child().unwrap().get_visible());
    assert!(!shell.header_grouping.get_visible());
    assert!(labels(&shell.header_search).contains(&"Fix login".into()));
    assert!(!labels(&page.transcript.root).contains(&"Fix login".into()));
    for action in [
        &page.transcript.open,
        &page.transcript.copy_name,
        &page.transcript.refresh,
    ] {
        assert!(action.is_ancestor(&page.transcript.sidebar));
    }
    assert!(!page.table.get_visible());
    assert!(page.transcript.root.get_visible());
    assert!(page.transcript.open.get_visible());
    case.app.window().set_default_size(980, 650);
    case.app.show_window();
    case.settle();
    assert!(page.transcript.open.width() > 0);
    let action_row = page.transcript.open.parent().unwrap();
    let open_bounds = page.transcript.open.compute_bounds(&action_row).unwrap();
    // Widget width excludes CSS padding and borders; bounds include the entire button.
    assert_eq!(
        open_bounds.width(),
        action_row.width() as f32,
        "Open action fills its row"
    );
    let refresh_bounds = page.transcript.refresh.compute_bounds(&action_row).unwrap();
    assert_eq!(
        refresh_bounds.width(),
        open_bounds.width(),
        "Refresh and Open fill the same width"
    );
    assert_eq!(
        refresh_bounds.height(),
        open_bounds.height(),
        "Action buttons have matching padding"
    );
    assert!(
        refresh_bounds.height() >= 38.0,
        "Give action buttons comfortable vertical padding"
    );
    assert_eq!(
        page.transcript.open.tooltip_text().as_deref(),
        Some("Open in Codex")
    );
    assert!(labels(&page.transcript.messages).contains(&"Read this locally".into()));
    assert!(labels(&page.transcript.messages).contains(&"Ready".into()));
    assert!(labels(&page.transcript.messages).contains(&"let x = 1;".into()));
    let mut image_loaded = false;
    walk(page.transcript.messages.upcast_ref(), &mut |widget| {
        if let Some(picture) = widget.downcast_ref::<gtk::Picture>() {
            image_loaded |= picture.paintable().is_some()
                && picture.alternative_text().as_deref() == Some("Attached image");
        }
    });
    assert!(
        image_loaded,
        "the copied image must render in the conversation"
    );
    let mut disclosures = Vec::new();
    walk(page.transcript.messages.upcast_ref(), &mut |widget| {
        if let Some(expander) = widget.downcast_ref::<gtk::Expander>() {
            disclosures.push(expander.clone());
        }
    });
    assert_eq!(disclosures.len(), 1);
    let group = disclosures[0].clone();
    assert_eq!(group.label().as_deref(), Some("1 tool call"));
    assert!(!group.is_expanded());
    group.set_expanded(true);
    disclosures.clear();
    walk(group.child().unwrap().upcast_ref(), &mut |widget| {
        if let Some(expander) = widget.downcast_ref::<gtk::Expander>() {
            disclosures.push(expander.clone());
        }
    });
    assert_eq!(disclosures.len(), 2);
    assert!(disclosures.iter().all(|item| !item.is_expanded()));
    for disclosure in disclosures {
        disclosure.set_expanded(true);
    }
    let mut avatars = 0;
    walk(page.transcript.messages.upcast_ref(), &mut |widget| {
        if widget.has_css_class("avatar-picture") {
            avatars += 1;
        }
    });
    assert_eq!(avatars, 2, "both user messages have an account avatar");
    assert!(labels(&page.transcript.messages).contains(&"All tests passed".into()));
    assert_eq!(case.called("sessions.transcript")[0]["session_id"], "one");
    assert!(case.called("uploader.sessions.include").is_empty());
    assert!(labels(&page.transcript.messages).contains(&"Last message".into()));
    assert_eq!(
        case.called("sessions.transcript")[1]["cursor"],
        json!({"id":3,"ts_ms":3})
    );
    page.transcript.back.emit_clicked();
    assert!(page.table.get_visible());
    assert!(!page.transcript.root.get_visible());
    assert!(!page.transcript.heading.get_visible());
    assert!(shell.header_search.first_child().unwrap().get_visible());
    assert!(shell.header_grouping.get_visible());
    assert_eq!(page.row_keys(), before);
    assert!(case.desktop.opened.borrow().is_empty());
    let active: gtk::Button = named(&page.list, "open-session codex:thread-1").remove(0);
    active.emit_clicked();
    case.pump(|case| case.called("sessions.transcript").len() >= 3);
    assert!(labels(&page.row("codex:thread-1").unwrap()).contains(&"Indexing".into()));
    assert!(labels(&page.transcript.root).contains(&"Indexing".into()));
    assert!(!labels(&page.transcript.root).contains(&"Upload unavailable".into()));
    assert!(
        !page.transcript.save.is_sensitive(),
        "Upload selection waits for the catalog"
    );
    assert!(!labels(&page.transcript.root).contains(&"No transcript".into()));
    assert_eq!(
        case.called("sessions.transcript")[2]["session_id"],
        "thread-1"
    );
    assert!(!shell.topbar.get_visible());
    shell.sessions_button.emit_clicked();
    assert!(page.table.get_visible());
    assert!(!page.transcript.root.get_visible());
    assert!(!shell.topbar.get_visible());
    assert_eq!(page.row_keys(), before);
    let claude = serde_json::from_value(upload_row(
        "claude",
        "two",
        "Docs",
        "/w/web",
        false,
        "not_shared",
    ))
    .unwrap();
    case.app
        .open_local_session(agent_relay_probe::linux_app::models::LocalSessionRow {
            upload: Some(claude),
            relay: None,
        });
    assert_eq!(
        page.transcript.open.label().as_deref(),
        Some("Open in Terminal")
    );
    assert!(!page.transcript.copy_name.get_visible());
    page.transcript.open.emit_clicked();
    assert_eq!(
        *case.desktop.opened.borrow(),
        vec!["cd -- '/w/web' && claude --resume 'two'"]
    );
    assert!(case.called("uploader.sessions.include").is_empty());
    assert!(case.called("agents.register").is_empty());
}

fn a_right_click_outside_the_selection_acts_on_that_row(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Sessions);
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    page.list.select_row(page.row("codex:one").as_ref());
    // The search hides the selected row; it stays selected.
    case.app.set_session_search("Docs");
    case.settle();
    case.settle();
    assert_eq!(page.row_keys(), ["claude:two"]);
    let items = case
        .app
        .session_menu_items(&page.row("claude:two").unwrap());
    let shown: Vec<&str> = items.iter().map(|(label, _)| label.as_str()).collect();
    assert_eq!(shown, ["Hide session", "Upload session"]);
    assert_eq!(
        case.app
            .with_state(|state| state.session_selection.iter().cloned().collect::<Vec<_>>()),
        ["codex:one"]
    );
}

fn an_uploaded_session_opens_in_cloud(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let session = case.app.with_state(|state| state.sessions[0].clone());
    case.app.open_cloud(&session);
    assert_eq!(
        *case.desktop.opened.borrow(),
        ["https://agentrelay.com/cloud/dashboard/sessions/one"]
    );
}

fn a_full_journal_is_compacted_from_its_stage(runtime: &tokio::runtime::Runtime) {
    let mut full = uploader();
    full["journal_full"] = json!(true);
    let case = Case::with(runtime, |core| {
        core.answer("uploader.status", check::<method::UploaderStatus>(full));
    });
    case.sign_in();
    case.app.go(Page::Sessions);
    case.app.go(Page::Settings(Pane::Sharing));
    let progress = case.app.shell().unwrap().settings.column.clone();
    walk(progress.upcast_ref(), &mut |widget| {
        if let Some(details) = widget.downcast_ref::<gtk::Expander>() {
            details.set_expanded(true);
        }
    });
    assert!(!buttons(&progress, "Compact now").is_empty());
    buttons(&progress, "Compact now")[0].emit_clicked();
    case.pump(|case| !case.called("uploader.compact").is_empty());
}

fn stopped_uploads_are_retried_from_their_stage(runtime: &tokio::runtime::Runtime) {
    let mut stopped = uploader();
    stopped["stage"] = json!("needs_attention");
    stopped["stage_message"] = json!("An upload could not be prepared safely.");
    stopped["delivery"]["stopped"] = json!(true);
    stopped["delivery"]["failure_code"] = json!("invalid_payload");
    let case = Case::with(runtime, |core| {
        core.answer("uploader.status", check::<method::UploaderStatus>(stopped));
    });
    case.sign_in();
    case.app.go(Page::Sessions);
    case.app.go(Page::Settings(Pane::Sharing));
    let progress = case.app.shell().unwrap().settings.column.clone();
    walk(progress.upcast_ref(), &mut |widget| {
        if let Some(details) = widget.downcast_ref::<gtk::Expander>() {
            details.set_expanded(true);
        }
    });
    assert!(!buttons(&progress, "Retry uploads").is_empty());
    buttons(&progress, "Retry uploads")[0].emit_clicked();
    case.pump(|case| !case.called("uploader.retry").is_empty());
}

// Messages.

fn messages_read_and_send_through_the_core(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.show_message_composer("web@desk");
    assert_eq!(case.app.page(), Page::Messages);
    let chat = case.app.chat("web@desk").unwrap();
    case.pump(|_| chat.state.borrow().shown == ["m1"]);
    assert_eq!(
        case.called("messages.history")[0]["endpoint"],
        json!("web@desk")
    );
    assert!(chat.status.text().contains("@ada"));
    assert!(labels(&chat.messages).contains(&"hello".to_string()));
    chat.text.buffer().set_text("hi back");
    case.app.send_chat("web@desk");
    case.pump(|case| !case.called("messages.send").is_empty());
    // An exact address reaches only that agent on that machine.
    let send = &case.called("messages.send")[0];
    assert_eq!(
        (&send["address"], &send["to"], &send["text"]),
        (&json!("web@desk"), &Value::Null, &json!("hi back"))
    );
    let before = case.called("messages.history").len();
    case.emit("invalidated", json!({"what": "messages"}));
    case.pump(|case| case.called("messages.history").len() > before);
}

fn a_conversation_warns_before_queueing_for_an_agent_not_running(
    runtime: &tokio::runtime::Runtime,
) {
    let case = Case::with(runtime, |core| {
        core.answer("roster.get", recipient(Some("offline"), None, true));
    });
    case.sign_in();
    let chat = case.open_conversation("web@desk");
    assert_eq!(case.called("roster.get")[0]["address"], json!("web@desk"));
    assert_eq!(
        delivery(&chat),
        "@web is not running right now. Queue anyway?"
    );
    assert_eq!(chat.send.label().unwrap(), "Queue Anyway");
    assert_eq!(
        chat.reply.text(),
        "Not running — no reply until it runs again."
    );
    // Another workspace's roster says nothing.
    case.answer("roster.get", recipient(None, None, false));
    case.emit("invalidated", json!({"what": "roster"}));
    case.pump(|_| {
        chat.state
            .borrow()
            .recipient
            .as_ref()
            .is_some_and(|recipient| !recipient.known)
    });
    assert_eq!(
        delivery(&chat),
        "An exact address reaches only that agent on that machine."
    );
    assert_eq!(chat.send.label().unwrap(), "Send");
    assert!(!chat.reply.is_visible());
}

fn a_name_and_its_at_name_are_one_conversation(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.app.open_chat(" nobody ");
    case.app.open_chat("@nobody");
    assert_eq!(case.app.open_chats(), ["@nobody"]);
    assert_eq!(case.app.shown_chat().as_deref(), Some("@nobody"));
}

fn a_name_no_agent_has_is_said_before_and_after_a_send(runtime: &tokio::runtime::Runtime) {
    let case = Case::with(runtime, |core| {
        core.answer("roster.get", recipient(None, None, true));
        core.answer(
            "messages.send",
            fail(ErrorKind::NotFound, "No agent named nobody."),
        );
    });
    case.sign_in();
    let chat = case.open_conversation("@nobody");
    assert_eq!(case.called("roster.get")[0]["to"], json!("nobody"));
    assert_eq!(delivery(&chat), "No agent has this name or address.");
    chat.text.buffer().set_text("hello?");
    case.app.send_chat("@nobody");
    case.pump(|_| chat.state.borrow().error.is_some());
    assert_eq!(delivery(&chat), "No such agent");
}

fn a_send_shows_what_relaycast_holds_and_follows_it(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let chat = case.open_conversation("web@desk");
    chat.text.buffer().set_text("ship it");
    case.app.send_chat("web@desk");
    case.pump(|_| chat.state.borrow().last_send.is_some());
    assert_eq!(delivery(&chat), "Queued — not yet handed to the agent");
    // Read again two seconds after the send, with the message's id.
    case.answer(
        "roster.get",
        recipient(Some("live"), Some("delivered"), true),
    );
    case.pump(|_| delivery(&chat) == "Delivered");
    let last = case.called("roster.get").last().cloned().unwrap();
    assert_eq!(
        (&last["address"], &last["message_id"]),
        (&json!("web@desk"), &json!("m2"))
    );
    // A read that cannot tell keeps the last reported state.
    case.answer("roster.get", recipient(Some("live"), None, true));
    let reads = case.called("roster.get").len();
    case.emit("invalidated", json!({"what": "fleet"}));
    case.pump(|case| case.called("roster.get").len() > reads);
    case.settle();
    assert_eq!(delivery(&chat), "Delivered");
    case.answer(
        "roster.get",
        recipient(Some("live"), Some("picked_up"), true),
    );
    case.emit("invalidated", json!({"what": "sessions"}));
    case.pump(|_| delivery(&chat) == "Picked up by the agent");
    // Writing the next message drops the note.
    chat.text.buffer().set_text("n");
    assert_eq!(
        delivery(&chat),
        "An exact address reaches only that agent on that machine."
    );
    // Closed, the conversation is no longer followed.
    case.app.close_chat("web@desk");
    let reads = case.called("roster.get").len();
    case.emit("invalidated", json!({"what": "roster"}));
    case.settle();
    assert_eq!(case.called("roster.get").len(), reads);
    assert!(case.app.open_chats().is_empty());
}

fn only_the_shown_conversation_and_unsettled_sends_are_followed(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let chat = case.open_conversation("web@desk");
    chat.text.buffer().set_text("ship it");
    case.app.send_chat("web@desk");
    case.pump(|_| chat.state.borrow().last_send.is_some());
    case.answer(
        "roster.get",
        recipient(Some("live"), Some("picked_up"), true),
    );
    case.pump(|_| delivery(&chat) == "Picked up by the agent");
    // A third conversation is shown; the first's send is settled and the
    // second has none.
    case.open_conversation("@quiet");
    case.open_conversation("bos@cloud");
    let before: Vec<usize> = ["web@desk", "@quiet", "bos@cloud"]
        .iter()
        .map(|endpoint| case.lookups(endpoint))
        .collect();
    for what in ["sessions", "fleet", "messages"] {
        case.emit("invalidated", json!({"what": what}));
    }
    case.pump(|case| case.lookups("bos@cloud") > before[2]);
    case.settle();
    assert_eq!(case.lookups("web@desk"), before[0]);
    assert_eq!(case.lookups("@quiet"), before[1]);
    // One read runs at a time: three invalidations mid-read make one more
    // read, not three.
    assert!(case.lookups("bos@cloud") - before[2] <= 2);
    // Shown again, a conversation is read again.
    case.app.select_chat("@quiet");
    case.pump(|case| case.lookups("@quiet") > before[1]);
}

fn a_refresh_without_an_invalidation_reads_no_recipient(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.open_conversation("web@desk");
    case.settle();
    let (lookups, rosters) = (
        case.called("roster.get").len(),
        case.called("roster.list").len(),
    );
    // Refresh (Ctrl+R) and the 30 s roster read re-fetch the lists only;
    // recipients follow the core's invalidations, as on the Mac.
    case.app.refresh_page();
    case.app.refresh_people();
    case.pump(|case| case.called("roster.list").len() > rosters);
    case.settle();
    assert_eq!(case.called("roster.get").len(), lookups);
}

fn a_lookup_asked_for_mid_read_reads_once_more(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.open_conversation("web@desk");
    case.settle();
    let (held, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    case.answer(
        "roster.get",
        held_answer(
            held.clone(),
            release.clone(),
            recipient(Some("idle"), None, true),
        ),
    );
    let before = case.called("roster.get").len();
    case.app.look_up_recipient("web@desk");
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), held.notified())
            .await
            .unwrap()
    });
    for _ in 0..4 {
        case.app.look_up_recipient("web@desk");
    }
    case.settle();
    assert_eq!(case.called("roster.get").len(), before + 1);
    case.answer("roster.get", recipient(Some("idle"), None, true));
    release.notify_one();
    case.pump(|case| case.called("roster.get").len() == before + 2);
    case.settle();
    assert_eq!(case.called("roster.get").len(), before + 2);
}

fn a_closed_conversation_starts_no_lookup_again(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let chat = case.open_conversation("web@desk");
    case.open_conversation("@other");
    case.app.select_chat("web@desk");
    chat.text.buffer().set_text("ship it");
    case.app.send_chat("web@desk");
    case.pump(|_| chat.state.borrow().last_send.is_some());
    // A held read with another asked for behind it, and the send's 2 s
    // follow-up still scheduled.
    let (held, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    case.answer(
        "roster.get",
        held_answer(
            held.clone(),
            release.clone(),
            recipient(Some("live"), Some("delivered"), true),
        ),
    );
    case.app.look_up_recipient("web@desk");
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), held.notified())
            .await
            .unwrap()
    });
    case.app.look_up_recipient("web@desk");
    case.app.close_chat("web@desk");
    case.answer(
        "roster.get",
        recipient(Some("live"), Some("delivered"), true),
    );
    let reads = case.lookups("web@desk");
    release.notify_one();
    case.wait(3);
    case.emit("invalidated", json!({"what": "sessions"}));
    case.settle();
    assert_eq!(case.lookups("web@desk"), reads);
}

fn a_queued_message_to_a_stopped_agent_says_so(runtime: &tokio::runtime::Runtime) {
    let case = Case::with(runtime, |core| {
        core.answer("roster.get", recipient(Some("offline"), None, true));
        core.answer(
            "messages.send",
            sent(recipient(Some("offline"), Some("queued"), true), "m3"),
        );
    });
    case.sign_in();
    let chat = case.open_conversation("web@desk");
    chat.text.buffer().set_text("when you're back");
    case.app.send_chat("web@desk");
    case.pump(|_| chat.state.borrow().last_send.is_some());
    assert_eq!(delivery(&chat), "Queued — agent not running");
    assert_eq!(chat.send.label().unwrap(), "Queue Anyway");
    assert_eq!(
        chat.state.borrow().last_send.as_ref().unwrap().state,
        Some(MessageState::Queued)
    );
}

// Leaving the account.

fn a_pending_overview_stops_polling_when_its_account_leaves(runtime: &tokio::runtime::Runtime) {
    let case = Case::with(runtime, |core| {
        core.answer(
            "sessions.overview.get",
            overview_with(json!([{"status": "queued"}])),
        );
    });
    case.sign_in();
    case.app.load_overview("s-1");
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .overviews
                .get("s-1")
                .is_some_and(|overview| overview.status == OverviewStatus::Queued)
        })
    });
    case.app.confirm_logout();
    case.set_state(fake_core::snapshot(json!({})));
    case.pump(|case| case.app.view() == Some(View::SignIn));
    let reads = case.called("sessions.overview.get").len();
    case.wait(6);
    assert_eq!(case.called("sessions.overview.get").len(), reads);
    assert!(case
        .app
        .with_state(|state| !state.overviews.contains_key("s-1")));
}

fn a_mutation_answered_on_the_disconnect_screen_is_dropped(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let (held, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    case.answer(
        "agents.register",
        held_answer(
            held.clone(),
            release.clone(),
            json!({"name": "api-work", "address": "api-work@desk", "already_registered": false}),
        ),
    );
    let api = case.app.with_state(|state| state.local_sessions[0].clone());
    case.app.toggle_relay(&api, true);
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(10), held.notified())
            .await
            .unwrap()
    });
    case.app.confirm_logout();
    case.pump(|case| case.app.with_state(|state| state.sign_out_answered));
    assert_eq!(case.app.view(), Some(View::SigningOut));
    let lists = case.called("sessions.list").len();
    release.notify_one();
    case.settle();
    case.settle();
    // Answered while the disconnect screen shows: nothing redraws or reads.
    assert_eq!(case.called("sessions.list").len(), lists);
    assert_eq!(case.app.view(), Some(View::SigningOut));
}

fn session_columns_customize_and_restore(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::{
        SessionColumn, SessionColumnLayout, SESSION_COLUMNS_KEY,
    };
    let case = Case::new(runtime);
    case.sign_in();
    case.app.show_window();
    case.settle();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let menu: gtk::MenuButton = named(&page.controls, "session-columns").remove(0);
    assert!(
        labels(&menu.child().unwrap()).is_empty(),
        "Table display uses an icon-only trigger"
    );
    assert_eq!(menu.tooltip_text().as_deref(), Some("Table display"));
    menu.popup();
    let popover = menu.popover().unwrap();
    assert!(!labels(&popover).contains(&"Table display".into()));
    let grouping = named::<gtk::DropDown>(&popover, "session-grouping").remove(0);
    case.settle();
    assert!(
        grouping.allocated_width() >= 330,
        "Grouping fills the panel width"
    );
    assert!(grouping.activate());
    case.settle();
    let dropdown_menu = descendants(grouping.upcast_ref())
        .into_iter()
        .find_map(|widget| widget.downcast::<gtk::Popover>().ok())
        .unwrap();
    assert!(dropdown_menu.is_visible());
    assert!(
        !dropdown_menu.has_arrow(),
        "Native dropdown has no nested popover arrow"
    );
    assert!(dropdown_menu.allocated_width() >= grouping.allocated_width());
    dropdown_menu.popdown();
    grouping.set_selected(1);
    assert!(labels(&grouping).contains(&"Harness".into()));
    assert!(labels(&page.list).contains(&"Codex".into()));
    grouping.set_selected(0);
    assert!(labels(&grouping).contains(&"None".into()));
    named::<gtk::CheckButton>(&popover, "show-column project")[0].set_active(false);
    assert!(!case
        .app
        .session_columns()
        .visible()
        .contains(&SessionColumn::Project));
    assert!(named::<gtk::Widget>(&page.list, "session-cell project codex:one").is_empty());
    case.settle();
    let target = named::<gtk::Box>(&popover, "column-setting session").remove(0);
    assert_eq!(
        target.allocated_height(),
        40,
        "Column rows including borders have a consistent height"
    );
    let controllers = target.observe_controllers();
    let drop = (0..controllers.n_items())
        .find_map(|i| {
            controllers
                .item(i)
                .and_then(|item| item.downcast::<gtk::DropTarget>().ok())
        })
        .unwrap();
    drop.emit_by_name::<gtk::gdk::DragAction>("motion", &[&0.0f64, &0.0f64]);
    assert!(target.has_css_class("column-drop-before"));
    drop.emit_by_name::<gtk::gdk::DragAction>("motion", &[&0.0f64, &100.0f64]);
    assert!(target.has_css_class("column-drop-after"));
    assert!(!target.has_css_class("column-drop-before"));
    drop.emit_by_name::<()>("leave", &[]);
    assert!(!target.has_css_class("column-drop-after"));
    assert!(drop.emit_by_name::<bool>(
        "drop",
        &[
            &glib::BoxedValue("session-column:updated".to_value()),
            &0.0f64,
            &0.0f64
        ]
    ));
    assert!(!target.has_css_class("column-drop-before"));
    assert!(!target.has_css_class("column-drop-after"));
    // Lower-half drops insert after the target, not at its old index.
    assert!(drop.emit_by_name::<bool>(
        "drop",
        &[
            &glib::BoxedValue("session-column:updated".to_value()),
            &0.0f64,
            &100.0f64,
        ]
    ));
    assert_eq!(
        &case.app.session_columns().order[..2],
        &[SessionColumn::Session, SessionColumn::Updated]
    );
    assert!(drop.emit_by_name::<bool>(
        "drop",
        &[
            &glib::BoxedValue("session-column:updated".to_value()),
            &0.0f64,
            &0.0f64,
        ]
    ));
    named::<gtk::Button>(&popover, "move-column-down updated")[0].emit_clicked();
    named::<gtk::Button>(&popover, "move-column-up updated")[0].emit_clicked();
    let expected = vec![
        SessionColumn::Updated,
        SessionColumn::Session,
        SessionColumn::Status,
        SessionColumn::Relay,
        SessionColumn::Upload,
    ];
    assert_eq!(case.app.session_columns().visible(), expected);
    let row = page.row("codex:one").unwrap();
    let content = row.child().unwrap();
    let cells: Vec<String> =
        std::iter::successors(content.first_child(), |child| child.next_sibling())
            .map(|child| child.widget_name().to_string())
            .filter(|name| name.starts_with("session-cell ") || name.starts_with("open-session "))
            .collect();
    assert_eq!(cells[0], "session-cell updated codex:one");
    assert_eq!(cells[1], "open-session codex:one");
    assert!(!named::<gtk::Button>(&page.table, "sort-session-Project")[0].is_visible());
    let reloaded = Preferences::load(case.app.prefs().path().to_owned());
    assert_eq!(
        SessionColumnLayout::from_value(reloaded.get(SESSION_COLUMNS_KEY)).visible(),
        expected
    );
    named::<gtk::CheckButton>(&popover, "show-column session")[0].set_active(false);
    let row = page.row("codex:one").unwrap();
    let open = named::<gtk::Button>(&row, "session-cell updated codex:one").remove(0);
    // A visible metadata cell still opens the conversation with Session hidden.
    case.answer(
        "sessions.transcript",
        json!({"entries": [], "next_cursor": null}),
    );
    open.emit_clicked();
    case.pump(|case| !case.called("sessions.transcript").is_empty());
    case.app.window().set_default_size(1600, 900);
    named::<gtk::Button>(&popover, "reset-session-columns")[0].emit_clicked();
    assert_eq!(
        case.app.window().default_width(),
        agent_relay_probe::linux_app::models::DEFAULT_WINDOW_WIDTH
    );
    assert_eq!(
        case.app.window().default_height(),
        agent_relay_probe::linux_app::models::DEFAULT_WINDOW_HEIGHT
    );
    assert_eq!(case.app.session_columns(), SessionColumnLayout::default());
    assert!(named::<gtk::Switch>(&page.list, "upload-switch codex:one").is_empty());
    assert!(case.called("uploader.sessions.include").is_empty());
    assert!(case.called("uploader.sessions.delete").is_empty());
}

fn session_row_surface_opens_and_checkbox_lane_selects(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::SessionColumn;
    for hide_title in [false, true] {
        let case = Case::new(runtime);
        case.answer(
            "sessions.transcript",
            json!({"entries": [], "next_cursor": null}),
        );
        case.sign_in();
        case.app.show_window();
        if hide_title {
            let mut layout = case.app.session_columns();
            layout.set_visible(SessionColumn::Session, false);
            case.app.set_session_columns(layout);
        }
        case.settle();
        let shell = case.app.shell().unwrap();
        let page = &shell.pages.sessions;
        let row = page.row("codex:one").unwrap();
        let check = named::<gtk::CheckButton>(&row, "select-session codex:one").remove(0);
        let controllers = row.observe_controllers();
        let click = (0..controllers.n_items())
            .filter_map(|i| controllers.item(i))
            .filter_map(|item| item.downcast::<gtk::GestureClick>().ok())
            .find(|click| click.name().as_deref() == Some("session-row-open"))
            .unwrap();
        let y = f64::from(row.height()) / 2.0;
        let press = |x: f64| {
            click.emit_by_name::<()>("pressed", &[&1i32, &x, &y]);
            click.emit_by_name::<()>("released", &[&1i32, &x, &y]);
        };
        press(2.0); // Padding beside the checkbox selects, never opens.
        assert!(check.is_active());
        assert!(case.called("sessions.transcript").is_empty());
        assert_eq!(page.list.selected_rows().len(), 1);
        check.set_active(false); // The native checkbox retains its own behavior.
        assert_eq!(page.list.selected_rows().len(), 0);
        let control = named::<gtk::Button>(&row, "receive-messages codex:one").remove(0);
        let bounds = control.compute_bounds(&row).unwrap();
        press(f64::from(bounds.x() + bounds.width() / 2.0));
        assert!(
            case.called("sessions.transcript").is_empty(),
            "Even disabled controls are excluded from the open target"
        );
        let bounds = check.compute_bounds(&row).unwrap();
        let gap = f64::from(bounds.x() + bounds.width()) + 12.0;
        // A canceled press (e.g. scrolling) must not open a transcript.
        click.emit_by_name::<()>("pressed", &[&1i32, &gap, &y]);
        click.emit_by_name::<()>("stopped", &[]);
        click.emit_by_name::<()>("released", &[&1i32, &gap, &y]);
        assert!(case.called("sessions.transcript").is_empty());
        press(gap); // The rest of the gap opens, even with the title column hidden.
        case.pump(|case| !case.called("sessions.transcript").is_empty());
        assert!(case
            .app
            .with_state(|state| state.session_selection.is_empty()));
    }
}

fn pi_setup_error_is_visible_in_relay_settings_and_clears_after_recovery(
    runtime: &tokio::runtime::Runtime,
) {
    let case = Case::new(runtime);
    case.sign_in();
    let mut snapshot = workspace_snapshot();
    let error = "Pi extension could not be installed: a different extension uses agent-relay.js.";
    snapshot["agents"]["integration_error"] = json!(error);
    case.set_state(snapshot);
    case.pump(|case| {
        case.app
            .with_state(|s| s.relay_problem().as_deref() == Some(error))
    });
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| case.settings_labels().contains(&error.to_owned()));
    case.set_state(workspace_snapshot());
    case.pump(|case| !case.settings_labels().contains(&error.to_owned()));
}

pub const TESTS: &[(&str, Test)] = &[
    (
        "claude_delivery_refusal_survives_a_failed_reconciliation_read",
        claude_delivery_refusal_survives_a_failed_reconciliation_read,
    ),
    (
        "claude_delivery_refusal_survives_reconciliation_until_explicit_refresh",
        claude_delivery_refusal_survives_reconciliation_until_explicit_refresh,
    ),
    (
        "a_settings_switch_holds_its_position_until_the_core_refuses",
        a_settings_switch_holds_its_position_until_the_core_refuses,
    ),
    (
        "the_sharing_policy_asked_for_is_selected_at_once",
        the_sharing_policy_asked_for_is_selected_at_once,
    ),
    (
        "sessions_title_edits_use_saved_brief_and_rollback",
        sessions_title_edits_use_saved_brief_and_rollback,
    ),
    (
        "sessions_title_unsupported_never_writes",
        sessions_title_unsupported_never_writes,
    ),
    (
        "sessions_title_reconnect_retires_pending_work",
        sessions_title_reconnect_retires_pending_work,
    ),
    (
        "sessions_title_transcript_reopens_with_current_native_title",
        sessions_title_transcript_reopens_with_current_native_title,
    ),
    (
        "sessions_title_blur_debounce_and_noop",
        sessions_title_blur_debounce_and_noop,
    ),
    (
        "pi_setup_error_is_visible_in_relay_settings_and_clears_after_recovery",
        pi_setup_error_is_visible_in_relay_settings_and_clears_after_recovery,
    ),
    (
        "capy_binding_error_is_visible_and_retryable",
        capy_binding_error_is_visible_and_retryable,
    ),
    (
        "capy_thread_spawn_is_persisted_and_follows_binding",
        capy_thread_spawn_is_persisted_and_follows_binding,
    ),
    (
        "saved_views_save_restore_and_delete",
        saved_views_save_restore_and_delete,
    ),
    (
        "saved_views_default_on_first_open",
        saved_views_default_on_first_open,
    ),
    (
        "confirmed_cloud_delete_still_runs_after_hide_excludes_upload",
        confirmed_cloud_delete_still_runs_after_hide_excludes_upload,
    ),
    (
        "hiding_waits_for_explicit_registration_and_then_stops_messages",
        hiding_waits_for_explicit_registration_and_then_stops_messages,
    ),
    (
        "hiding_survives_failed_list_after_explicit_registration",
        hiding_survives_failed_list_after_explicit_registration,
    ),
    (
        "session_row_surface_opens_and_checkbox_lane_selects",
        session_row_surface_opens_and_checkbox_lane_selects,
    ),
    (
        "session_columns_customize_and_restore",
        session_columns_customize_and_restore,
    ),
    (
        "session_columns_resize_from_header_only",
        session_columns_resize_from_header_only,
    ),
    (
        "session_title_fills_available_width",
        session_title_fills_available_width,
    ),
    (
        "hidden_sessions_stop_sharing_and_can_be_shown_without_reenabling",
        hidden_sessions_stop_sharing_and_can_be_shown_without_reenabling,
    ),
    (
        "hidden_session_failure_returns_row_with_error",
        hidden_session_failure_returns_row_with_error,
    ),
    (
        "sessions_message_orb_tracks_confirmed_availability",
        sessions_message_orb_tracks_confirmed_availability,
    ),
    (
        "sessions_upload_requests_are_independent_and_latest_click_wins",
        sessions_upload_requests_are_independent_and_latest_click_wins,
    ),
    (
        "sessions_failed_upload_rolls_back_only_its_row",
        sessions_failed_upload_rolls_back_only_its_row,
    ),
    (
        "sessions_reenable_after_uncertain_delete_reaches_core",
        sessions_reenable_after_uncertain_delete_reaches_core,
    ),
    (
        "sessions_upload_icon_animates_only_while_uploading",
        sessions_upload_icon_animates_only_while_uploading,
    ),
    (
        "sessions_action_cursors_follow_sensitivity",
        sessions_action_cursors_follow_sensitivity,
    ),
    (
        "sessions_header_hover_previews_next_sort",
        sessions_header_hover_previews_next_sort,
    ),
    (
        "sessions_sort_by_headers_and_preserve_order_on_refresh",
        sessions_sort_by_headers_and_preserve_order_on_refresh,
    ),
    (
        "sessions_cloud_delete_requires_confirmation",
        sessions_cloud_delete_requires_confirmation,
    ),
    (
        "sessions_show_harness_model_and_reasoning",
        sessions_show_harness_model_and_reasoning,
    ),
    (
        "sessions_paginate_on_scroll_without_controls",
        sessions_paginate_on_scroll_without_controls,
    ),
    (
        "search_animation_closes_and_reopens_without_stale_dismissal",
        search_animation_closes_and_reopens_without_stale_dismissal,
    ),
    (
        "session_filter_popover_matches_macos_interactions",
        session_filter_popover_matches_macos_interactions,
    ),
    (
        "diagnostics_copy_details_keeps_feedback_across_redraw",
        diagnostics_copy_details_keeps_feedback_across_redraw,
    ),
    (
        "my_agents_lists_sessions_and_switches_them_on_the_relay",
        my_agents_lists_sessions_and_switches_them_on_the_relay,
    ),
    (
        "capy_setup_card_copies_the_prompt_and_hides_for_good",
        capy_setup_card_copies_the_prompt_and_hides_for_good,
    ),
    (
        "devin_setup_card_turns_the_hooks_on_or_hides_for_good",
        devin_setup_card_turns_the_hooks_on_or_hides_for_good,
    ),
    (
        "agent_details_and_tools_call_the_core",
        agent_details_and_tools_call_the_core,
    ),
    (
        "an_agent_runs_one_tool_call_at_a_time_and_rereads_after_it",
        an_agent_runs_one_tool_call_at_a_time_and_rereads_after_it,
    ),
    (
        "another_machines_agents_are_its_on_the_relay_list",
        another_machines_agents_are_its_on_the_relay_list,
    ),
    (
        "an_untitled_session_matches_its_shown_title",
        an_untitled_session_matches_its_shown_title,
    ),
    (
        "a_machine_filter_ends_with_its_machine",
        a_machine_filter_ends_with_its_machine,
    ),
    (
        "fleet_release_is_generation_checked",
        fleet_release_is_generation_checked,
    ),
    (
        "a_worker_without_an_id_is_released_under_its_row_key",
        a_worker_without_an_id_is_released_under_its_row_key,
    ),
    (
        "a_refresh_asked_for_mid_read_reads_again",
        a_refresh_asked_for_mid_read_reads_again,
    ),
    (
        "recent_messages_show_deliveries",
        recent_messages_show_deliveries,
    ),
    (
        "team_shows_a_card_per_teammate",
        team_shows_a_card_per_teammate,
    ),
    (
        "transcript_sidebar_controls_use_the_selected_session",
        transcript_sidebar_controls_use_the_selected_session,
    ),
    (
        "groups_collapse_and_local_conversations_open",
        groups_collapse_and_local_conversations_open,
    ),
    (
        "group_checkboxes_select_only_their_group",
        group_checkboxes_select_only_their_group,
    ),
    (
        "bulk_messaging_mixed_selection_turns_all_on_then_off",
        bulk_messaging_mixed_selection_turns_all_on_then_off,
    ),
    (
        "local_sessions_group_search_and_toggle_relay",
        local_sessions_group_search_and_toggle_relay,
    ),
    (
        "sessions_show_uploads_and_mutate_through_the_core",
        sessions_show_uploads_and_mutate_through_the_core,
    ),
    (
        "a_right_click_outside_the_selection_acts_on_that_row",
        a_right_click_outside_the_selection_acts_on_that_row,
    ),
    (
        "an_uploaded_session_opens_in_cloud",
        an_uploaded_session_opens_in_cloud,
    ),
    (
        "a_full_journal_is_compacted_from_its_stage",
        a_full_journal_is_compacted_from_its_stage,
    ),
    (
        "stopped_uploads_are_retried_from_their_stage",
        stopped_uploads_are_retried_from_their_stage,
    ),
    (
        "messages_read_and_send_through_the_core",
        messages_read_and_send_through_the_core,
    ),
    (
        "a_conversation_warns_before_queueing_for_an_agent_not_running",
        a_conversation_warns_before_queueing_for_an_agent_not_running,
    ),
    (
        "a_name_and_its_at_name_are_one_conversation",
        a_name_and_its_at_name_are_one_conversation,
    ),
    (
        "a_name_no_agent_has_is_said_before_and_after_a_send",
        a_name_no_agent_has_is_said_before_and_after_a_send,
    ),
    (
        "a_send_shows_what_relaycast_holds_and_follows_it",
        a_send_shows_what_relaycast_holds_and_follows_it,
    ),
    (
        "only_the_shown_conversation_and_unsettled_sends_are_followed",
        only_the_shown_conversation_and_unsettled_sends_are_followed,
    ),
    (
        "a_refresh_without_an_invalidation_reads_no_recipient",
        a_refresh_without_an_invalidation_reads_no_recipient,
    ),
    (
        "a_lookup_asked_for_mid_read_reads_once_more",
        a_lookup_asked_for_mid_read_reads_once_more,
    ),
    (
        "a_closed_conversation_starts_no_lookup_again",
        a_closed_conversation_starts_no_lookup_again,
    ),
    (
        "a_queued_message_to_a_stopped_agent_says_so",
        a_queued_message_to_a_stopped_agent_says_so,
    ),
    (
        "a_pending_overview_stops_polling_when_its_account_leaves",
        a_pending_overview_stops_polling_when_its_account_leaves,
    ),
    (
        "a_mutation_answered_on_the_disconnect_screen_is_dropped",
        a_mutation_answered_on_the_disconnect_screen_is_dropped,
    ),
];

/// `widget` and everything under it, depth first.
fn descendants(widget: &gtk::Widget) -> Vec<gtk::Widget> {
    let mut found = vec![widget.clone()];
    let mut child = widget.first_child();
    while let Some(current) = child {
        found.extend(descendants(&current));
        child = current.next_sibling();
    }
    found
}

fn session_columns_resize_from_header_only(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::{
        SessionColumn, SessionColumnLayout, SESSION_COLUMNS_KEY,
    };
    let case = Case::new(runtime);
    case.sign_in();
    let mut layout = case.app.session_columns();
    for column in [
        SessionColumn::Harness,
        SessionColumn::Model,
        SessionColumn::Reasoning,
    ] {
        layout.set_visible(column, true);
    }
    case.app.set_session_columns(layout);
    case.app.show_window();
    case.settle();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let header = named::<gtk::Overlay>(&page.table, "session-header project")[0].clone();
    let handle = named::<gtk::Box>(&page.table, "resize-column project")[0].clone();
    assert!(named::<gtk::Box>(&page.list, "resize-column project").is_empty());
    assert_eq!(
        handle.cursor().unwrap().name().as_deref(),
        Some("col-resize")
    );
    let reference_bounds = handle.compute_bounds(&page.table).unwrap();
    for column in case.app.session_columns().visible() {
        let divider = &named::<gtk::Box>(&page.table, &format!("resize-column {}", column.id()))[0];
        let bounds = divider.compute_bounds(&page.table).unwrap();
        assert_eq!(
            bounds.y(),
            reference_bounds.y(),
            "{} divider must align vertically",
            column.title()
        );
        assert_eq!(
            bounds.height(),
            reference_bounds.height(),
            "{} divider must have equal height",
            column.title()
        );
    }
    let controllers = header.observe_controllers();
    let drag = (0..controllers.n_items())
        .filter_map(|i| controllers.item(i))
        .find_map(|item| item.downcast::<gtk::GestureDrag>().ok())
        .unwrap();
    let original = header.width();
    let rows = page.row_keys();
    drag.emit_by_name::<()>("drag-begin", &[&f64::from(header.width() - 5), &0.0f64]);
    drag.emit_by_name::<()>("drag-update", &[&85.0f64, &0.0f64]);
    case.settle();
    assert_eq!(header.width_request(), original + 85);
    let cell = named::<gtk::Overlay>(&page.list, "session-cell project codex:one")[0].clone();
    assert_eq!(cell.width_request(), original + 85);
    assert_eq!(
        cell.width(),
        header.width(),
        "Header and body allocations align"
    );
    assert!(
        !case.app.session_columns().has_widths(),
        "Preview must not write preferences"
    );
    let root = handle.root().unwrap();
    assert_eq!(
        root.focus().as_ref(),
        Some(handle.upcast_ref::<gtk::Widget>()),
        "A pointer resize focuses the grip so Escape can cancel it"
    );
    drag.emit_by_name::<()>("drag-end", &[&85.0f64, &0.0f64]);
    case.settle();
    assert_ne!(
        root.focus().as_ref(),
        Some(handle.upcast_ref::<gtk::Widget>()),
        "A finished pointer resize releases the grip's focus"
    );
    assert_eq!(
        case.app.session_columns().width(SessionColumn::Project),
        original + 85
    );
    assert_eq!(page.row_keys(), rows, "Resizing must not sort");
    assert!(case.called("sessions.transcript").is_empty());
    let reloaded = Preferences::load(case.app.prefs().path().to_owned());
    assert_eq!(
        SessionColumnLayout::from_value(reloaded.get(SESSION_COLUMNS_KEY)),
        case.app.session_columns()
    );
    drag.emit_by_name::<()>("drag-begin", &[&f64::from(header.width() - 5), &0.0f64]);
    drag.emit_by_name::<()>("drag-update", &[&-9000.0f64, &0.0f64]);
    assert_eq!(header.width_request(), 80);
    drag.emit_by_name::<()>("cancel", &[&None::<gtk::gdk::EventSequence>]);
    assert_eq!(header.width_request(), original + 85);
    assert_ne!(
        root.focus().as_ref(),
        Some(handle.upcast_ref::<gtk::Widget>()),
        "A cancelled pointer resize releases the grip's focus"
    );
    let key = handle
        .observe_controllers()
        .into_iter()
        .filter_map(Result::ok)
        .find_map(|item| item.downcast::<gtk::EventControllerKey>().ok())
        .unwrap();
    let press = |name: gtk::gdk::Key| {
        key.emit_by_name::<bool>(
            "key-pressed",
            &[&name, &0u32, &gtk::gdk::ModifierType::empty()],
        );
    };
    drag.emit_by_name::<()>("drag-begin", &[&f64::from(header.width() - 5), &0.0f64]);
    drag.emit_by_name::<()>("drag-update", &[&40.0f64, &0.0f64]);
    press(gtk::gdk::Key::Escape);
    assert_eq!(header.width_request(), original + 85);
    assert_ne!(
        root.focus().as_ref(),
        Some(handle.upcast_ref::<gtk::Widget>()),
        "Escape during a pointer resize releases the grip's focus"
    );
    drag.emit_by_name::<()>("drag-end", &[&40.0f64, &0.0f64]);
    assert_eq!(
        case.app.session_columns().width(SessionColumn::Project),
        original + 85,
        "A drag cancelled by Escape does not persist on release"
    );
    handle.grab_focus();
    press(gtk::gdk::Key::Right);
    press(gtk::gdk::Key::Escape);
    assert_eq!(
        root.focus().as_ref(),
        Some(handle.upcast_ref::<gtk::Widget>()),
        "Keyboard focus on the grip stays put"
    );
    let click = (0..controllers.n_items())
        .filter_map(|i| controllers.item(i))
        .find_map(|item| item.downcast::<gtk::GestureClick>().ok())
        .unwrap();
    click.emit_by_name::<()>(
        "pressed",
        &[&2i32, &f64::from(header.width() - 5), &10.0f64],
    );
    assert_eq!(
        case.app.session_columns().width(SessionColumn::Project),
        SessionColumn::Project.width()
    );
}

fn sessions_header_hover_previews_next_sort(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    let mut layout = case.app.session_columns();
    for column in [
        agent_relay_probe::linux_app::models::SessionColumn::Harness,
        agent_relay_probe::linux_app::models::SessionColumn::Model,
        agent_relay_probe::linux_app::models::SessionColumn::Reasoning,
    ] {
        layout.set_visible(column, true);
    }
    case.app.set_session_columns(layout);
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let title = named::<gtk::Button>(&page.table, "sort-session-Session")[0].clone();
    let updated = named::<gtk::Button>(&page.table, "sort-session-Updated")[0].clone();
    for name in ["Harness", "Model", "Reasoning"] {
        let button = named::<gtk::Button>(&page.table, &format!("sort-session-{name}"))[0].clone();
        assert!(button.is_sensitive());
        button.set_state_flags(gtk::StateFlags::PRELIGHT, false);
        assert!(labels(&button).contains(&"↑".into()));
        button.emit_clicked();
        assert!(labels(&button).contains(&"↓".into()));
        button.unset_state_flags(gtk::StateFlags::PRELIGHT);
        assert!(labels(&button).contains(&"↑".into()));
    }
    updated.emit_clicked();
    let original = page.row_keys();
    assert!(!labels(&title)
        .iter()
        .any(|label| label == "↑" || label == "↓"));
    assert!(labels(&updated).contains(&"↓".into()));
    updated.set_state_flags(gtk::StateFlags::PRELIGHT, false);
    assert!(labels(&updated).contains(&"↑".into()));
    assert_eq!(
        page.row_keys(),
        original,
        "Hovering only previews, never sorts"
    );
    updated.unset_state_flags(gtk::StateFlags::PRELIGHT);
    assert!(labels(&updated).contains(&"↓".into()));
    title.set_state_flags(gtk::StateFlags::PRELIGHT, false);
    assert!(labels(&title).contains(&"↑".into()));
    title.emit_clicked();
    assert!(
        labels(&title).contains(&"↓".into()),
        "After clicking ascending, preview descending while still hovered"
    );
    title.unset_state_flags(gtk::StateFlags::PRELIGHT);
    assert!(labels(&title).contains(&"↑".into()));
    title.set_state_flags(gtk::StateFlags::PRELIGHT, false);
    title.emit_clicked();
    assert!(labels(&title).contains(&"↑".into()));
    title.unset_state_flags(gtk::StateFlags::PRELIGHT);
    assert!(labels(&title).contains(&"↓".into()));
}

fn session_title_fills_available_width(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::SessionColumn;
    let case = Case::new(runtime);
    case.sign_in();
    case.app.show_window();
    let mut layout = case.app.session_columns();
    for column in layout.visible() {
        if !matches!(column, SessionColumn::Session | SessionColumn::Project) {
            layout.set_visible(column, false);
        }
    }
    layout.set_width(SessionColumn::Session, 240);
    layout.set_width(SessionColumn::Project, 100);
    case.app.set_session_columns(layout.clone());
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    for last in [SessionColumn::Project, SessionColumn::Session] {
        if last == SessionColumn::Session {
            layout.move_to(SessionColumn::Project, SessionColumn::Session);
        }
        case.app.set_session_columns(layout.clone());
        case.settle();
        let header = named::<gtk::Overlay>(&page.table, "session-header session")[0].clone();
        let project = named::<gtk::Overlay>(&page.table, "session-header project")[0].clone();
        assert_eq!(project.width(), layout.width(SessionColumn::Project));
        assert!(
            header.width() > layout.width(SessionColumn::Session),
            "Session takes spare space regardless of order"
        );
        let cell = named::<gtk::Overlay>(&page.list, "session-cell session codex:one");
        let cell = if cell.is_empty() {
            named::<gtk::Overlay>(&page.list, "open-session codex:one").remove(0)
        } else {
            cell[0].clone()
        };
        assert_eq!(cell.width(), header.width());
    }
    layout.set_visible(SessionColumn::Project, false);
    case.app.set_session_columns(layout.clone());
    case.settle();
    let header = named::<gtk::Overlay>(&page.table, "session-header session")[0].clone();
    assert!(header.width() > 240);
    layout.set_visible(SessionColumn::Project, true);
    layout.set_width(SessionColumn::Session, 1200);
    layout.set_width(SessionColumn::Project, 1200);
    case.app.set_session_columns(layout);
    case.settle();
    assert_eq!(
        header.width(),
        1200,
        "Overflow preserves requested widths and scrolls"
    );
}

fn hidden_sessions_stop_sharing_and_can_be_shown_without_reenabling(
    runtime: &tokio::runtime::Runtime,
) {
    use std::sync::atomic::{AtomicBool, Ordering};
    let case = Case::new(runtime);
    let registered = Arc::new(AtomicBool::new(true));
    let included = Arc::new(AtomicBool::new(true));
    let current = registered.clone();
    case.core.answer("sessions.list", Answer::with(move |_| {
        let registration = if current.load(Ordering::SeqCst) { json!({"name":"hidden-test", "address":"hidden-test@desk", "added_by_session":false}) } else { Value::Null };
        async move { Ok(json!({"sessions":[local_session("codex", "one", "Fix login", true, registration)]})) }
    }));
    let current = registered.clone();
    case.core.answer(
        "agents.unregister",
        Answer::with(move |_| {
            current.store(false, Ordering::SeqCst);
            async { Ok(json!({})) }
        }),
    );
    let current = included.clone();
    case.core.answer("uploader.sessions.list", Answer::with(move |_| {
        let on = current.load(Ordering::SeqCst);
        async move { Ok(json!({"sharing_mode":"selected", "sessions":[upload_row("codex", "one", "Fix login", "/w/api", on, if on { "uploaded" } else { "not_shared" })]})) }
    }));
    let current = included.clone();
    let registration = registered.clone();
    case.core.answer(
        "uploader.sessions.exclude",
        Answer::with(move |params| {
            assert!(
                !registration.load(Ordering::SeqCst),
                "Relay must stop before uploads"
            );
            assert_eq!(params["session_keys"], json!(["codex:one"]));
            current.store(false, Ordering::SeqCst);
            async { Ok(json!({"updated":1})) }
        }),
    );
    case.set_state(workspace_snapshot());
    case.pump(|case| {
        case.app
            .with_state(|s| s.connected() && s.sessions.len() == 1 && s.local_sessions.len() == 1)
    });
    case.app.show_window();
    case.settle();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    let row = page.list.row_at_index(0).unwrap();
    let mut menu = case.app.session_menu_items(&row);
    let (_, action) = menu.remove(
        menu.iter()
            .position(|(label, _)| label == "Hide session")
            .unwrap(),
    );
    action.unwrap()();
    case.pump(|case| {
        case.app
            .with_state(|state| state.hiding_sessions.is_empty())
            && !included.load(Ordering::SeqCst)
    });
    assert!(page.row_keys().is_empty());
    assert!(case.app.session_hidden("codex:one"));
    assert_eq!(case.called("agents.unregister").len(), 1);
    assert_eq!(case.called("uploader.sessions.exclude").len(), 1);
    assert!(case.called("uploader.sessions.delete").is_empty());
    let persisted = Preferences::load(case.app.prefs().path().to_owned());
    assert_eq!(
        persisted.get("hiddenSessions.v1"),
        Some(&json!(["codex:one"]))
    );
    let columns = named::<gtk::MenuButton>(&page.controls, "session-columns").remove(0);
    columns.popup();
    let show =
        named::<gtk::CheckButton>(&columns.popover().unwrap(), "show-hidden-sessions").remove(0);
    assert!(!show.is_active());
    show.set_active(true);
    case.settle();
    assert_eq!(page.row_keys(), ["codex:one"]);
    assert!(page
        .list
        .row_at_index(0)
        .unwrap()
        .has_css_class("session-hidden"));
    let receive = named::<gtk::Button>(&page.list, "receive-messages codex:one").remove(0);
    assert!(!receive.is_sensitive());
    let session = case.app.with_state(|state| state.local_sessions[0].clone());
    case.app.toggle_relay(&session, true);
    case.app.change_uploads(vec!["codex:one".into()], true);
    case.settle();
    assert!(case.called("agents.register").is_empty());
    assert!(case.called("uploader.sessions.include").is_empty());
    columns.popdown();
    named::<gtk::Button>(&page.list, "open-session codex:one")[0].emit_clicked();
    case.settle();
    assert!(!page.transcript.save.is_sensitive());
    assert!(!page.transcript.receive.is_sensitive());
    page.transcript.back.emit_clicked();
    case.app
        .set_sessions_hidden(vec!["codex:one".into()], false);
    case.settle();
    assert!(!page
        .list
        .row_at_index(0)
        .unwrap()
        .has_css_class("session-hidden"));
    assert!(
        case.called("agents.register").is_empty(),
        "Unhiding does not rejoin relay"
    );
    assert!(
        case.called("uploader.sessions.include").is_empty(),
        "Unhiding does not restart uploads"
    );
}

fn hiding_waits_for_explicit_registration_and_then_stops_messages(
    runtime: &tokio::runtime::Runtime,
) {
    explicit_registration_hide(runtime, false);
}

fn hiding_survives_failed_list_after_explicit_registration(runtime: &tokio::runtime::Runtime) {
    explicit_registration_hide(runtime, true);
}

fn explicit_registration_hide(runtime: &tokio::runtime::Runtime, fail_registered_list: bool) {
    use std::sync::atomic::{AtomicBool, Ordering};
    let case = Case::new(runtime);
    let registered = Arc::new(AtomicBool::new(false));
    let current = registered.clone();
    let fail_once = Arc::new(AtomicBool::new(fail_registered_list));
    case.core.answer("sessions.list", Answer::with(move |_| {
        let is_registered = current.load(Ordering::SeqCst);
        let fails = is_registered && fail_once.swap(false, Ordering::SeqCst);
        let registration = if is_registered {
            json!({"name":"hidden-test", "address":"hidden-test@desk", "added_by_session":false})
        } else { Value::Null };
        async move {
            if fails { return Err(RpcError::new(ErrorKind::Internal, "Cannot read registered sessions")); }
            Ok(json!({"sessions":[local_session("codex", "one", "Fix login", true, registration)]}))
        }
    }));
    let release = Arc::new(Notify::new());
    let current = registered.clone();
    let gate = release.clone();
    case.core.answer("agents.register", Answer::with(move |_| {
        let (current, gate) = (current.clone(), gate.clone());
        async move {
            gate.notified().await;
            current.store(true, Ordering::SeqCst);
            Ok(json!({"name":"hidden-test", "address":"hidden-test@desk", "already_registered":false}))
        }
    }));
    let current = registered.clone();
    case.core.answer(
        "agents.unregister",
        Answer::with(move |_| {
            current.store(false, Ordering::SeqCst);
            async { Ok(json!({})) }
        }),
    );
    let current = registered.clone();
    case.core.answer(
        "uploader.sessions.exclude",
        Answer::with(move |_| {
            assert!(
                !current.load(Ordering::SeqCst),
                "Hide must stop messages before excluding uploads"
            );
            async { Ok(json!({"updated":1})) }
        }),
    );
    case.set_state(workspace_snapshot());
    case.pump(|case| !case.app.with_state(|state| state.local_sessions.is_empty()));
    let target = case
        .app
        .with_state(|state| state.local_sessions[0].target.clone());
    case.app
        .register_session_with_name(target, "hidden-test".into());
    case.pump(|case| !case.called("agents.register").is_empty());
    case.app.set_sessions_hidden(vec!["codex:one".into()], true);
    release.notify_one();
    case.pump(|case| {
        case.app
            .with_state(|state| state.hiding_sessions.is_empty())
    });
    // The fake core records the calls as they arrive, a moment after the
    // app's own state moved on.
    case.pump(|case| {
        case.called("agents.unregister").len() == 1
            && case.called("uploader.sessions.exclude").len() == 1
    });
    assert!(!registered.load(Ordering::SeqCst));
    assert!(case.app.session_hidden("codex:one"));
}

fn hidden_session_failure_returns_row_with_error(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.sign_in();
    case.core.answer(
        "uploader.sessions.exclude",
        Answer::fail(
            agent_relay_probe::relay::protocol::ErrorKind::Internal,
            "Cannot stop uploads",
        ),
    );
    case.app.set_sessions_hidden(vec!["codex:one".into()], true);
    case.pump(|case| {
        case.app
            .with_state(|state| state.hiding_sessions.is_empty())
    });
    assert!(!case.app.session_hidden("codex:one"));
    let shell = case.app.shell().unwrap();
    assert!(shell
        .pages
        .sessions
        .row_keys()
        .contains(&"codex:one".into()));
    assert!(labels(&shell.pages.sessions.list)
        .iter()
        .any(|label| label.contains("Cannot stop uploads")));
    assert!(case.called("uploader.sessions.delete").is_empty());
}

fn saved_views_save_restore_and_delete(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::{
        SavedSessionViews, SessionColumn, SAVED_SESSION_VIEWS_KEY,
    };
    let case = Case::new(runtime);
    case.sign_in();
    case.app.show_window();
    case.settle();
    case.app.set_session_search("updated:>=2026-10-08");
    case.app.set_session_grouping(1);
    let mut layout = case.app.session_columns();
    layout.set_width(SessionColumn::Session, 640);
    layout.set_visible(SessionColumn::Project, false);
    case.app.set_session_columns(layout);
    let expected = case.app.session_view_configuration();
    let shell = case.app.shell().unwrap();
    let menus = named::<gtk::MenuButton>(&shell.header_search, "saved-session-views");
    assert_eq!(menus.len(), 1, "One bookmark opens saved views");
    let menu = menus[0].clone();
    let bar: gtk::Box = named(&shell.header_search, "session-search-bar").remove(0);
    assert!(
        !menu.is_ancestor(&bar),
        "Saved views sits outside the search box"
    );
    assert!(named::<gtk::MenuButton>(&shell.header_search, "save-session-view").is_empty());
    assert!(!menu.has_css_class("bookmarked"));
    menu.popup();
    case.settle();
    let pop = menu.popover().unwrap();
    let save_current = buttons(&pop, "Save current view").remove(0);
    assert!(
        save_current.has_css_class("primary"),
        "Save current view uses the Agent Relay brand button"
    );
    save_current.emit_clicked();
    case.settle();
    let entry: gtk::Entry = named(&pop, "saved-view-name").remove(0);
    let confirm: gtk::Button = named(&pop, "confirm-save-session-view").remove(0);
    assert!(!confirm.is_sensitive());
    entry.set_text("Last week");
    named::<gtk::CheckButton>(&pop, "saved-view-default")[0].set_active(true);
    assert!(confirm.is_sensitive());
    // Enter in the name field is the same action as the Save button.
    entry.emit_activate();
    case.settle();
    assert!(!pop.is_visible());
    assert!(
        menu.has_css_class("bookmarked"),
        "Saving the current configuration fills the bookmark"
    );
    case.app.set_session_grouping(2);
    assert!(!menu.has_css_class("bookmarked"));
    case.app.set_session_grouping(1);
    assert!(
        menu.has_css_class("bookmarked"),
        "Returning to a saved configuration fills it again"
    );
    let persisted = Preferences::load(case.prefs_path.clone());
    let views = SavedSessionViews::from_value(persisted.get(SAVED_SESSION_VIEWS_KEY));
    let view = views.default_view().unwrap();
    assert_eq!(view.name, "Last week");
    assert_eq!(view.configuration, expected);
    let id = view.id;
    case.app.set_session_search("project:other");
    case.app.set_session_grouping(2);
    assert!(!menu.has_css_class("bookmarked"));
    menu.popup();
    case.settle();
    let pop = menu.popover().unwrap();
    named::<gtk::Button>(&pop, &format!("open-saved-view-{id}"))[0].emit_clicked();
    case.settle();
    assert_eq!(case.app.session_view_configuration(), expected);
    assert!(menu.has_css_class("bookmarked"));
    menu.popup();
    case.settle();
    let delete: gtk::Button = named(&pop, &format!("delete-saved-view-{id}")).remove(0);
    assert!(delete.is_focusable());
    assert!(delete.grab_focus());
    assert!(
        delete.is_focus(),
        "Delete receives keyboard focus even when another app has the active window"
    );
    delete.emit_clicked();
    case.settle();
    assert!(case.app.saved_session_views().views.is_empty());
    assert!(
        !menu.has_css_class("bookmarked"),
        "Deleting the matching view clears the bookmark"
    );
    assert_eq!(case.app.saved_session_views().default_id, None);
    assert!(labels(&pop).contains(&"Save a search and table layout to use it again.".to_owned()));
    let persisted = Preferences::load(case.prefs_path.clone());
    assert!(
        SavedSessionViews::from_value(persisted.get(SAVED_SESSION_VIEWS_KEY))
            .views
            .is_empty()
    );
}

fn saved_views_default_on_first_open(runtime: &tokio::runtime::Runtime) {
    use agent_relay_probe::linux_app::models::{
        LocalSessionSortColumn, SavedSessionViews, SessionColumn,
    };
    let case = Case::new(runtime);
    let mut config = case.app.session_view_configuration();
    config.search = "project:cloud updated:>=2026-10-08".into();
    config.grouping = 1;
    config.sort.column = LocalSessionSortColumn::Session;
    config.sort.ascending = true;
    let mut layout = config.layout();
    layout.set_width(SessionColumn::Session, 640);
    config.columns = layout.value();
    config.show_hidden = true;
    let mut views = SavedSessionViews::default();
    views.save("Default", config.clone(), true).unwrap();
    case.app.store_saved_session_views(&views).unwrap();
    case.sign_in();
    assert_eq!(case.app.session_view_configuration(), config);
}

// Exercise the window capture controller with coordinates on a non-focusable
// transcript background. Unlike grab_focus(), this preserves the entry focus.
fn click_outside_title(case: &Case) {
    let window = case.app.window();
    let shell = case.app.shell().unwrap();
    let body = &shell.pages.sessions.transcript.root;
    let point = body
        .compute_point(
            window,
            &gtk::graphene::Point::new((body.width() - 20) as f32, (body.height() - 20) as f32),
        )
        .unwrap();
    let picked = window
        .pick(point.x() as f64, point.y() as f64, gtk::PickFlags::DEFAULT)
        .unwrap();
    assert!(!picked.is_ancestor(&shell.pages.sessions.transcript.heading));
    let controllers = window.observe_controllers();
    let clicks: Vec<_> = (0..controllers.n_items())
        .filter_map(|i| controllers.item(i))
        .filter_map(|object| object.downcast::<gtk::GestureClick>().ok())
        .filter(|click| click.name().as_deref() == Some("session-title-click-away"))
        .collect();
    assert_eq!(
        clicks.len(),
        1,
        "Only the mapped session owns a click-away observer"
    );
    clicks[0].emit_by_name::<()>(
        "pressed",
        &[&1i32, &(point.x() as f64), &(point.y() as f64)],
    );
}

fn render_title_header(case: &Case, name: &str) {
    if let Ok(dir) = std::env::var("TITLE_RENDER_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        let paintable = gtk::WidgetPaintable::new(Some(case.app.window()));
        let snapshot = gtk::Snapshot::new();
        paintable.snapshot(
            &snapshot,
            case.app.window().width() as f64,
            case.app.window().height() as f64,
        );
        let node = snapshot.to_node().unwrap();
        case.app
            .window()
            .renderer()
            .unwrap()
            .render_texture(&node, None)
            .save_to_png(std::path::Path::new(&dir).join(format!("title-gtk-{name}.png")))
            .unwrap();
    }
}

fn sessions_title_edits_use_saved_brief_and_rollback(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.core.answer(
        "sessions.title.capability",
        json!({"supported": true, "reason": null}),
    );
    case.core.answer("sessions.overview.get", Answer::with(|params| async move {
        Ok(json!({"sessionId": params["session_id"], "requests": [], "analyses": [{
            "id": "brief", "sessionId": params["session_id"], "sourceProvider": "codex", "status": "completed",
            "result": {"brief": {"title": "Generated title", "description": "Session summary"}}, "error": null
        }]}))
    }));
    let held = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    case.core.answer(
        "sessions.title.set",
        held_answer(held, release.clone(), json!({"title": "Generated title"})),
    );
    case.sign_in();
    case.app.show_window();
    case.answer(
        "sessions.transcript",
        json!({"entries": [], "next_cursor": null}),
    );
    let title_shell = case.app.shell().unwrap();
    named::<gtk::Button>(&title_shell.pages.sessions.list, "open-session codex:one")[0]
        .emit_clicked();
    case.app.show_window();
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .session_titles
                .get("codex:one")
                .is_some_and(|edit| edit.supported == Some(true))
        })
    });
    case.settle();
    let shell = case.app.shell().unwrap();
    let root = &shell.pages.sessions.transcript.heading;
    named::<gtk::Button>(root, "rename-session codex:one")
        .remove(0)
        .emit_clicked();
    case.pump(|case| {
        case.called("sessions.title.capability")
            .iter()
            .any(|params| params["session_id"] == "one")
            && case.app.with_state(|state| {
                state
                    .title_overviews
                    .get("codex:one")
                    .is_some_and(|brief| brief.title == "Generated title")
            })
    });
    case.settle();
    let entry = named::<gtk::Entry>(root, "session-title-entry codex:one").remove(0);
    assert_eq!(entry.text(), "Fix login");
    named::<gtk::Button>(root, "generated-session-title codex:one")
        .remove(0)
        .emit_clicked();
    assert_eq!(entry.text(), "Generated title");
    assert!(
        case.called("sessions.title.set").is_empty(),
        "Loading a suggestion does not save it"
    );
    assert!(
        case.called("sessions.overview.request").is_empty(),
        "Preloading never generates a new summary"
    );
    entry.emit_activate();
    case.pump(|case| case.called("sessions.title.set").len() == 1);
    assert!(
        labels(root).contains(&"Generated title".to_owned()),
        "Title changes before the core responds"
    );
    assert_eq!(
        case.called("sessions.title.set")[0],
        json!({"source": "codex", "session_id": "one", "title": "Generated title"})
    );
    case.app.set_session_search("Generated title");
    case.settle();
    assert_eq!(
        shell.pages.sessions.row_keys(),
        vec!["codex:one"],
        "Search sees the optimistic title"
    );
    case.app.set_session_search("");
    case.settle();
    case.app.refresh_local();
    case.app.refresh_uploader(true);
    case.settle();
    assert!(
        labels(root).contains(&"Generated title".to_owned()),
        "Stale refresh cannot undo optimistic title"
    );
    release.notify_one();
    case.pump(|case| {
        case.app
            .with_state(|state| !state.session_titles["codex:one"].pending)
    });
    case.settle();
    case.core.answer(
        "sessions.title.set",
        Answer::with(|_| async { Err(RpcError::invalid_params("Rename failed")) }),
    );
    named::<gtk::Button>(root, "rename-session codex:one")
        .remove(0)
        .emit_clicked();
    let entry = named::<gtk::Entry>(root, "session-title-entry codex:one").remove(0);
    entry.set_text("Rejected title");
    entry.emit_activate();
    case.pump(|case| {
        case.app.with_state(|state| {
            state.session_titles["codex:one"].error.as_deref() == Some("Rename failed")
        })
    });
    let entry = named::<gtk::Entry>(root, "session-title-entry codex:one").remove(0);
    assert_eq!(
        entry.text(),
        "Rejected title",
        "Failed edits remain available to retry"
    );
    case.settle();
    click_outside_title(&case);
    case.settle();
    assert_eq!(
        case.called("sessions.title.set").len(),
        2,
        "Click-away never retries a rejected draft"
    );
    case.app.update_state(|state| {
        state.title_overviews.get_mut("codex:one").unwrap().title = "Corrected suggestion".into();
    });
    case.answer(
        "sessions.title.set",
        Answer::with(|params| async move { Ok(json!({"title": params["title"]})) }),
    );
    named::<gtk::Button>(root, "generated-session-title codex:one")[0].emit_clicked();
    assert_eq!(entry.text(), "Corrected suggestion");
    assert!(case
        .app
        .with_state(|state| state.session_titles["codex:one"].error.is_none()));
    click_outside_title(&case);
    case.pump(|case| case.called("sessions.title.set").len() == 3);
    case.settle();
    assert!(!entry.is_mapped());
    assert!(
        !shell.pages.sessions.table.is_visible(),
        "Editor clicks must stay in the transcript"
    );
}

fn sessions_title_unsupported_never_writes(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.core.answer(
        "sessions.title.capability",
        json!({"supported": false, "reason": "This harness does not support renaming sessions."}),
    );
    case.sign_in();
    case.app.show_window();
    case.answer(
        "sessions.transcript",
        json!({"entries": [], "next_cursor": null}),
    );
    let title_shell = case.app.shell().unwrap();
    named::<gtk::Button>(&title_shell.pages.sessions.list, "open-session codex:one")[0]
        .emit_clicked();
    case.settle();
    let shell = case.app.shell().unwrap();
    let root = &shell.pages.sessions.transcript.heading;
    named::<gtk::Button>(root, "rename-session codex:one")
        .remove(0)
        .emit_clicked();
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .session_titles
                .get("codex:one")
                .is_some_and(|edit| edit.supported == Some(false))
        })
    });
    let pencil = named::<gtk::Button>(root, "rename-session codex:one").remove(0);
    assert!(!pencil.is_sensitive());
    assert_eq!(
        pencil.tooltip_text().as_deref(),
        Some("This harness does not support renaming sessions.")
    );
    assert!(case
        .app
        .with_state(|state| state.session_titles["codex:one"].draft.is_none()));
    case.settle();
    assert!(case.called("sessions.title.set").is_empty());
}

fn sessions_title_reconnect_retires_pending_work(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.answer(
        "sessions.title.capability",
        json!({"supported": true, "reason": null}),
    );
    let old_overviews = Arc::new(Notify::new());
    let release = old_overviews.clone();
    case.answer(
        "sessions.overview.get",
        Answer::with(move |params| {
            let release = release.clone();
            async move {
                release.notified().await;
                Ok(json!({"sessionId": params["session_id"], "requests": [], "analyses": []}))
            }
        }),
    );
    let save_release = Arc::new(Notify::new());
    case.answer(
        "sessions.title.set",
        held_answer(
            Arc::new(Notify::new()),
            save_release.clone(),
            json!({"title": "Uncertain rename"}),
        ),
    );
    case.sign_in();
    case.app.show_window();
    case.answer(
        "sessions.transcript",
        json!({"entries": [], "next_cursor": null}),
    );
    let title_shell = case.app.shell().unwrap();
    named::<gtk::Button>(&title_shell.pages.sessions.list, "open-session codex:one")[0]
        .emit_clicked();
    case.app.show_window();
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .session_titles
                .get("codex:one")
                .is_some_and(|edit| edit.supported == Some(true))
        })
    });
    case.settle();
    let shell = case.app.shell().unwrap();
    let root = &shell.pages.sessions.transcript.heading;
    named::<gtk::Button>(root, "rename-session codex:one")[0].emit_clicked();
    let entry = named::<gtk::Entry>(root, "session-title-entry codex:one").remove(0);
    entry.set_text("Uncertain rename");
    entry.emit_activate();
    case.pump(|case| {
        !case.called("sessions.title.set").is_empty()
            && !case.called("sessions.overview.get").is_empty()
    });
    case.app.on_connection(false, Some("Restarting".into()));
    case.app.with_state(|state| {
        let edit = &state.session_titles["codex:one"];
        assert!(!edit.pending && !edit.checking);
        assert_eq!(edit.draft.as_deref(), Some("Uncertain rename"));
        assert!(edit.error.is_some());
        assert_eq!(edit.supported, None);
        assert!(state.loading_title_overviews.is_empty());
        assert!(state.title_overviews.is_empty());
        assert!(state.title_overview_reads.is_empty());
    });
    save_release.notify_one();
    old_overviews.notify_waiters();
    case.settle();
    assert!(
        case.app
            .with_state(|state| state.session_titles["codex:one"].optimistic.is_none()),
        "the old view's response must be dropped"
    );
    let reads = case.called("sessions.overview.get").len();
    let capabilities = case.called("sessions.title.capability").len();
    case.answer(
        "sessions.overview.get",
        Answer::with(|params| async move {
            Ok(json!({"sessionId": params["session_id"], "requests": [], "analyses": []}))
        }),
    );
    case.answer("sessions.title.set", json!({"title": "Retried rename"}));
    case.app.on_connection(true, None);
    case.pump(|case| {
        case.called("sessions.overview.get").len() > reads
            && case.called("sessions.title.capability").len() > capabilities
            && case.app.with_state(|state| {
                state
                    .session_titles
                    .get("codex:one")
                    .is_some_and(|edit| edit.supported == Some(true))
            })
    });
    let entry = named::<gtk::Entry>(root, "session-title-entry codex:one").remove(0);
    assert_eq!(entry.text(), "Uncertain rename");
    entry.set_text("Retried rename");
    entry.emit_activate();
    case.pump(|case| {
        case.called("sessions.title.set").len() == 2
            && case
                .app
                .with_state(|state| !state.session_titles["codex:one"].pending)
    });
}

fn sessions_title_transcript_reopens_with_current_native_title(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.answer(
        "sessions.title.capability",
        json!({"supported": true, "reason": null}),
    );
    case.answer("sessions.title.set", json!({"title": "Accepted title"}));
    case.answer(
        "sessions.transcript",
        json!({"entries": [], "next_cursor": null}),
    );
    case.sign_in();
    case.app.show_window();
    case.answer(
        "sessions.transcript",
        json!({"entries": [], "next_cursor": null}),
    );
    let title_shell = case.app.shell().unwrap();
    named::<gtk::Button>(&title_shell.pages.sessions.list, "open-session codex:one")[0]
        .emit_clicked();
    case.app.show_window();
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .session_titles
                .get("codex:one")
                .is_some_and(|edit| edit.supported == Some(true))
        })
    });
    case.settle();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    case.settle();
    let heading = &page.transcript.heading;
    named::<gtk::Button>(heading, "rename-session codex:one")[0].emit_clicked();
    let entry = named::<gtk::Entry>(heading, "session-title-entry codex:one").remove(0);
    assert_eq!(entry.text(), "Fix login");
    entry.set_text("Accepted title");
    let mut catalog = sessions();
    catalog["sessions"][0]["title"] = json!("Accepted title");
    case.answer("uploader.sessions.list", catalog.clone());
    entry.emit_activate();
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .sessions
                .iter()
                .any(|row| row.session_id == "one" && row.title == "Accepted title")
                && state.session_titles["codex:one"].optimistic.is_none()
                && !state.session_titles["codex:one"].pending
        })
    });
    named::<gtk::Button>(heading, "rename-session codex:one")[0].emit_clicked();
    assert_eq!(
        entry.text(),
        "Accepted title",
        "the retained transcript cell must not restore its original captured title"
    );
    named::<gtk::Button>(heading, "cancel-session-title codex:one")[0].emit_clicked();
    catalog["sessions"][0]["title"] = json!("Renamed in native app");
    case.answer("uploader.sessions.list", catalog);
    case.app.refresh_uploader(true);
    case.pump(|_| labels(heading).contains(&"Renamed in native app".to_owned()));
    named::<gtk::Button>(heading, "rename-session codex:one")[0].emit_clicked();
    assert_eq!(entry.text(), "Renamed in native app");
}

fn sessions_title_blur_debounce_and_noop(runtime: &tokio::runtime::Runtime) {
    let case = Case::new(runtime);
    case.answer(
        "sessions.title.capability",
        json!({"supported": true, "reason": null}),
    );
    case.answer(
        "sessions.transcript",
        json!({"entries": [], "next_cursor": null}),
    );
    case.answer(
        "sessions.title.set",
        Answer::with(|params| async move { Ok(json!({"title": params["title"]})) }),
    );
    case.answer("sessions.overview.get", Answer::with(|params| async move {
        Ok(json!({"sessionId": params["session_id"], "requests": [], "analyses": [{"id": "brief", "sessionId": params["session_id"], "sourceProvider": "codex", "status": "completed", "result": {"brief": {"title": "Fix login", "description": "Session summary"}}, "error": null}]}))
    }));
    case.sign_in();
    case.app.show_window();
    case.settle();
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions;
    assert!(named::<gtk::Button>(&page.list, "rename-session codex:one").is_empty());
    assert!(named::<gtk::Entry>(&page.list, "session-title-entry codex:one").is_empty());
    assert!(case.called("sessions.title.capability").is_empty());
    assert!(case.called("sessions.overview.get").is_empty());
    named::<gtk::Button>(&page.list, "open-session codex:one")[0].emit_clicked();
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .session_titles
                .get("codex:one")
                .is_some_and(|edit| edit.supported == Some(true))
                && state
                    .title_overviews
                    .get("codex:one")
                    .is_some_and(|overview| overview.title == "Fix login")
        })
    });
    let heading = &page.transcript.heading;
    let rename = named::<gtk::Button>(heading, "rename-session codex:one").remove(0);
    let entry = named::<gtk::Entry>(heading, "session-title-entry codex:one").remove(0);
    let done = named::<gtk::Button>(heading, "save-session-title codex:one").remove(0);
    let cancel = named::<gtk::Button>(heading, "cancel-session-title codex:one").remove(0);
    let auto = named::<gtk::Button>(heading, "generated-session-title codex:one").remove(0);
    assert!(labels(&rename).contains(&"Rename".into()));
    for draft in ["Fix login", "   "] {
        rename.emit_clicked();
        entry.set_text(draft);
        done.emit_clicked();
        assert!(
            rename.is_focus(),
            "Explicit no-op save restores Rename focus"
        );
    }
    rename.emit_clicked();
    auto.emit_clicked();
    done.emit_clicked();
    assert!(case.called("sessions.title.set").is_empty());
    rename.emit_clicked();
    case.settle();
    let reads = case.called("sessions.overview.get").len();
    let capabilities = case.called("sessions.title.capability").len();
    entry.set_text("Typing");
    entry.set_text("Typing a new title");
    page.transcript.back.grab_focus();
    let until = Instant::now() + Duration::from_millis(50);
    while Instant::now() < until {
        dispatch_one();
    }
    entry.grab_focus();
    case.settle();
    assert!(
        case.called("sessions.title.set").is_empty(),
        "Focus return cancels delayed save"
    );
    done.grab_focus();
    case.settle();
    assert!(
        case.called("sessions.title.set").is_empty(),
        "Toolbar focus stays inside the editor"
    );
    auto.emit_clicked();
    assert_eq!(entry.text(), "Fix login");
    assert_eq!(case.called("sessions.overview.get").len(), reads);
    assert_eq!(case.called("sessions.title.capability").len(), capabilities);
    cancel.emit_clicked();
    case.settle();
    assert!(rename.is_focus(), "Cancel restores Rename focus");
    assert!(case.called("sessions.title.set").is_empty());
    rename.emit_clicked();
    case.settle();
    entry.set_text("Escape discards this draft");
    let editor = descendants(heading.upcast_ref())
        .into_iter()
        .find(|widget| widget.has_css_class("session-title-cell"))
        .unwrap();
    let controllers = editor.observe_controllers();
    let keyboard = (0..controllers.n_items())
        .filter_map(|i| controllers.item(i))
        .find_map(|controller| controller.downcast::<gtk::EventControllerKey>().ok())
        .unwrap();
    assert!(keyboard.emit_by_name::<bool>(
        "key-pressed",
        &[
            &gtk::gdk::Key::Escape,
            &0u32,
            &gtk::gdk::ModifierType::empty()
        ]
    ));
    case.settle();
    assert!(rename.is_focus(), "Escape restores Rename focus");
    assert!(case.called("sessions.title.set").is_empty());
    rename.emit_clicked();
    entry.set_text("Committed by leaving");
    entry.grab_focus();
    case.settle();
    page.transcript.back.grab_focus();
    case.pump(|case| case.called("sessions.title.set").len() == 1);
    case.settle();
    assert!(
        page.transcript.back.is_focus(),
        "Blur save preserves outside focus"
    );
    rename.emit_clicked();
    entry.set_text("Must not save on navigation");
    entry.grab_focus();
    case.settle();
    page.transcript.back.emit_clicked();
    case.settle();
    assert_eq!(case.called("sessions.title.set").len(), 1);
    named::<gtk::Button>(&page.list, "open-session codex:one")[0].emit_clicked();
    case.settle();
    let cancel = named::<gtk::Button>(heading, "cancel-session-title codex:one").remove(0);
    cancel.emit_clicked();
    for (name, appearance) in [("light", Appearance::Light), ("dark", Appearance::Dark)] {
        case.app.set_appearance(appearance);
        case.settle();
        render_title_header(&case, &format!("{name}-resting"));
        named::<gtk::Button>(heading, "rename-session codex:one")[0].emit_clicked();
        case.settle();
        assert_eq!(shell.header.height(), 64);
        let field = named::<gtk::Entry>(heading, "session-title-entry codex:one").remove(0);
        assert!(field.has_css_class("session-title-entry"));
        render_title_header(&case, name);
        cancel.emit_clicked();
    }
}

// Optimistic Settings controls: the change shows at once, with a spinner
// beside it, and falls back when the core refuses.

/// The switch on the row titled `title`, with whether its spinner shows.
fn settings_switch(case: &Case, title: &str) -> (gtk::Switch, bool) {
    let mut found = Vec::new();
    walk(
        case.app.shell().unwrap().settings.column.upcast_ref(),
        &mut |widget| {
            if let Some(switch) = widget.downcast_ref::<gtk::Switch>() {
                let holder = switch.parent().expect("a switch sits in its holder");
                let row = holder.parent().expect("the holder sits on its row");
                if labels(&row).contains(&title.to_string()) {
                    let mut spinning = false;
                    walk(&holder, &mut |widget| {
                        if widget.downcast_ref::<gtk::Spinner>().is_some() {
                            spinning = true;
                        }
                    });
                    found.push((switch.clone(), spinning));
                }
            }
        },
    );
    assert_eq!(found.len(), 1, "one switch titled {title}");
    found.remove(0)
}

fn a_settings_switch_holds_its_position_until_the_core_refuses(runtime: &tokio::runtime::Runtime) {
    const TITLE: &str = "Let sessions put themselves on the relay";
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    let case = Case::with(runtime, |core| {
        core.answer(
            "settings.set",
            Answer::with(move |_| {
                let gate = gate.clone();
                async move {
                    gate.notified().await;
                    Err(RpcError::new(
                        ErrorKind::Refused,
                        "settings.json cannot be written",
                    ))
                }
            }),
        );
    });
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    let (switch, spinning) = settings_switch(&case, TITLE);
    assert!(switch.is_active(), "on in the fixture");
    assert!(!spinning);
    switch.set_active(false);
    case.pump(|case| !case.called("settings.set").is_empty());
    assert_eq!(
        case.called("settings.set")[0],
        json!({"allow_self_registration": false})
    );
    // The row is drawn again off, spinning, from the pending change.
    case.pump(|case| matches!(settings_switch(case, TITLE), (switch, true) if !switch.is_active()));
    assert!(case.app.with_state(|state| {
        state.setting_pending("allow_self_registration")
            && state
                .settings
                .as_ref()
                .is_some_and(|s| !s.allow_self_registration)
            && state
                .confirmed_settings
                .as_ref()
                .is_some_and(|s| s.allow_self_registration)
    }));
    release.notify_one();
    // Refused: the switch falls back and the pane says why.
    case.pump(|case| {
        case.settings_labels()
            .contains(&"settings.json cannot be written".to_string())
    });
    let (switch, spinning) = settings_switch(&case, TITLE);
    assert!(switch.is_active());
    assert!(!spinning);
    assert!(case.app.with_state(|state| {
        state.pending_settings.is_empty()
            && state
                .settings
                .as_ref()
                .is_some_and(|s| s.allow_self_registration)
    }));
}

fn the_sharing_policy_asked_for_is_selected_at_once(runtime: &tokio::runtime::Runtime) {
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    let case = Case::with(runtime, |core| {
        core.answer(
            "uploader.sharing.set",
            Answer::with(move |_| {
                let gate = gate.clone();
                async move {
                    gate.notified().await;
                    Err(RpcError::new(
                        ErrorKind::Internal,
                        "The uploader is restarting.",
                    ))
                }
            }),
        );
    });
    case.sign_in();
    case.app.go(Page::Settings(Pane::Sharing));
    let selected = |case: &Case| {
        let mut rows = Vec::new();
        walk(
            case.app.shell().unwrap().settings.column.upcast_ref(),
            &mut |widget| {
                if widget.has_css_class("policy-row") && widget.has_css_class("selected") {
                    rows.push(labels(widget)[0].clone());
                }
            },
        );
        rows
    };
    let spinners = |case: &Case| {
        let mut count = 0;
        walk(
            case.app.shell().unwrap().settings.column.upcast_ref(),
            &mut |widget| {
                if widget.has_css_class("policy-row") {
                    walk(widget, &mut |inner| {
                        if inner.downcast_ref::<gtk::Spinner>().is_some() {
                            count += 1;
                        }
                    });
                }
            },
        );
        count
    };
    assert_eq!(
        selected(&case),
        vec![SharingMode::Selected.title().to_string()]
    );
    case.app.change_sharing(SharingMode::All);
    case.pump(|case| !case.called("uploader.sharing.set").is_empty());
    // Selected and spinning at once; every row stays clickable.
    assert_eq!(selected(&case), vec![SharingMode::All.title().to_string()]);
    assert_eq!(spinners(&case), 1);
    assert!(case
        .app
        .with_state(|state| state.sharing_mode() == Some(SharingMode::All)));
    let mut sensitive = true;
    walk(
        case.app.shell().unwrap().settings.column.upcast_ref(),
        &mut |widget| {
            if widget.has_css_class("policy-row") && !widget.is_sensitive() {
                sensitive = false;
            }
        },
    );
    assert!(sensitive);
    release.notify_one();
    // Refused: the confirmed policy comes back, with why.
    case.pump(|case| {
        case.settings_labels()
            .contains(&"The uploader is restarting.".to_string())
    });
    assert_eq!(
        selected(&case),
        vec![SharingMode::Selected.title().to_string()]
    );
    assert_eq!(spinners(&case), 0);
    assert!(case
        .app
        .with_state(|state| !state.sharing_mode_wanted.is_pending()));
}

fn claude_delivery_refusal_survives_reconciliation_until_explicit_refresh(
    runtime: &tokio::runtime::Runtime,
) {
    const ERROR: &str = "Could not save message approvals.";
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| case.app.with_state(|state| state.claude_delivery.is_some()));
    case.settle();
    let disclosure = widgets::<gtk::Expander>(&case.app.shell().unwrap().settings.column)
        .into_iter()
        .find(|expander| expander.label().as_deref() == Some("Claude Code message approvals"))
        .expect("the approvals disclosure");
    disclosure.set_expanded(true);
    case.app.render_settings();
    let release = Arc::new(Notify::new());
    let held = Arc::new(Notify::new());
    let mut refreshed = claude_delivery();
    refreshed["sessions"][0]["title"] = json!("Reconciled approvals");
    case.answer(
        "claude_delivery.status",
        held_answer(held, release.clone(), refreshed),
    );
    case.answer(
        "claude_delivery.restrict",
        fail(ErrorKind::StoreFailed, ERROR),
    );
    let restriction = widgets::<gtk::CheckButton>(&case.app.shell().unwrap().settings.column)
        .into_iter()
        .find(|check| check.label().as_deref() == Some("Only allowed members may deliver directly"))
        .expect("the approvals restriction");
    assert!(restriction.is_active());
    restriction.set_active(false);
    case.pump(|case| {
        case.app
            .with_state(|state| state.claude_delivery_error.as_deref() == Some(ERROR))
    });
    release.notify_one();
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .claude_delivery
                .as_ref()
                .is_some_and(|status| status.sessions[0].title == "Reconciled approvals")
        })
    });
    assert_eq!(
        case.app
            .with_state(|state| state.claude_delivery_error.clone())
            .as_deref(),
        Some(ERROR)
    );
    assert!(case.settings_labels().contains(&ERROR.to_string()));
    let mut explicit = claude_delivery();
    explicit["sessions"][0]["title"] = json!("Explicitly refreshed approvals");
    case.answer(
        "claude_delivery.status",
        check::<method::ClaudeDeliveryStatus>(explicit),
    );
    case.app.refresh_claude_delivery();
    case.pump(|case| {
        case.app.with_state(|state| {
            state
                .claude_delivery
                .as_ref()
                .is_some_and(|status| status.sessions[0].title == "Explicitly refreshed approvals")
        })
    });
    assert!(case
        .app
        .with_state(|state| state.claude_delivery_error.is_none()));
}

fn claude_delivery_refusal_survives_a_failed_reconciliation_read(
    runtime: &tokio::runtime::Runtime,
) {
    const ERROR: &str = "Could not save message approvals.";
    let case = Case::new(runtime);
    case.sign_in();
    case.app.go(Page::Settings(Pane::Relay));
    case.pump(|case| case.app.with_state(|state| state.claude_delivery.is_some()));
    case.settle();
    let disclosure = widgets::<gtk::Expander>(&case.app.shell().unwrap().settings.column)
        .into_iter()
        .find(|expander| expander.label().as_deref() == Some("Claude Code message approvals"))
        .expect("the approvals disclosure");
    disclosure.set_expanded(true);
    case.app.render_settings();
    let release_read = Arc::new(Notify::new());
    let gate = release_read.clone();
    case.answer(
        "claude_delivery.status",
        Answer::with(move |_| {
            let gate = gate.clone();
            async move {
                gate.notified().await;
                Err(RpcError::new(
                    ErrorKind::StoreFailed,
                    "Could not read approvals.",
                ))
            }
        }),
    );
    case.answer(
        "claude_delivery.restrict",
        fail(ErrorKind::StoreFailed, ERROR),
    );
    let restriction = widgets::<gtk::CheckButton>(&case.app.shell().unwrap().settings.column)
        .into_iter()
        .find(|check| check.label().as_deref() == Some("Only allowed members may deliver directly"))
        .expect("the approvals restriction");
    let reads_before = case.called("claude_delivery.status").len();
    restriction.set_active(false);
    case.pump(|case| {
        case.app
            .with_state(|state| state.claude_delivery_error.as_deref() == Some(ERROR))
            && case.called("claude_delivery.status").len() > reads_before
    });
    // Queue an explicit refresh behind reconciliation. Its arrival proves the
    // failed read's callback has run, while its held answer cannot clear errors.
    let explicit_release = Arc::new(Notify::new());
    let mut explicit = claude_delivery();
    explicit["sessions"][0]["title"] = json!("Explicit approvals after read failure");
    case.answer(
        "claude_delivery.status",
        held_answer(Arc::new(Notify::new()), explicit_release.clone(), explicit),
    );
    case.app.refresh_claude_delivery();
    release_read.notify_one();
    case.pump(|case| case.called("claude_delivery.status").len() > reads_before + 1);
    assert_eq!(
        case.app
            .with_state(|state| state.claude_delivery_error.clone())
            .as_deref(),
        Some(ERROR)
    );
    assert!(case.settings_labels().contains(&ERROR.to_string()));
    explicit_release.notify_one();
    case.pump(|case| {
        case.app.with_state(|state| {
            state.claude_delivery.as_ref().is_some_and(|status| {
                status.sessions[0].title == "Explicit approvals after read failure"
            })
        })
    });
    assert!(case
        .app
        .with_state(|state| state.claude_delivery_error.is_none()));
}
