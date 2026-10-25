//! The local transport every bridge and relay-send connection runs on: one
//! API over a per-user Unix socket on Unix and a named pipe on Windows.
//!
//! The rest of the core names an endpoint by its socket path
//! (`~/.agentworkforce/desktop/core.sock`, the relay-send `relay.sock`).
//! On Unix that path is the socket file. On Windows it is only a key: the
//! pipe is `\\.\pipe\agent-relay-<16 hex digits>`, the first eight bytes of
//! the SHA-256 of the path as [`pipe_name`] normalizes it, so the lock file
//! beside the path (`<path>.lock`) still pairs with exactly one pipe.
//!
//! Admission is the operating system's on both: a Unix listener reads each
//! peer's kernel credentials ([`crate::relay::peer`]); a pipe is created
//! with a DACL that grants only the current user's SID, rejects remote
//! clients, and refuses to join a pipe name another process already holds.
//! [`CoreStream::peer_credentials`] reports the other end: the client a
//! listener accepted, or the server a client reached, which clients check
//! is this user's so they never speak to an impostor.
//!
//! This module owns only the byte stream. The socket file's lifecycle (a
//! leftover socket, 0600 permissions, the `sun_path` length) stays with its
//! owners (`daemon`, `outbound`), and is a no-op on Windows.

use crate::relay::peer::PeerCredentials;
use sha2::{Digest, Sha256};
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as imp;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

/// The Windows pipe name for the endpoint at `path`. A pure function of the
/// path, case- and separator-insensitive as Windows paths are, so every
/// client and the daemon derive the same pipe; defined on every platform so
/// its stability is tested everywhere.
pub fn pipe_name(path: &Path) -> String {
    let mut key = path.to_string_lossy().replace('/', "\\").to_lowercase();
    if let Some(stripped) = key.strip_prefix(r"\\?\") {
        key = stripped.to_string();
    }
    while key.len() > 1 && key.ends_with('\\') {
        key.pop();
    }
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!(r"\\.\pipe\agent-relay-{hex}")
}

/// Whether something answers at `path` right now. Blocking but brief, and
/// safe inside an async context: it never needs a runtime.
pub fn is_served(path: &Path) -> bool {
    imp::is_served(path)
}

/// A bound endpoint that accepts connections.
pub struct CoreListener {
    inner: imp::Listener,
}

impl CoreListener {
    /// Binds the endpoint for `path`. On Unix the socket file must not
    /// exist (the caller replaces a stale one); on Windows the pipe name
    /// must be free. Needs a tokio runtime context.
    pub fn bind(path: &Path) -> io::Result<CoreListener> {
        Ok(CoreListener {
            inner: imp::Listener::bind(path)?,
        })
    }

    /// The next connection. Cancel-safe: a dropped accept loses no client.
    /// The peer's identity is [`CoreStream::peer_credentials`].
    pub async fn accept(&mut self) -> io::Result<CoreStream> {
        Ok(CoreStream {
            inner: self.inner.accept().await?,
        })
    }
}

/// One connection, either end.
pub struct CoreStream {
    inner: imp::Stream,
}

impl CoreStream {
    /// Connects to the endpoint for `path`. On Windows a pipe whose every
    /// instance is momentarily taken is retried briefly.
    pub async fn connect(path: &Path) -> io::Result<CoreStream> {
        Ok(CoreStream {
            inner: imp::Stream::connect(path).await?,
        })
    }

    /// Two connected ends, for tests.
    pub async fn pair() -> io::Result<(CoreStream, CoreStream)> {
        let (left, right) = imp::Stream::pair().await?;
        Ok((CoreStream { inner: left }, CoreStream { inner: right }))
    }

    /// The process at the other end, as the operating system reports it.
    pub fn peer_credentials(&self) -> io::Result<PeerCredentials> {
        self.inner.peer_credentials()
    }

    /// Owned halves, for a reader and a writer on different tasks.
    pub fn into_split(self) -> (CoreReadHalf, CoreWriteHalf) {
        let (read, write) = self.inner.into_split();
        (CoreReadHalf { inner: read }, CoreWriteHalf { inner: write })
    }
}

/// The reading half of a [`CoreStream`].
pub struct CoreReadHalf {
    inner: imp::ReadHalf,
}

/// The writing half of a [`CoreStream`]; shutting it down ends the
/// connection's sending side.
pub struct CoreWriteHalf {
    inner: imp::WriteHalf,
}

impl AsyncRead for CoreStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for CoreStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

impl AsyncRead for CoreReadHalf {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for CoreWriteHalf {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// A blocking client connection, for the command-line clients (`relay
/// call`, `relay socket-request`, the hooks). Usable from any thread,
/// including one inside a tokio runtime: it never starts a runtime on the
/// caller's thread.
pub struct BlockingCoreStream {
    inner: imp::BlockingStream,
}

impl BlockingCoreStream {
    pub fn connect(path: &Path) -> io::Result<BlockingCoreStream> {
        Ok(BlockingCoreStream {
            inner: imp::BlockingStream::connect(path)?,
        })
    }

    /// The server's process, as the operating system reports it.
    pub fn peer_credentials(&self) -> io::Result<PeerCredentials> {
        self.inner.peer_credentials()
    }

    /// Bounds each read; `None` waits forever. Shared with clones, as a
    /// socket option is.
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.inner.set_read_timeout(timeout)
    }

    /// Bounds each write; `None` waits forever. Shared with clones.
    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.inner.set_write_timeout(timeout)
    }

    /// Another handle on the same connection, for a separate reader and
    /// writer.
    pub fn try_clone(&self) -> io::Result<BlockingCoreStream> {
        Ok(BlockingCoreStream {
            inner: self.inner.try_clone()?,
        })
    }
}

impl io::Read for BlockingCoreStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf)
    }
}

impl io::Write for BlockingCoreStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn a_path_names_one_stable_pipe() {
        let name = pipe_name(Path::new(r"C:\Users\A\.agentworkforce\desktop\core.sock"));
        assert!(name.starts_with(r"\\.\pipe\agent-relay-"), "{name}");
        assert_eq!(name.len(), r"\\.\pipe\agent-relay-".len() + 16);
        assert_eq!(
            name,
            pipe_name(Path::new("c:/users/a/.agentworkforce/desktop/core.sock"))
        );
        assert_eq!(
            name,
            pipe_name(Path::new(
                r"\\?\C:\Users\A\.agentworkforce\desktop\core.sock"
            ))
        );
        assert_ne!(
            name,
            pipe_name(Path::new(
                r"C:\Users\A\.agentworkforce\desktop\core.dev.sock"
            ))
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_listener_accepts_this_users_connection_both_ways() {
        let directory = short_directory();
        let path = directory.path().join("t.sock");
        let mut listener = CoreListener::bind(&path).unwrap();
        let served = tokio::spawn(async move {
            let stream = listener.accept().await.unwrap();
            let peer = stream.peer_credentials().unwrap();
            assert_eq!(peer.uid, crate::relay::peer::current_uid());
            assert_eq!(peer.pid, Some(std::process::id() as i32));
            let (read, mut write) = stream.into_split();
            let mut line = String::new();
            BufReader::new(read).read_line(&mut line).await.unwrap();
            write
                .write_all(line.to_uppercase().as_bytes())
                .await
                .unwrap();
            write.shutdown().await.unwrap();
            // A second client finds the next instance.
            listener.accept().await.unwrap()
        });
        let mut client = CoreStream::connect(&path).await.unwrap();
        let server = client.peer_credentials().unwrap();
        assert_eq!(server.uid, crate::relay::peer::current_uid());
        client.write_all(b"hello\n").await.unwrap();
        let mut answer = String::new();
        BufReader::new(&mut client)
            .read_line(&mut answer)
            .await
            .unwrap();
        assert_eq!(answer, "HELLO\n");
        let _second = CoreStream::connect(&path).await.unwrap();
        served.await.unwrap();
    }

    /// The probe connects and hangs up, which the listener then sees as an
    /// empty connection: it is checked on its own so no echo test takes that
    /// connection for its client.
    #[tokio::test(flavor = "multi_thread")]
    async fn is_served_tells_a_live_listener_from_none() {
        let directory = short_directory();
        let path = directory.path().join("s.sock");
        assert!(!is_served(&path));
        let mut listener = CoreListener::bind(&path).unwrap();
        let accepting = tokio::spawn(async move {
            let probe = listener.accept().await.unwrap();
            drop(probe);
            listener
        });
        assert!(is_served(&path));
        drop(accepting.await.unwrap());
        assert!(!is_served(&path));
    }

    #[test]
    fn a_blocking_client_times_out_and_reads_to_the_end() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let directory = short_directory();
        let path = directory.path().join("b.sock");
        let mut listener = {
            let _entered = runtime.enter();
            CoreListener::bind(&path).unwrap()
        };
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let served = runtime.spawn(async move {
            let mut stream = listener.accept().await.unwrap();
            let _ = released.await;
            stream.write_all(b"done").await.unwrap();
            stream.shutdown().await.unwrap();
        });
        let client = BlockingCoreStream::connect(&path).unwrap();
        assert_eq!(
            client.peer_credentials().unwrap().uid,
            crate::relay::peer::current_uid()
        );
        client
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let mut reader = client.try_clone().unwrap();
        let mut buffer = [0u8; 8];
        let error = io::Read::read(&mut reader, &mut buffer).unwrap_err();
        assert!(
            matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
            ),
            "{error:?}"
        );
        client.set_read_timeout(None).unwrap();
        release.send(()).unwrap();
        let mut answer = Vec::new();
        io::Read::read_to_end(&mut reader, &mut answer).unwrap();
        assert_eq!(answer, b"done");
        runtime.block_on(served).unwrap();
    }

    /// A directory short enough for a socket path on macOS.
    fn short_directory() -> tempfile::TempDir {
        let mut builder = tempfile::Builder::new();
        builder.prefix("tr-");
        if cfg!(unix) {
            builder.tempdir_in("/tmp").unwrap()
        } else {
            builder.tempdir().unwrap()
        }
    }
}
