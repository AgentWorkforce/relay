//! The transport on Unix: a stream socket at the path itself, peers
//! identified by their kernel credentials (`relay::peer`).

use crate::relay::peer::{peer_credentials, PeerCredentials};
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;
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

pub struct BlockingStream(std::os::unix::net::UnixStream);

impl BlockingStream {
    pub fn connect(path: &Path) -> io::Result<BlockingStream> {
        std::os::unix::net::UnixStream::connect(path).map(BlockingStream)
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
        self.0.try_clone().map(BlockingStream)
    }

    pub fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        io::Read::read(&mut self.0, buf)
    }

    pub fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        io::Write::write(&mut self.0, buf)
    }

    pub fn flush(&mut self) -> io::Result<()> {
        io::Write::flush(&mut self.0)
    }
}
