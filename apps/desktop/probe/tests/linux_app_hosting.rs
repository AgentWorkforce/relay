//! The Linux app's bridge hosting a core when none answers, with
//! `agent-relay-fake-core` standing in for `agent-relay-probe`; and the
//! `agent-relay-desktop` binary's own modes.

use agent_relay_probe::linux_app::bridge::{Bridge, BridgeEvent, BridgeOptions, EVENT_BUFFER};
use agent_relay_probe::linux_app::fake_core::FakeCore;
use agent_relay_probe::linux_app::host::HostOptions;
use agent_relay_probe::linux_app::service::{ServiceStart, ServiceState, UserService};
use serde_json::json;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::TempDir;
use tokio::sync::mpsc;

const FAKE: &str = env!("CARGO_BIN_EXE_agent-relay-fake-core");
#[cfg(unix)]
const APP: &str = env!("CARGO_BIN_EXE_agent-relay-desktop");

/// A directory short enough for a socket path on macOS; any temporary
/// directory on Windows, where the path only names a pipe.
fn directory() -> (TempDir, PathBuf) {
    let mut builder = tempfile::Builder::new();
    builder.prefix("hc-");
    let directory = if cfg!(unix) {
        builder.tempdir_in("/tmp")
    } else {
        builder.tempdir()
    }
    .unwrap();
    let path = directory.path().join("core.sock");
    (directory, path)
}

/// A helper program running `body`: a shell script on Unix, a batch file
/// running `windows` on Windows. On Unix it is ready to run when this
/// returns: no process holds it open for writing any more.
#[allow(unused_variables)]
fn script(directory: &Path, name: &str, body: &str, windows: &str) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        wait_until_executable(&path);
        path
    }
    #[cfg(windows)]
    {
        let path = directory.join(format!("{name}.cmd"));
        std::fs::write(&path, format!("@echo off\r\n{windows}\r\n")).unwrap();
        path
    }
}

/// Waits until `path`, a script this test just wrote, can be executed.
///
/// The tests run on several threads at once. While one writes a script,
/// another may fork a child (a hosted core, the isolated `agent-relay-desktop`);
/// the child inherits the script's write descriptor and keeps it open until
/// its own `exec` closes it (the descriptor is close-on-exec). Executing the
/// script before then fails with ETXTBSY ("Text file busy"), which the
/// hosting code reports as a helper that could not start, and the test
/// fails on a race that has nothing to do with it. Once one `exec` of the
/// script succeeds no writer is left, and none can appear, since the script
/// is never opened for writing again: from then on every run is safe.
#[cfg(unix)]
fn wait_until_executable(path: &Path) {
    let started = std::time::Instant::now();
    loop {
        match Command::new(path)
            .stdin(std::process::Stdio::null())
            .output()
        {
            Ok(_) => return,
            Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) => {
                assert!(
                    started.elapsed() < Duration::from_secs(10),
                    "{} stayed busy: {error}",
                    path.display()
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("cannot run {}: {error}", path.display()),
        }
    }
}

/// Whether a core answers at `socket`: its socket file on Unix; on Windows,
/// where no file stands for the pipe, whether the pipe answers.
fn listening(socket: &Path) -> bool {
    if cfg!(windows) {
        agent_relay_probe::relay::transport::is_served(socket)
    } else {
        socket.exists()
    }
}

/// Whether process `pid` still runs.
#[cfg(unix)]
fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// Reaps `pid`, which this test started but no longer waits for.
#[cfg(unix)]
fn reap(pid: u32) {
    let _ = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) };
}

/// Kills `pid` at once, as a crash would.
#[cfg(unix)]
fn kill(pid: u32) {
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
}

#[cfg(windows)]
use windows_process::{alive, kill, reap};

/// Process liveness and killing on Windows, through the process handle.
#[cfg(windows)]
mod windows_process {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    };

    pub fn alive(pid: u32) -> bool {
        // SAFETY: plain handle calls; the handle is closed once.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut code = 0u32;
            let read = GetExitCodeProcess(process, &mut code);
            CloseHandle(process);
            read != 0 && code == STILL_ACTIVE as u32
        }
    }

    /// Windows has no zombies: an exited process needs no reaping.
    pub fn reap(_pid: u32) {}

    pub fn kill(pid: u32) {
        // SAFETY: plain handle calls; the handle is closed once.
        unsafe {
            let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !process.is_null() {
                TerminateProcess(process, 1);
                CloseHandle(process);
            }
        }
    }
}

struct Events(mpsc::Receiver<BridgeEvent>);

impl Events {
    async fn next<T>(&mut self, wait: u64, pick: impl Fn(BridgeEvent) -> Option<T>) -> T {
        tokio::time::timeout(Duration::from_secs(wait), async {
            loop {
                if let Some(value) = pick(self.0.recv().await.expect("the bridge stopped")) {
                    return value;
                }
            }
        })
        .await
        .expect("no such event in time")
    }

    async fn status(&mut self, wait: u64) -> String {
        self.next(wait, |event| match event {
            BridgeEvent::Status(status) => Some(format!("{:?}", status.account.state)),
            _ => None,
        })
        .await
    }

    async fn disconnected(&mut self, wait: u64) -> Option<String> {
        self.next(wait, |event| match event {
            BridgeEvent::Disconnected { error } => Some(error),
            _ => None,
        })
        .await
    }
}

/// No systemd: `start` runs `starting` and reports what it returns.
struct FakeService {
    starting: Box<dyn Fn() -> ServiceStart + Send + Sync>,
    starts: Mutex<u32>,
}

impl FakeService {
    fn new(starting: impl Fn() -> ServiceStart + Send + Sync + 'static) -> Arc<FakeService> {
        Arc::new(FakeService {
            starting: Box::new(starting),
            starts: Mutex::new(0),
        })
    }
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
        *self.starts.lock().unwrap() += 1;
        (self.starting)()
    }

    fn enable(&self) -> Result<(), String> {
        Ok(())
    }

    fn stop(&self) -> Result<(), String> {
        Ok(())
    }

    fn disable(&self) -> Result<(), String> {
        Ok(())
    }
}

fn host(
    socket: &Path,
    probe: Option<PathBuf>,
    service: Option<Arc<dyn UserService>>,
) -> (Bridge, Events) {
    let options = BridgeOptions {
        socket: socket.to_path_buf(),
        host: Some(HostOptions {
            probe,
            site_url: Some("http://127.0.0.1:9".into()),
            app_data_dir: None,
            version: None,
        }),
        service,
    };
    let (bridge, events) = Bridge::start(options, &tokio::runtime::Handle::current());
    (bridge, Events(events))
}

#[tokio::test(flavor = "multi_thread")]
async fn hosts_a_core_when_none_answers_and_stops_it_with_the_app() {
    let (_directory, socket) = directory();
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), None);
    assert_eq!(events.status(10).await, "SignedOut");
    assert!(bridge.hosting());
    let pid = bridge.hosted_pid().unwrap();
    assert_eq!(
        bridge
            .call_value("uploader.sessions.preview", json!({}))
            .await,
        Ok(json!({"sessions": []}))
    );
    bridge.stop().await;
    assert!(!bridge.hosting());
    // The child is gone (reaped) and took its socket with it.
    assert!(!alive(pid));
    assert!(!listening(&socket));
}

async fn eventually(check: impl Fn() -> bool) -> bool {
    for _ in 0..200 {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    check()
}

#[tokio::test(flavor = "multi_thread")]
async fn quitting_can_leave_the_hosted_core_for_the_next_launch() {
    let (_directory, socket) = directory();
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), None);
    events.status(10).await;
    let pid = bridge.hosted_pid().unwrap();
    bridge.quit(true).await;
    assert!(alive(pid) && listening(&socket));

    // The next launch connects to it rather than hosting another, and
    // quitting without keeping agents connected stops it.
    let (next, mut events) = host(&socket, Some(FAKE.into()), None);
    assert_eq!(events.status(10).await, "SignedOut");
    assert!(!next.hosting());
    next.quit(false).await;
    assert!(eventually(|| !listening(&socket)).await);
    reap(pid);
}

#[tokio::test(flavor = "multi_thread")]
async fn quitting_leaves_the_service_core_alone() {
    let (_directory, socket) = directory();
    let core = FakeCore::start(&socket).unwrap();
    let service = FakeService::new(|| ServiceStart::Started);
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), Some(service));
    events.status(10).await;
    bridge.quit(false).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(listening(&socket) && !core.is_stopped());
    core.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn quitting_leaves_a_core_started_by_hand_alone() {
    let (_directory, socket) = directory();
    let core = FakeCore::start(&socket).unwrap();
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), None);
    events.status(10).await;
    bridge.quit(false).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(listening(&socket) && !core.is_stopped());
    core.stop().await;
}

/// Hosts a core and quits keeping it, as an earlier run of the app would.
async fn leave_a_core_running(socket: &Path) -> u32 {
    let (bridge, mut events) = host(socket, Some(FAKE.into()), None);
    events.status(10).await;
    let pid = bridge.hosted_pid().unwrap();
    bridge.quit(true).await;
    pid
}

#[tokio::test(flavor = "multi_thread")]
async fn handing_over_to_the_service_stops_a_core_left_running() {
    let (_directory, socket) = directory();
    let pid = leave_a_core_running(&socket).await;
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), None);
    events.status(10).await;
    assert!(!bridge.hosting());
    bridge.release_hosted().await;
    assert!(eventually(|| !listening(&socket)).await);
    reap(pid);
    // The unit takes the socket: greeting the stopping core must not have
    // let this app host one meanwhile.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!bridge.hosting() && !listening(&socket));
    bridge.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_core_left_running_on_another_version_is_replaced() {
    let (_directory, socket) = directory();
    let pid = leave_a_core_running(&socket).await;
    let options = BridgeOptions {
        socket: socket.clone(),
        host: Some(HostOptions {
            probe: Some(FAKE.into()),
            site_url: Some("http://127.0.0.1:9".into()),
            app_data_dir: None,
            version: Some("9.9.9".into()),
        }),
        service: None,
    };
    let (bridge, events) = Bridge::start(options, &tokio::runtime::Handle::current());
    let _events = Events(events);
    // The fake core it hosts is on another version too, so it is only
    // checked that the one left running stopped and another was hosted.
    assert!(
        eventually(|| !alive(pid) || {
            reap(pid);
            !alive(pid)
        })
        .await
    );
    assert!(eventually(|| bridge.hosting()).await);
    bridge.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hosted_core_that_exits_is_started_again() {
    let (_directory, socket) = directory();
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), None);
    events.status(10).await;
    let first = bridge.hosted_pid().unwrap();
    kill(first);
    let _ = std::fs::remove_file(&socket);
    events.disconnected(10).await;
    events.status(15).await;
    assert!(bridge.hosting());
    assert_ne!(bridge.hosted_pid(), Some(first));
    bridge.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_helper_is_reported() {
    let (_directory, socket) = directory();
    let (bridge, mut events) = host(&socket, None, None);
    let error = events.disconnected(10).await.unwrap();
    assert!(error.contains("helper program"), "{error}");
    bridge.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_helper_that_exits_at_once_is_reported() {
    let (directory, socket) = directory();
    let broken = script(directory.path(), "broken", "exit 3", "exit /b 3");
    let (bridge, mut events) = host(&socket, Some(broken), None);
    let error = events.disconnected(10).await.unwrap();
    assert!(error.contains("exit status 3"), "{error}");
    bridge.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_systemd_service_is_started_rather_than_a_hosted_core() {
    let (_directory, socket) = directory();
    let runtime = tokio::runtime::Handle::current();
    let cores = Arc::new(Mutex::new(Vec::new()));
    let service = FakeService::new({
        let (socket, cores) = (socket.clone(), cores.clone());
        move || {
            let _entered = runtime.enter();
            cores
                .lock()
                .unwrap()
                .push(FakeCore::start(&socket).unwrap());
            ServiceStart::Started
        }
    });
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), Some(service.clone()));
    events.status(10).await;
    assert_eq!(cores.lock().unwrap().len(), 1);
    assert!(!bridge.hosting());
    bridge.stop().await;
    let started: Vec<FakeCore> = cores.lock().unwrap().drain(..).collect();
    for core in started {
        core.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_started_service_that_is_slow_is_never_doubled_by_a_hosted_core() {
    let (_directory, socket) = directory();
    let service = FakeService::new(|| ServiceStart::Started);
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), Some(service));
    let error = events.disconnected(20).await.unwrap();
    assert!(error.contains("did not start in time"), "{error}");
    assert_eq!(bridge.hosted_pid(), None);
    bridge.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unconfirmed_service_start_is_never_doubled_by_a_hosted_core() {
    let (_directory, socket) = directory();
    let service = FakeService::new(|| ServiceStart::Unconfirmed);
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), Some(service));
    let error = events.disconnected(20).await.unwrap();
    assert!(
        error.contains("background service did not start"),
        "{error}"
    );
    assert_eq!(bridge.hosted_pid(), None);
    bridge.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_service_the_core_is_hosted() {
    let (_directory, socket) = directory();
    let service = FakeService::new(|| ServiceStart::NotEnabled);
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), Some(service.clone()));
    events.status(10).await;
    assert!(bridge.hosting());
    assert_eq!(*service.starts.lock().unwrap(), 1);
    bridge.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_running_core_is_used_rather_than_hosted() {
    let (_directory, socket) = directory();
    let core = FakeCore::start(&socket).unwrap();
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), None);
    events.status(10).await;
    assert!(!bridge.hosting());
    bridge.stop().await;
    core.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn releasing_a_hosted_core_lets_another_take_the_socket() {
    let (_directory, socket) = directory();
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), None);
    events.status(10).await;
    bridge.release_hosted().await;
    assert!(!bridge.hosting());
    events.disconnected(10).await;
    // Well past the first reconnect: nothing is hosted in the meantime.
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(bridge.hosted_pid(), None);
    assert!(!listening(&socket));
    let core = FakeCore::start(&socket).unwrap();
    events.status(10).await;
    assert!(!bridge.hosting());
    // Once another core answered, a later gap is hosted again.
    core.stop().await;
    events.disconnected(10).await;
    events.status(15).await;
    assert!(bridge.hosting());
    bridge.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_after_a_release_hosts_again() {
    let (_directory, socket) = directory();
    let (bridge, mut events) = host(&socket, Some(FAKE.into()), None);
    events.status(10).await;
    bridge.release_hosted().await;
    events.disconnected(10).await;
    bridge.restart();
    events.status(15).await;
    assert!(bridge.hosting());
    bridge.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_while_connecting_leaves_the_attempt_alone() {
    let (_directory, socket) = directory();
    let runtime = tokio::runtime::Handle::current();
    let cores = Arc::new(Mutex::new(Vec::new()));
    let service = FakeService::new({
        let (socket, cores) = (socket.clone(), cores.clone());
        move || {
            std::thread::sleep(Duration::from_millis(800));
            let _entered = runtime.enter();
            let mut cores = cores.lock().unwrap();
            if cores.is_empty() {
                cores.push(FakeCore::start(&socket).unwrap());
            }
            ServiceStart::Started
        }
    });
    let (bridge, mut events) = host(&socket, None, Some(service.clone()));
    tokio::time::sleep(Duration::from_millis(300)).await;
    bridge.restart();
    events
        .next(10, |event| (event == BridgeEvent::Connected).then_some(()))
        .await;
    assert_eq!(*service.starts.lock().unwrap(), 1);
    bridge.stop().await;
    let started: Vec<FakeCore> = cores.lock().unwrap().drain(..).collect();
    for core in started {
        core.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn stopping_never_waits_for_a_ui_that_is_behind() {
    let (_directory, socket) = directory();
    let core = FakeCore::start(&socket).unwrap();
    let (bridge, mut events) = host(&socket, None, None);
    events.status(10).await;
    // Fills the UI's channel, which nobody reads from here on, so the
    // disconnection that follows waits for room.
    for index in 0..EVENT_BUFFER {
        core.emit(
            "activity",
            json!({"level": "info", "message": index.to_string(), "at_ms": 0}),
        )
        .await;
    }
    core.stop().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = std::time::Instant::now();
    bridge.stop().await;
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    drop(events);
}

/// A copy of `agent-relay-desktop` with a stand-in `agent-relay-probe` beside it
/// that prints `beside`. Cargo builds the real core beside the test binaries;
/// the copy runs where no real core is within reach, so a probe lookup that
/// misses `RELAY_DESKTOP_PROBE` runs the stand-in, never the real core.
// The `agent-relay-desktop` binary's own modes run shell-script stand-ins and exec
// into the core: Unix only here; the Windows app's modes are tested with
// its own launcher (`bin/agent-relay-desktop.rs`).
#[cfg(unix)]
fn isolated_app() -> (TempDir, PathBuf) {
    let directory = tempfile::Builder::new()
        .prefix("app-")
        .tempdir_in("/tmp")
        .unwrap();
    let app = directory.path().join("agent-relay-desktop");
    std::fs::hard_link(APP, &app)
        .or_else(|_| std::fs::copy(APP, &app).map(drop))
        .unwrap();
    script(directory.path(), "agent-relay-probe", "echo beside", "");
    (directory, app)
}

/// Runs the isolated `agent-relay-desktop`; `probe` is its `RELAY_DESKTOP_PROBE`.
#[cfg(unix)]
fn app(arguments: &[&str], probe: Option<&Path>, home: &Path) -> (i32, String, String) {
    let (_isolated, isolated) = isolated_app();
    let mut command = Command::new(&isolated);
    command
        .args(arguments)
        .env_remove("RELAY_DESKTOP_PROBE")
        .env("HOME", home)
        .env_remove("XDG_DATA_HOME");
    if let Some(probe) = probe {
        command.env("RELAY_DESKTOP_PROBE", probe);
    }
    let output = command.output().unwrap();
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

#[cfg(unix)]
#[test]
fn headless_runs_the_core_in_place_of_the_app() {
    let (directory, _) = directory();
    let probe = script(directory.path(), "probe", "echo \"$@\"", "");
    let (code, stdout, _) = app(&["--headless"], Some(&probe), directory.path());
    assert_eq!((code, stdout.as_str()), (0, "relay serve --headless\n"));
    let (code, _, stderr) = app(&["--headless", "--verbose"], Some(&probe), directory.path());
    assert_eq!(
        (code, stderr.as_str()),
        (2, "Unknown headless option: --verbose\n")
    );
    let missing = directory.path().join("missing");
    let (code, _, stderr) = app(&["--headless"], Some(&missing), directory.path());
    assert_eq!(
        (code, stderr.as_str()),
        (
            1,
            "Agent Relay could not start its helper program: No such file or directory.\n"
        )
    );
}

/// `RELAY_DESKTOP_PROBE` wins over the core beside the app, which wins when
/// it is unset or blank.
#[cfg(unix)]
#[test]
fn headless_runs_the_configured_probe_before_the_one_beside_it() {
    let (directory, _) = directory();
    let probe = script(directory.path(), "probe", "echo configured", "");
    let (code, stdout, _) = app(&["--headless"], Some(&probe), directory.path());
    assert_eq!((code, stdout.as_str()), (0, "configured\n"));
    let (code, stdout, _) = app(&["--headless"], None, directory.path());
    assert_eq!((code, stdout.as_str()), (0, "beside\n"));
    let (code, stdout, _) = app(&["--headless"], Some(Path::new(" ")), directory.path());
    assert_eq!((code, stdout.as_str()), (0, "beside\n"));
}

#[cfg(unix)]
#[test]
fn a_build_outside_a_per_user_install_lists_no_launcher() {
    let (directory, _) = directory();
    let probe = script(directory.path(), "probe", "exit 9", "");
    let (code, _, stderr) = app(&["--install-launcher"], Some(&probe), directory.path());
    assert_eq!(code, 2);
    assert!(stderr.starts_with("Only a per-user install"), "{stderr}");
    assert!(!directory.path().join(".local").exists());
}

/// Built with the `gtk` feature, the same command opens the window.
#[cfg(not(feature = "gtk"))]
#[cfg(unix)]
#[test]
fn without_the_window_the_app_points_at_headless() {
    let (directory, _) = directory();
    let probe = script(directory.path(), "probe", "exit 9", "");
    let (code, _, stderr) = app(&[], Some(&probe), directory.path());
    assert_eq!(code, 1);
    assert!(stderr.contains("--headless"), "{stderr}");
}
