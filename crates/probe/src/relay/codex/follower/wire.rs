//! Bounded passive router connection. Windows remains explicitly unavailable.
use super::{Error, Transport};
use crate::relay::codex::ipc::IpcStream;
use serde_json::Value;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

const MAX_FRAME: usize = 4 * 1024 * 1024;

pub struct Socket {
    stream: IpcStream,
    pending: Vec<u8>,
}
impl Socket {
    #[cfg(unix)]
    pub fn connect(path: &Path) -> Result<Self, Error> {
        use std::os::unix::fs::FileTypeExt;
        let metadata = std::fs::symlink_metadata(path).map_err(|_| Error::Unavailable)?;
        if !metadata.file_type().is_socket()
            || !crate::platform::fs::owned_by_current_user(&metadata)
        {
            return Err(Error::Unavailable);
        }
        let stream = IpcStream::connect(path).map_err(|_| Error::Unavailable)?;
        let peer = crate::relay::peer::peer_credentials(&stream).map_err(|_| Error::Unavailable)?;
        if peer.uid != crate::relay::peer::current_uid() {
            return Err(Error::Unavailable);
        }
        Self::from_stream(stream)
    }
    #[cfg(windows)]
    pub fn connect(_path: &Path) -> Result<Self, Error> {
        Err(Error::Unavailable)
    }

    pub(super) fn from_stream(stream: IpcStream) -> Result<Self, Error> {
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|_| Error::Unavailable)?;
        Ok(Self {
            stream,
            pending: Vec::new(),
        })
    }

    fn buffered(&mut self) -> Result<Option<Value>, Error> {
        let Some(header) = self.pending.get(..4) else {
            return Ok(None);
        };
        let size = u32::from_le_bytes(header.try_into().map_err(|_| Error::InvalidFrame)?) as usize;
        if size == 0 || size > MAX_FRAME {
            return Err(Error::InvalidFrame);
        }
        let Some(payload) = self.pending.get(4..4 + size) else {
            return Ok(None);
        };
        let value = serde_json::from_slice(payload).map_err(|_| Error::InvalidFrame)?;
        self.pending.drain(..4 + size);
        Ok(Some(value))
    }
}

impl Transport for Socket {
    fn send(&mut self, message: &Value) -> Result<(), Error> {
        let payload = serde_json::to_vec(message).map_err(|_| Error::InvalidFrame)?;
        if payload.is_empty() || payload.len() > MAX_FRAME {
            return Err(Error::InvalidFrame);
        }
        let frame =
            crate::relay::codex::ipc::encode_frame(&payload).map_err(|_| Error::InvalidFrame)?;
        self.stream
            .write_all(&frame)
            .map_err(|_| Error::Disconnected)
    }

    fn receive(&mut self, deadline: Instant) -> Result<Option<Value>, Error> {
        loop {
            if let Some(value) = self.buffered()? {
                return Ok(Some(value));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            self.stream
                .set_read_timeout(Some(remaining))
                .map_err(|_| Error::Disconnected)?;
            let mut chunk = [0u8; 16 * 1024];
            match self.stream.read(&mut chunk) {
                Ok(0) => return Err(Error::Disconnected),
                Ok(count) => self.pending.extend_from_slice(&chunk[..count]),
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error)
                    if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) =>
                {
                    return Ok(None)
                }
                Err(_) => return Err(Error::Disconnected),
            }
        }
    }
}
