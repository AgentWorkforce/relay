//! The transport on Unix: a stream socket at the path itself, peers
//! identified by their kernel credentials (`relay::peer`).

use crate::relay::peer::{peer_credentials, PeerCredentials};
use std::io;
use std::os::fd::AsRawFd;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

pub type ReadHalf = tokio::net::unix::OwnedReadHalf;
pub type WriteHalf = tokio::net::unix::OwnedWriteHalf;

pub fn is_served(path: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(path).is_ok()
}

pub struct Listener(tokio::net::UnixListener);

impl Listener {
    pub fn bind(path: &Path) -> io::Result<Listener> {
        tokio::net::UnixListener::bind(path).map(Listener)
    }

    pub async fn accept(&mut self) -> io::Result<Stream> {
        self.0.accept().await.map(|(stream, _)| Stream(stream))
    }
}

pub struct Stream(tokio::net::UnixStream);

impl Stream {
    pub async fn connect(path: &Path) -> io::Result<Stream> {
        tokio::net::UnixStream::connect(path).await.map(Stream)
    }

    pub async fn pair() -> io::Result<(Stream, Stream)> {
        let (left, right) = tokio::net::UnixStream::pair()?;
        Ok((Stream(left), Stream(right)))
    }

    pub fn peer_credentials(&self) -> io::Result<PeerCredentials> {
        peer_credentials(&self.0)
    }

    pub fn into_split(self) -> (ReadHalf, WriteHalf) {
        self.0.into_split()
    }
}

impl AsyncRead for Stream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

pub struct BlockingStream(std::os::unix::net::UnixStream, Option<Instant>);

impl BlockingStream {
    pub fn connect_until(path: &Path, deadline: Instant) -> io::Result<BlockingStream> {
        let address = socket2::SockAddr::unix(path)?;
        let socket = socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None)?;
        #[cfg(target_os = "linux")]
        {
            socket.set_nonblocking(true)?;
            loop {
                let remaining = remaining_until(deadline)?;
                match socket.connect(&address) {
                    // Linux AF_UNIX EAGAIN means no connection was queued. Polling
                    // this socket would report HUP rather than wait for capacity.
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(remaining.min(Duration::from_millis(5)));
                    }
                    result => {
                        result?;
                        break;
                    }
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        socket.connect_timeout(&address, remaining_until(deadline)?)?;
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        socket.set_nonblocking(true)?;
        Ok(BlockingStream(socket.into(), Some(deadline)))
    }

    pub fn connect(path: &Path) -> io::Result<BlockingStream> {
        std::os::unix::net::UnixStream::connect(path).map(|stream| BlockingStream(stream, None))
    }

    pub fn peer_credentials(&self) -> io::Result<PeerCredentials> {
        peer_credentials(&self.0)
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.0.set_read_timeout(timeout)
    }

    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.0.set_write_timeout(timeout)
    }

    pub fn try_clone(&self) -> io::Result<BlockingStream> {
        self.0
            .try_clone()
            .map(|stream| BlockingStream(stream, self.1))
    }

    pub fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.until_ready(nix::poll::PollFlags::POLLIN, |stream| {
            io::Read::read(stream, buf)
        })
    }

    pub fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.until_ready(nix::poll::PollFlags::POLLOUT, |stream| {
            io::Write::write(stream, buf)
        })
    }

    pub fn flush(&mut self) -> io::Result<()> {
        io::Write::flush(&mut self.0)
    }

    fn until_ready<T>(
        &mut self,
        interest: nix::poll::PollFlags,
        mut operation: impl FnMut(&mut std::os::unix::net::UnixStream) -> io::Result<T>,
    ) -> io::Result<T> {
        let Some(deadline) = self.1 else {
            return operation(&mut self.0);
        };
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))?;
            let millis = remaining
                .as_nanos()
                .div_ceil(1_000_000)
                .min(i32::MAX as u128) as i32;
            let mut descriptors = [nix::poll::PollFd::new(self.0.as_raw_fd(), interest)];
            match nix::poll::poll(&mut descriptors, millis) {
                Ok(0) => continue,
                Err(nix::errno::Errno::EINTR) => continue,
                Err(error) => return Err(io::Error::from_raw_os_error(error as i32)),
                Ok(_) => {}
            }
            if Instant::now() >= deadline {
                return Err(io::ErrorKind::TimedOut.into());
            }
            match operation(&mut self.0) {
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    continue
                }
                result => return result,
            }
        }
    }
}

fn remaining_until(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| io::Error::from(io::ErrorKind::TimedOut))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn full_queue() -> (
        tempfile::TempDir,
        socket2::Socket,
        socket2::Socket,
        std::path::PathBuf,
    ) {
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        let path = directory.path().join("queue.sock");
        let address = socket2::SockAddr::unix(&path).unwrap();
        let listener =
            socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None).unwrap();
        listener.bind(&address).unwrap();
        listener.listen(0).unwrap();
        let queued =
            socket2::Socket::new(socket2::Domain::UNIX, socket2::Type::STREAM, None).unwrap();
        queued.connect(&address).unwrap();
        (directory, listener, queued, path)
    }

    #[test]
    fn full_accept_queue_retries_until_capacity_returns() {
        let (_directory, listener, _queued, path) = full_queue();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let accepting = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let _accepted = listener.accept().unwrap();
            // Keep the listener alive until the retry has connected.
            let _ = released.recv_timeout(Duration::from_secs(3));
        });
        let started = Instant::now();
        let result = BlockingStream::connect_until(&path, started + Duration::from_secs(2));
        let _ = release.send(());
        accepting.join().unwrap();
        let _client = result.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(50));
    }

    #[test]
    fn full_accept_queue_stops_at_the_original_deadline() {
        let (_directory, _listener, _queued, path) = full_queue();
        let started = Instant::now();
        let result = BlockingStream::connect_until(&path, started + Duration::from_millis(100));
        assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
