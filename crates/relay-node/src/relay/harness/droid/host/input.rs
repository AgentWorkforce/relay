//! Bounded buffered writes: the host services control requests between pumps.
use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::process::ChildStdin;
use std::time::{Duration, Instant};

const PUMP_BYTES: usize = 64 * 1024;
const QUEUE_BYTES: usize = 8 * 1024 * 1024;
const QUEUE_FRAMES: usize = 128;
const STALL_BUDGET: Duration = Duration::from_millis(250);

pub(super) struct Input {
    pipe: File,
    frames: VecDeque<Vec<u8>>,
    offset: usize,
    queued: usize,
    last_progress: Instant,
}
impl Input {
    pub(super) fn new(input: ChildStdin) -> io::Result<Self> {
        Self::from_fd(input.into())
    }
    fn from_fd(fd: OwnedFd) -> io::Result<Self> {
        use nix::fcntl::{fcntl, FcntlArg, OFlag};
        let flags = OFlag::from_bits_truncate(fcntl(fd.as_raw_fd(), FcntlArg::F_GETFL)?);
        fcntl(fd.as_raw_fd(), FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))?;
        Ok(Self {
            pipe: fd.into(),
            frames: VecDeque::new(),
            offset: 0,
            queued: 0,
            last_progress: Instant::now(),
        })
    }
    /// Writes at most one pass's byte budget, with no sleeps or blocking I/O.
    /// Positive progress refreshes the stall timer even after scheduler delay.
    pub(super) fn pump(&mut self) -> io::Result<bool> {
        let mut budget = PUMP_BYTES;
        while budget > 0 {
            let Some(frame) = self.frames.front() else {
                return Ok(true);
            };
            let end = frame.len().min(self.offset + budget);
            match self.pipe.write(&frame[self.offset..end]) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => {
                    self.offset += count;
                    self.queued -= count;
                    budget -= count;
                    self.last_progress = Instant::now();
                    if self.offset == frame.len() {
                        self.frames.pop_front();
                        self.offset = 0;
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                    ) =>
                {
                    return if self.last_progress.elapsed() >= STALL_BUDGET {
                        Err(io::ErrorKind::TimedOut.into())
                    } else {
                        Ok(false)
                    };
                }
                Err(error) => return Err(error),
            }
        }
        Ok(self.frames.is_empty())
    }
}
impl Write for Input {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        if self.frames.len() >= QUEUE_FRAMES
            || bytes.len() > QUEUE_BYTES.saturating_sub(self.queued)
        {
            return Err(io::Error::new(
                io::ErrorKind::OutOfMemory,
                "Droid input queue limit exceeded",
            ));
        }
        if self.frames.is_empty() {
            self.last_progress = Instant::now();
        }
        self.frames.push_back(bytes.to_vec());
        self.queued += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.pump()? {
            Ok(())
        } else {
            Err(io::ErrorKind::WouldBlock.into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixStream;

    #[test]
    fn a_frame_progresses_across_control_passes_without_a_whole_frame_deadline() {
        let (writer, mut reader) = UnixStream::pair().unwrap();
        let mut input = Input::from_fd(writer.into()).unwrap();
        let payload = "x".repeat(512 * 1024);
        super::super::send(
            &mut input,
            serde_json::json!({"method":"droid.add_user_message","params":{"text":payload}}),
        )
        .unwrap();
        let (drained, progress) = std::sync::mpsc::channel();
        let receiver = std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut bytes = [0; 4096];
            while let Ok(count) = reader.read(&mut bytes) {
                if count == 0 {
                    break;
                }
                all.extend_from_slice(&bytes[..count]);
                let _ = drained.send(all.len());
            }
            all
        });
        let before = input.queued;
        assert!(!input.pump().unwrap());
        let written = before - input.queued;
        assert!(written > 0 && written <= PUMP_BYTES);
        assert!(input.queued >= payload.len() - PUMP_BYTES);
        // A reply queued while the prompt is partial must remain a second
        // complete JSON frame, never bytes interleaved into the prompt.
        super::super::send(
            &mut input,
            serde_json::json!({"id":"permission","result":{"selectedOption":"cancel"}}),
        )
        .unwrap();
        let mut drained = 0;
        while drained < written {
            drained = progress.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        // Control work or scheduler delay may span the former whole-frame cap.
        std::thread::sleep(Duration::from_millis(350));
        let deadline = Instant::now() + Duration::from_secs(10);
        let result = loop {
            match input.pump() {
                Ok(true) => break Ok(()),
                Ok(false) if Instant::now() < deadline => std::thread::yield_now(),
                Ok(false) => break Err(io::Error::from(io::ErrorKind::TimedOut)),
                Err(error) => break Err(error),
            }
        };
        drop(input);
        let bytes = receiver.join().unwrap();
        result.unwrap();
        let frames = bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["params"]["text"], payload);
        assert_eq!(frames[1]["id"], "permission");
        assert_eq!(frames[1]["result"]["selectedOption"], "cancel");
    }

    #[test]
    fn a_stalled_provider_never_blocks_a_pump_and_eventually_fails_closed() {
        let (writer, _unread) = UnixStream::pair().unwrap();
        let mut input = Input::from_fd(writer.into()).unwrap();
        super::super::send(&mut input, serde_json::json!({"method":"droid.add_user_message","params":{"text":"x".repeat(1024 * 1024)}})).unwrap();
        let start = Instant::now();
        let error = loop {
            match input.pump() {
                Ok(false) if start.elapsed() < Duration::from_secs(3) => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Ok(_) => panic!("a full unread stream must remain pending"),
                Err(error) => break error,
            }
        };
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn pending_input_has_a_finite_frame_and_byte_limit() {
        let (writer, _unread) = UnixStream::pair().unwrap();
        let mut input = Input::from_fd(writer.into()).unwrap();
        for _ in 0..QUEUE_FRAMES {
            input.write_all(b"frame\n").unwrap();
        }
        assert!(input.write_all(b"overflow").is_err());
        let (writer, _unread) = UnixStream::pair().unwrap();
        let mut input = Input::from_fd(writer.into()).unwrap();
        assert!(input.write_all(&vec![0; QUEUE_BYTES + 1]).is_err());
    }
}
