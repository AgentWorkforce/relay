//! A spawned agent is credited to the person its node is claimed for
//! (`spawn::credit`): its Relaycast record gains the owner metadata a
//! session registration carries, so the roster reports it as theirs.

use super::*;
use crate::relay::cloud_session::{AgentOwner, CloudAccess, CloudAccount, CloudError};
use crate::relay::spawn::credit::Credit;
use futures_util::future::BoxFuture;

const USER: &str = "user_khaliq";
const WORKSPACE: &str = "ws_1";

/// Signed in as `USER` in `WORKSPACE`, the install attached for them.
struct SignedIn;

impl CloudAccess for SignedIn {
    fn account(&self) -> Option<CloudAccount> {
        Some(CloudAccount {
            site_url: "https://agentrelay.example".into(),
            workspace_id: WORKSPACE.into(),
            user_id: Some(USER.into()),
        })
    }

    fn agent_owner(&self) -> Option<AgentOwner> {
        Some(AgentOwner {
            user_id: USER.into(),
            workspace_id: Some(WORKSPACE.into()),
        })
    }

    fn request(
        &self,
        _: &'static str,
        _: String,
        _: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        Box::pin(async { Err(CloudError::Unreachable) })
    }
}

/// Relaycast's REST API holding agent records by name: `GET
/// /v1/agents/{name}` answers the record, `PATCH /v1/agents/{name}` merges
/// its metadata (and status) into it, as Relaycast does. Every PATCH body
/// is kept in `patches`.
struct Rest {
    base_url: String,
    records: Arc<Mutex<HashMap<String, Value>>>,
    patches: Arc<Mutex<Vec<Value>>>,
}

fn rest() -> Rest {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let records: Arc<Mutex<HashMap<String, Value>>> = Arc::default();
    let patches: Arc<Mutex<Vec<Value>>> = Arc::default();
    let (held, patched) = (records.clone(), patches.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            let header_end = loop {
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Some(end + 4);
                }
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break None,
                    Ok(read) => request.extend_from_slice(&buffer[..read]),
                }
            };
            let Some(header_end) = header_end else {
                continue;
            };
            let head = String::from_utf8_lossy(&request[..header_end]).to_string();
            let length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            while request.len() < header_end + length {
                match stream.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => request.extend_from_slice(&buffer[..read]),
                }
            }
            let line = head.lines().next().unwrap_or_default().to_string();
            let mut parts = line.split_whitespace();
            let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            let name = path
                .strip_prefix("/v1/agents/")
                .filter(|name| !name.contains('/') && !name.contains('?'))
                .map(str::to_string);
            let mut records = held.lock().unwrap();
            let found = match (method, name) {
                ("GET", Some(name)) => records.get(&name).cloned(),
                ("PATCH", Some(name)) => {
                    let body: Value =
                        serde_json::from_slice(&request[header_end..]).unwrap_or(Value::Null);
                    patched.lock().unwrap().push(body.clone());
                    records.get_mut(&name).map(|record| {
                        if let Some(metadata) = body["metadata"].as_object() {
                            for (key, value) in metadata {
                                record["metadata"][key] = value.clone();
                            }
                        }
                        if let Some(status) = body["status"].as_str() {
                            record["status"] = json!(status);
                        }
                        record.clone()
                    })
                }
                _ => None,
            };
            drop(records);
            let (status, body) = match found {
                Some(record) => ("200 OK", json!({"ok": true, "data": record})),
                None => (
                    "404 Not Found",
                    json!({"ok": false, "error": {"code": "not_found", "message": "not here"}}),
                ),
            };
            let body = body.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    Rest {
        base_url,
        records,
        patches,
    }
}

impl Rest {
    /// Holds Relaycast's record of `name` as the node's `agent.register`
    /// leaves it: `metadata.fleet` only, unless `metadata` says more.
    fn hold(&self, name: &str, metadata: Value) {
        let mut record = json!({"id": format!("agent_{name}"), "name": name, "type": "agent",
            "status": "active", "persona": null, "address": format!("{name}@test-desk-desktop"),
            "last_seen": chrono::Utc::now().to_rfc3339(),
            "metadata": {"fleet": {"node_id": "node_desktop_1", "invocation_id": format!("inv_{name}")}}});
        if let Some(extra) = metadata.as_object() {
            for (key, value) in extra {
                record["metadata"][key] = value.clone();
            }
        }
        self.records.lock().unwrap().insert(name.into(), record);
    }

    fn record(&self, name: &str) -> Value {
        self.records.lock().unwrap()[name].clone()
    }
}

/// Cloud's last answer to the claim recorded the node as `owner`'s.
fn claimed(core: &Core, user: &str, owner: &str) {
    std::fs::create_dir_all(&core.config.app_data_dir).unwrap();
    std::fs::write(
        core.config
            .app_data_dir
            .join(super::super::claim::CLAIM_FILE),
        json!({"nodeID": "node_desktop_1", "token": "00", "siteURL": "https://agentrelay.example",
            "workspaceID": WORKSPACE, "userID": user, "owner": owner, "atMs": 0})
        .to_string(),
    )
    .unwrap();
}

/// The roster's view of `record`, as `roster.list` decodes it for `core`.
fn roster_row(core: &Core, record: &Value) -> crate::relay::people::RosterAgent {
    let rows = crate::relay::people::decode_roster(
        std::slice::from_ref(record),
        &HashMap::new(),
        core.owner_hash().as_deref(),
        chrono::Utc::now().timestamp_millis(),
    );
    rows.into_iter().next().expect("the roster lists it")
}

async fn eventually(mut done: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "never happened");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_spawned_agent_is_credited_to_the_node_owner_and_listed_as_theirs() {
    let home = tempfile::tempdir().unwrap();
    let rest = rest();
    rest.hold("w1", json!({}));
    let core = core_signed_in(
        home.path(),
        Arc::new(FakeSpawner::default()),
        Arc::new(SignedIn),
        &rest.base_url,
    );
    claimed(&core, USER, "me");
    // Before: Relaycast's record names nobody, so the roster says not yours.
    let before = roster_row(&core, &rest.record("w1"));
    assert!(!before.is_self);
    assert_eq!(before.owner_hash, None);

    let result = spawn(&core, "w1").await;
    assert!(result.get("error").is_none(), "{result}");
    eventually(|| core.store.read(|s| s.agent_owners.contains_key("agent_w1"))).await;

    let record = rest.record("w1");
    let hash = crate::relay::people::identity_hash(USER);
    assert_eq!(record["metadata"]["owner_hash"], json!(hash));
    assert_eq!(record["metadata"]["cloud_user_id"], USER);
    assert_eq!(record["metadata"]["cloud_workspace_id"], WORKSPACE);
    // Merged: Relaycast's own stamp stays.
    assert_eq!(record["metadata"]["fleet"]["invocation_id"], "inv_w1");
    let patches = rest.patches.lock().unwrap().clone();
    assert_eq!(patches.len(), 1, "{patches:?}");
    assert!(patches[0]["status"].is_string(), "a PATCH keeps the status");

    let row = roster_row(&core, &record);
    assert!(row.is_self);
    assert_eq!(row.owner_hash.as_deref(), Some(hash.as_str()));
    assert_eq!(
        core.store.read(|s| s.agent_owners.get("agent_w1").cloned()),
        Some(AgentOwner {
            user_id: USER.into(),
            workspace_id: Some(WORKSPACE.into()),
        })
    );

    // Credited once: later passes ask nothing.
    assert_eq!(
        core.credit_spawned("w1", "agent_w1").await,
        Credit::Credited
    );
    assert_eq!(rest.patches.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn an_agent_another_person_owns_is_never_transferred() {
    let home = tempfile::tempdir().unwrap();
    let rest = rest();
    let theirs = crate::relay::people::identity_hash("user_grace");
    rest.hold(
        "w1",
        json!({"owner_hash": theirs, "cloud_user_id": "user_grace"}),
    );
    let core = core_signed_in(
        home.path(),
        Arc::new(FakeSpawner::default()),
        Arc::new(SignedIn),
        &rest.base_url,
    );
    claimed(&core, USER, "me");
    let result = spawn(&core, "w1").await;
    assert!(result.get("error").is_none(), "{result}");
    eventually(|| {
        let ledger = core.ledger();
        let state = ledger.lock();
        state.uncredited.contains("agent_w1")
    })
    .await;
    assert!(rest.patches.lock().unwrap().is_empty());
    let record = rest.record("w1");
    assert_eq!(record["metadata"]["owner_hash"], json!(theirs));
    assert!(!roster_row(&core, &record).is_self);
    assert!(core.store.read(|s| s.agent_owners.is_empty()));
}

#[tokio::test]
async fn nothing_is_credited_until_the_node_is_claimed_for_the_person_signed_in() {
    let home = tempfile::tempdir().unwrap();
    let rest = rest();
    rest.hold("w1", json!({}));
    let core = core_signed_in(
        home.path(),
        Arc::new(FakeSpawner::default()),
        Arc::new(SignedIn),
        &rest.base_url,
    );
    observed(&core);
    // Not claimed yet: an agent spawned now is left for later.
    let result = spawn(&core, "w1").await;
    assert!(result.get("error").is_none(), "{result}");
    assert_eq!(core.credit_spawned("w1", "agent_w1").await, Credit::Later);
    // Claimed for another account, or for someone other than who is
    // signed in now: still nothing.
    claimed(&core, USER, "other");
    assert_eq!(core.credit_spawned("w1", "agent_w1").await, Credit::Later);
    claimed(&core, "user_someone_else", "me");
    assert_eq!(core.credit_spawned("w1", "agent_w1").await, Credit::Later);
    assert!(rest.patches.lock().unwrap().is_empty());
    assert!(rest.record("w1")["metadata"]["owner_hash"].is_null());

    // Once the claim is the signed-in person's, the next lifecycle pass
    // credits the agent spawned before it.
    claimed(&core, USER, "me");
    core.observe_spawned().await;
    eventually(|| core.store.read(|s| s.agent_owners.contains_key("agent_w1"))).await;
    assert!(roster_row(&core, &rest.record("w1")).is_self);
}
