use super::*;
use crate::relay::managed_sessions::{ManagedLaunch, ManagedRuntime};
use crate::relay::opencode_existing::{Binding, Failure, HttpResponse, HttpTransport};
use crate::relay::opencode_serve::Served;
use crate::relay::process::{FakeProcess, FakeProcesses};
use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Mutex;

const SESSION: &str = "ses_spawned01";
const SPAWN: &str = "5f7c1f64-8f53-4c33-9d2f-7c1d2f1f0a11";

/// The registry's proof of a binding, as the test says.
struct Runtime(Mutex<bool>);

impl ManagedRuntime for Runtime {
    fn launch(&self, _: &ManagedLaunch, _: &Path) -> Result<ManagedBinding, ()> {
        Err(())
    }

    fn verify(&self, _: &ManagedBinding) -> bool {
        *self.0.lock().unwrap()
    }
}

/// OpenCode's server, as the test sets it up; it records what it is asked.
struct FakeServer {
    binding: Binding,
    starts: Mutex<Vec<ServerStart>>,
    prompts: Mutex<Vec<(String, String)>>,
    fails: Option<String>,
    /// How many prompts find the session not ready before `outcome`.
    waiting: Mutex<usize>,
    outcome: Outcome,
    status: Option<String>,
    startup: Result<bool, String>,
}

impl OpenCodeServer for FakeServer {
    fn start(&self, start: &ServerStart) -> Result<Binding, String> {
        self.starts.lock().unwrap().push(start.clone());
        match &self.fails {
            Some(reason) => Err(reason.clone()),
            None => Ok(self.binding.clone()),
        }
    }

    fn prompt(&self, binding: &Binding, message_id: &str, text: &str) -> Outcome {
        assert_eq!(binding, &self.binding);
        self.prompts
            .lock()
            .unwrap()
            .push((message_id.into(), text.into()));
        let mut waiting = self.waiting.lock().unwrap();
        if *waiting > 0 {
            *waiting -= 1;
            return Outcome::Waiting(Failure::SessionBusy);
        }
        self.outcome.clone()
    }

    fn startup(&self, _binding: &Binding) -> Result<bool, String> { self.startup.clone() }

    fn status(&self, binding: &Binding) -> Option<String> {
        assert_eq!(binding, &self.binding);
        self.status.clone()
    }
}

struct Fixture {
    home: tempfile::TempDir,
    server: Arc<FakeServer>,
    runtime: Arc<Runtime>,
    adapter: OpenCodeAdapter,
}

fn binding(pid: i32, start: u64, directory: &Path) -> Binding {
    Binding {
        relay_workspace_id: SPAWN_AUTHORITY.into(),
        owner_id: SPAWN.into(),
        session_id: SESSION.into(),
        endpoint: "http://127.0.0.1:4096".into(),
        server_pid: pid,
        server_start: start,
        server_uid: 501,
        executable: PathBuf::from("/opt/opencode/bin/opencode"),
        directory: directory.to_path_buf(),
        project_id: "prj_1".into(),
        opencode_workspace_id: None,
        credential_reference: format!("probe:opencode:{}", "0".repeat(64)),
    }
}

fn fixture(server: impl FnOnce(&mut FakeServer)) -> Fixture {
    let home = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let mut fake = FakeServer {
        binding: binding(4242, 9, home.path()),
        starts: Mutex::default(),
        prompts: Mutex::default(),
        fails: None,
        waiting: Mutex::new(0),
        outcome: Outcome::Completed {
            receipt_id: "opencode:msg_relay_1".into(),
        },
        status: Some("idle".into()),
        startup: Ok(true),
    };
    server(&mut fake);
    let server = Arc::new(fake);
    let runtime = Arc::new(Runtime(Mutex::new(true)));
    let adapter = OpenCodeAdapter {
        executable: Some(PathBuf::from("/opt/opencode/bin/opencode")),
        version: Arc::new(|_: &Path| Some("1.18.30".to_string())),
        versions: VersionCache::default(),
        server: server.clone(),
        managed: Arc::new(ManagedSessions::new(
            home.path().join("managed"),
            HashSet::new(),
            runtime.clone(),
        )),
        table,
        opencode: OpenCodeConfig::from_env(&|_| None, home.path()),
        logs: home.path().join("spawned-agents"),
        first_message_wait: std::time::Duration::from_secs(5),
    };
    Fixture {
        home,
        server,
        runtime,
        adapter,
    }
}

fn launch(directory: &Path, full_access: bool) -> Launch {
    Launch {
        harness: ID,
        name: "o1".into(),
        text: "[via Agent Relay]\n\nFix CI".into(),
        directory: directory.to_path_buf(),
        full_access,
        message_id: "spawn-inv_o1".into(),
        session_id: SPAWN.into(),
    }
}

/// A real process standing in for OpenCode's server, so a stop has
/// something of this test's own to end.
fn server_process(table: &FakeProcesses, start: u64) -> std::process::Child {
    let child = std::process::Command::new("/bin/sleep")
        .arg("30")
        .spawn()
        .unwrap();
    table.insert(
        child.id() as i32,
        FakeProcess {
            start,
            ..FakeProcess::default()
        },
    );
    child
}

fn ended(child: &mut std::process::Child) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _ = child.kill();
    false
}

fn target() -> Target {
    Target::new(SessionKind::OpenCode, SESSION)
}

#[test]
fn opencode_is_offered_for_a_version_whose_server_agent_relay_drives() {
    let mut f = fixture(|_| {});
    assert_eq!(f.adapter.detect(), Installed::Yes);
    for (version, refusal) in [
        (Some("0.15.31"), "is too old to spawn"),
        (Some("2.0.10"), "cannot be spawned yet"),
        (
            Some("unexpected wrapper output"),
            "did not report its version",
        ),
        (None, "did not report its version"),
    ] {
        f.adapter.versions = VersionCache::default();
        f.adapter.version = Arc::new(move |_: &Path| version.map(String::from));
        let Installed::Unusable(reason) = f.adapter.detect() else {
            panic!("{version:?} is not offered");
        };
        assert!(reason.contains(refusal), "{reason}");
        let refused = f.adapter.launch(&launch(f.home.path(), true), &|_, _| {
            panic!("nothing starts")
        });
        assert_eq!(refused, Err(LaunchError::Unavailable(reason)));
    }
    f.adapter.executable = None;
    assert_eq!(f.adapter.detect(), Installed::No);
    let refused = f.adapter.launch(&launch(f.home.path(), true), &|_, _| {});
    assert!(matches!(refused, Err(LaunchError::Unavailable(_))));
    assert!(f.server.starts.lock().unwrap().is_empty());
}

#[test]
fn versions_are_read_as_opencode_prints_them() {
    assert_eq!(parse_version("1.18.30\n"), Some((1, 18, 30)));
    assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
    assert_eq!(parse_version("opencode 1.2.3-beta.1"), Some((1, 2, 3)));
    assert_eq!(parse_version("update available\n1.4.0"), Some((1, 4, 0)));
    assert_eq!(parse_version("1.2"), None);
    assert_eq!(parse_version("1.2.3.4"), None);
    assert_eq!(parse_version("Error: opencode-ai's postinstall"), None);
    assert_eq!(supported(Some("1.0.0")), Ok(()));
    assert_eq!(supported(None), Err(OPENCODE_NO_VERSION.to_string()));
}

#[test]
fn the_version_is_asked_once_per_installed_file() {
    let folder = tempfile::tempdir().unwrap();
    let executable = folder.path().join("opencode");
    std::fs::write(&executable, "one").unwrap();
    let asked = Mutex::new(0);
    let probe = |_: &Path| {
        *asked.lock().unwrap() += 1;
        Some("1.0.0".to_string())
    };
    let cache = VersionCache::default();
    assert_eq!(cache.get(&executable, &probe).as_deref(), Some("1.0.0"));
    assert_eq!(cache.get(&executable, &probe).as_deref(), Some("1.0.0"));
    assert_eq!(*asked.lock().unwrap(), 1);
    // An update replaces the file.
    std::fs::write(&executable, "a newer one").unwrap();
    cache.get(&executable, &probe);
    assert_eq!(*asked.lock().unwrap(), 2);
}

#[test]
fn the_executable_is_found_where_opencode_installs_it() {
    let home = tempfile::tempdir().unwrap();
    let make = |path: &Path, mode: u32| {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    };
    let on_path = home.path().join("bin/opencode");
    make(&on_path, 0o755);
    let path = home.path().join("bin").display().to_string();
    let env = |key: &str| (key == "PATH").then(|| path.clone());
    assert_eq!(
        find_executable(&env, home.path(), &[]),
        Some(on_path.clone())
    );
    let installer = home.path().join(".opencode/bin/opencode");
    make(&installer, 0o644);
    assert_eq!(
        find_executable(&env, home.path(), &[]),
        Some(on_path),
        "not executable"
    );
    make(&installer, 0o755);
    assert_eq!(find_executable(&env, home.path(), &[]), Some(installer));
    let chosen = home.path().join("custom/opencode");
    make(&chosen, 0o755);
    let chosen_text = chosen.display().to_string();
    let env = |key: &str| (key == "RELAY_DESKTOP_OPENCODE").then(|| chosen_text.clone());
    assert_eq!(find_executable(&env, home.path(), &[]), Some(chosen));
    let env = |key: &str| (key == "RELAY_DESKTOP_OPENCODE").then(|| "/nowhere/opencode".into());
    assert_eq!(find_executable(&env, home.path(), &[]), None);
    assert_eq!(find_executable(&|_| None, Path::new("/nowhere"), &[]), None);
}

#[test]
fn spawned_sessions_never_ask_and_off_keeps_them_to_reading_and_editing() {
    let actions = |rules: &Value| -> Vec<(String, String, String)> {
        rules
            .as_array()
            .unwrap()
            .iter()
            .map(|rule| {
                let field = |key: &str| rule[key].as_str().unwrap().to_string();
                (field("permission"), field("pattern"), field("action"))
            })
            .collect()
    };
    let full = actions(&permission_rules(true));
    assert_eq!(full[0], ("*".into(), "*".into(), "allow".into()));
    let confined = actions(&permission_rules(false));
    assert_eq!(confined[0], ("*".into(), "*".into(), "deny".into()));
    for rules in [&full, &confined] {
        assert!(rules.iter().all(|rule| rule.2 != "ask"));
        assert_eq!(
            rules.last().unwrap(),
            &("question".into(), "*".into(), "deny".into())
        );
    }
    let allowed = |permission: &str| {
        confined
            .iter()
            .any(|rule| rule.0 == permission && rule.1 == "*" && rule.2 == "allow")
    };
    assert!(allowed("edit") && allowed("read") && allowed("grep"));
    assert!(!allowed("bash") && !allowed("webfetch") && !allowed("external_directory"));
    assert!(confined.contains(&("read".into(), "*.env".into(), "deny".into())));
}

#[test]
fn it_owns_the_sessions_it_starts_only() {
    let f = fixture(|_| {});
    assert!(f.adapter.owns(&target()));
    assert!(!f
        .adapter
        .owns(&Target::new(SessionKind::OpenCodeOpen, SESSION)));
    assert!(!f.adapter.owns(&Target::new(SessionKind::Codex, SPAWN)));
}

#[test]
fn a_launch_seals_its_session_for_delivery_and_hands_over_the_task() {
    let f = fixture(|_| {});
    let seen = Mutex::new(Vec::new());
    let launched = f
        .adapter
        .launch(&launch(f.home.path(), true), &|target, process| {
            seen.lock().unwrap().push((target.clone(), process));
        })
        .unwrap();
    let process = SpawnedProcess {
        pid: 4242,
        start: 9,
    };
    assert_eq!(
        launched,
        Launched {
            target: target(),
            process: Some(process),
            task: TaskHandoff::Confirmed,
        }
    );
    assert_eq!(*seen.lock().unwrap(), [(target(), Some(process))]);
    let starts = f.server.starts.lock().unwrap();
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0].spawn_id, SPAWN);
    assert_eq!(starts[0].title, "@o1");
    assert_eq!(starts[0].rules, permission_rules(true));
    assert_eq!(starts[0].directory, f.home.path().canonicalize().unwrap());
    assert_eq!(
        *f.server.prompts.lock().unwrap(),
        [(
            "spawn-inv_o1".to_string(),
            "[via Agent Relay]\n\nFix CI".to_string()
        )]
    );
    // Later messages take the managed route, with its flag off.
    assert_eq!(
        f.adapter.managed.binding(&target()),
        Some(ManagedBinding::OpenCode(f.server.binding.clone()))
    );
    assert!(f.adapter.managed.sessions().is_empty());
    let confined = fixture(|_| {});
    confined
        .adapter
        .launch(&launch(confined.home.path(), false), &|_, _| {})
        .unwrap();
    assert_eq!(
        confined.server.starts.lock().unwrap()[0].rules,
        permission_rules(false)
    );
}

#[test]
fn a_first_message_in_doubt_is_unconfirmed_and_a_refused_one_ends_the_agent() {
    let f = fixture(|server| server.outcome = Outcome::InDoubt(Failure::TimedOut));
    let launched = f
        .adapter
        .launch(&launch(f.home.path(), true), &|_, _| {})
        .unwrap();
    assert_eq!(launched.task, TaskHandoff::Unconfirmed("in_doubt"));

    let table = Arc::new(FakeProcesses::default());
    let mut child = server_process(&table, 11);
    let pid = child.id() as i32;
    let mut f = fixture(|server| {
        server.binding = binding(pid, 11, Path::new("/w"));
        server.outcome = Outcome::Refused(Failure::SessionMismatch);
    });
    f.adapter.table = table.clone();
    let refused = f.adapter.launch(&launch(f.home.path(), true), &|_, _| {});
    assert!(
        matches!(&refused, Err(LaunchError::Failed(reason)) if reason.contains("first message")),
        "{refused:?}"
    );
    assert!(ended(&mut child), "its server was signalled");
    // Still listed: its route stays until the spawn confirms it gone.
    assert!(f.adapter.managed.binding(&target()).is_some());
    table.remove(pid);
    let process = SpawnedProcess { pid, start: 11 };
    assert_eq!(f.adapter.release(&target(), Some(&process)), Ok(()));
    assert_eq!(f.adapter.managed.binding(&target()), None, "and forgotten");
}

#[test]
fn a_server_that_outlives_its_release_keeps_its_delivery_route() {
    let table = Arc::new(FakeProcesses::default());
    let mut child = server_process(&table, 16);
    let pid = child.id() as i32;
    let mut f = fixture(|_| {});
    f.adapter.table = table.clone();
    let process = SpawnedProcess { pid, start: 16 };
    let sealed = ManagedBinding::OpenCode(binding(pid, 16, f.home.path()));
    f.adapter.managed.adopt(sealed.clone()).unwrap();
    // It ignores the signal: still listed after the release's wait.
    let refused = f.adapter.release(&target(), Some(&process));
    assert!(refused.unwrap_err().contains("still running"));
    assert!(ended(&mut child), "it was signalled");
    assert_eq!(f.adapter.managed.binding(&target()), Some(sealed));
    // Once it is gone, asking again releases it and forgets the binding.
    table.remove(pid);
    assert_eq!(f.adapter.release(&target(), Some(&process)), Ok(()));
    assert_eq!(f.adapter.managed.binding(&target()), None);
}

#[test]
fn a_first_message_waits_for_a_session_not_ready_yet() {
    let f = fixture(|server| *server.waiting.get_mut().unwrap() = 2);
    let launched = f
        .adapter
        .launch(&launch(f.home.path(), true), &|_, _| {})
        .unwrap();
    assert_eq!(launched.task, TaskHandoff::Confirmed);
    assert_eq!(f.server.prompts.lock().unwrap().len(), 3);

    let table = Arc::new(FakeProcesses::default());
    let mut child = server_process(&table, 16);
    let pid = child.id() as i32;
    let mut f = fixture(|server| {
        server.binding = binding(pid, 16, Path::new("/w"));
        *server.waiting.get_mut().unwrap() = usize::MAX;
    });
    f.adapter.table = table;
    f.adapter.first_message_wait = std::time::Duration::from_millis(600);
    let refused = f.adapter.launch(&launch(f.home.path(), true), &|_, _| {});
    assert!(
        matches!(&refused, Err(LaunchError::Failed(reason)) if reason.contains("SessionBusy")),
        "{refused:?}"
    );
    assert!(f.server.prompts.lock().unwrap().len() >= 2, "asked again");
    assert!(ended(&mut child), "a session never ready is ended");
}

type Answer = dyn Fn(&str, &str) -> Option<HttpResponse> + Send + Sync;

/// HTTP as the test answers it; it records what it is asked.
struct FakeHttp {
    answer: Box<Answer>,
    asked: Mutex<Vec<(String, String)>>,
}

impl HttpTransport for FakeHttp {
    fn request(
        &self,
        method: &str,
        url: &str,
        _: &str,
        _: &Path,
        _: Option<&[u8]>,
        _: std::time::Duration,
    ) -> Option<HttpResponse> {
        self.asked.lock().unwrap().push((method.into(), url.into()));
        (self.answer)(method, url)
    }
}

impl FakeHttp {
    fn posts(&self) -> usize {
        let asked = self.asked.lock().unwrap();
        asked.iter().filter(|(method, _)| method == "POST").count()
    }
}

/// An `opencode serve` the kernel would prove: this user's, the trusted
/// executable, its listener, marker and password.
fn provable_server(table: &FakeProcesses, folder: &Path, start: u64) -> (Served, ServerStart) {
    use crate::relay::opencode_serve::MARKER;
    let executable = folder.join("opencode");
    std::fs::write(&executable, "#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let uid = crate::relay::peer::current_uid();
    let marker = "m".repeat(64);
    table.insert(
        4300,
        FakeProcess {
            uid,
            start,
            parent: 1,
            executable: Some(executable.clone()),
            arguments: [&executable.display().to_string(), "serve", "--hostname"]
                .into_iter()
                .chain(["127.0.0.1", "--port", "4096"])
                .map(String::from)
                .collect(),
            environment: [
                (MARKER.to_string(), marker.clone()),
                ("OPENCODE_SERVER_PASSWORD".to_string(), "p".repeat(64)),
            ]
            .into(),
            tcp_listeners: vec![("127.0.0.1".into(), 4096)],
            ..FakeProcess::default()
        },
    );
    let served = Served {
        process: table.process(4300).unwrap(),
        endpoint: "http://127.0.0.1:4096".into(),
        marker,
    };
    let start = ServerStart {
        executable,
        directory: folder.canonicalize().unwrap(),
        spawn_id: SPAWN.into(),
        title: "@o1".into(),
        rules: permission_rules(true),
    };
    (served, start)
}

fn system_server(
    table: Arc<FakeProcesses>,
    folder: &Path,
    answer: impl Fn(&str, &str) -> Option<HttpResponse> + Send + Sync + 'static,
) -> (SystemServer, Arc<FakeHttp>) {
    let http = Arc::new(FakeHttp {
        answer: Box::new(answer),
        asked: Mutex::default(),
    });
    let server = SystemServer {
        table,
        http: http.clone(),
        environment: None,
        systemd_run: None,
        logs: folder.join("logs"),
        journal: folder.join("journal"),
        opencode: OpenCodeConfig {
            config_dir: folder.join("config/opencode"),
            data_dir: folder.join("data/opencode"),
            runtime: folder.join("rt"),
        },
    };
    (server, http)
}

/// A server that serves, creates the session and reads it back.
fn opencode_answers(directory: String) -> impl Fn(&str, &str) -> Option<HttpResponse> {
    let ok = |body: Value| {
        Some(HttpResponse {
            status: 200,
            body: body.to_string().into_bytes(),
        })
    };
    move |method, url| match (method, url.rsplit('/').next().unwrap_or_default()) {
        ("GET", "status") => ok(json!({})),
        ("POST", "session") => ok(json!({"id": SESSION, "permission": permission_rules(true)})),
        ("GET", SESSION) => {
            ok(json!({"id": SESSION, "directory": directory, "projectID": "prj_1"}))
        }
        _ => None,
    }
}

#[test]
fn a_server_creates_its_session_once_and_it_is_read_back() {
    let folder = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let (served, start) = provable_server(&table, folder.path(), 5);
    let directory = start.directory.display().to_string();
    let (server, http) = system_server(table, folder.path(), opencode_answers(directory));
    let mut created = None;
    let binding = server
        .ready(&served, &start, &mut created)
        .unwrap()
        .unwrap();
    assert_eq!(binding.session_id, SESSION);
    assert_eq!(binding.project_id, "prj_1");
    assert_eq!(binding.relay_workspace_id, SPAWN_AUTHORITY);
    assert_eq!(binding.owner_id, SPAWN);
    assert_eq!((binding.server_pid, binding.server_start), (4300, 5));
    assert!(server.ready(&served, &start, &mut created).is_some());
    assert_eq!(http.posts(), 1, "created once");
}

#[test]
fn a_server_not_serving_yet_is_asked_nothing_that_creates() {
    let folder = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let (served, start) = provable_server(&table, folder.path(), 5);
    let (server, http) = system_server(table, folder.path(), |method, _| match method {
        "GET" => Some(HttpResponse {
            status: 503,
            body: Vec::new(),
        }),
        _ => None,
    });
    let mut created = None;
    assert_eq!(server.ready(&served, &start, &mut created), None);
    assert_eq!(http.posts(), 0);
}

#[test]
fn a_create_whose_answer_is_lost_is_never_sent_again() {
    let folder = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let (served, start) = provable_server(&table, folder.path(), 5);
    let (server, http) = system_server(table, folder.path(), |method, url| {
        (method == "GET" && url.ends_with("/status")).then(|| HttpResponse {
            status: 200,
            body: b"{}".to_vec(),
        })
    });
    let mut created = None;
    let failed = server.ready(&served, &start, &mut created);
    assert!(
        matches!(&failed, Some(Err(reason)) if reason.contains("did not answer")),
        "{failed:?}"
    );
    assert_eq!(http.posts(), 1);
}

#[test]
fn a_server_that_replaced_an_ended_one_gets_a_session_of_its_own() {
    let folder = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let (first, start) = provable_server(&table, folder.path(), 5);
    let directory = start.directory.display().to_string();
    let (server, http) = system_server(table.clone(), folder.path(), opencode_answers(directory));
    let mut created = None;
    assert!(matches!(
        server.ready(&first, &start, &mut created),
        Some(Ok(_))
    ));
    let (second, _) = provable_server(&table, folder.path(), 6);
    let binding = server
        .ready(&second, &start, &mut created)
        .unwrap()
        .unwrap();
    assert_eq!(binding.server_start, 6);
    assert_eq!(http.posts(), 2);
    assert_eq!(created.map(|(process, _)| process.start), Some(6));
}

#[test]
fn a_server_that_does_not_come_up_fails_the_launch_before_anything_is_recorded() {
    let f = fixture(|server| server.fails = Some("its server did not come up".into()));
    let failed = f.adapter.launch(&launch(f.home.path(), true), &|_, _| {
        panic!("nothing started")
    });
    assert_eq!(
        failed,
        Err(LaunchError::Failed(
            "OpenCode could not start: its server did not come up".into()
        ))
    );
    assert!(f.server.prompts.lock().unwrap().is_empty());
}

#[test]
fn a_session_the_registry_cannot_prove_ends_its_server() {
    let table = Arc::new(FakeProcesses::default());
    let mut child = server_process(&table, 12);
    let pid = child.id() as i32;
    let mut f = fixture(|server| server.binding = binding(pid, 12, Path::new("/w")));
    *f.runtime.0.lock().unwrap() = false;
    f.adapter.table = table;
    let failed = f
        .adapter
        .launch(&launch(f.home.path(), true), &|_, _| panic!("not recorded"));
    assert!(matches!(failed, Err(LaunchError::Failed(_))), "{failed:?}");
    assert!(ended(&mut child));
    assert!(f.server.prompts.lock().unwrap().is_empty());
}

fn intent(target: Option<Target>, process: Option<SpawnedProcess>) -> Intent {
    Intent {
        invocation_id: "inv_o1".into(),
        name: "o1".into(),
        harness: ID,
        node_id: "node_desktop_1".into(),
        node_name: "mac-desktop".into(),
        title: "Fix CI".into(),
        base_url: "https://cast.example".into(),
        workspace_key: crate::relay::workspace::Secret::new("rk_live_test0000".to_string()),
        workspace_id: None,
        machine_prefix: "mac".into(),
        message_id: "spawn-inv_o1".into(),
        session_id: SPAWN.into(),
        created_ms: 0,
        ended: false,
        launch_failed: false,
        register_sent: false,
        agent_id: None,
        token: None,
        requester: None,
        target,
        process,
    }
}

#[test]
fn a_restart_finds_the_session_it_recorded_and_ends_a_server_left_without_one() {
    let mut f = fixture(|_| {});
    let process = SpawnedProcess {
        pid: 4242,
        start: 9,
    };
    assert_eq!(
        f.adapter.find(&intent(Some(target()), Some(process))),
        Some((target(), Some(process)))
    );
    assert_eq!(f.adapter.find(&intent(None, None)), None);
    let table = Arc::new(FakeProcesses::default());
    let mut child = server_process(&table, 13);
    f.adapter.table = table;
    std::fs::create_dir_all(&f.adapter.logs).unwrap();
    let pending = SpawnedProcess {
        pid: child.id() as i32,
        start: 13,
    };
    std::fs::write(
        pending_path(&f.adapter.logs, SPAWN),
        serde_json::to_vec(&pending).unwrap(),
    )
    .unwrap();
    assert_eq!(f.adapter.find(&intent(None, None)), None);
    assert!(ended(&mut child), "the server with no session was ended");
    assert!(!pending_path(&f.adapter.logs, SPAWN).exists());
}

#[test]
fn it_lives_while_its_exact_server_runs_and_stopping_is_idempotent() {
    let table = Arc::new(FakeProcesses::default());
    let mut child = server_process(&table, 14);
    let pid = child.id() as i32;
    let mut f = fixture(|_| {});
    f.adapter.table = table.clone();
    let process = SpawnedProcess { pid, start: 14 };
    assert!(f.adapter.alive(&target(), Some(&process)));
    assert!(!f.adapter.alive(&target(), None));
    let recycled = SpawnedProcess { pid, start: 15 };
    assert!(!f.adapter.alive(&target(), Some(&recycled)));
    f.adapter
        .managed
        .adopt(ManagedBinding::OpenCode(binding(pid, 14, f.home.path())))
        .unwrap();
    f.adapter.stop(&target(), Some(&process));
    assert!(ended(&mut child));
    // Its binding outlives the signal until the server is gone.
    assert!(f.adapter.managed.binding(&target()).is_some());
    table.remove(pid);
    assert!(!f.adapter.alive(&target(), Some(&process)));
    f.adapter.stop(&target(), Some(&process));
    assert_eq!(f.adapter.managed.binding(&target()), None);
    f.adapter.stop(&target(), None);
    table.insert(
        pid,
        FakeProcess {
            start: 14,
            zombie: true,
            ..FakeProcess::default()
        },
    );
    assert!(!f.adapter.alive(&target(), Some(&process)), "a zombie");
}

fn watched(alive: bool) -> Watched {
    Watched {
        name: "o1".into(),
        target: target(),
        process: Some(SpawnedProcess {
            pid: 4242,
            start: 9,
        }),
        alive,
    }
}

fn observe(f: &Fixture, agent: Watched) -> (ProcessLiveness, WorkState, bool) {
    let observed = f.adapter.observe(&[agent]);
    assert_eq!(observed.len(), 1);
    let o = observed[0];
    (o.process, o.work, o.turn_in_progress)
}

#[test]
fn a_running_agent_is_working_or_idle_as_opencode_says() {
    for (status, expected) in [
        (Some("busy"), (WorkState::Working, true)),
        (Some("retry"), (WorkState::Working, true)),
        (Some("idle"), (WorkState::Idle, false)),
        (Some("something new"), (WorkState::Unknown, false)),
        (None, (WorkState::Unknown, false)),
    ] {
        let f = fixture(|server| server.status = status.map(String::from));
        let sealed = binding(4242, 9, f.home.path());
        f.adapter
            .managed
            .adopt(ManagedBinding::OpenCode(sealed))
            .unwrap();
        assert_eq!(
            observe(&f, watched(true)),
            (ProcessLiveness::Running, expected.0, expected.1),
            "{status:?}"
        );
    }
    // No proved binding: nothing to ask.
    let f = fixture(|server| server.status = Some("busy".into()));
    assert_eq!(
        observe(&f, watched(true)),
        (ProcessLiveness::Running, WorkState::Unknown, false)
    );
    let mut unknown = watched(false);
    unknown.process = None;
    assert_eq!(
        observe(&f, unknown),
        (ProcessLiveness::Unknown, WorkState::Unknown, false)
    );
}

fn write_messages(f: &Fixture, messages: &[(&str, &str)]) {
    let folder = &f.adapter.opencode.data_dir;
    std::fs::create_dir_all(folder).unwrap();
    let database = rusqlite::Connection::open(folder.join("opencode.db")).unwrap();
    database
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, \
             time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL); \
             DELETE FROM message;",
        )
        .unwrap();
    for (index, (session, data)) in messages.iter().enumerate() {
        database
            .execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)",
                rusqlite::params![format!("msg_{index}"), session, index as i64, data],
            )
            .unwrap();
    }
}

#[test]
fn an_ended_agent_left_a_turn_unfinished_when_opencode_recorded_one() {
    let f = fixture(|_| {});
    let ended_with = |unfinished: bool| {
        (
            ProcessLiveness::Exited,
            lifecycle::ended_work(unfinished),
            unfinished,
        )
    };
    assert_eq!(
        observe(&f, watched(false)),
        ended_with(false),
        "no database"
    );
    let done = r#"{"role":"assistant","time":{"created":2,"completed":3},"finish":"stop"}"#;
    let user = r#"{"role":"user","time":{"created":1}}"#;
    let running = r#"{"role":"assistant","time":{"created":2}}"#;
    let tools = r#"{"role":"assistant","time":{"created":2,"completed":3},"finish":"tool-calls"}"#;
    for (messages, unfinished) in [
        (vec![(SESSION, user), (SESSION, done)], false),
        (vec![(SESSION, done), (SESSION, user)], true),
        (vec![(SESSION, user), (SESSION, running)], true),
        (vec![(SESSION, user), (SESSION, tools)], true),
        (
            vec![(SESSION, user), (SESSION, done), ("ses_other01", user)],
            false,
        ),
        (vec![], false),
    ] {
        write_messages(&f, &messages);
        assert_eq!(
            observe(&f, watched(false)),
            ended_with(unfinished),
            "{messages:?}"
        );
    }
}

#[test]
fn a_created_session_must_keep_every_rule() {
    let rules = permission_rules(false);
    let body = |permission: Value| {
        serde_json::to_vec(&json!({"id": SESSION, "permission": permission})).unwrap()
    };
    assert_eq!(
        created_session(&body(rules.clone()), &rules),
        Ok(SESSION.into())
    );
    let mut more = rules.as_array().unwrap().clone();
    more.insert(
        0,
        json!({"permission": "bash", "pattern": "*", "action": "ask"}),
    );
    assert_eq!(
        created_session(&body(Value::Array(more)), &rules),
        Ok(SESSION.into()),
        "OpenCode may add its own before them"
    );
    assert_eq!(
        created_session(&body(Value::Null), &rules),
        Err(RULES_REFUSED.into())
    );
    let partial = Value::Array(rules.as_array().unwrap()[1..].to_vec());
    assert_eq!(
        created_session(&body(partial), &rules),
        Err(RULES_REFUSED.into())
    );
    let unusable = serde_json::to_vec(&json!({"id": "nope", "permission": rules})).unwrap();
    assert!(created_session(&unusable, &rules).is_err());
    assert!(created_session(b"<html>", &rules).is_err());
}

#[test]
fn opencode_lists_only_sessions_that_are_not_idle() {
    let body = br#"{"ses_spawned01": {"type": "busy"}, "ses_other01": {"type": "retry"}}"#;
    assert_eq!(session_status(body, SESSION).as_deref(), Some("busy"));
    assert_eq!(session_status(b"{}", SESSION).as_deref(), Some("idle"));
    assert_eq!(session_status(b"[]", SESSION), None);
    assert_eq!(session_status(b"nope", SESSION), None);
    assert_eq!(session_work("busy"), WorkState::Working);
    assert_eq!(session_work("idle"), WorkState::Idle);
}

#[test]
fn a_spawned_server_loads_agent_relays_plugin_beside_the_persons_configuration() {
    use crate::relay::opencode::managed::spawned::CONFIG_CONTENT;
    let folder = tempfile::tempdir().unwrap();
    let table = Arc::new(FakeProcesses::default());
    let (mut server, _) = system_server(table, folder.path(), |_, _| None);
    server.environment = Some(Arc::new(|harness: &str, mut environment| {
        assert_eq!(harness, "opencode");
        environment.remove("XDG_CONFIG_HOME");
        environment.insert(CONFIG_CONTENT.into(), r#"{"plugin":["theirs"]}"#.into());
        environment
    }));
    let environment = server.environment();
    let inline: Value = serde_json::from_str(&environment[CONFIG_CONTENT]).unwrap();
    let file = folder.path().join("rt/plugin/agent-relay-spawn.js");
    assert_eq!(
        inline["plugin"],
        json!([
            "theirs",
            url::Url::from_file_path(&file).unwrap().to_string()
        ])
    );
    assert_eq!(
        std::fs::read_to_string(file).unwrap(),
        server.opencode.spawn_plugin_source()
    );
    assert!(!folder.path().join("config").exists());
}

#[test]
fn first_model_failure_is_not_successful_startup() {
    let f = fixture(|_| {});
    assert_eq!(startup::read(&f.adapter.opencode, SESSION), Ok(false));
    write_messages(&f, &[(SESSION, r#"{"role":"assistant","time":{"completed":3},"error":{"name":"APIError","data":{"message":"This API key has expired. Bearer hidden-credential"}}}"#)]);
    let error = startup::read(&f.adapter.opencode, SESSION).unwrap_err();
    assert!(error.starts_with("This API key has expired."));
    assert!(!error.contains("hidden-credential"));
    assert_eq!(startup::read(&f.adapter.opencode, "another-session"), Ok(false));
    write_messages(&f, &[(SESSION, r#"{"role":"assistant","time":{"completed":3},"finish":"stop"}"#)]);
    assert_eq!(startup::read(&f.adapter.opencode, SESSION), Ok(true));
}

#[test]
fn a_queued_prompt_with_a_model_error_fails_the_launch_with_its_reason() {
    let f = fixture(|server| {
        server.startup = Err("This API key has expired. Bearer fixture-secret".into());
    });
    let result = f.adapter.launch(&launch(f.home.path(), true), &|_, _| {});
    assert!(matches!(result, Err(LaunchError::Unavailable(reason))
        if reason.starts_with("This API key has expired.") && !reason.contains("fixture-secret")));
    assert_eq!(f.server.prompts.lock().unwrap().len(), 1);
}

#[test]
fn an_unverified_model_start_is_reported_without_resending_the_prompt() {
    let f = fixture(|server| { server.startup = Ok(false); });
    let launched = f.adapter.launch(&launch(f.home.path(), true), &|_, _| {}).unwrap();
    assert_eq!(launched.task, TaskHandoff::Unconfirmed("model_start_unconfirmed"));
    assert_eq!(f.server.prompts.lock().unwrap().len(), 1);
}
