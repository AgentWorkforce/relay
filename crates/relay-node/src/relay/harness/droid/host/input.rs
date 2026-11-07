//! A stalled provider cannot indefinitely block the host's control socket.
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::process::ChildStdin;
use std::time::{Duration, Instant};

pub(super) struct Input(ChildStdin);
impl Input {
    pub(super) fn new(input: ChildStdin) -> io::Result<Self> {
        let fd = input.as_raw_fd();
        use nix::fcntl::{fcntl, FcntlArg, OFlag};
        let flags = OFlag::from_bits_truncate(fcntl(fd, FcntlArg::F_GETFL)?);
        fcntl(fd, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))?;
        Ok(Self(input))
    }
}
impl Write for Input {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
    fn write_all(&mut self, mut bytes: &[u8]) -> io::Result<()> {
        let overall_deadline = Instant::now() + Duration::from_secs(2);
        let mut idle_deadline = Instant::now() + Duration::from_millis(250);
        while !bytes.is_empty() {
            match self.0.write(bytes) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => {
                    bytes = &bytes[count..];
                    idle_deadline = Instant::now() + Duration::from_millis(250);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(error) => return Err(error),
            }
            let now = Instant::now();
            // A progressing reader gets a fresh stall budget; the overall
            // bound still leaves room inside the 3s control-client deadline.
            if !bytes.is_empty() && (now >= idle_deadline || now >= overall_deadline) {
                return Err(io::ErrorKind::TimedOut.into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_slow_progressing_reader_gets_more_than_one_stall_budget() {
        let mut child = std::process::Command::new("python3")
            .args([
                "-c",
                "import os,time\nwhile os.read(0,4096): time.sleep(0.006)",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut input = Input::new(child.stdin.take().unwrap()).unwrap();
        let start = Instant::now();
        let result = super::super::send(
            &mut input,
            serde_json::json!({"method":"droid.add_user_message","params":{"text":"x".repeat(512 * 1024)}}),
        );
        let _ = child.kill();
        let _ = child.wait();
        result.unwrap();
        assert!(start.elapsed() > Duration::from_millis(250));
        assert!(start.elapsed() < Duration::from_secs(3));
    }
    #[test]
    fn a_provider_that_does_not_read_has_a_bounded_write() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("60")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = Input::new(child.stdin.take().unwrap()).unwrap();
        let start = Instant::now();
        let result = super::super::send(
            &mut input,
            serde_json::json!({"method":"droid.add_user_message", "params":{"text":"x".repeat(1024 * 1024)}}),
        );
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(
            result
                .unwrap_err()
                .downcast_ref::<io::Error>()
                .unwrap()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}
