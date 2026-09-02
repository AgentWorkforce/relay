use crate::cmdbuilder::CommandBuilder;
use crate::win::psuedocon::PsuedoCon;
use crate::{Child, MasterPty, PtyPair, PtySize, PtySystem, SlavePty};
use anyhow::Error;
use filedescriptor::{FileDescriptor, Pipe};
use std::{
    ffi::OsStr,
    io::{self, Read},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    ptr,
    sync::{Arc, Mutex},
};
use winapi::{
    shared::winerror::{ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_CONNECTED},
    um::{
        fileapi::{CreateFileW, ReadFile, OPEN_EXISTING},
        handleapi::INVALID_HANDLE_VALUE,
        namedpipeapi::{ConnectNamedPipe, CreateNamedPipeW},
        winbase::{
            FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND, PIPE_NOWAIT, PIPE_READMODE_BYTE,
            PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        },
        wincon::COORD,
        winnt::GENERIC_WRITE,
    },
};

/// Reader for the private ConPTY output pipe.
///
/// `portable-pty` historically used `CreatePipe`, whose synchronous `ReadFile`
/// blocks indefinitely while a child is idle. Relay needs to serialize bytes
/// that have already been copied from the kernel with a verified input's
/// receive-time boundary, without holding that ordering lock across an idle
/// read. A byte-mode named pipe created with `PIPE_NOWAIT` gives `ReadFile` an
/// immediate `ERROR_NO_DATA` result instead.
struct NonblockingPipeReader {
    handle: FileDescriptor,
}

impl NonblockingPipeReader {
    fn try_clone(&self) -> anyhow::Result<Self> {
        Ok(Self {
            handle: self.handle.try_clone()?,
        })
    }
}

impl Read for NonblockingPipeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }

        let mut num_read = 0;
        let ok = unsafe {
            ReadFile(
                self.handle.as_raw_handle() as _,
                buf.as_mut_ptr() as _,
                buf.len().min(u32::MAX as usize) as u32,
                &mut num_read,
                ptr::null_mut(),
            )
        };
        if ok != 0 {
            return Ok(num_read as usize);
        }

        let error = io::Error::last_os_error();
        match error.raw_os_error().map(|code| code as u32) {
            Some(ERROR_NO_DATA) => Err(io::Error::from(io::ErrorKind::WouldBlock)),
            Some(ERROR_BROKEN_PIPE) => Ok(0),
            _ => Err(error),
        }
    }
}

/// Create a private local byte pipe whose read end never blocks.
///
/// Only ConPTY stdout uses this helper. Its stdin deliberately keeps the
/// upstream blocking anonymous-pipe behavior expected by the pseudo console.
fn nonblocking_output_pipe() -> anyhow::Result<(NonblockingPipeReader, FileDescriptor)> {
    let pipe_name = format!(r"\\.\pipe\portable-pty-{}", uuid::Uuid::new_v4());
    let pipe_name: Vec<u16> = OsStr::new(&pipe_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let read_handle = unsafe {
        CreateNamedPipeW(
            pipe_name.as_ptr(),
            PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            0,
            64 * 1024,
            0,
            ptr::null_mut(),
        )
    };
    if read_handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error().into());
    }
    let read_handle = unsafe { FileDescriptor::from_raw_handle(read_handle as _) };

    let write_handle = unsafe {
        CreateFileW(
            pipe_name.as_ptr(),
            GENERIC_WRITE,
            0,
            ptr::null_mut(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        )
    };
    if write_handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error().into());
    }
    let write_handle = unsafe { FileDescriptor::from_raw_handle(write_handle as _) };

    if unsafe { ConnectNamedPipe(read_handle.as_raw_handle() as _, ptr::null_mut()) } == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error().map(|code| code as u32) != Some(ERROR_PIPE_CONNECTED) {
            return Err(error.into());
        }
    }

    Ok((
        NonblockingPipeReader {
            handle: read_handle,
        },
        write_handle,
    ))
}

#[derive(Default)]
pub struct ConPtySystem {}

impl PtySystem for ConPtySystem {
    fn openpty(&self, size: PtySize) -> anyhow::Result<PtyPair> {
        let stdin = Pipe::new()?;
        let (stdout_read, stdout_write) = nonblocking_output_pipe()?;

        let con = PsuedoCon::new(
            COORD {
                X: size.cols as i16,
                Y: size.rows as i16,
            },
            stdin.read,
            stdout_write,
        )?;

        let master = ConPtyMasterPty {
            inner: Arc::new(Mutex::new(Inner {
                con,
                readable: stdout_read,
                writable: Some(stdin.write),
                size,
            })),
        };

        let slave = ConPtySlavePty {
            inner: master.inner.clone(),
        };

        Ok(PtyPair {
            master: Box::new(master),
            slave: Box::new(slave),
        })
    }
}

struct Inner {
    con: PsuedoCon,
    readable: NonblockingPipeReader,
    writable: Option<FileDescriptor>,
    size: PtySize,
}

impl Inner {
    pub fn resize(
        &mut self,
        num_rows: u16,
        num_cols: u16,
        pixel_width: u16,
        pixel_height: u16,
    ) -> Result<(), Error> {
        self.con.resize(COORD {
            X: num_cols as i16,
            Y: num_rows as i16,
        })?;
        self.size = PtySize {
            rows: num_rows,
            cols: num_cols,
            pixel_width,
            pixel_height,
        };
        Ok(())
    }
}

#[derive(Clone)]
pub struct ConPtyMasterPty {
    inner: Arc<Mutex<Inner>>,
}

pub struct ConPtySlavePty {
    inner: Arc<Mutex<Inner>>,
}

impl MasterPty for ConPtyMasterPty {
    fn resize(&self, size: PtySize) -> anyhow::Result<()> {
        let mut inner = self.inner.lock().unwrap();
        inner.resize(size.rows, size.cols, size.pixel_width, size.pixel_height)
    }

    fn get_size(&self) -> Result<PtySize, Error> {
        let inner = self.inner.lock().unwrap();
        Ok(inner.size.clone())
    }

    fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        Ok(Box::new(self.inner.lock().unwrap().readable.try_clone()?))
    }

    fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>> {
        Ok(Box::new(
            self.inner
                .lock()
                .unwrap()
                .writable
                .take()
                .ok_or_else(|| anyhow::anyhow!("writer already taken"))?,
        ))
    }
}

impl SlavePty for ConPtySlavePty {
    fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<Box<dyn Child + Send + Sync>> {
        let inner = self.inner.lock().unwrap();
        let child = inner.con.spawn_command(cmd)?;
        Ok(Box::new(child))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, time::Instant};
    use winapi::um::{handleapi::GetHandleInformation, winbase::HANDLE_FLAG_INHERIT};

    fn assert_not_inheritable(handle: &FileDescriptor) {
        let mut flags = 0;
        assert_ne!(
            unsafe { GetHandleInformation(handle.as_raw_handle() as _, &mut flags) },
            0,
            "GetHandleInformation failed: {}",
            io::Error::last_os_error()
        );
        assert_eq!(
            flags & HANDLE_FLAG_INHERIT,
            0,
            "private ConPTY pipe handles must not leak to child processes"
        );
    }

    #[test]
    fn nonblocking_output_pipe_is_prompt_private_and_lossless() {
        let (mut reader, mut writer) = nonblocking_output_pipe().unwrap();
        let mut cloned_reader = reader.try_clone().unwrap();
        assert_not_inheritable(&reader.handle);
        assert_not_inheritable(&cloned_reader.handle);
        assert_not_inheritable(&writer);

        let mut buf = [0u8; 16];
        let started = Instant::now();
        let error = reader.read(&mut buf).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(250),
            "an idle ConPTY output read must return promptly"
        );
        assert_eq!(
            cloned_reader.read(&mut buf).unwrap_err().kind(),
            io::ErrorKind::WouldBlock,
            "a cloned ConPTY reader must preserve nonblocking mode"
        );

        writer.write_all(b"ready").unwrap();
        assert_eq!(reader.read(&mut buf).unwrap(), 5);
        assert_eq!(&buf[..5], b"ready");

        drop(writer);
        assert_eq!(reader.read(&mut buf).unwrap(), 0);
    }
}
