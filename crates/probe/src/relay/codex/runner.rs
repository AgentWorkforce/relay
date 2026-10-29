//! Running the Codex command line: `codex queue` to completion, and
//! `codex app-server proxy` as a byte stream. Behind `CodexRunner` so the
//! routes are tested with fakes and no test starts a Codex.

use crate::platform::process::Group;
use std::io::{self, ErrorKind, Read, Write};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// How one command run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunOutcome {
    Exited {
        code: i32,
        stdout: String,
        stderr: String,
    },
    /// It did not finish in time and was stopped; what it did is unknown.
    TimedOut,
    /// It could not be started.
    NotStarted(String),
}

/// The proxy's stdio as one stream.
pub trait ProxyStream: Send {
    /// Writes all of `bytes`, or fails with `TimedOut` once `deadline`
    /// passes with some unwritten (the proxy stopped reading).
    fn write_all(&mut self, bytes: &[u8], deadline: Instant) -> io::Result<()>;
    /// The next bytes, empty at end of stream; a `TimedOut` error once
    /// `deadline` passes with nothing read.
    fn read(&mut self, deadline: Instant) -> io::Result<Vec<u8>>;
}

pub trait CodexRunner: Send + Sync {
    /// Runs `executable arguments` from the temporary directory with no
    /// input, stopping it at `timeout`.
    fn run(&self, executable: &Path, arguments: &[String], timeout: Duration) -> RunOutcome;
    /// Runs with Codex's file state rooted at `home` and its databases at
    /// `sqlite_home`. Fakes and older callers inherit `run`; the system
    /// runner binds both variables explicitly so a fleet worker's isolated
    /// queue cannot be confused with the desktop user's default queue.
    fn run_in_home(
        &self,
        executable: &Path,
        arguments: &[String],
        timeout: Duration,
        _home: &Path,
        _sqlite_home: &Path,
    ) -> RunOutcome {
        self.run(executable, arguments, timeout)
    }
    /// Starts `executable app-server proxy`; dropping the stream stops it.
    fn proxy(&self, executable: &Path) -> io::Result<Box<dyn ProxyStream>>;
    /// Starts the proxy against the exact Codex home that owns the thread.
    fn proxy_in_home(
        &self,
        executable: &Path,
        _home: &Path,
        _sqlite_home: &Path,
    ) -> io::Result<Box<dyn ProxyStream>> {
        self.proxy(executable)
    }
}

/// The real command line.
pub struct SystemRunner;

/// Output a command may print before the rest is dropped; `codex queue`
/// prints a line or two.
const OUTPUT_LIMIT: u64 = 64 * 1024;

fn command(executable: &Path, arguments: &[String]) -> Command {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null());
    // Its own process group (a job object on Windows), so stopping it stops
    // whatever it started (an npm launcher's child would otherwise hold the
    // pipes).
    crate::platform::process::own_group(&mut command);
    command
}

/// The first `OUTPUT_LIMIT` bytes of `stream`, read to its end: the rest
/// is drained, never left to fill the pipe or break it under the writer.
fn read_limited(mut stream: impl Read) -> String {
    let mut bytes = Vec::new();
    let _ = stream.by_ref().take(OUTPUT_LIMIT).read_to_end(&mut bytes);
    let _ = io::copy(&mut stream, &mut io::sink());
    String::from_utf8_lossy(&bytes).into_owned()
}

fn collect(stream: Option<impl Read + Send + 'static>) -> Receiver<String> {
    let (sender, text) = mpsc::channel();
    std::thread::spawn(move || {
        let text = stream.map(read_limited).unwrap_or_default();
        let _ = sender.send(text);
    });
    text
}

/// The output of a command whose leader exited. A process it left behind
/// still holding the pipe is stopped; while it lives, the group id cannot
/// name another process (on Windows the job holds its members).
fn output(text: &Receiver<String>, group: &Group) -> String {
    if let Ok(text) = text.recv_timeout(Duration::from_secs(2)) {
        return text;
    }
    group.kill();
    text.recv_timeout(Duration::from_secs(2))
        .unwrap_or_default()
}

fn wait_until(child: &mut Child, deadline: Instant) -> Option<i32> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.code().unwrap_or(-1)),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => return None,
        }
    }
}

/// Stops the process group and waits until its leader is really gone, so
/// whatever it was writing is either finished or never will be. Whatever
/// the leader started is killed too, even when the leader exits on the
/// first signal, so nothing it left behind keeps running or holds a pipe.
/// Windows has no polite stop, so there the first step already terminates.
fn stop(child: &mut Child, group: &Group) {
    group.terminate();
    let _ = wait_until(child, Instant::now() + Duration::from_secs(5));
    // Members left behind keep the group id reserved.
    group.kill();
    let _ = child.wait();
}

/// Writes all of `bytes` to a non-blocking descriptor by `deadline`.
#[cfg(unix)]
pub fn write_by<W: Write + AsRawFd>(
    target: &mut W,
    bytes: &[u8],
    deadline: Instant,
) -> io::Result<()> {
    let fd = target.as_raw_fd();
    // SAFETY: reading and setting the status flags of a descriptor we own.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let mut written = 0;
    while written < bytes.len() {
        match target.write(&bytes[written..]) {
            Ok(0) => return Err(io::Error::new(ErrorKind::WriteZero, "proxy input closed")),
            Ok(count) => written += count,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(io::Error::new(
                        ErrorKind::TimedOut,
                        "the proxy stopped reading",
                    ));
                }
                let mut ready = libc::pollfd {
                    fd,
                    events: libc::POLLOUT,
                    revents: 0,
                };
                let millis = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
                // SAFETY: one pollfd for a descriptor we own.
                if unsafe { libc::poll(&mut ready, 1, millis) } < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != ErrorKind::Interrupted {
                        return Err(error);
                    }
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

/// A writer with deadlines for Windows (`platform::pipe`).
#[cfg(windows)]
pub use crate::platform::pipe::DeadlineWriter;

/// The proxy's input as this platform writes it with a deadline.
#[cfg(unix)]
type ProxyInput = ChildStdin;
#[cfg(windows)]
type ProxyInput = DeadlineWriter;

#[cfg(unix)]
fn proxy_input(stdin: ChildStdin) -> ProxyInput {
    stdin
}

#[cfg(windows)]
fn proxy_input(stdin: ChildStdin) -> ProxyInput {
    DeadlineWriter::new(stdin)
}

#[cfg(unix)]
fn write_input(input: &mut ProxyInput, bytes: &[u8], deadline: Instant) -> io::Result<()> {
    write_by(input, bytes, deadline)
}

#[cfg(windows)]
fn write_input(input: &mut ProxyInput, bytes: &[u8], deadline: Instant) -> io::Result<()> {
    input.write_all(bytes, deadline)
}

impl CodexRunner for SystemRunner {
    fn run(&self, executable: &Path, arguments: &[String], timeout: Duration) -> RunOutcome {
        self.run_command(command(executable, arguments), timeout)
    }

    fn run_in_home(
        &self,
        executable: &Path,
        arguments: &[String],
        timeout: Duration,
        home: &Path,
        sqlite_home: &Path,
    ) -> RunOutcome {
        let mut command = command(executable, arguments);
        command
            .env("CODEX_HOME", home)
            .env("CODEX_SQLITE_HOME", sqlite_home);
        // The daemon this may start outlives the core (on Linux, a
        // systemd-run scope does the same).
        crate::platform::process::leave_job(&mut command);
        self.run_command(command, timeout)
    }

    fn proxy(&self, executable: &Path) -> io::Result<Box<dyn ProxyStream>> {
        self.proxy_command(command(executable, &["app-server".into(), "proxy".into()]))
    }

    fn proxy_in_home(
        &self,
        executable: &Path,
        home: &Path,
        sqlite_home: &Path,
    ) -> io::Result<Box<dyn ProxyStream>> {
        let mut command = command(executable, &["app-server".into(), "proxy".into()]);
        command
            .env("CODEX_HOME", home)
            .env("CODEX_SQLITE_HOME", sqlite_home);
        self.proxy_command(command)
    }
}

impl SystemRunner {
    fn run_command(&self, mut command: Command, timeout: Duration) -> RunOutcome {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            // A job the core runs in that forbids leaving it (not the
            // app's own) refuses with access denied: start inside it then.
            #[cfg(windows)]
            Err(error) if error.raw_os_error() == Some(5) => {
                match crate::platform::process::own_group(&mut command).spawn() {
                    Ok(child) => child,
                    Err(error) => return RunOutcome::NotStarted(error.to_string()),
                }
            }
            Err(error) => return RunOutcome::NotStarted(error.to_string()),
        };
        let group = Group::of(&child);
        let stdout = collect(child.stdout.take());
        let stderr = collect(child.stderr.take());
        let Some(code) = wait_until(&mut child, Instant::now() + timeout) else {
            stop(&mut child, &group);
            return RunOutcome::TimedOut;
        };
        RunOutcome::Exited {
            code,
            stdout: output(&stdout, &group),
            stderr: output(&stderr, &group),
        }
    }

    fn proxy_command(&self, mut command: Command) -> io::Result<Box<dyn ProxyStream>> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let group = Group::of(&child);
        let input = child.stdin.take().map(proxy_input);
        let output = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("no proxy output"))?;
        Ok(Box::new(ChildProxy {
            child,
            group,
            input,
            output: ChannelReader::new(output),
        }))
    }
}

/// A reader with deadlines: a thread reads the source and hands chunks
/// over a channel, so a partial frame can never block the caller.
pub struct ChannelReader {
    chunks: Receiver<Vec<u8>>,
}

impl ChannelReader {
    pub fn new(mut source: impl Read + Send + 'static) -> ChannelReader {
        let (sender, chunks) = mpsc::channel();
        std::thread::spawn(move || {
            let mut chunk = vec![0u8; 65_536];
            loop {
                match source.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        if sender.send(chunk[..count].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
        ChannelReader { chunks }
    }

    pub fn read(&mut self, deadline: Instant) -> io::Result<Vec<u8>> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match self.chunks.recv_timeout(remaining) {
            Ok(chunk) => Ok(chunk),
            Err(RecvTimeoutError::Timeout) => {
                Err(io::Error::new(ErrorKind::TimedOut, "no answer in time"))
            }
            Err(RecvTimeoutError::Disconnected) => Ok(Vec::new()),
        }
    }
}

struct ChildProxy {
    child: Child,
    group: Group,
    input: Option<ProxyInput>,
    output: ChannelReader,
}

impl ProxyStream for ChildProxy {
    fn write_all(&mut self, bytes: &[u8], deadline: Instant) -> io::Result<()> {
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| io::Error::new(ErrorKind::BrokenPipe, "proxy input closed"))?;
        write_input(input, bytes, deadline)
    }

    fn read(&mut self, deadline: Instant) -> io::Result<Vec<u8>> {
        self.output.read(deadline)
    }
}

impl Drop for ChildProxy {
    fn drop(&mut self) {
        self.input = None;
        stop(&mut self.child, &self.group);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// A runner that records what it was asked to run and answers from a
    /// script; it never starts a process.
    #[derive(Default)]
    pub struct FakeRunner {
        pub runs: Mutex<Vec<(PathBuf, Vec<String>, Duration)>>,
        pub run_homes: Mutex<Vec<PathBuf>>,
        pub run_sqlite_homes: Mutex<Vec<PathBuf>>,
        pub outcomes: Mutex<VecDeque<RunOutcome>>,
        pub proxies: Mutex<Vec<PathBuf>>,
        pub proxy_homes: Mutex<Vec<PathBuf>>,
        pub proxy_sqlite_homes: Mutex<Vec<PathBuf>>,
        pub streams: Mutex<VecDeque<Box<dyn ProxyStream>>>,
    }

    impl FakeRunner {
        pub fn answering(outcomes: impl IntoIterator<Item = RunOutcome>) -> FakeRunner {
            FakeRunner {
                outcomes: Mutex::new(outcomes.into_iter().collect()),
                ..FakeRunner::default()
            }
        }
    }

    impl CodexRunner for FakeRunner {
        fn run(&self, executable: &Path, arguments: &[String], timeout: Duration) -> RunOutcome {
            self.runs
                .lock()
                .unwrap()
                .push((executable.to_path_buf(), arguments.to_vec(), timeout));
            self.outcomes
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(RunOutcome::NotStarted("no scripted outcome".into()))
        }

        fn run_in_home(
            &self,
            executable: &Path,
            arguments: &[String],
            timeout: Duration,
            home: &Path,
            sqlite_home: &Path,
        ) -> RunOutcome {
            self.run_homes.lock().unwrap().push(home.to_path_buf());
            self.run_sqlite_homes
                .lock()
                .unwrap()
                .push(sqlite_home.to_path_buf());
            self.run(executable, arguments, timeout)
        }

        fn proxy(&self, executable: &Path) -> io::Result<Box<dyn ProxyStream>> {
            self.proxies.lock().unwrap().push(executable.to_path_buf());
            self.streams
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| io::Error::new(ErrorKind::NotFound, "no proxy"))
        }

        fn proxy_in_home(
            &self,
            executable: &Path,
            home: &Path,
            sqlite_home: &Path,
        ) -> io::Result<Box<dyn ProxyStream>> {
            self.proxy_homes.lock().unwrap().push(home.to_path_buf());
            self.proxy_sqlite_homes
                .lock()
                .unwrap()
                .push(sqlite_home.to_path_buf());
            self.proxy(executable)
        }
    }

    #[cfg(unix)]
    #[test]
    fn system_runs_the_codex_command_in_the_requested_home() {
        let home = tempfile::tempdir().unwrap();
        let sqlite_home = tempfile::tempdir().unwrap();
        let arguments = vec![
            "-c".into(),
            "printf '%s|%s' \"$CODEX_HOME\" \"$CODEX_SQLITE_HOME\"".into(),
        ];
        let outcome = SystemRunner.run_in_home(
            Path::new("/bin/sh"),
            &arguments,
            Duration::from_secs(2),
            home.path(),
            sqlite_home.path(),
        );
        assert_eq!(
            outcome,
            RunOutcome::Exited {
                code: 0,
                stdout: format!(
                    "{}|{}",
                    home.path().to_string_lossy(),
                    sqlite_home.path().to_string_lossy()
                ),
                stderr: String::new(),
            }
        );
    }

    #[cfg(windows)]
    #[test]
    fn system_runs_a_command_to_its_exit_code() {
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let cmd = Path::new(&root).join(r"System32\cmd.exe");
        let outcome = SystemRunner.run(
            &cmd,
            &["/D".into(), "/C".into(), "exit 3".into()],
            Duration::from_secs(10),
        );
        assert!(
            matches!(outcome, RunOutcome::Exited { code: 3, .. }),
            "{outcome:?}"
        );
    }

    /// Two connected byte streams: a Unix socket pair, or a loopback TCP
    /// connection on Windows.
    #[cfg(unix)]
    fn pair() -> (
        std::os::unix::net::UnixStream,
        std::os::unix::net::UnixStream,
    ) {
        std::os::unix::net::UnixStream::pair().unwrap()
    }

    #[cfg(windows)]
    fn pair() -> (std::net::TcpStream, std::net::TcpStream) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let writer = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (reader, _) = listener.accept().unwrap();
        (writer, reader)
    }

    // test_incomplete_loaded_thread_response_obeys_deadline.
    #[test]
    fn a_partial_answer_obeys_the_deadline() {
        let (mut writer, reader) = pair();
        writer
            .write_all(
                b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n\x81\x7e\x00",
            )
            .unwrap();
        let mut reader = ChannelReader::new(reader);
        let started = Instant::now();
        let first = reader.read(started + Duration::from_millis(500)).unwrap();
        assert!(first.ends_with(b"\x81\x7e\x00"));
        let error = reader
            .read(Instant::now() + Duration::from_millis(50))
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_millis(900));
        drop(writer);
        assert_eq!(
            reader
                .read(Instant::now() + Duration::from_secs(2))
                .unwrap(),
            b""
        );
    }

    // Review: output past the limit is drained, not cut off under the writer.
    #[test]
    fn output_past_the_limit_is_drained() {
        struct Counted(usize, std::sync::Arc<std::sync::atomic::AtomicUsize>);
        impl Read for Counted {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let count = buffer.len().min(self.0);
                buffer[..count].fill(b'x');
                self.0 -= count;
                self.1.fetch_add(count, std::sync::atomic::Ordering::SeqCst);
                Ok(count)
            }
        }
        let read = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let text = read_limited(Counted(200_000, read.clone()));
        assert_eq!(text.len(), OUTPUT_LIMIT as usize);
        assert_eq!(read.load(std::sync::atomic::Ordering::SeqCst), 200_000);
    }

    // Review: a write to a proxy that stopped reading ends at the deadline.
    #[cfg(windows)]
    #[test]
    fn a_write_the_reader_never_takes_ends_at_the_deadline() {
        // A proxy that never takes its input: loopback buffers vary by
        // machine (one took 64 MB at once), so the block is explicit.
        struct Stuck(std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>);
        impl Write for Stuck {
            fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
                let (released, changed) = &*self.0;
                let mut released = released.lock().unwrap();
                while !*released {
                    released = changed.wait(released).unwrap();
                }
                Ok(buffer.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let gate = std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let mut writer = DeadlineWriter::new(Stuck(gate.clone()));
        let started = Instant::now();
        let error = writer
            .write_all(&[0u8; 16], started + Duration::from_millis(100))
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
        // Releasing the proxy lets the writer thread finish and exit.
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        drop(writer);
        // A reader that takes everything lets the write finish.
        let (writer, mut reader) = pair();
        let mut writer = DeadlineWriter::new(writer);
        let drain = std::thread::spawn(move || {
            let mut all = Vec::new();
            reader.read_to_end(&mut all).unwrap();
            all.len()
        });
        writer
            .write_all(
                &vec![1u8; 1 << 20],
                Instant::now() + Duration::from_secs(10),
            )
            .unwrap();
        drop(writer);
        assert_eq!(drain.join().unwrap(), 1 << 20);
    }

    // Review: a write to a proxy that stopped reading ends at the deadline.
    #[cfg(unix)]
    #[test]
    fn a_write_the_reader_never_takes_ends_at_the_deadline() {
        let (mut writer, reader) = pair();
        let started = Instant::now();
        let error = write_by(
            &mut writer,
            &vec![0u8; 8 << 20],
            started + Duration::from_millis(100),
        )
        .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
        drop(reader);
        // A reader that takes everything lets the write finish.
        let (mut writer, mut reader) = pair();
        let drain = std::thread::spawn(move || {
            let mut all = Vec::new();
            reader.read_to_end(&mut all).unwrap();
            all.len()
        });
        write_by(
            &mut writer,
            &vec![1u8; 1 << 20],
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        drop(writer);
        assert_eq!(drain.join().unwrap(), 1 << 20);
    }
}
