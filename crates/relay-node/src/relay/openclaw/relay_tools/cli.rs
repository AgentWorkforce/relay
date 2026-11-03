//! OpenClaw's command-line tool, found without `PATH` (the core runs under
//! launchd or systemd with a minimal one), and the lines `openclaw mcp
//! login` prints on its way to the browser.
//!
//! The running Gateway is the best witness of which OpenClaw the person
//! uses: its kernel-reported executable (usually node) with the script
//! argument it runs. Otherwise an `openclaw` launcher in the directories
//! package managers install into, then `PATH`.

use crate::relay::process::ProcessTable;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How one OpenClaw command is started: the program, the arguments before
/// OpenClaw's own (the script node runs), and the environment that points
/// it at the same `openclaw.json` this core reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cli {
    pub program: PathBuf,
    pub leading: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl Cli {
    pub fn new(program: PathBuf, leading: Vec<String>) -> Cli {
        Cli {
            program,
            leading,
            env: Vec::new(),
        }
    }

    /// `openclaw <args>`, stdin closed, in a process group of its own so
    /// [`stop`] reaches everything it starts.
    pub fn command(&self, args: &[&str]) -> Command {
        use crate::relay::existing_session::platform::CommandExt;
        let mut command = Command::new(&self.program);
        command
            .args(&self.leading)
            .args(args)
            .stdin(Stdio::null())
            .envs(self.env.iter().map(|(key, value)| (key, value)))
            .process_group(0);
        command
    }
}

/// How long a stopped CLI may take to stop what it started.
const STOP_GRACE: Duration = Duration::from_secs(5);

/// Stops `child` and every process it started, then reaps it. OpenClaw's
/// launcher (2026.10.4) respawns the CLI as a detached child, in a process
/// group of its own, and forwards SIGTERM to it: killing the launcher
/// outright would leave `mcp login` running, holding its OAuth callback
/// port, so the next Connect could not start one. So the group is asked
/// to stop first, and only a CLI that outlives the grace is killed.
///
/// Windows has no signal to ask a group with; OpenClaw is not offered
/// there, and a CLI that ran anyway is killed at once.
pub fn stop(child: &mut Child) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{killpg, Signal};
        if let Ok(pid) = i32::try_from(child.id()) {
            let _ = killpg(nix::unistd::Pid::from_raw(pid), Signal::SIGTERM);
        }
    }
    #[cfg(windows)]
    let _ = child.kill();
    let deadline = Instant::now() + STOP_GRACE;
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Whether `argument` is the script an OpenClaw Gateway's node runs.
fn is_script(argument: &str) -> bool {
    let argument = argument.replace('\\', "/");
    argument.ends_with("/openclaw/dist/index.js") || argument.ends_with("/openclaw.mjs")
}

fn is_launcher(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == "openclaw") && is_executable(path)
}

fn is_executable(path: &Path) -> bool {
    use crate::relay::existing_session::platform::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// The OpenClaw a running Gateway of `uid` runs.
pub fn from_gateway(table: &dyn ProcessTable, uid: u32) -> Option<Cli> {
    table.all_pids().into_iter().find_map(|pid| {
        let process = table.process(pid).filter(|process| process.uid == uid)?;
        let arguments = table.arguments(process.pid);
        if !crate::relay::openclaw::is_gateway_process(&arguments) {
            return None;
        }
        let executable = table.executable(pid)?;
        if let Some(script) = arguments.iter().find(|argument| is_script(argument)) {
            let script = match Path::new(script) {
                path if path.is_absolute() => path.to_path_buf(),
                path => table.cwd(pid)?.join(path),
            };
            return script
                .is_file()
                .then(|| Cli::new(executable, vec![script.to_string_lossy().into_owned()]));
        }
        if is_launcher(&executable) {
            return Some(Cli::new(executable, Vec::new()));
        }
        // A launcher named in argv, else the one beside the runtime (a
        // title-only Gateway: `openclaw-gateway` run by an nvm node).
        arguments
            .iter()
            .map(PathBuf::from)
            .find(|path| path.is_absolute() && is_launcher(path))
            .or_else(|| {
                executable
                    .parent()
                    .map(|dir| dir.join("openclaw"))
                    .filter(|path| is_launcher(path))
            })
            .map(|launcher| Cli::new(launcher, Vec::new()))
    })
}

/// Where package managers put `openclaw`, then `PATH`'s directories.
pub fn search_dirs(home: &Path, env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
        home.join(".volta/bin"),
    ];
    for key in ["NPM_CONFIG_PREFIX", "npm_config_prefix"] {
        if let Some(prefix) = env(key).filter(|prefix| !prefix.trim().is_empty()) {
            dirs.push(PathBuf::from(prefix.trim()).join("bin"));
        }
    }
    if let Some(path) = env("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs
}

/// The first `openclaw` launcher in `dirs`.
pub fn from_dirs(dirs: &[PathBuf]) -> Option<Cli> {
    dirs.iter()
        .map(|dir| dir.join("openclaw"))
        .find(|path| is_launcher(path))
        .map(|launcher| Cli::new(launcher, Vec::new()))
}

/// What a finished command printed.
#[derive(Debug)]
pub struct Ran {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Why a command did not finish.
#[derive(Debug, PartialEq, Eq)]
pub enum RunError {
    /// It could not be started.
    Missing,
    /// It was stopped at its deadline.
    TimedOut,
}

fn drain(stream: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stream) = stream {
            let _ = stream.read_to_string(&mut text);
        }
        text
    })
}

/// Runs `command` to its end, or stops it at `timeout`.
pub fn run(mut command: Command, timeout: Duration) -> Result<Ran, RunError> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| RunError::Missing)?;
    let (stdout, stderr) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => break None,
        }
    };
    let Some(status) = status else {
        stop(&mut child);
        return Err(RunError::TimedOut);
    };
    Ok(Ran {
        success: status.success(),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

/// How far `openclaw mcp login` got.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Nothing decisive yet.
    More,
    /// It printed the authorization URL and waits for the browser.
    Url(String),
    /// Already signed in, or the sign-in just finished.
    Saved,
    /// It could not start its callback server and wants a code pasted in a
    /// terminal, which the apps cannot offer.
    Manual,
    /// This OpenClaw has no `mcp login`.
    Unsupported,
    /// The running Gateway owns OpenClaw's state, and this OpenClaw signs in
    /// only while it is stopped.
    GatewayOwns,
}

/// Reads `openclaw mcp login`'s lines (src/cli/mcp-cli-oauth.ts) in order.
#[derive(Default)]
pub struct LoginLines {
    asked: bool,
    url: Option<String>,
}

impl LoginLines {
    pub fn feed(&mut self, line: &str) -> Step {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        if line.starts_with("MCP OAuth credentials saved") {
            Step::Saved
        } else if super::servers::gateway_owns(line) {
            Step::GatewayOwns
        } else if line.starts_with("After approval, run")
            || line.starts_with("Could not start the local OAuth callback")
        {
            Step::Manual
        } else if lower.contains("unknown command") || lower.contains("too many arguments") {
            Step::Unsupported
        } else if line.starts_with("Open this URL to authorize") {
            self.asked = true;
            Step::More
        } else if self.asked
            && self.url.is_none()
            && (line.starts_with("https://") || line.starts_with("http://"))
        {
            self.url = Some(line.to_string());
            Step::More
        } else if line.starts_with("Waiting for the browser") {
            self.url.clone().map_or(Step::More, Step::Url)
        } else {
            Step::More
        }
    }

    /// The URL printed so far.
    pub fn url(&self) -> Option<String> {
        self.url.clone()
    }
}

/// Every line `child` prints on stdout and stderr, as they come.
pub fn lines(child: &mut Child) -> mpsc::Receiver<String> {
    let (send, receive) = mpsc::channel();
    let forward = |stream: Option<Box<dyn Read + Send>>, send: mpsc::Sender<String>| {
        std::thread::spawn(move || {
            if let Some(stream) = stream {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    // Lines after the caller stopped listening are dropped.
                    let _ = send.send(line);
                }
            }
        });
    };
    forward(
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        send.clone(),
    );
    forward(
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        send,
    );
    receive
}

/// Reads `lines` until a decisive step, the end of output, or `deadline`:
/// a URL printed without the line that follows it still counts once the
/// deadline passes. `None` when the output ended undecided.
pub fn await_login(lines: &mpsc::Receiver<String>, deadline: Instant) -> Option<Step> {
    let mut read = LoginLines::default();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match lines.recv_timeout(left) {
            Ok(line) => match read.feed(&line) {
                Step::More => {}
                step => return Some(step),
            },
            Err(mpsc::RecvTimeoutError::Timeout) => return read.url().map(Step::Url),
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
}
