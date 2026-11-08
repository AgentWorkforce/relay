//! Delivery into a Muse session a person opened, through a probe-owned
//! courier. The courier is an interactive Muse session the probe launches on
//! a PTY it owns, in the target session's exact workspace and trust, as the
//! same user — the desktop's own process, like a broker-spawned PTY worker.
//! Muse admits a peer message between two same-workspace, same-trust sessions
//! with no prompt (`exact_profile_match`), so the courier forwards the relay
//! text and the turn renders in the person's session. The probe never types
//! into the person's session.
//!
//! The receipt is read from the *target's* own log: once Muse records
//! `peer_message.admission.settled` `accepted` for a message from our courier
//! whose text equals ours, the turn is durably in the person's session. The
//! shared [`Journal`]/[`Coordinator`] give dedupe on the relay message id, a
//! per-session lock, confirmed-replay, and never-resend-in-doubt — the same
//! guarantees the Grok adapter relies on. A courier send is not model-
//! idempotent, so `replay` only reconciles by reading the target log; it never
//! forwards a second time.

mod receipts;
pub use receipts::SystemReceipts;

use super::{Binding, Coordinator, Failure, Gate, Journal, Outcome, Provider, Request, Transport};
use crate::relay::muse::MuseConfig;
#[cfg(unix)]
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The non-secret credential reference a muse-open binding carries.
pub fn courier_reference(session_id: &str) -> String {
    format!("muse-open:{session_id}")
}

/// Whether a reference is a muse-open one.
pub fn is_courier_reference(reference: &str) -> bool {
    reference.starts_with("muse-open:")
}

/// What the probe proved about a target session at delivery time, enough to
/// build a [`Binding`] for the courier route.
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
/// own the courier processes; the probe never drives the person's session.
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

impl super::Adapter for MuseCourierAdapter {
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

/// One delivery into an open Muse session through a courier, with the shared
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
    if !super::platform::SUPPORTED {
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

/// The `MuseConfig` default journal directory under the app data home.
pub fn default_journal_dir(config: &MuseConfig, app_data: &Path) -> PathBuf {
    let _ = config;
    app_data.join("existing-muse-sessions").join("journal")
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
    _private_store: Option<PrivateStore>,
}

/// One launch's private XDG data home. Dropping it removes the entire home, so
/// cleanup does not depend on Muse publishing a session id before a timeout.
struct PrivateStore {
    root: PathBuf,
    #[cfg(unix)]
    parent: std::fs::File,
    #[cfg(unix)]
    directory: std::fs::File,
    #[cfg(unix)]
    name: std::ffi::CString,
}

#[cfg(unix)]
struct InheritedDataHome {
    directory: std::fs::File,
    path: PathBuf,
    #[cfg(not(target_os = "linux"))]
    path_name: std::ffi::CString,
}

#[cfg(unix)]
impl InheritedDataHome {
    /// Prepare the already-open store for the exec boundary. Linux can name a
    /// directory fd directly; macOS cannot traverse `/dev/fd/<n>`, so its
    /// current kernel path is checked against the retained inode immediately
    /// before exec and the launch fails closed if it changed again.
    unsafe fn prepare_for_exec(&self) -> std::io::Result<()> {
        #[cfg(target_os = "linux")]
        use std::os::fd::AsRawFd;

        #[cfg(target_os = "linux")]
        {
            let fd = self.directory.as_raw_fd();
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags == -1 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1 {
                return Err(std::io::Error::last_os_error());
            }
        }
        #[cfg(not(target_os = "linux"))]
        if !private_path_is(&self.path_name, &self.directory)? {
            return Err(std::io::Error::other(
                "private Muse courier data home changed before exec",
            ));
        }
        Ok(())
    }
}

impl PrivateStore {
    #[cfg(unix)]
    fn inherited_data_home(&self) -> std::io::Result<InheritedDataHome> {
        use std::os::fd::AsRawFd;
        #[cfg(not(target_os = "linux"))]
        use std::os::unix::ffi::OsStrExt;

        let directory = self.directory.try_clone()?;
        #[cfg(target_os = "linux")]
        let path = Path::new("/proc/self/fd").join(directory.as_raw_fd().to_string());
        #[cfg(target_os = "macos")]
        let path = {
            let mut bytes = vec![0u8; libc::PATH_MAX as usize];
            if unsafe {
                libc::fcntl(
                    directory.as_raw_fd(),
                    libc::F_GETPATH,
                    bytes.as_mut_ptr().cast::<libc::c_char>(),
                )
            } == -1
            {
                return Err(std::io::Error::last_os_error());
            }
            let end = bytes.iter().position(|byte| *byte == 0).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "private Muse courier path was not terminated",
                )
            })?;
            PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..end]))
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let path = self.root.clone();
        #[cfg(not(target_os = "linux"))]
        let path_name = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "NUL in private Muse courier path",
            )
        })?;
        Ok(InheritedDataHome {
            directory,
            path,
            #[cfg(not(target_os = "linux"))]
            path_name,
        })
    }

    #[cfg(unix)]
    fn remove_once(&self) -> std::io::Result<()> {
        remove_private_contents(&self.directory)?;
        if !private_name_is(&self.parent, &self.name, &self.directory)? {
            return Err(std::io::Error::other(
                "private Muse courier directory changed during cleanup",
            ));
        }
        let removed = unsafe {
            libc::unlinkat(
                std::os::fd::AsRawFd::as_raw_fd(&self.parent),
                self.name.as_ptr(),
                libc::AT_REMOVEDIR,
            )
        };
        if removed == -1 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn remove_once(&self) -> std::io::Result<()> {
        std::fs::remove_dir_all(&self.root)
    }

    fn remove(&self) -> std::io::Result<()> {
        let mut last = None;
        for attempt in 0..3 {
            match self.remove_once() {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => last = Some(error),
            }
            if attempt < 2 {
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        Err(last.expect("a failed private-store removal records its error"))
    }
}

#[cfg(unix)]
fn private_name(value: &str) -> std::io::Result<std::ffi::CString> {
    std::ffi::CString::new(value)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in directory name"))
}

#[cfg(unix)]
fn open_private_dir(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    options.open(path)
}

#[cfg(unix)]
fn open_private_child(
    parent: &std::fs::File,
    child: &std::ffi::CStr,
) -> std::io::Result<std::fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd};

    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            child.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

/// Removes an empty directory created before its validated handle was ready.
/// It never descends, so a replacement non-empty tree is left untouched.
#[cfg(unix)]
struct PendingPrivateDir {
    parent: Option<std::fs::File>,
    name: std::ffi::CString,
    armed: bool,
}

#[cfg(unix)]
impl PendingPrivateDir {
    fn finish(mut self, directory: std::fs::File) -> CreatedPrivateDir {
        self.armed = false;
        CreatedPrivateDir {
            parent: self
                .parent
                .take()
                .expect("pending directory has its parent"),
            directory,
            name: self.name.clone(),
        }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

#[cfg(unix)]
impl Drop for PendingPrivateDir {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;

        if self.armed {
            if let Some(parent) = &self.parent {
                let removed = unsafe {
                    libc::unlinkat(parent.as_raw_fd(), self.name.as_ptr(), libc::AT_REMOVEDIR)
                };
                if removed == -1 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() != std::io::ErrorKind::NotFound {
                        eprintln!(
                            "Agent Relay could not roll back private Muse courier directory {}: {error}",
                            self.name.to_string_lossy()
                        );
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
struct CreatedPrivateDir {
    parent: std::fs::File,
    directory: std::fs::File,
    name: std::ffi::CString,
}

#[cfg(unix)]
fn private_child_dir(parent: &std::fs::File, child: &str) -> std::io::Result<std::fs::File> {
    use std::os::fd::AsRawFd;

    let child = private_name(child)?;
    // Clone before mkdir so every post-create failure has an owned rollback
    // handle and cannot strand the new directory.
    let rollback_parent = parent.try_clone()?;
    let created = unsafe { libc::mkdirat(parent.as_raw_fd(), child.as_ptr(), 0o700) };
    let pending = if created == 0 {
        Some(PendingPrivateDir {
            parent: Some(rollback_parent),
            name: child.clone(),
            armed: true,
        })
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error);
        }
        None
    };
    let directory = open_private_child(parent, &child)?;
    if unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    if let Some(pending) = pending {
        pending.disarm();
    }
    Ok(directory)
}

#[cfg(unix)]
fn private_unique_child(
    parent: &std::fs::File,
    prefix: &str,
) -> std::io::Result<CreatedPrivateDir> {
    use std::os::fd::AsRawFd;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    for _ in 0..100 {
        let child = format!(
            "{prefix}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let child = private_name(&child)?;
        // Acquire the rollback handle before creation. Once mkdir succeeds,
        // PendingPrivateDir owns cleanup until the validated fd is returned.
        let rollback_parent = parent.try_clone()?;
        let created = unsafe { libc::mkdirat(parent.as_raw_fd(), child.as_ptr(), 0o700) };
        if created == 0 {
            let pending = PendingPrivateDir {
                parent: Some(rollback_parent),
                name: child.clone(),
                armed: true,
            };
            let directory = open_private_child(parent, &child)?;
            if unsafe { libc::fchmod(directory.as_raw_fd(), 0o700) } == -1 {
                return Err(std::io::Error::last_os_error());
            }
            return Ok(pending.finish(directory));
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not allocate a private courier directory",
    ))
}

#[cfg(unix)]
fn private_stat_at(parent: &std::fs::File, name: &std::ffi::CStr) -> std::io::Result<libc::stat> {
    use std::os::fd::AsRawFd;

    let mut stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } == -1
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(stat)
}

#[cfg(unix)]
fn private_name_is(
    parent: &std::fs::File,
    name: &std::ffi::CStr,
    directory: &std::fs::File,
) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;

    let named = private_stat_at(parent, name)?;
    let mut opened: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(directory.as_raw_fd(), &mut opened) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(named.st_dev == opened.st_dev
        && named.st_ino == opened.st_ino
        && named.st_mode & libc::S_IFMT == libc::S_IFDIR)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn private_path_is(path: &std::ffi::CStr, directory: &std::fs::File) -> std::io::Result<bool> {
    use std::os::fd::AsRawFd;

    let mut named: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            libc::AT_FDCWD,
            path.as_ptr(),
            &mut named,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } == -1
    {
        return Err(std::io::Error::last_os_error());
    }
    let mut opened: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(directory.as_raw_fd(), &mut opened) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(named.st_dev == opened.st_dev
        && named.st_ino == opened.st_ino
        && named.st_mode & libc::S_IFMT == libc::S_IFDIR)
}

#[cfg(unix)]
fn private_entries(directory: &std::fs::File) -> std::io::Result<Vec<std::ffi::CString>> {
    use std::ffi::CStr;
    use std::os::fd::{FromRawFd, IntoRawFd};

    // openat(".") creates a new directory description whose readdir offset is
    // independent of the long-lived cleanup handle and of previous retries.
    let current = private_name(".")?;
    let scan = open_private_child(directory, &current)?;
    let scan_fd = scan.into_raw_fd();
    let stream = unsafe { libc::fdopendir(scan_fd) };
    if stream.is_null() {
        let error = std::io::Error::last_os_error();
        drop(unsafe { std::fs::File::from_raw_fd(scan_fd) });
        return Err(error);
    }
    struct Stream(*mut libc::DIR);
    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let stream = Stream(stream);
    let mut entries = Vec::new();
    loop {
        nix::errno::Errno::clear();
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let error = nix::errno::errno();
            if error != 0 {
                return Err(std::io::Error::from_raw_os_error(error));
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            entries.push(name.to_owned());
        }
    }
    Ok(entries)
}

#[cfg(unix)]
fn remove_private_contents(directory: &std::fs::File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;

    for name in private_entries(directory)? {
        let stat = match private_stat_at(directory, &name) {
            Ok(stat) => stat,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
            let child = open_private_child(directory, &name)?;
            remove_private_contents(&child)?;
            if !private_name_is(directory, &name, &child)? {
                return Err(std::io::Error::other(
                    "private Muse courier child changed during cleanup",
                ));
            }
            if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
                == -1
            {
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error);
                }
            }
        } else if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } == -1 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error);
            }
        }
    }
    Ok(())
}

impl Drop for PrivateStore {
    fn drop(&mut self) {
        if let Err(error) = self.remove() {
            eprintln!(
                "Agent Relay could not remove private Muse courier store {}: {error}",
                self.root.display()
            );
        }
    }
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
/// and never types into the person's session. Finished couriers are reaped.
/// How long a courier waits for the session's turn to end before closing.
const COURIER_LINGER: Duration = Duration::from_secs(10 * 60);

const BODY_START: &str = "<<<RELAY MESSAGE BODY>>>";
const BODY_END: &str = "<<<END RELAY MESSAGE BODY>>>";

pub struct SystemCourier {
    config: MuseConfig,
    private_base: Option<PathBuf>,
    model: Option<String>,
    in_flight: std::sync::Mutex<Vec<CourierProc>>,
}

impl SystemCourier {
    pub fn new(config: MuseConfig, model: Option<String>) -> Self {
        Self {
            config,
            private_base: None,
            model,
            in_flight: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Keep the courier's required session log in Relay-owned app data while
    /// linking only Muse's live registry to the target's store. Peer messaging
    /// requires session logging, but Desktop history must not ingest this
    /// implementation-only conversation.
    pub fn isolated(config: MuseConfig, model: Option<String>, private_base: PathBuf) -> Self {
        let config = MuseConfig {
            data_dir: std::path::absolute(&config.data_dir).unwrap_or(config.data_dir),
        };
        let private_base = std::path::absolute(&private_base).unwrap_or(private_base);
        Self {
            config,
            private_base: Some(private_base),
            model,
            in_flight: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Prepare a unique `<base>/couriers/<target+store>/<launch>/muse` data
    /// home, linking only its runtime registry to the target's. Every ancestor
    /// below `base` is opened with `O_NOFOLLOW`; stale links or files fail
    /// closed instead of redirecting transcripts or permission changes.
    #[cfg(unix)]
    fn prepare_private_store(&self, target_session: &str) -> Option<PrivateStore> {
        use std::ffi::CString;
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;

        let base = self.private_base.as_ref()?;
        if !base.is_absolute() || !self.config.data_dir.is_absolute() {
            return None;
        }
        let base_dir = open_private_dir(base).ok()?;
        let couriers_dir = private_child_dir(&base_dir, "couriers").ok()?;
        let mut key = Sha256::new();
        key.update(target_session.as_bytes());
        key.update([0]);
        key.update(self.config.data_dir.as_os_str().as_bytes());
        let target_key = format!("{:x}", key.finalize());
        let target_dir = private_child_dir(&couriers_dir, &target_key[..24]).ok()?;
        let launch = private_unique_child(&target_dir, "launch").ok()?;
        let launch_name = launch.name.to_str().ok()?;
        let root = base
            .join("couriers")
            .join(&target_key[..24])
            .join(launch_name);
        // From this point every early return removes the launch directory.
        let private = PrivateStore {
            root,
            parent: launch.parent,
            directory: launch.directory,
            name: launch.name,
        };
        let muse_dir = private_child_dir(&private.directory, "muse").ok()?;
        let runtime_dir = private_child_dir(&muse_dir, "runtime").ok()?;

        let target = CString::new(self.config.runtime_dir().as_os_str().as_bytes()).ok()?;
        let registry = private_name("muse").ok()?;
        if unsafe { libc::symlinkat(target.as_ptr(), runtime_dir.as_raw_fd(), registry.as_ptr()) }
            == -1
        {
            return None;
        }
        Some(private)
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

    /// Arguments for Relay's one-shot courier. Session logging stays enabled:
    /// Muse requires it for `send_session_message`. [`Self::isolated`] keeps
    /// that log out of the user's normal Muse history instead.
    fn launch_args(&self, target_session: &str, text: &str) -> Vec<String> {
        let mut args = vec![
            "--reasoning-effort".into(),
            "low".into(),
            "--trust-workspace".into(),
        ];
        if let Some(full_access) = crate::relay::harness::muse::courier_access(
            &self.config,
            &crate::relay::process::SystemProcesses::default(),
            crate::relay::peer::current_uid(),
            target_session,
        ) {
            args.extend(["--approval-mode".into(), "never".into()]);
            if full_access {
                args.push("--yolo".into());
            }
        }
        if let Some(model) = &self.model {
            args.extend(["--model".into(), model.clone()]);
        }
        args.extend(["--".into(), Self::forwarding_prompt(target_session, text)]);
        args
    }

    /// Launch a courier in `workspace` that runs the forwarding prompt, and
    /// return the process and the courier session id Muse minted for it.
    #[cfg(unix)]
    fn launch(&self, workspace: &Path, target_session: &str, text: &str) -> Option<CourierProc> {
        use std::os::unix::io::{AsRawFd, FromRawFd};
        use std::os::unix::process::CommandExt;

        // Prepare fallible filesystem state before opening PTY descriptors so
        // a broken private store cannot leak them across delivery retries.
        let private_store = if self.private_base.is_some() {
            Some(self.prepare_private_store(target_session)?)
        } else {
            None
        };
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        let path_var = std::env::var_os("PATH");
        let launcher = crate::relay::muse::launcher(&home, path_var.as_deref())?;
        let mut master_fd: libc::c_int = 0;
        let mut slave_fd: libc::c_int = 0;
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        size.ws_row = 24;
        size.ws_col = 80;
        if unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut::<libc::termios>(),
                &mut size as *mut libc::winsize,
            )
        } != 0
        {
            return None;
        }
        // Acquire owners immediately: every later return closes both PTY
        // descriptors as well as the unique private store.
        let master_file = unsafe { std::fs::File::from_raw_fd(master_fd) };
        let slave_file = unsafe { std::fs::File::from_raw_fd(slave_fd) };

        let mut command = std::process::Command::new(&launcher);
        command.env(
            "PATH",
            crate::relay::muse::courier_path(&launcher, path_var.as_deref()),
        );
        // The isolated store retains the session log but links its registry
        // to the target store. A non-isolated courier keeps the legacy target
        // store behavior for direct callers and tests.
        let (inherited_data_home, data_home) = if let Some(store) = &private_store {
            let inherited = store.inherited_data_home().ok()?;
            let path = inherited.path.clone();
            (Some(inherited), Some(path))
        } else {
            (None, self.config.data_home().map(Path::to_path_buf))
        };
        if let Some(data_home) = data_home {
            command.env("XDG_DATA_HOME", data_home);
        }
        command.current_dir(workspace);
        command.env("TERM", "xterm-256color");
        // The forwarding prompt runs on startup; no keystrokes are sent.
        command.args(self.launch_args(target_session, text));
        command.env(crate::relay::muse::COURIER_MARKER, "1");
        command.env_remove(crate::relay::harness::muse::SPAWN_MARKER);
        command.env_remove(crate::relay::harness::muse::SPAWN_ACCESS);
        command.env_remove("RELAY_ATTEST_SESSION_ID");
        command.env_remove("MUSE_TOOL_USE_ID");
        let stdin = slave_file.try_clone().ok()?;
        let stdout = slave_file.try_clone().ok()?;
        let stderr = slave_file.try_clone().ok()?;
        let slave_fd = slave_file.as_raw_fd();
        unsafe {
            command
                .stdin(std::process::Stdio::from(stdin))
                .stdout(std::process::Stdio::from(stdout))
                .stderr(std::process::Stdio::from(stderr));
            command.pre_exec(move || {
                if let Some(data_home) = &inherited_data_home {
                    data_home.prepare_for_exec()?;
                }
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
            Err(_) => return None,
        };
        // Command retains its configured Stdio handles after spawn. Release
        // those slave clones before readiness polling so timeout reaping can
        // close the PTY and join the master reader.
        drop(command);
        drop(slave_file);
        let pid = child.id() as i32;
        // Reaping is by pid through waitpid; let the Child go without waiting.
        std::mem::forget(child);

        // Drain the PTY so the TUI never blocks writing its redraws.
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
                    _private_store: private_store,
                });
            }
            if Instant::now() >= deadline {
                let mut proc = CourierProc {
                    pid,
                    _master: master_file,
                    _drain: Some(drain),
                    session_id_holder: String::new(),
                    _private_store: private_store,
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
            _private_store: None,
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
        tmp.join("existing-muse-sessions").join("journal")
    }

    #[test]
    fn the_forwarding_prompt_ends_with_the_delimited_body() {
        let prompt = SystemCourier::forwarding_prompt(TARGET, "please ack");
        assert!(prompt.ends_with(&format!("{BODY_START}\nplease ack\n{BODY_END}")));
        assert_eq!(prompt.matches(BODY_START).count(), 2);
    }

    #[test]
    fn a_courier_isolated_store_keeps_messaging_enabled_and_history_private() {
        let tmp = tempfile::tempdir().unwrap();
        let target_store = MuseConfig {
            data_dir: tmp.path().join("target").join("muse"),
        };
        std::fs::create_dir_all(target_store.runtime_dir()).unwrap();
        let private_base = tmp.path().join("relay-private");
        std::fs::create_dir_all(&private_base).unwrap();
        let courier = SystemCourier::isolated(target_store.clone(), None, private_base.clone());
        let private_store = courier.prepare_private_store(TARGET).unwrap();
        let args = courier.launch_args(TARGET, "please ack");
        assert!(!args.iter().any(|arg| arg == "--no-session-log"));
        assert!(private_store
            .root
            .starts_with(private_base.join("couriers")));
        assert_eq!(
            std::fs::read_link(private_store.root.join("muse/runtime/muse")).unwrap(),
            target_store.runtime_dir()
        );
        assert_ne!(private_store.root.join("muse"), target_store.data_dir);
        assert_eq!(
            args.last(),
            Some(&SystemCourier::forwarding_prompt(TARGET, "please ack"))
        );
    }

    #[test]
    fn releasing_an_isolated_courier_removes_only_its_private_transcript() {
        let tmp = tempfile::tempdir().unwrap();
        let target_store = MuseConfig {
            data_dir: tmp.path().join("target").join("muse"),
        };
        std::fs::create_dir_all(target_store.runtime_dir()).unwrap();
        let private_base = tmp.path().join("relay-private");
        std::fs::create_dir_all(&private_base).unwrap();
        let system = SystemCourier::isolated(target_store.clone(), None, private_base);
        let private_store = system.prepare_private_store(TARGET).unwrap();
        let relative = Path::new("sessions/2026/11/07").join(TARGET);
        let private_session = private_store.root.join("muse").join(&relative);
        let target_session = target_store.data_dir.join(&relative);
        let private_root = private_store.root.clone();
        std::fs::create_dir_all(&private_session).unwrap();
        std::fs::create_dir_all(&target_session).unwrap();
        std::fs::write(private_session.join("session.jsonl"), b"private").unwrap();
        std::fs::write(target_session.join("session.jsonl"), b"target").unwrap();

        let courier = CourierProc {
            pid: 0,
            _master: std::fs::File::open("/dev/null").unwrap(),
            _drain: None,
            // Cleanup must not depend on registry discovery succeeding.
            session_id_holder: String::new(),
            _private_store: Some(private_store),
        };
        drop(courier);

        assert!(!private_root.exists());
        assert!(target_session.join("session.jsonl").is_file());
    }

    #[test]
    fn cleanup_stays_on_the_open_directory_when_the_hash_path_is_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let target_store = MuseConfig {
            data_dir: tmp.path().join("target").join("muse"),
        };
        std::fs::create_dir_all(target_store.runtime_dir()).unwrap();
        let private_base = tmp.path().join("relay-private");
        std::fs::create_dir_all(&private_base).unwrap();
        let system = SystemCourier::isolated(target_store, None, private_base);
        let private_store = system.prepare_private_store(TARGET).unwrap();
        let launch_root = private_store.root.clone();
        let launch_name = launch_root.file_name().unwrap().to_owned();
        let hash_dir = launch_root.parent().unwrap().to_path_buf();
        let couriers_dir = hash_dir.parent().unwrap();
        let moved_hash = couriers_dir.join("moved-target-hash");

        std::fs::rename(&hash_dir, &moved_hash).unwrap();
        let unrelated = hash_dir.join("unrelated");
        std::fs::create_dir_all(&unrelated).unwrap();
        std::fs::write(unrelated.join("keep"), b"not the courier store").unwrap();

        drop(private_store);

        assert!(unrelated.join("keep").is_file());
        assert!(!moved_hash.join(launch_name).exists());
    }

    #[test]
    fn inherited_data_home_stays_on_the_open_directory_after_path_replacement() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let target_store = MuseConfig {
            data_dir: tmp.path().join("target").join("muse"),
        };
        std::fs::create_dir_all(target_store.runtime_dir()).unwrap();
        let private_base = tmp.path().join("relay-private");
        std::fs::create_dir_all(&private_base).unwrap();
        let system = SystemCourier::isolated(target_store, None, private_base);
        let private_store = system.prepare_private_store(TARGET).unwrap();
        let launch_root = private_store.root.clone();
        let moved_launch = launch_root.with_file_name("moved-launch");
        let unrelated = tmp.path().join("unrelated-data-home");

        std::fs::rename(&launch_root, &moved_launch).unwrap();
        std::fs::create_dir_all(unrelated.join("muse")).unwrap();
        symlink(&unrelated, &launch_root).unwrap();
        let inherited = private_store.inherited_data_home().unwrap();
        std::fs::write(inherited.path.join("muse").join("bound"), b"private").unwrap();

        assert!(moved_launch.join("muse").join("bound").is_file());
        assert!(!unrelated.join("muse").join("bound").exists());

        #[cfg(target_os = "macos")]
        {
            let moved_again = launch_root.with_file_name("moved-again");
            std::fs::rename(&moved_launch, &moved_again).unwrap();
            symlink(&unrelated, &moved_launch).unwrap();
            assert!(unsafe { inherited.prepare_for_exec() }.is_err());
            std::fs::remove_file(&moved_launch).unwrap();
            std::fs::rename(&moved_again, &moved_launch).unwrap();
        }

        std::fs::remove_file(&launch_root).unwrap();
        std::fs::rename(&moved_launch, &launch_root).unwrap();
        drop(inherited);
        drop(private_store);
    }

    #[test]
    fn a_pending_private_directory_is_rolled_back_before_handoff() {
        use std::os::fd::AsRawFd;

        let tmp = tempfile::tempdir().unwrap();
        let parent = open_private_dir(tmp.path()).unwrap();
        let name = private_name("pending-launch").unwrap();
        assert_eq!(
            unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) },
            0
        );
        let pending = PendingPrivateDir {
            parent: Some(parent.try_clone().unwrap()),
            name,
            armed: true,
        };

        drop(pending);

        assert!(!tmp.path().join("pending-launch").exists());
    }

    #[test]
    fn a_symlinked_private_ancestor_is_refused_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let target_store = MuseConfig {
            data_dir: tmp.path().join("target").join("muse"),
        };
        std::fs::create_dir_all(target_store.runtime_dir()).unwrap();
        let private_base = tmp.path().join("relay-private");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&private_base).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, private_base.join("couriers")).unwrap();

        let courier = SystemCourier::isolated(target_store, None, private_base);
        assert!(courier.prepare_private_store(TARGET).is_none());
        assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
    }

    #[test]
    fn a_resumed_target_in_another_store_gets_a_fresh_registry_link() {
        let tmp = tempfile::tempdir().unwrap();
        let private_base = tmp.path().join("relay-private");
        std::fs::create_dir_all(&private_base).unwrap();
        let store = |name: &str| MuseConfig {
            data_dir: tmp.path().join(name).join("muse"),
        };
        let first_target = store("first-target");
        let second_target = store("second-target");
        std::fs::create_dir_all(first_target.runtime_dir()).unwrap();
        std::fs::create_dir_all(second_target.runtime_dir()).unwrap();

        let first = SystemCourier::isolated(first_target.clone(), None, private_base.clone())
            .prepare_private_store(TARGET)
            .unwrap();
        let second = SystemCourier::isolated(second_target.clone(), None, private_base)
            .prepare_private_store(TARGET)
            .unwrap();

        assert_ne!(first.root.parent(), second.root.parent());
        assert_eq!(
            std::fs::read_link(first.root.join("muse/runtime/muse")).unwrap(),
            first_target.runtime_dir()
        );
        assert_eq!(
            std::fs::read_link(second.root.join("muse/runtime/muse")).unwrap(),
            second_target.runtime_dir()
        );
    }

    #[test]
    fn isolated_paths_are_resolved_against_the_daemon_working_directory() {
        let courier = SystemCourier::isolated(
            MuseConfig {
                data_dir: PathBuf::from("relative-target/muse"),
            },
            None,
            PathBuf::from("relative-private-base"),
        );
        assert!(courier.config.data_dir.is_absolute());
        assert!(courier.private_base.as_ref().unwrap().is_absolute());
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
    ///   cargo test -p agent-relay-node --lib \
    ///     relay::existing_session::muse_open::tests::live_courier_delivers \
    ///     -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_courier_delivers() {
        let target_id = std::env::var("MUSE_TEST_TARGET").expect("MUSE_TEST_TARGET");
        let ws = std::env::var("MUSE_TEST_WS").expect("MUSE_TEST_WS");
        let model = std::env::var("MUSE_TEST_MODEL").ok();
        let home = dirs_home();
        let config = MuseConfig::from_env(&|k| std::env::var(k).ok(), &home);
        let tmp = tempfile::tempdir().unwrap();
        let journal = tmp.path().join("existing-muse-sessions").join("journal");
        std::fs::create_dir_all(journal.parent().unwrap()).unwrap();
        let courier = Arc::new(SystemCourier::isolated(
            config.clone(),
            model,
            journal.parent().unwrap().to_path_buf(),
        ));
        let receipts = Arc::new(SystemReceipts::new(&config));
        let t = Target {
            session_id: target_id,
            workspace_root: PathBuf::from(ws),
            workspace_id: "rw_test".into(),
            owner_id: "tester".into(),
            owner_uid: unsafe { libc::getuid() },
        };
        let outcome = deliver(
            &journal,
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
