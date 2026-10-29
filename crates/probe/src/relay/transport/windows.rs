//! The transport on Windows: a named pipe derived from the endpoint's path
//! (`super::pipe_name`).
//!
//! Every server instance is created with a protected DACL whose one entry
//! grants the current user's SID, and rejects remote clients, so the
//! operating system refuses another user's process before the core sees
//! it. The first instance is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`:
//! a pipe name another process already holds is never joined. The listener
//! always keeps one unconnected instance waiting, creating the next before
//! it hands out a connected one, so a client never finds the pipe missing
//! while the server runs.
//!
//! Identity: a client's pid comes from `GetNamedPipeClientProcessId`, and
//! its uid is the current user's (`peer::current_uid`), because the DACL
//! admitted it; a client checks the server it reached by the user of the
//! process `GetNamedPipeServerProcessId` names (`peer::process_uid`).

use super::pipe_name;
use crate::relay::peer::{self, PeerCredentials};
use std::ffi::c_void;
use std::future::Future;
use std::io;
use std::os::windows::io::{AsRawHandle, RawHandle};
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
};
use windows_sys::Win32::Foundation::{
    LocalFree, ERROR_ACCESS_DENIED, ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_BUSY,
    ERROR_PIPE_NOT_CONNECTED,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId};

/// How long a client retries a pipe whose every instance is taken: the
/// server is between accepting one client and offering the next instance.
const BUSY_WAIT: Duration = Duration::from_secs(2);
const BUSY_RETRY: Duration = Duration::from_millis(10);
/// How long `bind` waits for the instances of a server that just stopped in
/// this process (a test's fake core restarting) to close.
const BIND_WAIT: Duration = Duration::from_secs(1);
/// `SECURITY_IDENTIFICATION`: a pipe server may learn who a blocking
/// client is, never act as it. std adds `SECURITY_SQOS_PRESENT` itself.
const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;

fn os_error(error: &io::Error, code: u32) -> bool {
    error.raw_os_error() == Some(code as i32)
}

/// A read that found the other end gone: the end of the stream, as a Unix
/// socket reports it.
fn ended(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::BrokenPipe
        || os_error(error, ERROR_BROKEN_PIPE)
        || os_error(error, ERROR_PIPE_NOT_CONNECTED)
        || os_error(error, ERROR_NO_DATA)
}

pub fn is_served(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    // A plain synchronous open, so no runtime is needed; a busy pipe has
    // instances, so it is served.
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .security_qos_flags(SECURITY_IDENTIFICATION)
        .open(pipe_name(path))
    {
        Ok(_) => true,
        Err(error) => os_error(&error, ERROR_PIPE_BUSY),
    }
}

/// A self-relative security descriptor granting only the current user.
struct Security {
    descriptor: *mut c_void,
}

// SAFETY: the descriptor is written once, by the conversion that allocates
// it, then only read by CreateNamedPipeW (which copies it) until Drop frees
// it; nothing aliases it mutably.
unsafe impl Send for Security {}
unsafe impl Sync for Security {}

impl Security {
    fn current_user_only() -> io::Result<Security> {
        let sid = peer::current_user_sid()?;
        // D:P — a protected DACL (nothing inherited) with one entry: allow
        // (A) generic all (GA) to this user's SID. Everyone else is denied.
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut descriptor: *mut c_void = std::ptr::null_mut();
        // SAFETY: `sddl` is NUL-terminated and outlives the call; on success
        // `descriptor` receives a LocalAlloc'd descriptor that Drop frees.
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if converted == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Security { descriptor })
    }

    fn create(&self, name: &str, first: bool) -> io::Result<NamedPipeServer> {
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor,
            bInheritHandle: 0,
        };
        // SAFETY: `attributes` and the descriptor it points to are valid
        // for the call, which copies them into the new pipe object.
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    name,
                    (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
                )
        }
    }
}

impl Drop for Security {
    fn drop(&mut self) {
        // SAFETY: allocated by the conversion with LocalAlloc, freed once.
        unsafe { LocalFree(self.descriptor as _) };
    }
}

pub struct Listener {
    name: String,
    security: Security,
    /// The instance the next client connects to.
    pending: NamedPipeServer,
}

impl Listener {
    pub fn bind(path: &Path) -> io::Result<Listener> {
        let name = pipe_name(path);
        let security = Security::current_user_only()?;
        let deadline = Instant::now() + BIND_WAIT;
        let pending = loop {
            match security.create(&name, true) {
                Ok(server) => break server,
                Err(error) if os_error(&error, ERROR_ACCESS_DENIED) => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::AddrInUse,
                            format!("Another program already serves the pipe {name}."),
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        };
        Ok(Listener {
            name,
            security,
            pending,
        })
    }

    pub async fn accept(&mut self) -> io::Result<Stream> {
        loop {
            let connected = self.pending.connect().await;
            if let Err(error) = connected {
                // That instance is spent (typically a client came and went
                // before it was accepted): offer a fresh one.
                self.pending = self.security.create(&self.name, false)?;
                if os_error(&error, ERROR_NO_DATA) {
                    continue;
                }
                return Err(error);
            }
            // The next instance exists before this one is handed out. If it
            // cannot be created, the connected one stays pending and the
            // next accept returns it at once.
            let next = self.security.create(&self.name, false)?;
            return Ok(Stream::Server(std::mem::replace(&mut self.pending, next)));
        }
    }
}

async fn open_client(name: &str) -> io::Result<NamedPipeClient> {
    let deadline = Instant::now() + BUSY_WAIT;
    loop {
        // ClientOptions defaults to SECURITY_IDENTIFICATION as well.
        match ClientOptions::new().open(name) {
            Ok(client) => return Ok(client),
            Err(error) if os_error(&error, ERROR_PIPE_BUSY) && Instant::now() < deadline => {
                tokio::time::sleep(BUSY_RETRY).await;
            }
            Err(error) => return Err(error),
        }
    }
}

/// The client a server instance accepted. The DACL admitted only this
/// user, so its uid is this user's.
fn client_of(handle: RawHandle) -> io::Result<PeerCredentials> {
    let mut pid = 0u32;
    // SAFETY: `handle` is the live pipe handle of the caller's stream, and
    // `pid` is valid for the call.
    if unsafe { GetNamedPipeClientProcessId(handle as _, &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PeerCredentials {
        uid: peer::current_uid(),
        pid: (pid > 0).then_some(pid as i32),
    })
}

/// The server a client reached, and the user its process runs as.
pub(crate) fn server_of(handle: RawHandle) -> io::Result<PeerCredentials> {
    let mut pid = 0u32;
    // SAFETY: as in `client_of`.
    if unsafe { GetNamedPipeServerProcessId(handle as _, &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(PeerCredentials {
        uid: peer::process_uid(pid)?,
        pid: (pid > 0).then_some(pid as i32),
    })
}

pub enum Stream {
    Server(NamedPipeServer),
    Client(NamedPipeClient),
}

pub type ReadHalf = tokio::io::ReadHalf<Stream>;
pub type WriteHalf = tokio::io::WriteHalf<Stream>;

impl Stream {
    pub async fn connect(path: &Path) -> io::Result<Stream> {
        open_client(&pipe_name(path)).await.map(Stream::Client)
    }

    pub async fn pair() -> io::Result<(Stream, Stream)> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name = format!(
            r"\\.\pipe\agent-relay-pair-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let security = Security::current_user_only()?;
        let server = security.create(&name, true)?;
        let client = ClientOptions::new().open(&name)?;
        server.connect().await?;
        Ok((Stream::Server(server), Stream::Client(client)))
    }

    pub fn peer_credentials(&self) -> io::Result<PeerCredentials> {
        match self {
            Stream::Server(pipe) => client_of(pipe.as_raw_handle()),
            Stream::Client(pipe) => server_of(pipe.as_raw_handle()),
        }
    }

    /// A pipe cannot close one direction: shutting the write half down
    /// flushes it, and the other end sees the end of the stream once both
    /// halves are dropped.
    pub fn into_split(self) -> (ReadHalf, WriteHalf) {
        tokio::io::split(self)
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let polled = match self.get_mut() {
            Stream::Server(pipe) => Pin::new(pipe).poll_read(cx, buf),
            Stream::Client(pipe) => Pin::new(pipe).poll_read(cx, buf),
        };
        match polled {
            Poll::Ready(Err(error)) if ended(&error) => Poll::Ready(Ok(())),
            other => other,
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Stream::Server(pipe) => Pin::new(pipe).poll_write(cx, buf),
            Stream::Client(pipe) => Pin::new(pipe).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Server(pipe) => Pin::new(pipe).poll_flush(cx),
            Stream::Client(pipe) => Pin::new(pipe).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Server(pipe) => Pin::new(pipe).poll_shutdown(cx),
            Stream::Client(pipe) => Pin::new(pipe).poll_shutdown(cx),
        }
    }
}

/// The runtime blocking clients' pipes live on: one background worker, so
/// a blocking call never starts or enters a runtime on its caller's thread
/// (which may be inside another runtime) and still gets timeouts.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("relay-pipe-client")
            .enable_all()
            .build()
            .expect("start the pipe client runtime")
    })
}

/// Runs `work` on the pipe runtime and blocks this thread until it ends, as
/// a socket call would.
fn run<T: Send + 'static>(
    work: impl Future<Output = io::Result<T>> + Send + 'static,
) -> io::Result<T> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    runtime().spawn(async move {
        let _ = sender.send(work.await);
    });
    receiver
        .recv()
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "The pipe client stopped."))?
}

async fn within<T>(
    limit: Option<Duration>,
    work: impl Future<Output = io::Result<T>>,
) -> io::Result<T> {
    match limit {
        Some(limit) => tokio::time::timeout(limit, work)
            .await
            .unwrap_or_else(|_| Err(io::Error::from(io::ErrorKind::TimedOut))),
        None => work.await,
    }
}

#[derive(Clone, Copy, Default)]
struct Timeouts {
    read: Option<Duration>,
    write: Option<Duration>,
}

pub struct BlockingStream {
    pipe: Arc<NamedPipeClient>,
    /// Shared by clones, as a socket's options are.
    timeouts: Arc<Mutex<Timeouts>>,
}

fn checked(timeout: Option<Duration>) -> io::Result<Option<Duration>> {
    if timeout.is_some_and(|timeout| timeout.is_zero()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "A zero timeout is not allowed.",
        ));
    }
    Ok(timeout)
}

impl BlockingStream {
    pub fn connect(path: &Path) -> io::Result<BlockingStream> {
        let name = pipe_name(path);
        let pipe = run(async move { open_client(&name).await })?;
        Ok(BlockingStream {
            pipe: Arc::new(pipe),
            timeouts: Arc::default(),
        })
    }

    pub fn peer_credentials(&self) -> io::Result<PeerCredentials> {
        server_of(self.pipe.as_raw_handle())
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        let timeout = checked(timeout)?;
        self.timeouts.lock().unwrap().read = timeout;
        Ok(())
    }

    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        let timeout = checked(timeout)?;
        self.timeouts.lock().unwrap().write = timeout;
        Ok(())
    }

    pub fn try_clone(&self) -> io::Result<BlockingStream> {
        Ok(BlockingStream {
            pipe: self.pipe.clone(),
            timeouts: self.timeouts.clone(),
        })
    }

    pub fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let pipe = self.pipe.clone();
        let limit = self.timeouts.lock().unwrap().read;
        let capacity = buf.len();
        // A read that times out leaves nothing behind: data arriving later
        // waits in the pipe for the next read.
        let data = run(async move {
            let mut owned = vec![0u8; capacity];
            let read = within(limit, async {
                loop {
                    pipe.readable().await?;
                    match pipe.try_read(&mut owned) {
                        Ok(read) => return io::Result::Ok(read),
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                        Err(error) if ended(&error) => return io::Result::Ok(0),
                        Err(error) => return Err(error),
                    }
                }
            })
            .await?;
            owned.truncate(read);
            io::Result::Ok(owned)
        })?;
        buf[..data.len()].copy_from_slice(&data);
        Ok(data.len())
    }

    pub fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let pipe = self.pipe.clone();
        let limit = self.timeouts.lock().unwrap().write;
        let owned = buf.to_vec();
        run(async move {
            within(limit, async {
                loop {
                    pipe.writable().await?;
                    match pipe.try_write(&owned) {
                        Ok(written) => return io::Result::Ok(written),
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                        Err(error) => return Err(error),
                    }
                }
            })
            .await
        })
    }

    /// Writes are handed to the pipe as they are made.
    pub fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
