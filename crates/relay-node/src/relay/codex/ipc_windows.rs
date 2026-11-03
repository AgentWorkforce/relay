//! Windows router transport, with bounded I/O and a same-user server check.
use crate::relay::{peer, transport::BlockingCoreStream};
use std::io::{self, Read, Write};
use std::time::Duration;

pub enum IpcStream {
    Pipe(BlockingCoreStream),
    #[cfg(test)]
    Tcp(std::net::TcpStream),
}

impl IpcStream {
    pub fn connect_named(name: &str) -> io::Result<Self> {
        let stream = BlockingCoreStream::connect_named(name)?;
        if stream.peer_credentials()?.uid != peer::current_uid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Codex router belongs to another Windows account",
            ));
        }
        Ok(Self::Pipe(stream))
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        match self {
            Self::Pipe(stream) => stream.set_read_timeout(timeout),
            #[cfg(test)]
            Self::Tcp(stream) => stream.set_read_timeout(timeout),
        }
    }

    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        match self {
            Self::Pipe(stream) => stream.set_write_timeout(timeout),
            #[cfg(test)]
            Self::Tcp(stream) => stream.set_write_timeout(timeout),
        }
    }
}

impl Read for IpcStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Pipe(stream) => stream.read(buffer),
            #[cfg(test)]
            Self::Tcp(stream) => stream.read(buffer),
        }
    }
}

impl Write for IpcStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        match self {
            Self::Pipe(stream) => stream.write(buffer),
            #[cfg(test)]
            Self::Tcp(stream) => stream.write(buffer),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Pipe(stream) => stream.flush(),
            #[cfg(test)]
            Self::Tcp(stream) => stream.flush(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::{
        codex::ipc,
        transport::{pipe_name, CoreListener},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn an_absent_pipe_is_not_running() {
        let dir = tempfile::tempdir().unwrap();
        let name = pipe_name(&dir.path().join("missing-codex-router"));
        assert_eq!(
            IpcStream::connect_named(&name)
                .map_err(ipc::connection_error)
                .err(),
            Some(ipc::IpcError::NotRunning)
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn registers_over_a_real_windows_named_pipe() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codex-router");
        let mut listener = CoreListener::bind(&path).unwrap();
        let name = pipe_name(&path);
        let client = tokio::task::spawn_blocking(move || {
            ipc::Session::register(IpcStream::connect_named(&name).unwrap()).is_ok()
        });
        let mut server = listener.accept().await.unwrap();
        let size = server.read_u32_le().await.unwrap();
        let mut payload = vec![0; size as usize];
        server.read_exact(&mut payload).await.unwrap();
        let request: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(request["method"], "initialize");
        let response = serde_json::json!({
            "type": "response", "requestId": request["requestId"],
            "resultType": "success", "method": "initialize",
            "result": {"clientId": "windows-router-test"}
        });
        server
            .write_all(&ipc::encode_frame(&serde_json::to_vec(&response).unwrap()).unwrap())
            .await
            .unwrap();
        assert!(client.await.unwrap());
    }
}
