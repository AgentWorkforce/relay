//! Starting `opencode serve` for this core: one server on a loopback port of
//! its own, with Basic credentials and a marker that only its environment
//! holds. Probe-managed OpenCode sessions (`managed_sessions`) and spawned
//! OpenCode agents (`harness::opencode`) both start their server here, then
//! bind a session to it (`opencode_existing::Binding`), which delivery proves
//! again before every request: the exact process, its listener, its
//! credentials and the session's identity.
//!
//! OpenCode has no socket-activation interface, so the port reserved here is
//! released before the server binds it. A server that loses that narrow race
//! exits; that kernel fact is detected and the start retried on a fresh port.

use crate::relay::opencode_existing::{credential_reference, Binding};
use crate::relay::process::{ProcessInfo, ProcessTable};
use crate::relay::store::random_hex;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::TcpListener;
use std::path::Path;
use std::time::{Duration, Instant};

/// The environment variable that carries a server's marker, which its
/// binding's credential reference is sealed with.
pub const MARKER: &str = "AGENT_RELAY_MANAGED_SESSION_MARKER";

/// How many fresh ports a start tries.
const ATTEMPTS: usize = 3;

/// One `opencode serve` this core started and found running.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Served {
    /// The exact process, read twice from the kernel.
    pub process: ProcessInfo,
    /// `http://127.0.0.1:<port>`.
    pub endpoint: String,
    pub marker: String,
}

impl Served {
    /// The binding of `session_id`, in `directory`, on this server for the
    /// authority (`workspace_id`, `owner_id`), its credential reference
    /// sealed with the marker. OpenCode's project and workspace ids are
    /// still to be read back (`opencode_existing::inspect_session`).
    pub fn binding(
        &self,
        (workspace_id, owner_id): (&str, &str),
        session_id: &str,
        executable: &Path,
        directory: &Path,
    ) -> Binding {
        let mut binding = Binding {
            relay_workspace_id: workspace_id.to_string(),
            owner_id: owner_id.to_string(),
            session_id: session_id.to_string(),
            endpoint: self.endpoint.clone(),
            server_pid: self.process.pid,
            server_start: self.process.start,
            server_uid: self.process.uid,
            executable: executable.to_path_buf(),
            directory: directory.to_path_buf(),
            project_id: "pending-readback".into(),
            opencode_workspace_id: None,
            credential_reference: String::new(),
        };
        binding.credential_reference = credential_reference(&binding, &self.marker);
        binding
    }
}

/// Starts `opencode` with these arguments and this environment, in the
/// background; its pid.
pub type Start<'a> = dyn Fn(&[OsString], &BTreeMap<String, String>) -> Result<i32, ()> + 'a;

/// A server that did not start, or never became ready.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NotServed;

/// How to start one server.
pub struct Serve<'a> {
    pub table: &'a dyn ProcessTable,
    /// The uid the server must run as.
    pub owner_uid: u32,
    /// Its environment, before the marker and credentials are added.
    pub environment: BTreeMap<String, String>,
    /// How long it gets, over every attempt, to come up and be ready.
    pub timeout: Duration,
    pub start: &'a Start<'a>,
    /// Ends a server that never became ready.
    pub terminate: &'a dyn Fn(ProcessInfo),
}

/// `serve --hostname 127.0.0.1 --port <port>`.
pub fn arguments(port: u16) -> [OsString; 5] {
    [
        "serve".into(),
        "--hostname".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string().into(),
    ]
}

/// Starts a server and returns what `ready` makes of it, once `ready`
/// answers: it is asked, every tenth of a second, while the server's exact
/// process runs as `owner_uid`. A server that never becomes ready is ended.
/// Nothing is started on Windows, where the routes that bind its sessions
/// (managed sessions and spawned OpenCode) are not available.
pub fn serve<T>(
    serve: &Serve<'_>,
    ready: &mut dyn FnMut(&Served) -> Option<T>,
) -> Result<T, NotServed> {
    if !crate::relay::existing_session::platform::SUPPORTED {
        return Err(NotServed);
    }
    let marker = random_hex(64);
    let mut environment = serve.environment.clone();
    environment.insert(MARKER.into(), marker.clone());
    environment.insert(
        "OPENCODE_SERVER_USERNAME".into(),
        format!("relay-{}", random_hex(16)),
    );
    environment.insert("OPENCODE_SERVER_PASSWORD".into(), random_hex(64));
    let deadline = Instant::now() + serve.timeout;
    for _ in 0..ATTEMPTS {
        let port = TcpListener::bind(("127.0.0.1", 0))
            .and_then(|listener| listener.local_addr())
            .map_err(|_| NotServed)?
            .port();
        let pid = (serve.start)(&arguments(port), &environment).map_err(|()| NotServed)?;
        let endpoint = format!("http://127.0.0.1:{port}");
        let (found, launched) = wait(serve, pid, &endpoint, &marker, deadline, ready);
        if found.is_some() {
            return found.ok_or(NotServed);
        }
        if let Some(process) = launched {
            (serve.terminate)(process);
        }
        if Instant::now() >= deadline {
            break;
        }
    }
    Err(NotServed)
}

/// Waits for one started server until `ready` answers, its process is
/// gone or the deadline passes; also the process, once it was seen.
fn wait<T>(
    serve: &Serve<'_>,
    pid: i32,
    endpoint: &str,
    marker: &str,
    deadline: Instant,
    ready: &mut dyn FnMut(&Served) -> Option<T>,
) -> (Option<T>, Option<ProcessInfo>) {
    let mut launched = None;
    while Instant::now() < deadline {
        let process = serve.table.process(pid).filter(|process| {
            process.uid == serve.owner_uid && serve.table.process(pid) == Some(*process)
        });
        if let Some(process) = process {
            launched.get_or_insert(process);
            let served = Served {
                process,
                endpoint: endpoint.to_string(),
                marker: marker.to_string(),
            };
            if let Some(value) = ready(&served) {
                return (Some(value), launched);
            }
        } else if serve.table.process_gone(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    (None, launched)
}

// `serve` starts nothing on Windows.
#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};
    use std::cell::RefCell;

    fn table() -> FakeProcesses {
        FakeProcesses::default()
    }

    #[test]
    fn a_server_starts_with_its_own_port_marker_and_credentials() {
        let table = table();
        let started = RefCell::new(Vec::new());
        let start = |arguments: &[OsString], environment: &BTreeMap<String, String>| {
            started
                .borrow_mut()
                .push((arguments.to_vec(), environment.clone()));
            table.insert(
                4242,
                FakeProcess {
                    uid: 501,
                    start: 7,
                    ..FakeProcess::default()
                },
            );
            Ok(4242)
        };
        let terminate = |_: ProcessInfo| panic!("a ready server is kept");
        let serve_it = Serve {
            table: &table,
            owner_uid: 501,
            environment: BTreeMap::from([("PATH".to_string(), "/bin".to_string())]),
            timeout: Duration::from_secs(5),
            start: &start,
            terminate: &terminate,
        };
        let mut asked = 0;
        let served = serve(&serve_it, &mut |served: &Served| {
            asked += 1;
            (asked == 3).then(|| served.clone())
        })
        .unwrap();
        assert_eq!(asked, 3);
        let started = started.into_inner();
        assert_eq!(started.len(), 1);
        let (arguments, environment) = &started[0];
        let port = arguments[4].to_string_lossy().into_owned();
        assert_eq!(
            arguments[..4],
            ["serve", "--hostname", "127.0.0.1", "--port"]
        );
        assert_eq!(served.endpoint, format!("http://127.0.0.1:{port}"));
        assert_eq!(served.process.pid, 4242);
        assert_eq!(environment["PATH"], "/bin");
        assert_eq!(environment[MARKER], served.marker);
        assert_eq!(served.marker.len(), 64);
        assert!(environment["OPENCODE_SERVER_USERNAME"].starts_with("relay-"));
        assert_eq!(environment["OPENCODE_SERVER_PASSWORD"].len(), 64);
        let binding = served.binding(("w", "o"), "ses_abcd", Path::new("/x"), Path::new("/d"));
        assert_eq!(
            binding.credential_reference,
            credential_reference(&binding, &served.marker)
        );
        assert_eq!((binding.server_pid, binding.server_start), (4242, 7));
    }

    #[test]
    fn a_server_that_never_becomes_ready_is_ended() {
        let table = table();
        let ended = RefCell::new(Vec::new());
        let start = |_: &[OsString], _: &BTreeMap<String, String>| {
            table.insert(
                99,
                FakeProcess {
                    uid: 501,
                    start: 3,
                    ..FakeProcess::default()
                },
            );
            Ok(99)
        };
        let terminate = |process: ProcessInfo| ended.borrow_mut().push(process.pid);
        let serve_it = Serve {
            table: &table,
            owner_uid: 501,
            environment: BTreeMap::new(),
            timeout: Duration::from_millis(300),
            start: &start,
            terminate: &terminate,
        };
        assert_eq!(
            serve(&serve_it, &mut |_: &Served| None::<()>),
            Err(NotServed)
        );
        assert_eq!(ended.into_inner(), [99]);
    }

    #[test]
    fn a_server_of_another_user_is_never_ready() {
        let table = table();
        let start = |_: &[OsString], _: &BTreeMap<String, String>| {
            table.insert(
                99,
                FakeProcess {
                    uid: 0,
                    start: 3,
                    ..FakeProcess::default()
                },
            );
            Ok(99)
        };
        let terminate = |_: ProcessInfo| panic!("never seen as ours");
        let serve_it = Serve {
            table: &table,
            owner_uid: 501,
            environment: BTreeMap::new(),
            timeout: Duration::from_millis(250),
            start: &start,
            terminate: &terminate,
        };
        assert_eq!(serve(&serve_it, &mut |_: &Served| Some(())), Err(NotServed));
    }
}
