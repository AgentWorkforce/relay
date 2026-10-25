use super::*;
use crate::relay::existing_session::Failure;
use crate::relay::peer::current_uid;
use crate::relay::process::{FakeProcess, FakeProcesses};
use crate::relay::spawn::launch::{RegistrySpawner, Spawner};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const SESSION: &str = "01a0fd4c-3771-7a20-9f41-6f86d56624f9";
const SPAWN_SESSION: &str = "5f7c1f64-8f53-4c33-9d2f-7c1d2f1f0a11";
/// No real process has it: a signal sent to it reaches nothing.
const LEADER: i32 = 999_999_999;
const LEADER_START: u64 = 77;

struct FixedAuthority(bool);

impl Authority for FixedAuthority {
    fn verify(&self, _: &Binding) -> bool {
        self.0
    }
}

/// Answers every prompt with a receipt, counting them.
#[derive(Default)]
struct CountingTransport(AtomicUsize);

impl AcpTransport for CountingTransport {
    fn prompt(&self, _: &Binding, _: &str, _: Duration) -> Outcome {
        self.0.fetch_add(1, Ordering::SeqCst);
        Outcome::Delivered {
            receipt_id: "grok-acp:server-1".into(),
        }
    }
}

/// A leader that is a listening socket and a row in a fake process table,
/// and a session that opens as told.
struct FakeLeaders {
    table: Arc<FakeProcesses>,
    outcome: Outcome,
    environments: Mutex<Vec<BTreeMap<String, String>>>,
    listeners: Mutex<Vec<UnixListener>>,
    accepted: Mutex<Option<bool>>,
}

impl FakeLeaders {
    fn new(table: Arc<FakeProcesses>, outcome: Outcome) -> FakeLeaders {
        FakeLeaders {
            table,
            outcome,
            environments: Mutex::default(),
            listeners: Mutex::default(),
            accepted: Mutex::default(),
        }
    }
}

impl Drop for FakeLeaders {
    /// Its sockets are in this user's shared runtime folder under `/tmp`.
    fn drop(&mut self) {
        for listener in self.listeners.lock().unwrap().drain(..) {
            if let Some(path) = listener
                .local_addr()
                .ok()
                .and_then(|address| address.as_pathname().map(Path::to_path_buf))
            {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

impl LeaderRuntime for FakeLeaders {
    fn start(&self, leader: &LeaderStart, scope: Option<(&Path, &str)>) -> Result<i32, String> {
        assert!(scope.is_none());
        // Where every spawned leader listens, under `/tmp`.
        assert!(leader
            .socket
            .starts_with(crate::relay::managed_sessions::private_short_runtime_dir().unwrap()));
        let listener = UnixListener::bind(leader.socket).map_err(|error| error.to_string())?;
        self.listeners.lock().unwrap().push(listener);
        self.table.insert(
            LEADER,
            FakeProcess {
                uid: current_uid(),
                start: LEADER_START,
                ..FakeProcess::default()
            },
        );
        self.environments
            .lock()
            .unwrap()
            .push(leader.environment.clone());
        Ok(LEADER)
    }

    fn open(
        &self,
        _: &SessionOpen,
        accept: &dyn Fn(&Opened) -> bool,
    ) -> Result<(Opened, Outcome), String> {
        let opened = Opened {
            session_id: SESSION.into(),
            model_id: "grok-4.7".into(),
            agent_version: "1.0.46".into(),
        };
        let accepted = accept(&opened);
        *self.accepted.lock().unwrap() = Some(accepted);
        if !accepted {
            return Err("its leader could not be verified".into());
        }
        Ok((opened, self.outcome.clone()))
    }
}

struct World {
    /// Under `/tmp`, so a leader socket's path fits.
    root: tempfile::TempDir,
    table: Arc<FakeProcesses>,
}

impl World {
    fn new() -> World {
        World {
            root: tempfile::tempdir_in("/tmp").unwrap(),
            table: Arc::new(FakeProcesses::default()),
        }
    }

    fn path(&self) -> &Path {
        self.root.path()
    }

    /// A Grok installed as Grok installs itself: `~/.grok/bin/grok` linking
    /// to the download of `version`.
    fn install(&self, version: &str) -> PathBuf {
        let downloads = self.path().join(".grok/downloads");
        let bin = self.path().join(".grok/bin");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(self.path().join(".grok/auth.json"), "{}").unwrap();
        let download = downloads.join(format!("grok-{version}-macos-aarch64"));
        std::fs::write(&download, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&download, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = bin.join("grok");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&download, &link).unwrap();
        link
    }

    fn adapter(&self, leaders: Arc<dyn LeaderRuntime>, verifies: bool) -> GrokAdapter {
        GrokAdapter {
            executable: find_executable(None, &self.path().join(".grok")),
            grok: GrokConfig {
                home: self.path().join(".grok"),
            },
            table: self.table.clone(),
            uid: current_uid(),
            environment: None,
            folder: self.path().join("app-data/spawned-agents/grok"),
            systemd_run: None,
            leaders,
            authority: Arc::new(FixedAuthority(verifies)),
            transport: Arc::new(CountingTransport::default()),
        }
    }

    fn project(&self) -> PathBuf {
        let project = self.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::canonicalize(project).unwrap()
    }
}

fn launch(directory: &Path, full_access: bool) -> Launch {
    Launch {
        harness: ID,
        name: "g1".into(),
        text: "fix the build".into(),
        directory: directory.to_path_buf(),
        full_access,
        message_id: "m1".into(),
        session_id: SPAWN_SESSION.into(),
    }
}

fn binding(world: &World) -> Binding {
    Binding {
        provider: Provider::Grok,
        transport: Transport::Acp,
        workspace_id: SPAWN_ROUTE.into(),
        session_id: SESSION.into(),
        endpoint_id: String::new(),
        owner_id: SPAWN_ROUTE.into(),
        credential_reference: format!("probe:grok:{}", "0".repeat(64)),
        owner_uid: current_uid(),
        auth_id: String::new(),
        protocol_id: String::new(),
        cwd: world.project(),
        model_id: "grok-4.7".into(),
        agent_version: "1.0.46".into(),
        executable: "/usr/local/bin/grok".into(),
        leader_pid: LEADER,
        leader_start: LEADER_START,
        socket_path: "/tmp/grok-leader.sock".into(),
        socket_device: 12,
        socket_inode: 34,
    }
}

/// A spawned session as the core records it.
fn recorded(world: &World, adapter: &GrokAdapter) -> SpawnedGrok {
    let record = SpawnedGrok {
        binding: binding(world),
        grok_home: world.path().join(".grok"),
    };
    record::private_folder(&adapter.folder).unwrap();
    record::write(&adapter.folder, &record).unwrap();
    record
}

fn watched(alive: bool) -> Watched {
    Watched {
        name: "g1".into(),
        target: Target::new(SessionKind::Grok, SESSION),
        process: Some(SpawnedProcess {
            pid: LEADER,
            start: LEADER_START,
        }),
        alive,
    }
}

#[test]
fn grok_is_offered_where_a_recent_enough_grok_is_installed() {
    let world = World::new();
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Retry(Failure::TimedOut),
    ));
    assert_eq!(world.adapter(leaders.clone(), true).detect(), Installed::No);
    let refused = world
        .adapter(leaders.clone(), true)
        .launch(&launch(&world.project(), true), &|_, _| {});
    assert!(
        matches!(refused, Err(LaunchError::Unavailable(reason)) if reason == "Grok is not installed on this computer")
    );

    world.install("1.0.24");
    let old = world.adapter(leaders.clone(), true);
    let reason = too_old((1, 0, 24));
    assert_eq!(old.detect(), Installed::Unusable(reason.clone()));
    assert_eq!(
        reason,
        "Grok here is version 1.0.24, older than 1.0.46, the first that spawned Grok agents run on. Update it with `grok update`, then try again."
    );
    let refused = old.launch(&launch(&world.project(), true), &|_, _| {});
    assert!(matches!(refused, Err(LaunchError::Unavailable(found)) if found == reason));

    world.install("1.0.46");
    assert_eq!(
        world.adapter(leaders.clone(), true).detect(),
        Installed::Yes
    );
    world.install("1.2.0");
    assert_eq!(world.adapter(leaders, true).detect(), Installed::Yes);
}

#[test]
fn the_version_is_read_from_the_file_grok_installed_never_by_running_it() {
    let world = World::new();
    let link = world.install("1.0.46");
    assert_eq!(version_of(&link), Some((1, 0, 46)));
    // A Grok installed some other way has no version in its name: offered,
    // and a launch says what went wrong.
    let plain = world.path().join("grok");
    std::fs::write(&plain, "").unwrap();
    assert_eq!(version_of(&plain), None);
    let odd = world.path().join("grok-1.0-linux");
    std::fs::write(&odd, "").unwrap();
    assert_eq!(version_of(&odd), None);
    assert_eq!(version_of(&world.path().join("missing")), None);
}

#[test]
fn grok_is_found_in_its_home_or_on_path() {
    let world = World::new();
    let home = world.path().join(".grok");
    assert_eq!(find_executable(Some("/nonexistent"), &home), None);
    let elsewhere = world.path().join("bin");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let on_path = elsewhere.join("grok");
    std::fs::write(&on_path, "").unwrap();
    // Not executable: not Grok.
    assert_eq!(
        find_executable(Some(&elsewhere.to_string_lossy()), &home),
        None
    );
    std::fs::set_permissions(&on_path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!("relative:{}", elsewhere.display());
    assert_eq!(find_executable(Some(&path), &home), Some(on_path));
    let installed = world.install("1.0.46");
    assert_eq!(find_executable(Some(&path), &home), Some(installed));
}

#[test]
fn it_owns_the_sessions_it_starts_only() {
    let world = World::new();
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Retry(Failure::TimedOut),
    ));
    let grok = world.adapter(leaders, true);
    assert!(grok.owns(&Target::new(SessionKind::Grok, SESSION)));
    assert!(!grok.owns(&Target::new(SessionKind::GrokOpen, SESSION)));
    assert!(!grok.owns(&Target::new(SessionKind::Codex, SESSION)));
}

#[test]
fn a_leader_stays_up_without_clients_updates_or_grok_com() {
    let arguments: Vec<String> = leader::leader_arguments(Path::new("/tmp/grok-x.sock"))
        .into_iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        arguments,
        [
            "agent",
            "leader",
            "--no-exit-on-disconnect",
            "--no-auto-update",
            "--relay-on-demand",
            "--leader-socket",
            "/tmp/grok-x.sock"
        ]
    );
    // Delivery's authority recognizes it as the leader of that socket.
    assert_eq!(
        crate::relay::existing_session::grok::leader_socket(&arguments, None),
        Some(PathBuf::from("/tmp/grok-x.sock"))
    );
}

#[test]
fn a_launch_starts_a_marked_leader_records_its_session_and_hands_over_the_task() {
    let world = World::new();
    world.install("1.0.46");
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Delivered {
            receipt_id: "grok-acp:p1".into(),
        },
    ));
    let grok = world.adapter(leaders.clone(), true);
    let reported = Mutex::new(Vec::new());
    let launched = grok
        .launch(&launch(&world.project(), true), &|target, process| {
            reported.lock().unwrap().push((target.clone(), process))
        })
        .unwrap();
    let leader = SpawnedProcess {
        pid: LEADER,
        start: LEADER_START,
    };
    assert_eq!(launched.target, Target::new(SessionKind::Grok, SESSION));
    assert_eq!(launched.process, Some(leader));
    assert_eq!(launched.task, TaskHandoff::Confirmed);
    // First under the spawn's own id, so a restart before the session
    // existed can end the leader; then under the session.
    assert_eq!(
        *reported.lock().unwrap(),
        [
            (Target::new(SessionKind::Grok, SPAWN_SESSION), Some(leader)),
            (Target::new(SessionKind::Grok, SESSION), Some(leader)),
        ]
    );
    let environment = leaders.environments.lock().unwrap()[0].clone();
    let marker = environment.get(MANAGED_MARKER).cloned().unwrap();
    assert_eq!(marker.len(), 64);
    assert!(!environment.contains_key("GROK_SANDBOX"));

    let record = record::read(&grok.folder, SESSION).unwrap();
    let binding = &record.binding;
    assert_eq!(binding.cwd, world.project());
    assert_eq!(
        binding.executable,
        std::fs::canonicalize(world.path().join(".grok/bin/grok")).unwrap()
    );
    assert_eq!(
        (binding.leader_pid, binding.leader_start),
        (LEADER, LEADER_START)
    );
    assert_eq!(binding.model_id, "grok-4.7");
    // The marker is proof only in the leader's environment, never on disk.
    assert_eq!(
        binding.credential_reference,
        credential_reference(binding, &marker)
    );
    let stored = std::fs::read_to_string(grok.folder.join(format!("{SESSION}.json"))).unwrap();
    assert!(!stored.contains(&marker));
    let mode = std::fs::metadata(&grok.folder)
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o077, 0);
    assert_eq!(record.grok_home, world.path().join(".grok"));
}

#[test]
fn full_access_off_starts_the_leader_in_groks_workspace_sandbox() {
    let world = World::new();
    world.install("1.0.46");
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::InDoubt(Failure::TimedOut),
    ));
    let launched = world
        .adapter(leaders.clone(), true)
        .launch(&launch(&world.project(), false), &|_, _| {})
        .unwrap();
    // The leader never showed the prompt in the session: handed over
    // without a receipt.
    assert_eq!(launched.task, TaskHandoff::Unconfirmed("in_doubt"));
    let environment = leaders.environments.lock().unwrap()[0].clone();
    assert_eq!(
        environment.get("GROK_SANDBOX").map(String::as_str),
        Some("workspace")
    );
}

#[test]
fn a_leader_that_cannot_be_proven_gets_no_task_and_is_ended() {
    let world = World::new();
    world.install("1.0.46");
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Delivered {
            receipt_id: "grok-acp:p1".into(),
        },
    ));
    let grok = world.adapter(leaders.clone(), false);
    let refused = grok.launch(&launch(&world.project(), true), &|_, _| {});
    assert!(
        matches!(&refused, Err(LaunchError::Unavailable(reason)) if reason.starts_with("Grok did not open a session")),
        "{refused:?}"
    );
    assert_eq!(*leaders.accepted.lock().unwrap(), Some(false));
    assert!(record::read(&grok.folder, SESSION).is_none());

    // A first task Grok refused leaves no record either.
    let refusing = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Refused(Failure::ProviderRefused),
    ));
    let grok = world.adapter(refusing, true);
    let refused = grok.launch(&launch(&world.project(), true), &|_, _| {});
    assert!(
        matches!(&refused, Err(LaunchError::Unavailable(reason)) if reason.starts_with("Grok refused the first task;"))
    );
    assert!(record::read(&grok.folder, SESSION).is_none());
}

/// Starts a leader that is gone by the time its pid comes back.
struct VanishingLeaders(FakeLeaders);

impl LeaderRuntime for VanishingLeaders {
    fn start(&self, leader: &LeaderStart, scope: Option<(&Path, &str)>) -> Result<i32, String> {
        let pid = self.0.start(leader, scope)?;
        self.0.table.remove(pid);
        Ok(pid)
    }

    fn open(
        &self,
        open: &SessionOpen,
        accept: &dyn Fn(&Opened) -> bool,
    ) -> Result<(Opened, Outcome), String> {
        self.0.open(open, accept)
    }
}

#[test]
fn a_leader_gone_before_it_is_seen_fails_the_launch_and_is_never_recorded() {
    let world = World::new();
    world.install("1.0.46");
    let leaders = Arc::new(VanishingLeaders(FakeLeaders::new(
        world.table.clone(),
        Outcome::Delivered {
            receipt_id: "grok-acp:p1".into(),
        },
    )));
    let grok = world.adapter(leaders.clone(), true);
    let recorded = Mutex::new(Vec::new());
    let failed = grok.launch(&launch(&world.project(), true), &|target, process| {
        recorded.lock().unwrap().push((target.clone(), process));
    });
    assert!(
        matches!(&failed, Err(LaunchError::Unavailable(reason)) if reason.starts_with("Grok's leader did not start")),
        "{failed:?}"
    );
    assert!(recorded.lock().unwrap().is_empty());
    assert_eq!(*leaders.0.accepted.lock().unwrap(), None);
}

#[test]
fn a_restart_finds_the_session_by_its_record_and_ends_a_half_started_leader() {
    let world = World::new();
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Retry(Failure::TimedOut),
    ));
    let grok = world.adapter(leaders, true);
    let leader = SpawnedProcess {
        pid: LEADER,
        start: LEADER_START,
    };
    let intent = |target: Option<&str>, process: Option<SpawnedProcess>| Intent {
        invocation_id: "inv-1".into(),
        name: "g1".into(),
        harness: ID,
        node_id: "node-1".into(),
        node_name: "mac-desktop".into(),
        title: "fix the build".into(),
        base_url: "https://relay.example".into(),
        workspace_key: crate::relay::workspace::Secret::new("rk_live_x"),
        workspace_id: None,
        machine_prefix: "mac".into(),
        message_id: "m1".into(),
        session_id: SPAWN_SESSION.into(),
        created_ms: 0,
        ended: false,
        launch_failed: false,
        register_sent: false,
        agent_id: Some("agent-1".into()),
        token: None,
        requester: None,
        target: target.map(|id| Target::new(SessionKind::Grok, id)),
        process,
    };
    assert_eq!(grok.find(&intent(None, None)), None);
    // Interrupted before its session existed.
    assert_eq!(grok.find(&intent(Some(SPAWN_SESSION), Some(leader))), None);
    // A session with no record is not one this core started.
    assert_eq!(grok.find(&intent(Some(SESSION), Some(leader))), None);
    recorded(&world, &grok);
    let found = Some((Target::new(SessionKind::Grok, SESSION), Some(leader)));
    assert_eq!(grok.find(&intent(Some(SESSION), Some(leader))), found);
    // The record names the leader when the intent did not keep it.
    assert_eq!(grok.find(&intent(Some(SESSION), None)), found);
}

#[test]
fn it_lives_while_its_own_leader_runs_and_stops_idempotently() {
    let world = World::new();
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Retry(Failure::TimedOut),
    ));
    let grok = world.adapter(leaders, true);
    let target = Target::new(SessionKind::Grok, SESSION);
    let leader = SpawnedProcess {
        pid: LEADER,
        start: LEADER_START,
    };
    assert!(!grok.alive(&target, Some(&leader)));
    assert!(!grok.alive(&target, None));
    world.table.insert(
        LEADER,
        FakeProcess {
            uid: current_uid(),
            start: LEADER_START,
            ..FakeProcess::default()
        },
    );
    assert!(grok.alive(&target, Some(&leader)));
    // No record and no process: nothing to look at.
    assert!(!grok.alive(&target, None));
    recorded(&world, &grok);
    assert!(grok.alive(&target, None));
    // Another process that took the pid is not the leader.
    let other = SpawnedProcess {
        pid: LEADER,
        start: 1,
    };
    assert!(!grok.alive(&target, Some(&other)));
    // Ended but not reaped.
    world.table.insert(
        LEADER,
        FakeProcess {
            uid: current_uid(),
            start: LEADER_START,
            zombie: true,
            ..FakeProcess::default()
        },
    );
    assert!(!grok.alive(&target, Some(&leader)));
    grok.stop(&target, Some(&leader));
    grok.stop(&target, Some(&leader));
    world.table.remove(LEADER);
    grok.stop(&target, None);
    assert!(!grok.alive(&target, None));
}

fn write_events(record: &SpawnedGrok, lines: &str) {
    let events = record.events();
    std::fs::create_dir_all(events.parent().unwrap()).unwrap();
    std::fs::write(events, lines).unwrap();
}

#[test]
fn it_is_observed_from_its_leader_and_the_sessions_turn_events() {
    let world = World::new();
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Retry(Failure::TimedOut),
    ));
    let grok = world.adapter(leaders, true);
    let seen = |alive: bool| {
        let observed = grok.observe(&[watched(alive)]);
        (
            observed[0].process,
            observed[0].work,
            observed[0].turn_in_progress,
        )
    };
    // Not one this core recorded: nothing to say.
    assert_eq!(
        seen(true),
        (ProcessLiveness::Unknown, WorkState::Unknown, false)
    );
    let record = recorded(&world, &grok);
    // Recorded, no turn yet.
    assert_eq!(
        seen(true),
        (ProcessLiveness::Running, WorkState::Unknown, false)
    );
    write_events(
        &record,
        "{\"type\":\"turn_started\",\"yolo_mode\":true}\n{\"type\":\"phase_changed\",\"phase\":\"tool_execution\"}\n",
    );
    assert_eq!(
        seen(true),
        (ProcessLiveness::Running, WorkState::Working, true)
    );
    // A missing lookup is inconclusive, so it cannot reclaim the slot.
    assert_eq!(seen(false), (ProcessLiveness::Unknown, WorkState::Unknown, false));
    world.table.insert(LEADER, FakeProcess { start: LEADER_START, zombie: true, ..FakeProcess::default() });
    // A confirmed zombie ended with a turn running: what it left is unknown.
    assert_eq!(
        seen(false),
        (ProcessLiveness::Exited, WorkState::Unknown, true)
    );
    write_events(
        &record,
        "{\"type\":\"turn_started\"}\n{\"type\":\"permission_requested\"}\n",
    );
    assert_eq!(
        seen(true),
        (ProcessLiveness::Running, WorkState::Waiting, false)
    );
    write_events(
        &record,
        "{\"type\":\"turn_started\"}\n{\"type\":\"turn_ended\",\"outcome\":\"completed\"}\n{\"type\":\"mcp_server_connected\"}\n",
    );
    assert_eq!(
        seen(true),
        (ProcessLiveness::Running, WorkState::Idle, false)
    );
    assert_eq!(
        seen(false),
        (ProcessLiveness::Exited, WorkState::Completed, false)
    );
    // Reuse of the PID also proves that the recorded leader ended.
    world.table.insert(LEADER, FakeProcess { start: LEADER_START + 1, ..FakeProcess::default() });
    assert_eq!(seen(false), (ProcessLiveness::Exited, WorkState::Completed, false));
}

#[test]
fn the_last_turn_event_decides_the_work_state() {
    assert_eq!(record::work_state(b""), None);
    assert_eq!(
        record::work_state(b"{\"type\":\"mcp_init_completed\"}\nnot json\n"),
        None
    );
    assert_eq!(
        record::work_state(b"{\"type\":\"turn_ended\"}\n{\"type\":\"turn_started\"}"),
        Some(WorkState::Working)
    );
    assert_eq!(
        record::work_state(b"{\"type\":\"phase_changed\",\"phase\":\"permission_prompt\"}\n"),
        Some(WorkState::Waiting)
    );
    assert_eq!(
        record::work_state(
            b"{\"type\":\"permission_requested\"}\n{\"type\":\"permission_resolved\"}\n"
        ),
        Some(WorkState::Working)
    );
    assert_eq!(
        record::work_state(
            b"{\"type\":\"turn_started\"}\n{\"type\":\"turn_ended\",\"outcome\":\"cancelled\"}\n"
        ),
        Some(WorkState::Idle)
    );
}

#[test]
fn a_record_names_only_a_session_and_reads_back_whole() {
    let world = World::new();
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Retry(Failure::TimedOut),
    ));
    let grok = world.adapter(leaders, true);
    let record = recorded(&world, &grok);
    assert_eq!(record::read(&grok.folder, SESSION), Some(record.clone()));
    assert_eq!(record::read(&grok.folder, "../../etc/passwd"), None);
    let mode = std::fs::metadata(grok.folder.join(format!("{SESSION}.json")))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    // A record under another session's name is not that session's.
    std::fs::copy(
        grok.folder.join(format!("{SESSION}.json")),
        grok.folder.join(format!("{SPAWN_SESSION}.json")),
    )
    .unwrap();
    assert_eq!(record::read(&grok.folder, SPAWN_SESSION), None);
    record::remove(&grok.folder, SESSION);
    assert_eq!(record::read(&grok.folder, SESSION), None);
    assert_eq!(
        record.events(),
        world.path().join(".grok/sessions").join(format!(
            "{}/{SESSION}/events.jsonl",
            world.project().to_string_lossy().replace('/', "%2F")
        ))
    );
}

#[test]
fn a_later_message_goes_through_the_proven_leader_once() {
    let world = World::new();
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Retry(Failure::TimedOut),
    ));
    let transport = Arc::new(CountingTransport::default());
    let mut grok = world.adapter(leaders, true);
    grok.transport = transport.clone();
    let target = Target::new(SessionKind::Grok, SESSION);
    let message = Message {
        delivery_id: "d-1",
        message_id: "m-1",
        text: "and the tests",
        native: false,
    };
    assert_eq!(
        grok.deliver(&target, &message),
        Some(InjectOutcome::Refused(
            "No spawned Grok leader is recorded for this agent.".into()
        ))
    );
    recorded(&world, &grok);
    assert_eq!(
        grok.deliver(&target, &message),
        Some(InjectOutcome::Delivered)
    );
    // The journal replays the receipt: never sent twice.
    assert_eq!(
        grok.deliver(&target, &message),
        Some(InjectOutcome::Delivered)
    );
    assert_eq!(transport.0.load(Ordering::SeqCst), 1);
    // A leader that no longer proves gets nothing.
    let mut unproven = world.adapter(
        Arc::new(FakeLeaders::new(
            world.table.clone(),
            Outcome::Retry(Failure::TimedOut),
        )),
        false,
    );
    unproven.transport = transport.clone();
    let other = Message {
        delivery_id: "d-2",
        message_id: "m-2",
        ..message
    };
    assert_eq!(
        unproven.deliver(&target, &other),
        Some(InjectOutcome::Refused(
            "The spawned Grok leader was refused.".into()
        ))
    );
    assert_eq!(transport.0.load(Ordering::SeqCst), 1);
}

/// Records what it is asked to inject.
#[derive(Default)]
struct RecordingInjector(Mutex<Vec<Target>>);

impl crate::relay::inject::Injector for RecordingInjector {
    fn inject(&self, target: &Target, _: &str, _: &str) -> InjectOutcome {
        self.0.lock().unwrap().push(target.clone());
        InjectOutcome::Waiting("not this route".into())
    }

    fn reply_hint(&self, _: &Target, _: Option<&str>, _: Option<&str>, _: &str) -> Option<String> {
        None
    }

    fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
        None
    }
}

#[test]
fn only_a_spawned_grok_takes_messages_through_its_leader() {
    let world = World::new();
    let leaders = Arc::new(FakeLeaders::new(
        world.table.clone(),
        Outcome::Retry(Failure::TimedOut),
    ));
    let grok = Arc::new(world.adapter(leaders, true));
    recorded(&world, &grok);
    let adapters: Vec<Arc<dyn HarnessAdapter>> = vec![grok];
    let spawner = RegistrySpawner(crate::relay::harness::Registry::new(adapters));
    let injector = RecordingInjector::default();
    let intent = Intent {
        invocation_id: "inv-1".into(),
        name: "g1".into(),
        harness: ID,
        node_id: "node-1".into(),
        node_name: "mac-desktop".into(),
        title: "fix the build".into(),
        base_url: "https://relay.example".into(),
        workspace_key: crate::relay::workspace::Secret::new("rk_live_x"),
        workspace_id: None,
        machine_prefix: "mac".into(),
        message_id: "m1".into(),
        session_id: SPAWN_SESSION.into(),
        created_ms: 0,
        ended: false,
        launch_failed: false,
        register_sent: false,
        agent_id: Some("agent-1".into()),
        token: None,
        requester: None,
        target: None,
        process: None,
    };
    let target = Target::new(SessionKind::Grok, SESSION);
    let spawned = intent.registration("agent-1", target.clone(), None, ("node-1", "mac-desktop"));
    assert_eq!(
        spawner.deliver_registered(&injector, &spawned, &crate::relay::inject::DeliveryRoute { delivery_id: "d-1", message_id: "m-1", ..Default::default() }, "hi"),
        InjectOutcome::Delivered
    );
    assert!(injector.0.lock().unwrap().is_empty());
    // The same session registered some other way keeps its own route.
    let registered = crate::relay::store::Registration {
        spawn: None,
        ..spawned
    };
    assert_eq!(
        spawner.deliver_registered(&injector, &registered, &crate::relay::inject::DeliveryRoute { delivery_id: "d-2", message_id: "m-2", ..Default::default() }, "hi"),
        InjectOutcome::Waiting("not this route".into())
    );
    assert_eq!(*injector.0.lock().unwrap(), [target]);
}

/// A stand-in `grok` that speaks the ACP a spawn's session is opened with:
/// initialize, `session/new`, and one prompt it takes into its queue and
/// session. What it is sent is kept beside it.
fn fake_acp_grok(folder: &Path) -> PathBuf {
    let executable = folder.join("grok");
    let script = format!(
        r#"#!/bin/sh
id() {{ printf '%s' "$1" | sed -E 's/.*"id":"([^"]+)".*/\1/'; }}
printf '%s\n' "$@" > "$0.arguments"
read -r initialize || exit 0
printf '{{"jsonrpc":"2.0","id":"%s","result":{{"protocolVersion":1,"_meta":{{"modelState":{{"currentModelId":"grok-4.7"}},"agentVersion":"1.0.46"}}}}}}\n' "$(id "$initialize")"
read -r new || exit 0
printf '%s\n' "$new" > "$0.new"
printf '{{"jsonrpc":"2.0","id":"%s","result":{{"sessionId":"{SESSION}"}}}}\n' "$(id "$new")"
read -r prompt || exit 0
printf '%s\n' "$prompt" > "$0.prompt"
printf '{{"jsonrpc":"2.0","method":"_x.ai/queue/changed","params":{{"sessionId":"{SESSION}","runningPromptId":"server-1","runningText":"fix the build"}}}}\n'
printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"{SESSION}","update":{{"sessionUpdate":"user_message_chunk","content":{{"type":"text","text":"fix the build"}}}}}}}}\n'
sleep 5
"#
    );
    std::fs::write(&executable, script).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    executable
}

#[test]
fn a_session_is_opened_always_approving_with_the_persons_mcp_and_given_its_task() {
    let world = World::new();
    let executable = fake_acp_grok(world.path());
    let project = world.project();
    let socket = world.path().join("leader.sock");
    let open = SessionOpen {
        executable: &executable,
        socket: &socket,
        directory: &project,
        text: "fix the build",
        timeout: Duration::from_secs(10),
    };
    let asked = Mutex::new(None);
    let (opened, outcome) = SystemLeaders
        .open(&open, &|opened| {
            *asked.lock().unwrap() = Some(opened.clone());
            true
        })
        .unwrap();
    assert_eq!(
        opened,
        Opened {
            session_id: SESSION.into(),
            model_id: "grok-4.7".into(),
            agent_version: "1.0.46".into(),
        }
    );
    assert_eq!(*asked.lock().unwrap(), Some(opened));
    assert_eq!(
        outcome,
        Outcome::Delivered {
            receipt_id: "grok-acp:server-1".into()
        }
    );
    let arguments = std::fs::read_to_string(world.path().join("grok.arguments")).unwrap();
    assert_eq!(
        arguments.lines().collect::<Vec<_>>(),
        [
            "agent",
            "--always-approve",
            "--leader",
            "--leader-socket",
            socket.to_string_lossy().as_ref(),
            "stdio"
        ]
    );
    let new: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(world.path().join("grok.new")).unwrap())
            .unwrap();
    assert_eq!(new["method"], "session/new");
    assert_eq!(new["params"]["cwd"], project.to_string_lossy().as_ref());
    assert_eq!(new["params"]["mcpServers"], serde_json::json!([]));
    assert_eq!(new["params"]["_meta"]["yoloMode"], true);
    let prompt: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(world.path().join("grok.prompt")).unwrap())
            .unwrap();
    assert_eq!(prompt["params"]["sessionId"], SESSION);
    assert_eq!(prompt["params"]["prompt"][0]["text"], "fix the build");
}

#[test]
fn a_session_the_core_does_not_accept_is_given_nothing() {
    let world = World::new();
    let executable = fake_acp_grok(world.path());
    let project = world.project();
    let socket = world.path().join("leader.sock");
    let open = SessionOpen {
        executable: &executable,
        socket: &socket,
        directory: &project,
        text: "fix the build",
        timeout: Duration::from_secs(10),
    };
    let refused = SystemLeaders.open(&open, &|_| false);
    assert_eq!(refused, Err("its leader could not be verified".into()));
    assert!(!world.path().join("grok.prompt").exists());
}

#[test]
fn a_started_leader_runs_detached_with_its_arguments_and_environment() {
    let world = World::new();
    let executable = world.path().join("grok");
    let seen = world.path().join("seen");
    std::fs::write(
        &executable,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" \"$GROK_SANDBOX\" > '{}'\nexec sleep 30\n",
            seen.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut environment = BTreeMap::new();
    environment.insert("PATH".to_string(), "/usr/bin:/bin".to_string());
    environment.insert("GROK_SANDBOX".to_string(), "workspace".to_string());
    let project = world.project();
    let socket = world.path().join("leader.sock");
    let log = world.path().join("leader.log");
    let leader = LeaderStart {
        executable: &executable,
        socket: &socket,
        directory: &project,
        environment: &environment,
        log: &log,
    };
    let pid = SystemLeaders.start(&leader, None).unwrap();
    assert!(pid > 1);
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::fs::read_to_string(&seen)
        .unwrap_or_default()
        .lines()
        .count()
        < 8
    {
        assert!(Instant::now() < deadline, "the leader never ran");
        std::thread::sleep(Duration::from_millis(50));
    }
    // The launcher has exited; the leader runs on.
    crate::relay::uploader::signal(pid as u32, libc::SIGTERM);
    let seen = std::fs::read_to_string(&seen).unwrap();
    let mut expected: Vec<String> = leader::leader_arguments(&socket)
        .into_iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    expected.push("workspace".into());
    assert_eq!(seen.lines().collect::<Vec<_>>(), expected);
}

#[test]
fn an_expired_request_never_reaches_the_leader() {
    let world = World::new();
    let executable = fake_acp_grok(world.path());
    let project = world.project();
    let mut client = crate::relay::existing_session::grok::LeaderClient::start(
        &executable,
        &world.path().join("leader.sock"),
        &project,
    )
    .unwrap();
    assert_eq!(
        client.request(
            "session/new",
            serde_json::json!({}),
            Instant::now() - Duration::from_secs(1)
        ),
        None
    );
    // If the expired request was written, this fake consumes it as the first
    // request and this initialize receives the wrong phase's response.
    let initialized = client.initialize(Instant::now() + Duration::from_secs(2));
    assert!(initialized
        .and_then(Result::ok)
        .is_some_and(|value| value["protocolVersion"] == 1));
}

#[test]
fn an_expired_prompt_is_not_sent_or_marked_in_doubt() {
    let world = World::new();
    let executable = fake_acp_grok(world.path());
    let project = world.project();
    let mut client = crate::relay::existing_session::grok::LeaderClient::start(
        &executable,
        &world.path().join("leader.sock"),
        &project,
    )
    .unwrap();
    assert_eq!(
        client.prompt(
            SESSION,
            "grok-4.7",
            "fix the build",
            Instant::now() - Duration::from_secs(1)
        ),
        Outcome::Retry(Failure::TimedOut)
    );
}

#[test]
fn recording_the_session_does_not_use_the_first_prompt_budget() {
    let world = World::new();
    let executable = fake_acp_grok(world.path());
    let project = world.project();
    let socket = world.path().join("leader.sock");
    let open = SessionOpen {
        executable: &executable,
        socket: &socket,
        directory: &project,
        text: "fix the build",
        timeout: Duration::from_secs(5),
    };
    let (_, outcome) = SystemLeaders
        .open(&open, &|_| {
            std::thread::sleep(Duration::from_millis(5100));
            true
        })
        .unwrap();
    assert!(matches!(outcome, Outcome::Delivered { .. }));
}

#[test]
fn a_failed_leader_leaves_its_real_exit_status_and_stderr() {
    let world = World::new();
    let executable = world.path().join("fake-grok");
    std::fs::write(&executable, "#!/bin/sh\necho credentials-rejected >&2\nexit 42\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let project = world.project();
    let socket = world.path().join("unused.sock");
    let log = world.path().join("failed.log");
    let environment = BTreeMap::new();
    SystemLeaders.start(&LeaderStart {
        executable: &executable, socket: &socket, directory: &project,
        environment: &environment, log: &log,
    }, None).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !log.with_extension("exit").exists() {
        assert!(Instant::now() < deadline, "leader exit evidence was lost");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(std::fs::read_to_string(log.with_extension("exit")).unwrap().trim(), "42");
    assert!(std::fs::read_to_string(log).unwrap().contains("credentials-rejected"));
}
