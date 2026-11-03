//! An in-process Agent Relay Cloud on a loopback port: sign-in (device and
//! browser handoff), refresh, revoke, whoami, the workspace resolve and the
//! members list, with every request recorded.

#![allow(dead_code)]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

pub const USER: &str = "user-1";
pub const WORKSPACE: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
pub const ACCOUNT_KEY: &str = "rk_live_account00001";

#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub bearer: Option<String>,
    pub analytics: Option<String>,
    pub body: Value,
}

/// What the fake answers; tests change it as they go.
pub struct State {
    pub requests: Vec<Recorded>,
    /// Explicit per-request fixtures keyed by (path, bearer, RPC method or verb).
    pub response_overrides: HashMap<(String, String, String), (u16, Value)>,
    pub response_gates: HashMap<String, Arc<tokio::sync::Notify>>,
    /// Device polls answered `authorization_pending` before approval.
    pub pending_polls: u32,
    /// The device poll's final answer: `None` approves.
    pub device_error: Option<&'static str>,
    /// Access tokens Cloud accepts, and the session behind each refresh token.
    pub valid: Vec<String>,
    pub refresh_tokens: HashMap<String, u32>,
    pub minted: u32,
    pub resolve_status: u16,
    pub relaycast_url: Option<String>,
    pub relaycast_key: String,
    pub relaycast_status: u16,
    pub mcp_status: u16,
    pub provider_grants: HashMap<String, Value>,
    pub provider_grant_status: u16,
    pub mcp_native_identity: bool,
    /// The browser handoff exchange answers 500.
    pub exchange_fails: bool,
    /// The refresh answers this status, keeping the refresh token, while set.
    pub refresh_status: Option<u16>,
    /// `whoami` refuses every token while set, as for a suspended person.
    pub whoami_refused: bool,
    /// `/members` refuses every token while set, even a just-renewed one.
    pub members_refused: bool,
    /// Hold the whoami response until the test permits it.
    pub whoami_gate: Option<Arc<tokio::sync::Notify>>,
    pub whoami_status: Option<u16>,
    pub refresh_gate: Option<Arc<tokio::sync::Notify>>,
    pub whoami_workspace: String,
    pub whoami_workspace_name: String,
    pub whoami_workspace_count: u64,
    pub desktop_workspaces: Option<Value>,
    pub resolve_gate: Option<Arc<tokio::sync::Notify>>,
    pub whoami_user: String,
}

impl Default for State {
    fn default() -> State {
        State {
            requests: Vec::new(),
            response_overrides: HashMap::new(),
            response_gates: HashMap::new(),
            pending_polls: 1,
            device_error: None,
            valid: Vec::new(),
            refresh_tokens: HashMap::new(),
            minted: 0,
            resolve_status: 200,
            relaycast_url: None,
            relaycast_key: ACCOUNT_KEY.into(),
            relaycast_status: 200,
            mcp_status: 200,
            provider_grants: HashMap::new(),
            provider_grant_status: 200,
            mcp_native_identity: true,
            exchange_fails: false,
            refresh_status: None,
            whoami_refused: false,
            members_refused: false,
            whoami_gate: None,
            whoami_status: None,
            refresh_gate: None,
            whoami_workspace: WORKSPACE.into(),
            whoami_workspace_name: "Acme".into(),
            whoami_workspace_count: 1,
            desktop_workspaces: None,
            resolve_gate: None,
            whoami_user: USER.into(),
        }
    }
}

pub struct FakeCloud {
    pub site_url: String,
    pub state: Arc<Mutex<State>>,
    task: JoinHandle<()>,
}

impl Drop for FakeCloud {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeCloud {
    pub async fn start() -> FakeCloud {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let site_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let site = site_url.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(serve(stream, shared.clone(), site.clone()));
            }
        });
        FakeCloud {
            site_url,
            state,
            task,
        }
    }

    pub fn requests(&self, path: &str) -> Vec<Recorded> {
        self.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r.path == path)
            .cloned()
            .collect()
    }

    /// A session Cloud honours: `(access, refresh)`.
    pub fn issue(&self) -> (String, String) {
        mint(&mut self.state.lock().unwrap())
    }

    /// Cloud forgets every access token it issued (refresh tokens stay).
    pub fn expire_access(&self) {
        self.state.lock().unwrap().valid.clear();
    }
}

fn mint(state: &mut State) -> (String, String) {
    state.minted += 1;
    let access = format!("access-{}", state.minted);
    let refresh = format!("refresh-{}", state.minted);
    state.valid.push(access.clone());
    state.refresh_tokens.insert(refresh.clone(), state.minted);
    (access, refresh)
}

async fn serve(stream: TcpStream, state: Arc<Mutex<State>>, site: String) {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut line = String::new();
    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let mut length = 0usize;
    let mut bearer = None;
    let mut analytics = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).await.is_err() {
            return;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':').unwrap_or((header, ""));
        match name.to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().unwrap_or(0),
            "authorization" => bearer = value.trim().strip_prefix("Bearer ").map(str::to_string),
            "x-agent-relay-analytics" => analytics = Some(value.trim().to_string()),
            _ => {}
        }
    }
    let mut body = vec![0u8; length];
    if reader.read_exact(&mut body).await.is_err() {
        return;
    }
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let path = target.split('?').next().unwrap_or_default().to_string();
    let (status, answer) = {
        let mut state = state.lock().unwrap();
        state.requests.push(Recorded {
            method: method.clone(),
            path: path.clone(),
            bearer: bearer.clone(),
            analytics,
            body: body.clone(),
        });
        route(&mut state, &site, &method, &path, bearer.as_deref(), &body)
    };
    let gate = if path == "/cloud/api/v1/auth/whoami" {
        state.lock().unwrap().whoami_gate.clone()
    } else if path == "/cloud/api/v1/auth/token/refresh" {
        state.lock().unwrap().refresh_gate.clone()
    } else if path.ends_with("/resolve") {
        state.lock().unwrap().resolve_gate.clone()
    } else {
        state.lock().unwrap().response_gates.get(&path).cloned()
    };
    if let Some(gate) = gate {
        gate.notified().await;
    }
    let text = answer.to_string();
    let response = format!(
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = write.write_all(response.as_bytes()).await;
    let _ = write.shutdown().await;
}

fn route(
    state: &mut State,
    site: &str,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: &Value,
) -> (u16, Value) {
    let key = (path.to_string(), bearer.unwrap_or_default().to_string(), body["method"].as_str().unwrap_or(method).to_string());
    if let Some(response) = state.response_overrides.get(&key) { return response.clone(); }
    let authorized = bearer.is_some_and(|b| state.valid.iter().any(|v| v == b));
    let api = path.strip_prefix("/cloud/api/v1").unwrap_or(path);
    match (method, api) {
        ("POST", "/auth/device/start") => (
            200,
            json!({"device_code": "secret-device-code", "user_code": "ABCD-EFGH",
                   "verification_uri": format!("{site}/device"),
                   "verification_uri_complete": format!("{site}/device?code=ABCD-EFGH"),
                   "expires_in": 60, "interval": 1}),
        ),
        ("POST", "/auth/device/token") => {
            if body["device_code"] != "secret-device-code" {
                return (400, json!({"error": "invalid_grant"}));
            }
            if state.pending_polls > 0 {
                state.pending_polls -= 1;
                return (400, json!({"error": "authorization_pending"}));
            }
            if let Some(error) = state.device_error {
                return (400, json!({"error": error}));
            }
            let (access, refresh) = mint(state);
            (
                200,
                json!({"access_token": access, "refresh_token": refresh,
                       "access_token_expires_at": "2099-01-01T00:00:00Z",
                       "api_url": format!("{site}/cloud")}),
            )
        }
        ("POST", "/auth/desktop/session") => {
            if state.exchange_fails {
                return (500, json!({"error": "unavailable"}));
            }
            if !authorized || body["codeVerifier"].as_str().is_none_or(str::is_empty) {
                return (401, json!({"error": "denied"}));
            }
            let (access, refresh) = mint(state);
            (
                200,
                json!({"accessToken": access, "refreshToken": refresh,
                       "accessTokenExpiresAt": "2099-01-01T00:00:00Z"}),
            )
        }
        ("POST", "/auth/token/refresh") => {
            if let Some(status) = state.refresh_status {
                return (status, json!({"error": "try later"}));
            }
            let Some(token) = body["refreshToken"].as_str() else {
                return (400, json!({}));
            };
            if state.refresh_tokens.remove(token).is_none() {
                return (401, json!({"error": "invalid refresh token"}));
            }
            let (access, refresh) = mint(state);
            (
                200,
                json!({"accessToken": access, "refreshToken": refresh,
                       "accessTokenExpiresAt": "2099-01-01T00:00:00Z"}),
            )
        }
        ("POST", "/auth/token/revoke") => {
            if let Some(token) = body["token"].as_str() {
                state.refresh_tokens.remove(token);
            }
            (200, json!({}))
        }
        ("GET", "/v1/workspace") => {
            let status = if bearer == Some(state.relaycast_key.as_str()) {
                state.relaycast_status
            } else {
                401
            };
            if status != 200 {
                return (
                    status,
                    json!({"ok": false, "error": {"code": "unauthorized", "message": "Workspace unavailable"}}),
                );
            }
            (
                200,
                json!({"ok": true, "data": {"id": "rw_acme", "name": "Acme", "system_prompt": null,
                "plan": "free", "created_at": "2026-09-01T00:00:00Z", "metadata": {},
                "effective_retention": {}, "usage_classification": "unknown"}}),
            )
        }
        _ if !authorized => (401, json!({"error": {"message": "Unauthorized"}})),
        (method, p) if p.starts_with(&format!("/workspaces/{WORKSPACE}/mcp/shared-sessions-tokens")) => {
            provider_credentials_route(state,method,p,body)
        }
        ("POST", "/mcp/shared-sessions") => {
            if state.mcp_status != 200 {
                return (state.mcp_status, json!({"error":"MCP unavailable"}));
            }
            let result = match body["method"].as_str() {
                Some("initialize") => {
                    json!({"protocolVersion":"2025-06-18", "serverInfo":{"name":"hosted-relay", "version":"1"}, "capabilities":{"tools":{}, "experimental": if state.mcp_native_identity { json!({"com.agentrelay/native-session-identity":{"version":1},"com.agentrelay/desktop-provider-credentials":{"version":1}}) } else { json!({}) }}})
                }
                Some("tools/list") => {
                    json!({"tools":[{"name":"search_shared_sessions"}, {"name":"send_relay_message"}]})
                }
                _ => {
                    return (
                        400,
                        json!({"error":"Only read-only discovery is supported in this fake"}),
                    )
                }
            };
            (
                200,
                json!({"jsonrpc":"2.0", "id":body["id"], "result":result}),
            )
        }
        ("GET", "/auth/whoami") if state.whoami_status.is_some() => {
            (state.whoami_status.unwrap(), json!({"error": "try later"}))
        }
        ("GET", "/auth/whoami") if state.whoami_refused => {
            (401, json!({"error": {"message": "Unauthorized"}}))
        }
        ("GET", "/auth/desktop/workspaces") if state.desktop_workspaces.is_some() => {
            (200, json!({"workspaces": state.desktop_workspaces}))
        }
        ("POST", "/auth/desktop/workspaces") => {
            let selected = body["workspaceId"].as_str().unwrap_or_default();
            if !state
                .desktop_workspaces
                .as_ref()
                .and_then(Value::as_array)
                .is_some_and(|choices| choices.iter().any(|choice| choice["id"] == selected))
            {
                return (404, json!({"error":"Workspace not found"}));
            }
            state.whoami_workspace = selected.to_string();
            let (access, refresh) = mint(state);
            (
                200,
                json!({"accessToken":access,"refreshToken":refresh,"accessTokenExpiresAt":"2099-01-01T00:00:00Z"}),
            )
        }
        ("GET", "/auth/whoami") => (
            200,
            json!({"user": {"id": state.whoami_user, "email": "ada@example.com", "name": "Ada"},
                   "currentWorkspace": {"id": state.whoami_workspace, "name": state.whoami_workspace_name},
                   "workspaceCount": state.whoami_workspace_count,
                   "currentOrganization": {"avatarUrl": "https://example.com/workspace.png"}}),
        ),
        ("GET", p) if p == format!("/workspaces/{WORKSPACE}/resolve") => {
            if state.resolve_status != 200 {
                return (state.resolve_status, json!({"error": "nope"}));
            }
            (
                200,
                json!({"data": {"relaycastApiKey": state.relaycast_key, "name": "Acme",
                       "relaycastWorkspaceId": "rw_acme", "cloudWorkspaceId": WORKSPACE,
                       "urls": {"relaycastUrl": state.relaycast_url.as_deref().unwrap_or("https://cast.agentrelay.com")}}}),
            )
        }
        ("PUT", p) if p == format!("/workspaces/{WORKSPACE}/messaging/desktop-identities") => {
            let valid = body["source_id"].as_str().is_some_and(|id| !id.is_empty())
                && body["identities"].is_array();
            if valid {
                (
                    200,
                    json!({"synced": body["identities"].as_array().map(Vec::len)}),
                )
            } else {
                (400, json!({"error": "invalid desktop identities"}))
            }
        }
        ("GET", "/members") if state.members_refused => (401, json!({"error": "refused"})),
        ("GET", "/members") => (200, json!({"members": []})),
        ("POST", p) if p == format!("/workspaces/{WORKSPACE}/capy/thread-spawns") => (
            200,
            json!({"thread_id": "jam_01THREAD", "title": "Review", "status": "running",
                   "binding": {"state": "pending"}}),
        ),
        _ => (404, json!({"error": "no route"})),
    }
}

fn provider_credentials_route(state:&mut State,method:&str,path:&str,body:&Value)->(u16,Value) {
    if state.provider_grant_status != 200 {return (state.provider_grant_status,json!({"error":if state.provider_grant_status==403 {"An Agent Relay app login is required."} else {"Unavailable"}}));}
    if method == "POST" {
        let id=format!("grant-{}",body["provider"].as_str().unwrap());
        if let Some(existing)=state.provider_grants.get(&id) {
            if existing["accessToken"]!=body["accessToken"] {return (409,json!({"error":"Idempotent credential differs"}));}
        }
        let value=json!({"id":id,"provider":body["provider"],"workspaceId":WORKSPACE,"accessToken":body["accessToken"],
            "leaseExpiresAt":agent_relay_probe::relay::cloud_session::iso(agent_relay_probe::relay::state::now_ms()+900_000)});
        state.provider_grants.insert(id,value.clone());
        return (200,value);
    }
    let id=path.rsplit('/').next().unwrap();
    if method=="DELETE" {state.provider_grants.remove(id);return (200,json!({}));}
    if method=="PUT" {
        if let Some(value)=state.provider_grants.get_mut(id) {
            value["leaseExpiresAt"]=json!(agent_relay_probe::relay::cloud_session::iso(agent_relay_probe::relay::state::now_ms()+900_000));
            return (200,value.clone());
        }
    }
    (404,json!({"error":"Not found"}))
}
