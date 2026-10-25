//! Delivery into a Muse session started and owned by Agent Relay. Callers
//! must prove the live process against the registration's saved spawn
//! identity before reaching this internal courier.
//!
//! The receipt is read from the *target's* own log: once Muse records
//! `peer_message.admission.settled` `accepted` for a message from our courier
//! whose text equals ours, the turn is durably in the owned session. The
//! shared [`Journal`]/[`Coordinator`] give dedupe on the relay message id, a
//! per-session lock, confirmed-replay, and never-resend-in-doubt — the same
//! guarantees the Grok adapter relies on. A courier send is not model-
//! idempotent, so `replay` only reconciles by reading the target log; it never
//! forwards a second time.

mod receipts;
pub use receipts::SystemReceipts;

use crate::relay::existing_session::{
    Adapter, Binding, Coordinator, Failure, Gate, Journal, Outcome, Provider, Request, Transport,
};
use crate::relay::muse::MuseConfig;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The non-secret credential reference carried by the legacy `muse-open`
/// wire kind used for Relay-owned Muse spawns.
pub fn courier_reference(session_id: &str) -> String {
    format!("muse-open:{session_id}")
}

/// Whether a reference is a muse-open one.
pub fn is_courier_reference(reference: &str) -> bool {
    reference.starts_with("muse-open:")
}

/// What the core proved about a Relay-owned target at delivery time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub session_id: String,
    /// The target session's canonical workspace root, proven from the kernel.
    /// The courier launches here so Muse admits `exact_profile_match`.
    pub workspace_root: PathBuf,
    pub workspace_id: String,
    pub owner_id: String,
    pub owner_uid: u32,
}

impl Target {
    fn binding(&self) -> Binding {
        Binding {
            provider: Provider::Muse,
            transport: Transport::Courier,
            workspace_id: self.workspace_id.clone(),
            session_id: self.session_id.clone(),
            endpoint_id: String::new(),
            owner_id: self.owner_id.clone(),
            credential_reference: courier_reference(&self.session_id),
            owner_uid: self.owner_uid,
            auth_id: String::new(),
            protocol_id: String::new(),
            cwd: self.workspace_root.clone(),
            model_id: String::new(),
            agent_version: String::new(),
            executable: PathBuf::new(),
            leader_pid: 0,
            leader_start: 0,
            socket_path: PathBuf::new(),
            socket_device: 0,
            socket_inode: 0,
        }
    }
}

/// The result of asking a courier to forward one message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Forwarded {
    /// The forwarding prompt was written to a warm courier in the workspace;
    /// `courier_session` is the courier's own Muse session id, used to match
    /// the sender when reading the target's receipt.
    Sent { courier_session: String },
    /// No courier could be made ready; nothing was written.
    Unavailable,
}

/// A warm courier pool. `forward` ensures one courier for the workspace and
/// writes the strict one-shot forwarding prompt to its PTY. Implementations
/// own both the target host and courier processes.
pub trait Courier: Send + Sync {
    fn forward(&self, workspace: &Path, target_session: &str, text: &str) -> Forwarded;
    /// Ends the courier once its delivery has settled either way. A Muse TUI
    /// stays open after its turn, so without this every message would leave
    /// one running.
    fn release(&self, _courier_session: &str) {}
}

/// Reads the target session's own log for a durable admission receipt.
pub trait Receipts: Send + Sync {
    /// Whether the turn that took the delivery `receipt_id` in has ended,
    /// so its courier, which the session answers, can be closed.
    fn turn_ended(&self, _target_session: &str, _receipt_id: &str) -> bool {
        true
    }

    /// The Muse message id of an `accepted` admission in `target_session`'s
    /// log, from `courier_session`, whose body equals `text` exactly, settled
    /// at or after `since`. `None` until such a record exists.
    fn admitted(
        &self,
        target_session: &str,
        courier_session: &str,
        text: &str,
        since: Instant,
    ) -> Option<String>;
}

/// The courier adapter: forwards through the courier, then confirms from the
/// target log. Not model-idempotent, so `replay` reconciles by log only.
pub struct MuseCourierAdapter {
    courier: Arc<dyn Courier>,
    receipts: Arc<dyn Receipts>,
    /// How often to re-read the target log while waiting for admission.
    poll: Duration,
}

impl MuseCourierAdapter {
    pub fn new(courier: Arc<dyn Courier>, receipts: Arc<dyn Receipts>) -> Self {
        Self {
            courier,
            receipts,
            poll: Duration::from_millis(500),
        }
    }

    /// Closes the courier once the session's turn on the delivered message
    /// has ended, as the session answers by messaging the courier back. A
    /// delivery that did not land releases it at once; a turn that never ends
    /// releases it after `COURIER_LINGER`.
    fn release_after_turn(&self, target: &str, courier_session: String, outcome: &Outcome) {
        let receipt = match outcome {
            Outcome::Delivered { receipt_id } => receipt_id.clone(),
            _ => {
                self.courier.release(&courier_session);
                return;
            }
        };
        if self.receipts.turn_ended(target, &receipt) {
            self.courier.release(&courier_session);
            return;
        }
        let courier = self.courier.clone();
        let receipts = self.receipts.clone();
        let target = target.to_string();
        std::thread::spawn(move || {
            let until = Instant::now() + COURIER_LINGER;
            while Instant::now() < until && !receipts.turn_ended(&target, &receipt) {
                std::thread::sleep(Duration::from_secs(2));
            }
            courier.release(&courier_session);
        });
    }

    fn confirm(
        &self,
        target_session: &str,
        courier_session: &str,
        text: &str,
        since: Instant,
        deadline: Instant,
    ) -> Outcome {
        loop {
            if let Some(receipt) =
                self.receipts
                    .admitted(target_session, courier_session, text, since)
            {
                return Outcome::Delivered {
                    receipt_id: receipt,
                };
            }
            if Instant::now() >= deadline {
                // The message may have been admitted after we stopped
                // looking; a later attempt reconciles by log and never
                // forwards again.
                return Outcome::InDoubt(Failure::PriorAttemptUncertain);
            }
            std::thread::sleep(
                self.poll.min(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .max(Duration::from_millis(1)),
                ),
            );
        }
    }
}

impl Adapter for MuseCourierAdapter {
    fn provider(&self) -> Provider {
        Provider::Muse
    }

    fn inject(&self, request: &Request<'_>, _command_id: &str) -> Outcome {
        let start = Instant::now();
        let deadline = start + request.timeout;
        match self.courier.forward(
            &request.binding.cwd,
            &request.binding.session_id,
            request.text,
        ) {
            Forwarded::Sent { courier_session } => {
                let outcome = self.confirm(
                    &request.binding.session_id,
                    &courier_session,
                    request.text,
                    start,
                    deadline,
                );
                self.release_after_turn(&request.binding.session_id, courier_session, &outcome);
                outcome
            }
            // Nothing was written, so this is safe to retry later.
            Forwarded::Unavailable => Outcome::Retry(Failure::EndpointUnavailable),
        }
    }

    fn replay(&self, request: &Request<'_>, _command_id: &str) -> Outcome {
        // Reconcile only: never forward a second time. A courier send that
        // reached Muse would show in the target log for any courier of ours;
        // without the courier session we cannot attribute it, so this stays
        // in doubt unless a live courier of ours already recorded it.
        let _ = request;
        Outcome::InDoubt(Failure::PriorAttemptUncertain)
    }
}

/// One delivery into a Relay-owned Muse session through a courier, with the shared
/// journal's dedupe and never-resend guarantees. `delivery_id` is the relay
/// message id, so a double send is never a second turn and an in-doubt send is
/// never resent.
#[allow(clippy::too_many_arguments)]
pub fn deliver(
    journal_dir: &Path,
    courier: Arc<dyn Courier>,
    receipts: Arc<dyn Receipts>,
    target: &Target,
    delivery_id: &str,
    message_id: &str,
    text: &str,
    timeout: Duration,
) -> Outcome {
    // The courier is a Unix PTY process; nothing is journaled or sent on
    // Windows, where Muse is reported unavailable.
    if !crate::relay::existing_session::platform::SUPPORTED {
        return Outcome::Refused(Failure::UnsupportedRoute);
    }
    if let Some(parent) = journal_dir.parent() {
        // The private journal leaf is created 0700 by `Journal::new`, which is
        // not recursive; its parent tree is this route's app-data subtree.
        let _ = std::fs::create_dir_all(parent);
    }
    let journal = match Journal::new(journal_dir) {
        Ok(journal) => journal,
        // Nothing was sent yet.
        Err(_) => return Outcome::Retry(Failure::JournalUnavailable),
    };
    let adapter = Arc::new(MuseCourierAdapter::new(courier, receipts));
    let Some(coordinator) =
        Coordinator::new(Gate::enabled([Provider::Muse]), journal, vec![adapter])
    else {
        return Outcome::Refused(Failure::UnsupportedRoute);
    };
    coordinator.inject(&Request {
        binding: &target.binding(),
        delivery_id,
        message_id,
        text,
        timeout,
    })
}

/// A warm courier process: an interactive Muse TUI the probe launched on a
/// PTY it owns, in one workspace.
/// A courier process the probe launched for one delivery: an interactive Muse
/// TUI started with the forwarding prompt as its argument, on a PTY the probe
/// owns. Muse runs the prompt on start, so no keystrokes are typed into any
/// session. A reader drains the PTY so the TUI never blocks on output.
#[cfg_attr(windows, allow(dead_code))]
struct CourierProc {
    pid: i32,
    _master: std::fs::File,
    _drain: Option<std::thread::JoinHandle<()>>,
    session_id_holder: String,
}

impl CourierProc {
    /// Ends the courier's process group (it is a session leader), asking
    /// first and forcing after a few seconds, and reaps it.
    fn reap(&mut self) {
        // No courier is ever launched on Windows (`launch`), so there is no
        // process group to end there.
        #[cfg(unix)]
        unsafe {
            libc::killpg(self.pid, libc::SIGTERM);
            let mut status = 0;
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let done = libc::waitpid(self.pid, &mut status, libc::WNOHANG);
                if done == self.pid || done == -1 {
                    break;
                }
                if Instant::now() >= deadline {
                    libc::killpg(self.pid, libc::SIGKILL);
                    libc::waitpid(self.pid, &mut status, 0);
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        if let Some(handle) = self._drain.take() {
            let _ = handle.join();
        }
    }
}

/// Launches a probe-owned courier Muse TUI per delivery, with the strict
/// one-shot forwarding prompt as its startup argument. The probe owns the PTY
/// and never types into the target session. Finished couriers are reaped.
/// How long a courier waits for the session's turn to end before closing.
const COURIER_LINGER: Duration = Duration::from_secs(10 * 60);

const BODY_START: &str = "<<<RELAY MESSAGE BODY>>>";
const BODY_END: &str = "<<<END RELAY MESSAGE BODY>>>";

pub struct SystemCourier {
    config: MuseConfig,
    model: Option<String>,
    in_flight: std::sync::Mutex<Vec<CourierProc>>,
}

impl SystemCourier {
    pub fn new(config: MuseConfig, model: Option<String>) -> Self {
        Self {
            config,
            model,
            in_flight: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Reap any couriers whose process has exited.
    #[cfg(unix)]
    fn reap_exited(in_flight: &mut Vec<CourierProc>) {
        in_flight.retain_mut(|courier| {
            let mut status = 0;
            // WNOHANG: non-blocking reap; keep the courier if still running.
            let done = unsafe { libc::waitpid(courier.pid, &mut status, libc::WNOHANG) };
            if done == courier.pid {
                if let Some(handle) = courier._drain.take() {
                    let _ = handle.join();
                }
                false
            } else {
                true
            }
        });
    }

    /// Windows launches no courier (`launch`), so none is ever in flight.
    #[cfg(windows)]
    fn reap_exited(_in_flight: &mut Vec<CourierProc>) {}

    /// The courier session id Muse minted for `pid`: the registry record whose
    /// `process_generation_hint` names that pid.
    fn session_for_pid(&self, pid: i32) -> Option<String> {
        let entries = std::fs::read_dir(self.config.registry_dir()).ok()?;
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(data) = std::fs::read(entry.path()) {
                if let Some(record) = crate::relay::muse::decode_registry_record(&data) {
                    if record.pid == pid {
                        return Some(record.session_id);
                    }
                }
            }
        }
        None
    }

    /// The courier's one instruction. The message comes last, between
    /// marker lines, so nothing after it can be read as part of the body.
    fn forwarding_prompt(target_session: &str, text: &str) -> String {
        format!(
            "Call the send_session_message tool exactly once, with target \
             {target_session} and a body that is exactly the text between the \
             line {BODY_START} and the line {BODY_END} below, without those two \
             lines and with nothing added or removed. Do not call any other \
             tool, do not load skills, and stop after that one call.\n\
             {BODY_START}\n{text}\n{BODY_END}"
        )
    }

    /// Launch a courier in `workspace` that runs the forwarding prompt, and
    /// return the process and the courier session id Muse minted for it.
    #[cfg(unix)]
    fn launch(&self, workspace: &Path, target_session: &str, text: &str) -> Option<CourierProc> {
        use std::os::unix::io::{AsRawFd, FromRawFd};
        use std::os::unix::process::CommandExt;

        let mut master: libc::c_int = 0;
        let mut slave: libc::c_int = 0;
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        size.ws_row = 24;
        size.ws_col = 80;
        if unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut::<libc::termios>(),
                &mut size as *mut libc::winsize,
            )
        } != 0
        {
            return None;
        }

        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        let path_var = std::env::var_os("PATH");
        let launcher = crate::relay::muse::launcher(&home, path_var.as_deref())?;
        let mut command = std::process::Command::new(&launcher);
        command.env(
            "PATH",
            crate::relay::muse::courier_path(&launcher, path_var.as_deref()),
        );
        // The target's store, not whatever `XDG_DATA_HOME` this probe
        // inherited. The courier's registry and the session log are read
        // back from `self.config`, so the process must write there too.
        if let Some(data_home) = self.config.data_home() {
            command.env("XDG_DATA_HOME", data_home);
        }
        command.current_dir(workspace);
        command.env("TERM", "xterm-256color");
        command.arg("--reasoning-effort").arg("low");
        command.arg("--trust-workspace");
        if let Some(full_access) = crate::relay::harness::muse::courier_access(
            &self.config,
            &crate::relay::process::SystemProcesses::default(),
            crate::relay::peer::current_uid(),
            target_session,
        ) {
            command.args(["--approval-mode", "never"]);
            if full_access {
                command.arg("--yolo");
            }
        }
        if let Some(model) = &self.model {
            command.arg("--model").arg(model);
        }
        // The forwarding prompt runs on startup; no keystrokes are sent.
        command
            .arg("--")
            .arg(Self::forwarding_prompt(target_session, text));
        command.env(crate::relay::muse::COURIER_MARKER, "1");
        command.env_remove(crate::relay::harness::muse::SPAWN_MARKER);
        command.env_remove(crate::relay::harness::muse::SPAWN_ACCESS);
        command.env_remove("RELAY_ATTEST_SESSION_ID");
        command.env_remove("MUSE_TOOL_USE_ID");
        let slave_fd = slave;
        unsafe {
            command
                .stdin(std::process::Stdio::from_raw_fd(libc::dup(slave_fd)))
                .stdout(std::process::Stdio::from_raw_fd(libc::dup(slave_fd)))
                .stderr(std::process::Stdio::from_raw_fd(libc::dup(slave_fd)));
            command.pre_exec(move || {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(slave_fd, libc::TIOCSCTTY as libc::c_ulong, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                unsafe {
                    libc::close(master);
                    libc::close(slave);
                }
                return None;
            }
        };
        unsafe {
            libc::close(slave);
        }
        let pid = child.id() as i32;
        // Reaping is by pid through waitpid; let the Child go without waiting.
        std::mem::forget(child);

        // Drain the PTY so the TUI never blocks writing its redraws.
        let master_file = unsafe { std::fs::File::from_raw_fd(master) };
        let drain_fd = master_file.as_raw_fd();
        let drain = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                let n = unsafe {
                    libc::read(drain_fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len())
                };
                if n <= 0 {
                    break;
                }
            }
        });

        // Readiness from the registry, not the screen.
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(session_id) = self.session_for_pid(pid) {
                return Some(CourierProc {
                    pid,
                    _master: master_file,
                    _drain: Some(drain),
                    session_id_holder: session_id,
                });
            }
            if Instant::now() >= deadline {
                let mut proc = CourierProc {
                    pid,
                    _master: master_file,
                    _drain: Some(drain),
                    session_id_holder: String::new(),
                };
                proc.reap();
                return None;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// A courier is a Muse TUI on a PTY the probe owns, which needs Unix
    /// `openpty` and a controlling terminal: Windows launches none, and
    /// Muse is reported unavailable there.
    #[cfg(windows)]
    fn launch(&self, _workspace: &Path, _target_session: &str, _text: &str) -> Option<CourierProc> {
        None
    }
}

impl Drop for SystemCourier {
    fn drop(&mut self) {
        let in_flight = self
            .in_flight
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        for mut courier in in_flight.drain(..) {
            courier.reap();
        }
    }
}

impl Courier for SystemCourier {
    fn release(&self, courier_session: &str) {
        let courier = {
            let mut in_flight = self.in_flight.lock().unwrap();
            let index = in_flight
                .iter()
                .position(|courier| courier.session_id_holder == courier_session);
            index.map(|index| in_flight.remove(index))
        };
        if let Some(mut courier) = courier {
            courier.reap();
        }
    }

    fn forward(&self, workspace: &Path, target_session: &str, text: &str) -> Forwarded {
        let key = std::fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        let mut in_flight = self.in_flight.lock().unwrap();
        Self::reap_exited(&mut in_flight);
        match self.launch(&key, target_session, text) {
            Some(courier) => {
                let courier_session = courier.session_id_holder.clone();
                in_flight.push(courier);
                Forwarded::Sent { courier_session }
            }
            None => Forwarded::Unavailable,
        }
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;

    #[test]
    fn dropping_the_courier_reaps_only_its_in_flight_child() {
        fn child() -> std::process::Child {
            let mut command = std::process::Command::new("/bin/sh");
            crate::relay::detach::new_session(&mut command);
            command
                .args(["-c", "sleep 30"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap()
        }
        let mut owned = child();
        let mut unrelated = child();
        let dir = tempfile::tempdir().unwrap();
        let courier = SystemCourier::new(
            MuseConfig {
                data_dir: dir.path().join("muse"),
            },
            None,
        );
        courier.in_flight.lock().unwrap().push(CourierProc {
            pid: owned.id() as i32,
            _master: std::fs::File::open("/dev/null").unwrap(),
            _drain: None,
            session_id_holder: "test-owned-session".into(),
        });
        drop(courier);
        // ECHILD also proves CourierProc reaped the direct child itself.
        let owned_gone = !matches!(owned.try_wait(), Ok(None));
        let unrelated_running = matches!(unrelated.try_wait(), Ok(None));
        for process in [&mut owned, &mut unrelated] {
            if matches!(process.try_wait(), Ok(None)) {
                // SAFETY: an unreaped child we just created owns this group.
                unsafe {
                    libc::killpg(process.id() as i32, libc::SIGKILL);
                }
                let _ = process.wait();
            }
        }
        assert!(
            owned_gone,
            "an in-flight courier survived its owner dropping"
        );
        assert!(
            unrelated_running,
            "courier cleanup touched an unrelated process"
        );
    }
    use std::sync::Mutex;

    const TARGET: &str = "01a114ae-1885-7813-8596-26170831558f";

    fn target(tmp: &Path) -> Target {
        Target {
            session_id: TARGET.into(),
            workspace_root: tmp.join("ws"),
            workspace_id: "rw_1".into(),
            owner_id: "owner".into(),
            owner_uid: unsafe { libc::getuid() },
        }
    }

    #[derive(Default)]
    struct FakeCourier {
        sent: Mutex<Vec<(PathBuf, String, String)>>,
        released: Mutex<Vec<String>>,
        courier_session: String,
        unavailable: bool,
    }
    impl Courier for FakeCourier {
        fn release(&self, courier_session: &str) {
            self.released
                .lock()
                .unwrap()
                .push(courier_session.to_string());
        }
        fn forward(&self, workspace: &Path, target_session: &str, text: &str) -> Forwarded {
            self.sent.lock().unwrap().push((
                workspace.to_path_buf(),
                target_session.to_string(),
                text.to_string(),
            ));
            if self.unavailable {
                Forwarded::Unavailable
            } else {
                Forwarded::Sent {
                    courier_session: self.courier_session.clone(),
                }
            }
        }
    }

    struct FakeReceipts {
        admit: bool,
    }
    impl Receipts for FakeReceipts {
        fn admitted(&self, _t: &str, _c: &str, _text: &str, _since: Instant) -> Option<String> {
            self.admit.then(|| "muse-msg-1".to_string())
        }
    }

    fn journal_dir(tmp: &Path) -> PathBuf {
        tmp.join("spawned-muse-sessions").join("journal")
    }

    #[test]
    fn the_forwarding_prompt_ends_with_the_delimited_body() {
        let prompt = SystemCourier::forwarding_prompt(TARGET, "please ack");
        assert!(prompt.ends_with(&format!("{BODY_START}\nplease ack\n{BODY_END}")));
        assert_eq!(prompt.matches(BODY_START).count(), 2);
    }

    #[test]
    fn every_settled_courier_is_released() {
        for admit in [true, false] {
            let tmp = tempfile::tempdir().unwrap();
            let courier = Arc::new(FakeCourier {
                courier_session: "courier-1".into(),
                ..FakeCourier::default()
            });
            let outcome = deliver(
                &journal_dir(tmp.path()),
                courier.clone(),
                Arc::new(FakeReceipts { admit }),
                &target(tmp.path()),
                "relay-msg-1",
                "relay-msg-1",
                "hello",
                Duration::from_secs(1),
            );
            assert_eq!(
                *courier.released.lock().unwrap(),
                vec!["courier-1".to_string()],
                "{outcome:?}"
            );
        }
    }

    #[test]
    fn a_confirmed_send_is_delivered_and_forwards_verbatim_to_the_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let t = target(tmp.path());
        let courier = Arc::new(FakeCourier {
            courier_session: "courier-1".into(),
            ..FakeCourier::default()
        });
        let receipts = Arc::new(FakeReceipts { admit: true });
        let outcome = deliver(
            &journal_dir(tmp.path()),
            courier.clone(),
            receipts,
            &t,
            "relay-msg-1",
            "relay-msg-1",
            "hello from the relay",
            Duration::from_secs(5),
        );
        assert_eq!(
            outcome,
            Outcome::Delivered {
                receipt_id: "muse-msg-1".into()
            }
        );
        let sent = courier.sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, t.workspace_root);
        assert_eq!(sent[0].1, TARGET);
        assert_eq!(sent[0].2, "hello from the relay"); // verbatim
    }

    #[test]
    fn a_confirmed_delivery_replays_without_forwarding_again() {
        let tmp = tempfile::tempdir().unwrap();
        let t = target(tmp.path());
        let courier = Arc::new(FakeCourier {
            courier_session: "courier-1".into(),
            ..FakeCourier::default()
        });
        let args = || {
            deliver(
                &journal_dir(tmp.path()),
                courier.clone(),
                Arc::new(FakeReceipts { admit: true }),
                &t,
                "relay-msg-1",
                "relay-msg-1",
                "hi",
                Duration::from_secs(5),
            )
        };
        assert!(matches!(args(), Outcome::Delivered { .. }));
        // Same relay message id again: replayed from the journal, courier not
        // asked a second time.
        assert!(matches!(args(), Outcome::Delivered { .. }));
        assert_eq!(courier.sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_unconfirmed_send_is_in_doubt_and_is_never_resent() {
        let tmp = tempfile::tempdir().unwrap();
        let t = target(tmp.path());
        let courier = Arc::new(FakeCourier {
            courier_session: "courier-1".into(),
            ..FakeCourier::default()
        });
        let outcome = deliver(
            &journal_dir(tmp.path()),
            courier.clone(),
            Arc::new(FakeReceipts { admit: false }),
            &t,
            "relay-msg-1",
            "relay-msg-1",
            "hi",
            Duration::from_secs(1),
        );
        assert!(matches!(outcome, Outcome::InDoubt(_)));
        assert_eq!(courier.sent.lock().unwrap().len(), 1);
        // A later attempt for the same message never forwards again.
        let again = deliver(
            &journal_dir(tmp.path()),
            courier.clone(),
            Arc::new(FakeReceipts { admit: true }),
            &t,
            "relay-msg-1",
            "relay-msg-1",
            "hi",
            Duration::from_secs(1),
        );
        assert!(matches!(again, Outcome::InDoubt(_)));
        assert_eq!(courier.sent.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_unavailable_courier_retries_and_wrote_nothing_durable() {
        let tmp = tempfile::tempdir().unwrap();
        let t = target(tmp.path());
        let courier = Arc::new(FakeCourier {
            unavailable: true,
            ..FakeCourier::default()
        });
        let outcome = deliver(
            &journal_dir(tmp.path()),
            courier.clone(),
            Arc::new(FakeReceipts { admit: false }),
            &t,
            "relay-msg-1",
            "relay-msg-1",
            "hi",
            Duration::from_secs(1),
        );
        assert!(matches!(outcome, Outcome::Retry(_)));
        // Retry claim wrote nothing durable, so a real send can still happen.
        let ok = deliver(
            &journal_dir(tmp.path()),
            Arc::new(FakeCourier {
                courier_session: "courier-1".into(),
                ..FakeCourier::default()
            }),
            Arc::new(FakeReceipts { admit: true }),
            &t,
            "relay-msg-1",
            "relay-msg-1",
            "hi",
            Duration::from_secs(1),
        );
        assert!(matches!(ok, Outcome::Delivered { .. }));
    }

    /// Live end-to-end against a Muse TUI the tester opened. Set
    /// MUSE_TEST_TARGET=<session id>, MUSE_TEST_WS=<its workspace>, and
    /// optionally MUSE_TEST_MODEL. Run with:
    ///   cargo test -p agent-relay-probe --lib \
    ///     relay::harness::muse::courier::tests::live_courier_delivers \
    ///     -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_courier_delivers() {
        let target_id = std::env::var("MUSE_TEST_TARGET").expect("MUSE_TEST_TARGET");
        let ws = std::env::var("MUSE_TEST_WS").expect("MUSE_TEST_WS");
        let model = std::env::var("MUSE_TEST_MODEL").ok();
        let home = dirs_home();
        let config = MuseConfig::from_env(&|k| std::env::var(k).ok(), &home);
        let courier = Arc::new(SystemCourier::new(config.clone(), model));
        let receipts = Arc::new(SystemReceipts::new(&config));
        let t = Target {
            session_id: target_id,
            workspace_root: PathBuf::from(ws),
            workspace_id: "rw_test".into(),
            owner_id: "tester".into(),
            owner_uid: unsafe { libc::getuid() },
        };
        let tmp = tempfile::tempdir().unwrap();
        let outcome = deliver(
            &tmp.path().join("spawned-muse-sessions").join("journal"),
            courier.clone(),
            receipts,
            &t,
            "live-relay-msg-1",
            "live-relay-msg-1",
            "Relay courier live test: this message was delivered by the probe.",
            Duration::from_secs(30),
        );
        println!("LIVE COURIER OUTCOME: {outcome:?}");
        // A short test process must not exit while the production linger
        // thread still owns its courier. Wait for the target's terminal event
        // and release, then clean up even when an assertion will fail.
        let deadline = Instant::now() + Duration::from_secs(30);
        while !courier.in_flight.lock().unwrap().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(200));
        }
        let released = courier.in_flight.lock().unwrap().is_empty();
        let pending: Vec<String> = courier
            .in_flight
            .lock()
            .unwrap()
            .iter()
            .map(|proc| proc.session_id_holder.clone())
            .collect();
        for session in pending {
            courier.release(&session);
        }
        println!("LIVE COURIER RELEASED: {released}");
        assert!(matches!(outcome, Outcome::Delivered { .. }), "{outcome:?}");
        assert!(
            released,
            "the courier did not release after the target turn ended"
        );
    }

    fn dirs_home() -> PathBuf {
        PathBuf::from(std::env::var("HOME").expect("HOME"))
    }

    #[test]
    fn references_round_trip() {
        assert_eq!(courier_reference(TARGET), format!("muse-open:{TARGET}"));
        assert!(is_courier_reference(&courier_reference(TARGET)));
        assert!(!is_courier_reference("existing:grok:x"));
    }
}
