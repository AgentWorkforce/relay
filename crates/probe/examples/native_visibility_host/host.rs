//! Isolated native-UI acceptance host. No installed service, live provider,
//! credentials, or history is read. Control is test-process stdin, not RPC.
#[path = "claude_provider.rs"]
mod claude_provider;
#[path = "../../tests/support/fake_relaycast.rs"]
mod fake_relaycast;
#[path = "history.rs"]
mod history;

use agent_relay_probe::relay::{
    claude,
    codex::{
        self,
        app_server::TurnError,
        router::{CodexRouter, CodexRoutes, QueueError},
    },
    daemon::{self, BoundSocket, Config, Core, Plugins},
    delivery::DeliveryTiming,
    inject::{InjectOutcome, Injector},
    local::{LocalConfig, LocalSessions},
    paths::{self, CorePaths},
    process::{FakeProcess, FakeProcesses, StartClock},
    push::PushTiming,
    store::{SessionKind, Target},
};
use fake_relaycast::{Behaviour, FakeRelaycast, WORKSPACE_KEY};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Receipts {
    path: PathBuf,
    start: Instant,
    writing: Mutex<()>,
}
impl Receipts {
    fn record(&self, stage: &str, value: Value) {
        use std::os::fd::AsRawFd;
        let _writing = self.writing.lock().unwrap();
        let mut line = serde_json::to_vec(
            &json!({"stage":stage,"elapsed_ms":self.start.elapsed().as_millis(),"value":value}),
        )
        .unwrap();
        line.push(b'\n');
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .unwrap();
        // The Swift parent also takes this lock before appending a frame.
        assert_eq!(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) }, 0);
        file.write_all(&line).unwrap();
    }
}

struct CodexProviderConnection(std::os::unix::net::UnixStream);
impl CodexProviderConnection {
    fn accept(listener: &std::os::unix::net::UnixListener) -> std::io::Result<Self> {
        let (connection, _) = listener.accept()?;
        // Darwin inherits the listener's nonblocking mode. Acceptance does
        // not mean the sender has written its complete newline frame yet.
        connection.set_nonblocking(false)?;
        connection.set_read_timeout(Some(Duration::from_secs(2)))?;
        connection.set_write_timeout(Some(Duration::from_secs(2)))?;
        Ok(Self(connection))
    }

    fn receive(mut self, receipts: &Receipts) -> std::io::Result<()> {
        let mut line = String::new();
        std::io::BufReader::new(self.0.try_clone()?).read_line(&mut line)?;
        let value: Value = serde_json::from_str(&line)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        receipts.record("transport_accepted", value.clone());
        writeln!(
            self.0,
            "{}",
            json!({"accepted":true,"id":value["id"],"message_id":value["message_id"]})
        )
    }
}

#[cfg(test)]
mod codex_provider_tests {
    use super::*;
    use std::{
        os::{
            fd::AsRawFd,
            unix::net::{UnixListener, UnixStream},
        },
        sync::mpsc,
    };

    fn receiver_waits_for_complete_frame(prefix: &[u8]) {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("stages.jsonl");
        let socket = home.path().join("provider.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut sender = UnixStream::connect(&socket).unwrap();
        sender
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        sender
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        sender.write_all(prefix).unwrap();
        let receipts = Receipts {
            path: path.clone(),
            start: Instant::now(),
            writing: Mutex::default(),
        };
        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let receiver = std::thread::spawn(move || {
            // This is the same accept/setup/receive chain as the native host.
            let result = CodexProviderConnection::accept(&listener).and_then(|connection| {
                let flags = unsafe { libc::fcntl(connection.0.as_raw_fd(), libc::F_GETFL) };
                let options = (
                    flags,
                    connection.0.read_timeout()?,
                    connection.0.write_timeout()?,
                );
                ready_tx.send(options).unwrap();
                connection.receive(&receipts)
            });
            done_tx.send(result).unwrap();
        });
        let configured = ready_rx.recv_timeout(Duration::from_secs(2));
        // The writer withholds the rest of the frame until the receiver has
        // had a bounded opportunity to report an erroneous premature result.
        let premature = done_rx.recv_timeout(Duration::from_millis(50));
        let observed_before_newline = std::fs::read_to_string(&path).unwrap_or_default();
        let frame = b"{\"kind\":\"codex\",\"id\":\"exact-thread\",\"message_id\":\"exact-message\",\"text\":\"exact payload\"}\n";
        let written = sender.write_all(&frame[prefix.len()..]);
        let mut answer = String::new();
        let response = std::io::BufReader::new(sender).read_line(&mut answer);
        let pending = matches!(&premature, Err(mpsc::RecvTimeoutError::Timeout));
        let result = match premature {
            Ok(result) => Ok(result),
            Err(mpsc::RecvTimeoutError::Timeout) => done_rx.recv_timeout(Duration::from_secs(3)),
            Err(error) => Err(error),
        };
        let joined = receiver.join();
        // Join and close the owned sockets before reporting any assertion,
        // including with the original/reverted nonblocking receiver.
        let (flags, read_timeout, write_timeout) = configured.unwrap();
        assert!(flags >= 0);
        assert_eq!(
            flags & libc::O_NONBLOCK,
            0,
            "Accepted stream must explicitly enter blocking mode; receiver result: {result:?}"
        );
        assert_eq!(read_timeout, Some(Duration::from_secs(2)));
        assert_eq!(write_timeout, Some(Duration::from_secs(2)));
        assert!(
            pending,
            "Receiver must wait for a complete frame: {result:?}"
        );
        assert!(
            observed_before_newline.is_empty(),
            "Partial frames cannot produce receipts"
        );
        written.unwrap();
        response.unwrap();
        result.unwrap().unwrap();
        joined.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&answer).unwrap(),
            json!({"accepted":true,"id":"exact-thread","message_id":"exact-message"})
        );
        let records: Vec<Value> = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            records.len(),
            1,
            "Exactly one complete frame must be consumed"
        );
        assert_eq!(records[0]["stage"], "transport_accepted");
        assert_eq!(
            records[0]["value"],
            serde_json::from_slice::<Value>(frame).unwrap()
        );
    }

    #[test]
    fn accepted_codex_connection_waits_for_delayed_first_byte() {
        receiver_waits_for_complete_frame(b"");
    }

    #[test]
    fn accepted_codex_connection_waits_for_split_frame_newline() {
        receiver_waits_for_complete_frame(b"{\"kind\":\"codex\",\"id\":\"exact-thread\",");
    }
}

#[cfg(test)]
mod receipt_tests {
    use super::*;
    #[test]
    fn concurrent_writers_preserve_every_complete_json_frame() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("stages.jsonl");
        let writers: Vec<_> = (0..2)
            .map(|_| {
                Arc::new(Receipts {
                    path: path.clone(),
                    start: Instant::now(),
                    writing: Mutex::default(),
                })
            })
            .collect();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|worker| {
                let writer = writers[worker % 2].clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    for record in 0..32 {
                        writer.record(
                            "concurrent",
                            json!({"worker":worker,"record":record,"payload":vec!["synthetic";64]}),
                        );
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let rows: Vec<Value> = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| {
                serde_json::from_str(line)
                    .expect("Every concurrent append must remain one complete JSON object")
            })
            .collect();
        assert_eq!(rows.len(), 256);
        let keys: std::collections::BTreeSet<_> = rows
            .iter()
            .map(|row| {
                (
                    row["value"]["worker"].as_u64().unwrap(),
                    row["value"]["record"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(keys.len(), 256);
    }
}
struct Routes {
    socket: PathBuf,
    accepted: Mutex<Vec<(String, String)>>,
}
impl CodexRoutes for Routes {
    fn recorded(&self, thread: &str, message_ref: &str) -> bool {
        self.accepted.lock().unwrap().iter().any(|(id, message)| {
            id == thread
                && agent_relay_probe::relay::delivery::policy::MessageRef::of(message)
                    == message_ref
        })
    }
    fn queue_waiting(&self, _: &str, _: &str) -> Option<bool> {
        Some(false)
    }
    fn relay_waiting(&self, _: &str) -> Option<bool> {
        Some(false)
    }
    fn idle(&self, _: &str) -> bool {
        true
    }
    fn app_server(&self, thread: &str, text: &str, message_id: &str) -> Result<bool, TurnError> {
        let mut connection = std::os::unix::net::UnixStream::connect(&self.socket)
            .map_err(|e| TurnError::Refused(e.to_string()))?;
        connection
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        writeln!(
            connection,
            "{}",
            json!({"kind":"codex", "id":thread, "message_id":message_id, "text":text})
        )
        .map_err(|e| TurnError::InDoubt(e.to_string()))?;
        let mut answer = String::new();
        std::io::BufReader::new(connection)
            .read_line(&mut answer)
            .map_err(|e| TurnError::InDoubt(e.to_string()))?;
        let answer: Value =
            serde_json::from_str(&answer).map_err(|e| TurnError::InDoubt(e.to_string()))?;
        if answer["id"] != thread
            || answer["message_id"] != message_id
            || answer["accepted"] != true
        {
            return Err(TurnError::InDoubt("wrong fixture recipient receipt".into()));
        }
        self.accepted
            .lock()
            .unwrap()
            .push((thread.into(), message_id.into()));
        Ok(true)
    }
    fn window(&self, _: &str, _: &str, _: &str) -> Result<bool, TurnError> {
        Ok(false)
    }
    fn terminal_live(&self, _: &str) -> bool {
        false
    }
    fn queue_send(&self, _: &str, _: &str) -> Result<(), QueueError> {
        unreachable!("controlled app-server accepts")
    }
    fn cleanup(&self, _: &str, _: &str) {}
}
struct Injection {
    config: LocalConfig,
    table: Arc<FakeProcesses>,
    codex: CodexRouter,
}
impl Injector for Injection {
    fn final_answer(&self, _: &Target, _: &str) -> Option<String> {
        None
    }
    fn inject(&self, target: &Target, message: &str, text: &str) -> InjectOutcome {
        match target.kind {
            SessionKind::ClaudeTerminal => claude::send_to_terminal(
                &self.config.claude,
                &*self.table,
                &target.id,
                message,
                text,
            ),
            SessionKind::Codex => self.codex.inject(&target.id, message, text),
            _ => InjectOutcome::Refused("fixture target only".into()),
        }
    }
}

#[tokio::main]
pub async fn run() {
    // This fixture and its synthetic collector own one process group, so
    // native drivers can reap the whole fixture even if its control hangs.
    assert_eq!(
        unsafe { libc::setpgid(0, 0) },
        0,
        "isolate fixture process group"
    );
    let home = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .expect("isolated fixture directory"),
    );
    std::fs::create_dir_all(&home).unwrap();
    let home = home.canonicalize().unwrap();
    let history_probe = std::env::args_os().nth(2).map(PathBuf::from);
    let receipts = Arc::new(Receipts {
        path: home.join("stages.jsonl"),
        start: Instant::now(),
        writing: Mutex::default(),
    });
    let fake = FakeRelaycast::start(Behaviour::default()).await;
    fake_relaycast::sign_in_store(&home.join("app-data"), WORKSPACE_KEY, &fake.base_url);
    let socket = home.join("core.sock");
    let mut env = BTreeMap::new();
    env.insert("RELAYCAST_URL".into(), fake.base_url.clone());
    env.insert(
        "AGENT_RELAY_HOME".into(),
        home.join("relay").display().to_string(),
    );
    env.insert(
        "RELAY_DESKTOP_CODEX".into(),
        home.join("nonexistent-codex").display().to_string(),
    );
    env.insert(
        "RELAY_DESKTOP_CLAUDE".into(),
        home.join("nonexistent-claude").display().to_string(),
    );
    let mut local = LocalConfig::from_env(&|name| env.get(name).cloned(), &home);
    local.codex.executable = None;
    local.claude.executable = None;
    local.claude.app_sessions = None;
    local.muse_open = false;
    local.opencode_open = false;
    let table = Arc::new(FakeProcesses {
        clock: Some(StartClock::Ticks),
        ..Default::default()
    });
    let sessions = Arc::new(LocalSessions::new(local.clone(), table.clone()));
    let provider_socket = home.join("codex-provider.sock");
    let listener = std::os::unix::net::UnixListener::bind(&provider_socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let provider_stop = stopped.clone();
    let recorded = receipts.clone();
    let provider = std::thread::spawn(move || {
        while !provider_stop.load(std::sync::atomic::Ordering::SeqCst) {
            match CodexProviderConnection::accept(&listener) {
                Ok(connection) => connection.receive(&recorded).unwrap(),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => break,
            }
        }
    });
    let routes = Arc::new(Routes {
        socket: provider_socket,
        accepted: Mutex::default(),
    });
    let injector = Arc::new(Injection {
        config: local.clone(),
        table: table.clone(),
        codex: CodexRouter::new(routes),
    });
    let config = Config {
        paths: CorePaths::for_socket(socket.clone()).unwrap(),
        home: home.clone(),
        app_data_dir: home.join("app-data"),
        env,
        version: "0.0.0-native-fixture".into(),
        host_name: "Fixture Desk.local".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: PushTiming {
            heartbeat: Duration::from_millis(50),
            backoff_unit: Duration::from_millis(10),
            jitter: || 1.0,
            mint_gap: Duration::ZERO,
        },
        delivery_timing: DeliveryTiming {
            fast_poll: Duration::from_millis(50),
            heartbeat: Duration::from_millis(100),
            safety_poll: Duration::from_millis(100),
            ..Default::default()
        },
    };
    paths::socket_directory(config.paths.directory()).unwrap();
    let bound = BoundSocket::bind(&config.paths).unwrap();
    let runner = Arc::new(history::Runner::new(home.clone(), receipts.clone()));
    let uploader = Arc::new(agent_relay_probe::relay::uploader::Uploader::new(
        runner.clone(),
    ));
    let empty_install = history::prepare_empty(&home);
    uploader.attach(agent_relay_probe::relay::uploader::Install::from_json(&json!({
        "site_url":"http://127.0.0.1:3100","account_id":"account","workspace_id":"workspace","directory":empty_install
    })));
    let account = Some(Arc::new(agent_relay_probe::relay::account::Account::new(
        Some("http://127.0.0.1:3100"),
        &home,
        &config.env,
        &config.app_data_dir,
        uploader.clone(),
    )));
    let (core, signals) = Core::with_plugins(
        config,
        Plugins {
            sessions: sessions.clone(),
            injector,
            account,
            ..Default::default()
        },
    );
    // Test identity only: no sign-in or live credential flow is under test.
    // Sessions and registration still travel through the actual core and RPC.
    core.hub().update(|status| {
        status.account.state = agent_relay_probe::relay::state::SignInState::SignedIn;
        status.account.site_url = Some("http://127.0.0.1:3100".into());
        status.account.workspace_id = Some("workspace".into());
    });
    let task = tokio::spawn(daemon::run(core.clone(), bound, signals));
    println!(
        "{}",
        json!({"ready":true, "socket":socket,"process_group":std::process::id()})
    );
    std::io::stdout().flush().unwrap();
    // Blocking stdin stays off the runtime, leaving discovery and delivery free.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            if tx.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let mut codex_lock: Option<rusqlite::Connection> = None;
    let mut backfill: Option<history::Backfill> = None;
    while let Some(line) = rx.recv().await {
        let command: Value = serde_json::from_str(&line).unwrap();
        let result = match command["op"].as_str().unwrap() {
            "seed" => {
                if backfill.is_some() {
                    history::assert_isolated_roots(&home, &receipts);
                }
                let id = command["id"].as_str().unwrap();
                let title = command["title"].as_str().unwrap();
                let kind = command["kind"].as_str().unwrap();
                // The production sender checks the kernel PID of this host's
                // listener against the session registry, not just its path.
                let pid = if kind == "claude-terminal" {
                    claude_provider::listener_pid()
                } else {
                    command["pid"].as_i64().unwrap_or(300) as i32
                };
                let start = 100;
                if kind == "claude-terminal" {
                    let registry = local.claude.home.join("sessions");
                    std::fs::create_dir_all(&registry).unwrap();
                    let inbox = home.join(format!("peer-{pid}.sock"));
                    let listener = tokio::net::UnixListener::bind(&inbox).unwrap();
                    let recorded = receipts.clone();
                    let exact = id.to_string();
                    tokio::spawn(async move {
                        loop {
                            let Ok((stream, _)) = listener.accept().await else {
                                break;
                            };
                            match claude_provider::receive(stream).await {
                                Ok(Some((auth, message))) => recorded.record("transport_accepted", json!({"kind":"claude-terminal", "id":exact, "auth":auth, "message":message})),
                                // A sender refusing the listener's identity closes
                                // before auth; it must not kill the fixture inbox.
                                Ok(None) => {},
                                Err(error) => recorded.record("transport_rejected", json!({"kind":"claude-terminal", "id":exact, "error":error.to_string()})),
                            }
                        }
                    });
                    std::fs::write(registry.join(format!("{pid}.json")), json!({"sessionId":id,"pid":pid,"procStart":start.to_string(),"peerProtocol":1,"messagingSocketPath":inbox,"cwd":home.join("project"),"name":title}).to_string()).unwrap();
                    std::fs::write(registry.join(format!("{pid}.fixture.key")), json!({"peerToken":"fake-isolated-inbox-token","procStart":start.to_string()}).to_string()).unwrap();
                    table.insert(
                        pid,
                        FakeProcess {
                            parent: 1,
                            uid: local.uid,
                            start,
                            ..Default::default()
                        },
                    );
                } else {
                    std::fs::create_dir_all(&local.codex.home).unwrap();
                    let db = rusqlite::Connection::open(local.codex.home.join("state_5.sqlite"))
                        .unwrap();
                    db.execute_batch("CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,title TEXT,archived INTEGER,source TEXT,cwd TEXT,created_at_ms INTEGER,updated_at_ms INTEGER)").unwrap();
                    db.execute(
                        "INSERT INTO threads VALUES (?1,?2,0,'cli',?3,?4,?4)",
                        rusqlite::params![
                            id,
                            title,
                            home.join("project").display().to_string(),
                            agent_relay_probe::relay::state::now_ms()
                        ],
                    )
                    .unwrap();
                    let executable = home.join("bin/codex");
                    table.trust(&executable);
                    table.insert(
                        pid,
                        FakeProcess {
                            parent: 1,
                            uid: local.uid,
                            start,
                            executable: Some(executable),
                            arguments: vec!["codex".into(), "resume".into(), id.into()],
                            has_terminal: true,
                            ..Default::default()
                        },
                    );
                }
                receipts.record("created", json!({"kind":kind,"id":id,"title":title}));
                json!({"seeded":id})
            }
            "backfill" => {
                let probe = history_probe
                    .clone()
                    .expect("pass immutable collector probe as argv2");
                let running = history::Backfill::start(&home, &probe, receipts.clone()).await;
                runner.configure(probe);
                runner.held.store(true, std::sync::atomic::Ordering::SeqCst);
                uploader.attach(agent_relay_probe::relay::uploader::Install::from_json(&json!({
                    "site_url":"http://127.0.0.1:3100","account_id":"account","workspace_id":"workspace","directory":running.directory
                })));
                let busy = running.busy();
                receipts.record("backfill_busy", busy.clone());
                backfill = Some(running);
                busy
            }
            "history_state" => {
                let busy = backfill.as_ref().unwrap().busy();
                json!({"busy":busy,"status_enrichment_held":runner.status_started.load(std::sync::atomic::Ordering::SeqCst),"actual_status_helper_succeeded":runner.status_success.load(std::sync::atomic::Ordering::SeqCst)})
            }
            "history_new_path" => {
                assert!(backfill.is_some());
                history::assert_isolated_roots(&home, &receipts);
                let id = command["id"].as_str().unwrap();
                let kind = command["kind"].as_str().unwrap();
                let marker = format!("native-new-{id}");
                backfill.as_ref().unwrap().note_new_path(&marker);
                if kind == "claude-terminal" {
                    let project = home.join(".claude/projects/native-new");
                    std::fs::create_dir_all(&project).unwrap();
                    std::fs::write(project.join(format!("{id}.jsonl")),format!("{}\n",json!({"sessionId":id,"uuid":marker,"type":"user","cwd":home.join("project"),"message":{"role":"user","content":marker},"timestamp":"2026-10-24T12:00:00.000Z"}))).unwrap();
                } else {
                    let project = home.join(".codex/sessions/2026/10/24");
                    std::fs::create_dir_all(&project).unwrap();
                    std::fs::write(project.join(format!("rollout-{id}.jsonl")),format!("{}\n{}\n",
                            json!({"timestamp":"2026-10-24T12:00:00.000Z","type":"session_meta","payload":{"id":id,"cwd":home.join("project")}}),
                            json!({"timestamp":"2026-10-24T12:00:03.000Z","type":"event_msg","payload":{"type":"user_message","message":marker}}))).unwrap();
                }
                receipts.record("new_history_path", json!({"id":id,"kind":kind}));
                json!({"written":true})
            }
            "history_capture" => {
                let marker = format!("native-new-{}", command["id"].as_str().unwrap());
                let captured = backfill.as_ref().unwrap().captured(&marker).await;
                receipts.record("history_capture_confirmed", captured.clone());
                captured
            }
            "history_release" => {
                runner
                    .held
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                runner.release.notify_waiters();
                backfill.as_ref().unwrap().release();
                json!({"released":true})
            }
            "history_quiet" => {
                runner
                    .held
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                runner.release.notify_waiters();
                let quiet = backfill.as_mut().unwrap().quiet().await;
                receipts.record("after_idle_backoff", quiet.clone());
                quiet
            }
            "lock_codex" => {
                std::fs::create_dir_all(&local.codex.home).unwrap();
                let db =
                    rusqlite::Connection::open(local.codex.home.join("state_5.sqlite")).unwrap();
                db.execute_batch("CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,title TEXT,archived INTEGER,source TEXT,cwd TEXT); BEGIN EXCLUSIVE").unwrap();
                codex_lock = Some(db);
                json!({"blocked":"codex SQLite exclusive transaction"})
            }
            "unlock" => {
                codex_lock = None;
                json!({"released":true})
            }
            "discover" => {
                let config = local.clone();
                let processes = table.clone();
                let kind = command["kind"].as_str().unwrap().to_string();
                let found = tokio::task::spawn_blocking(move || {
                    if kind == "claude-terminal" {
                        claude::discover(&config.claude, &*processes)
                    } else {
                        codex::try_discover(&config.codex, &*processes, config.uid).unwrap()
                    }
                })
                .await
                .unwrap();
                let ids: Vec<_> = found.iter().map(|s| s.target.id.clone()).collect();
                receipts.record("provider_discovered", json!({"ids":ids,"sessions":found}));
                json!({"ids":ids,"sessions":found})
            }
            "negatives" => {
                let id = command["id"].as_str().unwrap();
                let registry = local.claude.home.join("sessions");
                let pid = claude_provider::listener_pid();
                let path = registry.join(format!("{pid}.json"));
                let key = registry.join(format!("{pid}.fixture.key"));
                let original = std::fs::read(&path).unwrap();
                let key_original = std::fs::read(&key).unwrap();
                let mut entry: Value = serde_json::from_slice(&original).unwrap();
                std::fs::remove_file(&key).unwrap();
                let missing_key = claude::send_to_terminal(
                    &local.claude,
                    &*table,
                    id,
                    "negative",
                    "never deliver",
                );
                assert!(
                    matches!(&missing_key, InjectOutcome::Retry(reason) if reason.contains("inbox key"))
                );
                std::fs::write(&key, &key_original).unwrap();
                entry["peerProtocol"] = json!(999);
                std::fs::write(&path, entry.to_string()).unwrap();
                let protocol = claude::send_to_terminal(
                    &local.claude,
                    &*table,
                    id,
                    "negative",
                    "never deliver",
                );
                assert!(
                    matches!(&protocol, InjectOutcome::Retry(reason) if reason.contains("peer protocol"))
                );
                entry["peerProtocol"] = json!(1);
                entry["messagingSocketPath"] = json!(home.join("unreachable.sock"));
                std::fs::write(&path, entry.to_string()).unwrap();
                let socket = claude::send_to_terminal(
                    &local.claude,
                    &*table,
                    id,
                    "negative",
                    "never deliver",
                );
                assert!(
                    matches!(&socket, InjectOutcome::Retry(reason) if reason.contains("could not reach"))
                );
                std::fs::write(&path, &original).unwrap();
                table.insert(
                    pid,
                    FakeProcess {
                        parent: 1,
                        uid: local.uid,
                        start: 101,
                        ..Default::default()
                    },
                );
                let recycled = claude::send_to_terminal(
                    &local.claude,
                    &*table,
                    id,
                    "negative",
                    "never deliver",
                );
                assert!(matches!(&recycled, InjectOutcome::Waiting(_)));
                table.insert(
                    pid,
                    FakeProcess {
                        parent: 1,
                        uid: local.uid,
                        start: 100,
                        ..Default::default()
                    },
                );
                let result = json!({"missing_key":format!("{missing_key:?}"),"unknown_protocol":format!("{protocol:?}"),"unreachable_socket":format!("{socket:?}"),"recycled_pid":format!("{recycled:?}")});
                receipts.record("negative_readiness", result.clone());
                result
            }
            "resolve_fixture_consent" => {
                let id = command["delivery_id"].as_str().unwrap();
                let began = Instant::now();
                let outcome = loop {
                    if core
                        .claude_delivery_status()
                        .held
                        .iter()
                        .any(|held| held.id == id)
                    {
                        assert!(core.approve_claude_delivery(id).unwrap());
                        break json!({"approved":true,"already_delivered":false});
                    }
                    if fake
                        .delivery_state(id)
                        .is_some_and(|delivery| delivery.state == "acked")
                    {
                        break json!({"approved":false,"already_delivered":true});
                    }
                    assert!(
                        began.elapsed() < Duration::from_secs(10),
                        "fixture delivery must reach consent hold or actual settlement"
                    );
                    tokio::time::sleep(Duration::from_millis(10)).await;
                };
                receipts.record(
                    "fixture_consent",
                    json!({"delivery_id":id,"outcome":outcome}),
                );
                outcome
            }
            "spawn_cleanup_child" => {
                let child = std::process::Command::new("/bin/sleep")
                    .arg("60")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap();
                let pid = child.id();
                drop(child); // Deliberately owned by this fixture's process group.
                json!({"pid":pid})
            }
            "exit_for_cleanup_test" => std::process::exit(7),
            "send" => {
                let name = command["name"].as_str().unwrap();
                let (delivery, message) =
                    fake.send_dm("fixture-sender", name, command["text"].as_str().unwrap());
                json!({"delivery_id":delivery,"message_id":message})
            }
            "stop" => break,
            _ => panic!("unknown fixture command"),
        };
        println!("{}", result);
        std::io::stdout().flush().unwrap();
    }
    drop(codex_lock);
    runner
        .held
        .store(false, std::sync::atomic::Ordering::SeqCst);
    runner.release.notify_waiters();
    if backfill.is_some() {
        history::assert_isolated_roots(&home, &receipts);
    }
    drop(backfill);
    stopped.store(true, std::sync::atomic::Ordering::SeqCst);
    provider.join().unwrap();
    core.request_shutdown();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
