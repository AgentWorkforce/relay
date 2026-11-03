//! `cursor-cloud` driven through the probe's own enumerate/hydrate paths
//! against a loopback stand-in for api.cursor.com.
use super::tests::{bare_home, EnvGuard, ENV_LOCK};
use super::*;
use ai_hist::Source;
use std::sync::{Arc, Mutex};

const AGENT: &str = "bc-00000000-0000-0000-0000-0000000000aa";
const LOCAL_CURSOR: &str = "9f764b2e-62a7-4657-bdf4-9eeecd269742";

/// The documented Cloud Agents shapes for one agent with one run.
struct CursorStub {
    listener: std::net::TcpListener,
    requests: Arc<Mutex<Vec<String>>>,
}

impl CursorStub {
    fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let logged = requests.clone();
        let serving = listener.try_clone().unwrap();
        std::thread::spawn(move || {
            for stream in serving.incoming() {
                let Ok(mut stream) = stream else { return };
                use std::io::{Read, Write};
                let mut buffer = [0u8; 8192];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                logged.lock().unwrap().push(request.clone());
                let line = request.lines().next().unwrap_or("").to_string();
                let (status, body) = if line.starts_with("GET /v1/agents?") {
                    (
                        200,
                        format!(
                            r#"{{"items":[{{"id":"{AGENT}","name":"Prepare iOS build 37","status":"IDLE","url":"https://cursor.com/agents/{AGENT}","createdAt":"2026-10-20T18:30:00.000Z","updatedAt":"2026-10-20T18:45:00.000Z","latestRunId":"run-1"}}]}}"#
                        ),
                    )
                } else if line.starts_with(&format!("GET /v1/agents/{AGENT}/runs")) {
                    (
                        200,
                        format!(
                            r#"{{"items":[{{"id":"run-1","agentId":"{AGENT}","status":"FINISHED","createdAt":"2026-10-20T18:30:00.000Z","updatedAt":"2026-10-20T18:45:00.000Z"}}]}}"#
                        ),
                    )
                } else if line.starts_with(&format!("GET /v0/agents/{AGENT}/conversation")) {
                    (
                        200,
                        format!(
                            r#"{{"id":"{AGENT}","messages":[{{"id":"m1","type":"user_message","text":"bump the build"}},{{"id":"m2","type":"assistant_message","text":"build 37 is ready"}}]}}"#
                        ),
                    )
                } else if line.starts_with(&format!("GET /v1/agents/{AGENT} ")) {
                    (
                        200,
                        format!(
                            r#"{{"id":"{AGENT}","name":"Prepare iOS build 37","status":"IDLE","createdAt":"2026-10-20T18:30:00.000Z","updatedAt":"2026-10-20T18:45:00.000Z"}}"#
                        ),
                    )
                } else {
                    (404, "{}".to_string())
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Self { listener, requests }
    }

    fn url(&self) -> String {
        format!("http://{}", self.listener.local_addr().unwrap())
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

/// A home with only a Cursor API key, pointed at `api_url`.
fn cursor_home(api_url: &str) -> (tempfile::TempDir, Vec<EnvGuard>) {
    let (home, mut env) = bare_home();
    env.push(EnvGuard::set("RELAYHISTORY_CURSOR_API_KEY", "key_test"));
    env.push(EnvGuard::set("RELAYHISTORY_CURSOR_API_BASE_URL", api_url));
    (home, env)
}

fn cursor_events(db: &Path, session_id: &str) -> Vec<(String, String)> {
    let conn =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let mut statement = conn
        .prepare(
            "SELECT role, text FROM session_events WHERE source = 'cursor' AND session_id = ?1 \
             ORDER BY ts_ms, id",
        )
        .unwrap();
    statement
        .query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn cursor_cloud_agents_are_listed_and_hydrated_as_remote_cursor_sessions() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let api = CursorStub::start();
    let (home, _env) = cursor_home(&api.url());
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("history.db");

    let report = enumerate(&db, home.path(), || false).unwrap().unwrap();
    let listed = report
        .connectors
        .iter()
        .find(|row| row.connector == CURSOR_CLOUD_CONNECTOR)
        .unwrap();
    assert_eq!((listed.state.as_str(), listed.sessions), ("listed", 1));
    assert!(scoped(Some(&[Source::parse("cursor").unwrap()])));

    let store = super::super::history::open(&db).unwrap();
    let source = Source::parse("cursor").unwrap();
    assert!(remote_only(&store, source, AGENT).unwrap());
    assert!(observed(&store, "cursor", AGENT).unwrap());
    assert_eq!(
        hydrate(&store, home.path(), "cursor", AGENT, || false).unwrap(),
        Some(true)
    );
    assert_eq!(
        cursor_events(&db, AGENT),
        [
            ("user".to_string(), "bump the build".to_string()),
            ("assistant".to_string(), "build 37 is ready".to_string()),
        ]
    );
    assert!(api
        .requests()
        .iter()
        .all(|request| request.contains("Bearer key_test")));
}

#[test]
fn a_local_cursor_id_never_becomes_a_cloud_placeholder() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let api = CursorStub::start();
    let (_home, _env) = cursor_home(&api.url());
    let dir = tempfile::tempdir().unwrap();
    let store = super::super::history::open(&dir.path().join("history.db")).unwrap();
    assert_eq!(
        hydrate_reader(&store, "cursor", LOCAL_CURSOR, || false).unwrap(),
        None
    );
    assert!(!observed(&store, "cursor", LOCAL_CURSOR).unwrap());
    assert!(api.requests().is_empty(), "{:?}", api.requests());

    // A Cloud Agent id the reader has never seen still opens.
    assert_eq!(
        hydrate_reader(&store, "cursor", AGENT, || false).unwrap(),
        Some(true)
    );
    assert_eq!(
        cursor_events(&dir.path().join("history.db"), AGENT).len(),
        2
    );
}
