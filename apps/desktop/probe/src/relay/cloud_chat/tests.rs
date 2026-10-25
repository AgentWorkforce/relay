use super::*;
use crate::relay::cloud_session::CloudAccess;
use crate::relay::daemon::{Config, Plugins};
use crate::relay::delivery::DeliveryTiming;
use crate::relay::paths::CorePaths;
use crate::relay::push::PushTiming;
use crate::relay::sessions::SessionDirectory;
use crate::relay::store::Target;
use crate::relay::workspace::Secret;
use futures_util::future::BoxFuture;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Notify;

const SITE: &str = "https://agentrelay.com";
const WORKSPACE: &str = "workspace";
const CLOUD_KEY: &str = "rk_live_cloudcloud";
const CAST: &str = "https://cast.agentrelay.com";
const IDENTITY: &str = "POST /workspaces/workspace/messaging/identity/credential";

/// Agent Relay Cloud as chat sees it: canned answers by `METHOD path`
/// (404 otherwise), every call recorded, and requests under `hold` parked
/// until released.
#[derive(Default)]
struct FakeCloud {
    answers: Mutex<HashMap<String, Result<Value, CloudError>>>,
    calls: Mutex<Vec<(String, Option<Value>)>>,
    hold: Mutex<Option<String>>,
    held: AtomicUsize,
    release: Notify,
}

impl FakeCloud {
    fn answer(&self, call: &str, answer: Result<Value, CloudError>) {
        self.answers.lock().unwrap().insert(call.into(), answer);
    }

    fn calls(&self, call: &str) -> Vec<Option<Value>> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(c, _)| c == call)
            .map(|(_, body)| body.clone())
            .collect()
    }

    fn last_body(&self, call: &str) -> Value {
        self.calls(call).pop().flatten().expect("a request body")
    }
}

impl CloudAccess for FakeCloud {
    fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
        None
    }

    fn account(&self) -> Option<CloudAccount> {
        Some(CloudAccount {
            site_url: SITE.into(),
            workspace_id: WORKSPACE.into(),
            user_id: Some("user-1".into()),
        })
    }

    fn request(
        &self,
        method: &'static str,
        path: String,
        body: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        let call = format!("{method} {path}");
        self.calls.lock().unwrap().push((call.clone(), body));
        let held = self
            .hold
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|h| call.starts_with(h.as_str()));
        let answer = self
            .answers
            .lock()
            .unwrap()
            .get(&call)
            .cloned()
            .unwrap_or(Err(CloudError::Status {
                status: 404,
                message: None,
            }));
        Box::pin(async move {
            if held {
                let released = self.release.notified();
                self.held.fetch_add(1, Ordering::SeqCst);
                released.await;
            }
            answer
        })
    }
}

#[derive(Default)]
struct FakeSessions(Mutex<Vec<DiscoveredSession>>);

impl SessionDirectory for FakeSessions {
    fn sessions(&self) -> Vec<DiscoveredSession> {
        self.0.lock().unwrap().clone()
    }
}

struct Harness {
    _temp: tempfile::TempDir,
    core: Arc<Core>,
    cloud: Arc<FakeCloud>,
    sessions: Arc<FakeSessions>,
}

impl Harness {
    fn new() -> Harness {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let mut env = BTreeMap::new();
        env.insert("TZ".to_string(), "Europe/Berlin".to_string());
        let config = Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.clone(),
            app_data_dir: home.join("app-data"),
            env,
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        let cloud = Arc::new(FakeCloud::default());
        let sessions = Arc::new(FakeSessions::default());
        let plugins = Plugins {
            cloud: cloud.clone(),
            sessions: sessions.clone(),
            ..Plugins::default()
        };
        let (core, _signals) = Core::with_plugins(config, plugins);
        Harness {
            _temp: temp,
            core,
            cloud,
            sessions,
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        call(&self.core, method, params).await.expect(method)
    }

    async fn ok(&self, method: &str, params: Value) -> Value {
        self.call(method, params).await.unwrap()
    }

    fn data(&self) -> PathBuf {
        self.core.config().app_data_dir.clone()
    }

    fn conversation_path(&self) -> PathBuf {
        conversation_path(&self.data(), SITE, WORKSPACE)
    }

    fn projects_path(&self) -> PathBuf {
        projects_path(&self.data(), SITE, WORKSPACE)
    }

    fn connect_account_workspace(&self) {
        self.core
            .store
            .update(|s| {
                s.cloud = Some(CloudWorkspace {
                    key: Secret::new(CLOUD_KEY),
                    base_url: CAST.into(),
                    workspace_id: Some("rw_cloud".into()),
                    account_workspace_id: None,
                    name: None,
                    relayfile_workspace_id: None,
                })
            })
            .unwrap();
    }

    fn register(&self, name: &str, target: &Target, key: &str) {
        let registration: Registration = serde_json::from_value(json!({
            "name": name, "agentID": format!("id-{name}"), "target": target,
            "title": "Work", "baseURL": CAST, "registeredAt": "2026-09-29T10:00:00Z",
            "workspaceKey": key, "machinePrefix": "test-desk",
        }))
        .unwrap();
        self.core
            .store
            .update(|s| s.registrations.push(registration))
            .unwrap();
    }

    fn add_session(&self, target: &Target, directory: &str) {
        self.sessions.0.lock().unwrap().push(DiscoveredSession {
            target: target.clone(),
            title: "Search".into(),
            directory: Some(directory.into()),
            updated_at_ms: None,
            host: None,
            live: true,
            holder: None,
        });
    }

    fn answer_chat(&self, reply: Value) {
        self.cloud
            .answer("POST /workspaces/workspace/skip/chat", Ok(reply));
    }

    fn answer_projects(&self, report: Value) {
        self.cloud
            .answer("POST /workspaces/workspace/skip/projects", Ok(report));
    }

    async fn until_held(&self) {
        for _ in 0..500 {
            if self.cloud.held.load(Ordering::SeqCst) > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("timed out waiting for a held Cloud request");
    }
}

fn codex(id: &str) -> Target {
    Target {
        kind: SessionKind::Codex,
        id: id.into(),
    }
}

fn thread_id() -> String {
    random_uuid()
}

fn projects_report(session_id: &str, state: &str, nudge: Option<&str>) -> Value {
    json!({
        "generatedAt": "2026-09-29T12:00:00.000Z",
        "briefing": {"headline": "One project.", "stuck": [], "moving": [], "ready": []},
        "projects": [{
            "id": "proj_1", "name": "Search", "summary": "", "state": state, "next": null,
            "repositories": ["storefront"], "lastActiveAt": null,
            "sessions": [{"sessionId": session_id, "source": "codex", "title": "Search",
                          "state": state, "reason": "r", "nudge": nudge, "lastActiveAt": null}],
        }],
    })
}

fn reply(message: &str) -> Value {
    json!({"message": message, "references": [], "actions": []})
}

// --- Contract -------------------------------------------------------------

#[test]
fn requests_encode_the_workspace_and_query() {
    let chat = Chat {
        core: Harness::new().core,
        account: CloudAccount {
            site_url: SITE.into(),
            workspace_id: "workspace/one".into(),
            user_id: None,
        },
        conversation: PathBuf::new(),
        projects: PathBuf::new(),
    };
    assert_eq!(
        chat.path("history"),
        "/workspaces/workspace%2Fone/skip/history"
    );
    let query = history_query("abc/def?x=1", Some("codex"), Some("opaque/+="));
    let pairs: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();
    assert_eq!(
        pairs,
        [
            ("kind".into(), "events".into()),
            ("sessionId".into(), "abc/def?x=1".into()),
            ("source".into(), "codex".into()),
            ("cursor".into(), "opaque/+=".into()),
        ]
    );
}

#[test]
fn chat_contract_keeps_source_and_proposal_identity() {
    let reply: ChatReply = serde_json::from_value(json!({
        "message": "The agent last updated its tests.",
        "actions": [{"id": "action-1", "type": "send_message", "agentId": "codex:thread-1", "message": "Please share the result."}],
        "references": [{"sessionId": "thread-1", "source": "codex"}],
        "toolCalls": [{"name": "read_session", "status": "completed"}],
    }))
    .unwrap();
    assert_eq!(reply.actions[0].agent_id, "codex:thread-1");
    assert_eq!(reply.actions[0].kind, "send_message");
    assert_eq!(reply.references[0].source.as_deref(), Some("codex"));
}

#[test]
fn session_events_accept_nullable_fields_and_preserve_cursors() {
    let page: HistoryEventsPage = serde_json::from_value(json!({
        "events": [{"eventId": "event-1", "content": null, "toolName": "shell", "toolStatus": "completed", "contentTruncated": true}],
        "nextCursor": "older",
    }))
    .unwrap();
    assert_eq!(page.events[0].tool_name.as_deref(), Some("shell"));
    assert_eq!(page.events[0].content_truncated, Some(true));
    assert_eq!(page.next_cursor.as_deref(), Some("older"));
}

#[test]
fn replay_identity_keeps_the_same_event_on_other_machines_and_kinds_apart() {
    let page: HistoryEventsPage = serde_json::from_value(json!({
        "events": [
            {"eventId": "same", "source": "codex", "sessionId": "s", "machineId": "one", "kind": "message"},
            {"eventId": "same", "source": "codex", "sessionId": "s", "machineId": "two", "kind": "message"},
            {"eventId": "same", "source": "codex", "sessionId": "s", "machineId": "two", "kind": "tool"},
        ],
        "nextCursor": null,
    }))
    .unwrap();
    let ids: HashSet<String> = page.events.iter().map(HistoryEvent::id).collect();
    assert_eq!(ids.len(), 3);
}

#[test]
fn agent_messages_require_the_account_workspace_and_canonical_history_source() {
    let cloud = CloudWorkspace {
        key: Secret::new("rk_cloud"),
        base_url: CAST.into(),
        workspace_id: None,
        account_workspace_id: None,
        name: None,
        relayfile_workspace_id: None,
    };
    let registration: Registration = serde_json::from_value(json!({
        "name": "agent-one", "agentID": "id", "target": codex(&thread_id()), "title": "Work",
        "baseURL": CAST, "registeredAt": "2026-09-29T10:00:00Z", "workspaceKey": "rk_cloud",
    }))
    .unwrap();
    assert!(belongs_to_cloud(&registration, Some(&cloud)));
    assert!(!belongs_to_cloud(&registration, None));
    let other = CloudWorkspace {
        key: Secret::new("rk_other"),
        ..cloud.clone()
    };
    assert!(!belongs_to_cloud(&registration, Some(&other)));
    assert_eq!(history_source(SessionKind::ClaudeTerminal), "claude");
    assert_eq!(history_source(SessionKind::ClaudeCloud), "claude");
    assert_eq!(history_source(SessionKind::Codex), "codex");
}

#[test]
fn push_key_follows_session_activity_not_wording_and_only_ready_sessions_push() {
    let session = |state: SkipWorkState, nudge: &str, at: Option<&str>| SkipProjectSession {
        session_id: "a".into(),
        source: "codex".into(),
        title: "A".into(),
        state,
        reason: String::new(),
        nudge: Some(nudge.into()),
        last_active_at: at.map(String::from),
    };
    let ready = session(
        SkipWorkState::Ready,
        "Open the PR.",
        Some("2026-09-29T10:00:00Z"),
    );
    let reworded = session(
        SkipWorkState::Ready,
        "Merge it.",
        Some("2026-09-29T10:00:00Z"),
    );
    let later = session(
        SkipWorkState::Ready,
        "Open the PR.",
        Some("2026-09-29T11:00:00Z"),
    );
    let working = session(SkipWorkState::Working, "Open the PR.", None);
    let empty = session(SkipWorkState::Ready, "", None);
    assert_eq!(ready.push_key(), reworded.push_key());
    assert_ne!(ready.push_key(), later.push_key());
    assert_eq!(working.push_key(), None);
    assert_eq!(empty.push_key(), None);
    assert_eq!(
        ready.push_key().as_deref(),
        Some("codex:a@2026-09-29T10:00:00Z")
    );
    // The local session a push goes to shares the uploader's key.
    assert_eq!(
        codex("a").upload_key().as_deref(),
        Some(ready.key().as_str())
    );
}

#[test]
fn previous_map_skips_blank_names_and_unknown_states_read_as_idle() {
    let report: SkipProjectsReport =
        serde_json::from_value(projects_report("a", "blocked_on_mars", None)).unwrap();
    assert_eq!(report.projects[0].state, SkipWorkState::Idle);
    assert_eq!(report.pushable().count(), 0);
    assert_eq!(
        report.previous(),
        [PreviousProject {
            id: "proj_1".into(),
            name: "Search".into(),
            sessions: vec!["codex:a".into()],
        }]
    );
    let mut blank = report.clone();
    blank.projects[0].name = "  ".into();
    assert!(blank.previous().is_empty());
}

#[test]
fn project_views_go_stale_after_fifteen_minutes() {
    let report: SkipProjectsReport =
        serde_json::from_value(projects_report("a", "ready", None)).unwrap();
    let generated = report.generated_ms().unwrap();
    assert!(!report.is_stale(generated + STALE_AFTER_MS));
    assert!(report.is_stale(generated + STALE_AFTER_MS + 1));
    let undated = SkipProjectsReport {
        generated_at: String::new(),
        ..report
    };
    assert!(undated.is_stale(generated));
}

#[test]
fn the_macs_saved_files_read_as_is() {
    let conversation: SavedConversation = serde_json::from_value(json!({
        "messages": [
            {"id": "6B1F", "role": "user", "content": "Status?", "references": [], "actions": []},
            {"id": "7C2A", "role": "assistant", "content": "Ask it?",
             "references": [{"sessionId": "t", "source": "codex"}],
             "actions": [
                {"id": "a1", "type": "send_message", "agentId": "codex:t", "message": "Status?"},
                {"id": "a2", "type": "send_message", "agentId": "codex:t", "message": "Again?"},
                {"id": "a3", "type": "send_message", "agentId": "codex:t", "message": "Once more?"}
             ]},
        ],
        "receipts": {
            "a1": "Sent to Relaycast for @agent-one. Check Agents for delivery.",
            "a2": "Send could not be confirmed: Relaycast could not be reached.",
            "a3": "Sending to Relaycast…",
        },
    }))
    .unwrap();
    let receipts = &conversation.receipts;
    assert_eq!(receipts["a1"].state, ReceiptState::Sent);
    assert_eq!(receipts["a1"].agent.as_deref(), Some("agent-one"));
    assert_eq!(receipts["a2"].state, ReceiptState::Unconfirmed);
    assert_eq!(
        receipts["a2"].detail.as_deref(),
        Some("Relaycast could not be reached.")
    );
    assert_eq!(receipts["a3"].state, ReceiptState::Sending);

    let projects: SavedProjects = serde_json::from_value(json!({
        "report": projects_report("t", "ready", Some("Go")),
        "receipts": {"codex:t@": {"message": "Pushed to @builder.", "date": 780_000_000.0, "sent": true}},
    }))
    .unwrap();
    let pushed = &projects.receipts["codex:t@"];
    assert_eq!(pushed.state, ReceiptState::Sent);
    assert_eq!(pushed.agent.as_deref(), Some("builder"));
    assert_eq!(pushed.at_ms, Some(1_758_307_200_000));

    // What the core writes reads back the same.
    let again: SavedConversation =
        serde_json::from_value(serde_json::to_value(&conversation).unwrap()).unwrap();
    assert_eq!(again, conversation);
}

#[test]
fn files_are_named_by_account_like_the_mac() {
    let data = Path::new("/data");
    let conversation = conversation_path(data, SITE, WORKSPACE);
    let name = conversation.file_name().unwrap().to_string_lossy();
    assert_eq!(name.len(), 64 + ".json".len());
    assert!(conversation.starts_with("/data/Conversations"));
    assert_eq!(
        projects_path(data, SITE, WORKSPACE),
        conversation.with_extension("projects.json")
    );
    assert_ne!(conversation, conversation_path(data, SITE, "other"));
}

#[test]
fn time_zone_comes_from_tz_then_the_system() {
    let env = |tz: &str| BTreeMap::from([("TZ".to_string(), tz.to_string())]);
    assert_eq!(local_timezone(&env("America/New_York")), "America/New_York");
    assert_eq!(
        local_timezone(&env(":/usr/share/zoneinfo/Asia/Tokyo")),
        "Asia/Tokyo"
    );
    assert!(!local_timezone(&BTreeMap::new()).is_empty());
}

// --- Bridge methods ------------------------------------------------------

#[tokio::test]
async fn chat_sends_bounded_context_and_saves_the_answer() {
    let h = Harness::new();
    let saved = SavedConversation {
        messages: (0..54)
            .map(|i| ChatTurn::new("user", format!("Message {i}")))
            .collect(),
        receipts: BTreeMap::new(),
    };
    save(&h.conversation_path(), &saved).unwrap();
    for i in 0..120 {
        h.add_session(&codex(&format!("thread-{i}")), "/Users/me/storefront");
    }
    h.answer_chat(reply("Ready"));
    let result = h.ok("chat.send", json!({"text": "  Status?  "})).await;
    assert_eq!(result["answered"], true);
    let body = h.cloud.last_body("POST /workspaces/workspace/skip/chat");
    assert_eq!(body["timezone"], "Europe/Berlin");
    assert_eq!(body["messages"].as_array().unwrap().len(), 40);
    assert_eq!(body["agents"].as_array().unwrap().len(), 100);
    assert_eq!(
        body["agents"][0],
        json!({"id": "codex:thread-0", "name": "Search", "status": "not addressable",
               "project": "storefront", "sessionId": "thread-0", "source": "codex"})
    );
    assert!(body.get("projects").is_none());

    let messages = result["conversation"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 56);
    assert_eq!(messages[55]["role"], "assistant");
    assert_eq!(messages[55]["content"], "Ready");
    // Reloaded from disk, the same conversation.
    assert_eq!(
        h.ok("chat.conversation", json!({})).await,
        result["conversation"]
    );
}

#[tokio::test]
async fn questions_are_bounded_and_failures_keep_nothing() {
    let h = Harness::new();
    let error = h
        .call("chat.send", json!({"text": "   "}))
        .await
        .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::InvalidParams);
    let error = h
        .call("chat.send", json!({"text": "x".repeat(12_001)}))
        .await
        .unwrap_err();
    assert_eq!(error.message, "Keep your message under 12,000 characters.");

    h.cloud.answer(
        "POST /workspaces/workspace/skip/chat",
        Err(CloudError::Status {
            status: 503,
            message: Some("Skip is unavailable".into()),
        }),
    );
    let error = h
        .call("chat.send", json!({"text": "Status?"}))
        .await
        .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::CloudFailed);
    assert_eq!(error.message, "Skip is unavailable");
    assert_eq!(
        h.ok("chat.conversation", json!({})).await["messages"],
        json!([])
    );

    h.answer_chat(json!({"message": 7}));
    let error = h
        .call("chat.send", json!({"text": "Status?"}))
        .await
        .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::CloudFailed);
    assert!(!h.conversation_path().exists());
}

#[tokio::test]
async fn history_reads_one_session_with_source_and_cursor() {
    let h = Harness::new();
    let path = format!(
        "GET /workspaces/workspace/skip/history?{}",
        history_query("thread-1", Some("codex"), Some("opaque/+="))
    );
    h.cloud.answer(
        &path,
        Ok(json!({"events": [
            {"eventId": "e1", "content": "Work"},
            {"eventId": "e1", "content": "Work"},
        ], "nextCursor": "older"})),
    );
    let page = h
        .ok(
            "chat.history",
            json!({"session_id": "thread-1", "source": "codex", "cursor": "opaque/+="}),
        )
        .await;
    assert_eq!(page["next_cursor"], "older");
    assert_eq!(page["events"].as_array().unwrap().len(), 1);
    assert_eq!(page["events"][0]["event_id"], "e1");
    assert_eq!(page["events"][0]["content_truncated"], Value::Null);
}

#[tokio::test]
async fn sign_in_and_unavailable_errors_are_distinct() {
    let h = Harness::new();
    let path = format!(
        "GET /workspaces/workspace/skip/history?{}",
        history_query("thread-1", Some("codex"), None)
    );
    let params = json!({"session_id": "thread-1", "source": "codex"});
    h.cloud.answer(&path, Err(CloudError::Rejected));
    let error = h.call("chat.history", params.clone()).await.unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::NotSignedIn);
    h.cloud.answer(
        &path,
        Err(CloudError::Status {
            status: 503,
            message: Some("History provider unavailable".into()),
        }),
    );
    let error = h.call("chat.history", params).await.unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::CloudFailed);
    assert_eq!(error.message, "History provider unavailable");
}

#[tokio::test]
async fn signed_out_chat_answers_not_signed_in() {
    let temp = tempfile::tempdir().unwrap();
    let config = Config {
        paths: CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
        home: temp.path().into(),
        app_data_dir: temp.path().join("app-data"),
        env: BTreeMap::new(),
        version: "0.0.0-test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: PushTiming::default(),
        delivery_timing: DeliveryTiming::default(),
    };
    let (core, _signals) = Core::new(config);
    let error = call(&core, "chat.conversation", json!({}))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::NotSignedIn);
    assert!(call(&core, "chat.unknown", json!({})).await.is_none());
}

#[tokio::test]
async fn sign_out_deletes_the_saved_conversation_and_projects() {
    let h = Harness::new();
    h.answer_chat(reply("Ready"));
    h.ok("chat.send", json!({"text": "Private question"})).await;
    h.answer_projects(projects_report("a", "working", None));
    h.ok("chat.projects.refresh", json!({})).await;
    assert!(h.conversation_path().exists());
    assert!(h.projects_path().exists());

    forget(&h.data(), &h.cloud.account().unwrap());
    assert!(!h.conversation_path().exists());
    assert!(!h.projects_path().exists());
    assert_eq!(
        h.ok("chat.conversation", json!({})).await["messages"],
        json!([])
    );
    assert_eq!(
        h.ok("chat.projects", json!({})).await["report"],
        Value::Null
    );
}

#[tokio::test]
async fn a_reply_after_sign_out_or_a_new_conversation_is_dropped() {
    let h = Harness::new();
    h.answer_chat(reply("Too late"));
    *h.cloud.hold.lock().unwrap() = Some("POST /workspaces/workspace/skip/chat".into());
    let core = h.core.clone();
    let sending =
        tokio::spawn(async move { call(&core, "chat.send", json!({"text": "Status?"})).await });
    h.until_held().await;
    let error = h.call("chat.clear", json!({})).await.unwrap_err();
    assert_eq!(error.data.kind, ErrorKind::Busy);
    assert_eq!(h.ok("chat.conversation", json!({})).await["sending"], true);
    forget(&h.data(), &h.cloud.account().unwrap());
    // A question asked after signing in again is still out when the stale
    // answer arrives; it keeps its own in-flight mark.
    with_state(&h.conversation_path(), |state| state.sending = true);
    h.cloud.release.notify_waiters();
    let result = sending.await.unwrap().unwrap().unwrap();
    assert_eq!(result["answered"], false);
    assert!(!h.conversation_path().exists());
    assert!(with_state(&h.conversation_path(), |state| state.sending));
}

#[tokio::test]
async fn an_action_in_flight_during_a_new_conversation_leaves_it_empty() {
    let h = Harness::new();
    let target = codex(&thread_id());
    h.connect_account_workspace();
    h.register("agent-one", &target, CLOUD_KEY);
    h.answer_chat(json!({"message": "Ask it?", "references": [], "actions": [
        {"id": "action-1", "type": "send_message", "agentId": target.key(), "message": "Status?"}
    ]}));
    h.ok("chat.send", json!({"text": "What is agent-one doing?"}))
        .await;

    *h.cloud.hold.lock().unwrap() = Some(IDENTITY.into());
    let core = h.core.clone();
    let acting =
        tokio::spawn(
            async move { call(&core, "chat.act", json!({"action_id": "action-1"})).await },
        );
    h.until_held().await;
    // Recorded before dispatch.
    let shown = h.ok("chat.conversation", json!({})).await;
    assert_eq!(
        shown["messages"][1]["actions"][0]["receipt"]["state"],
        "sending"
    );
    h.ok("chat.clear", json!({})).await;
    h.cloud.release.notify_waiters();
    acting.await.unwrap().unwrap().unwrap();
    assert_eq!(h.cloud.calls(IDENTITY).len(), 1);
    let saved: SavedConversation = load(&h.conversation_path()).unwrap();
    assert!(saved.messages.is_empty());
    assert!(saved.receipts.is_empty());
}

#[tokio::test]
async fn an_action_is_sent_once_and_only_to_the_account_workspace() {
    let h = Harness::new();
    let mine = codex(&thread_id());
    let elsewhere = codex(&thread_id());
    h.connect_account_workspace();
    h.register("agent-one", &mine, CLOUD_KEY);
    h.register("agent-two", &elsewhere, "rk_live_other");
    h.answer_chat(
        json!({"message": "Ask them?", "references": [], "actions": [
            {"id": "a1", "type": "send_message", "agentId": mine.key(), "message": "Status?"},
            {"id": "a2", "type": "send_message", "agentId": elsewhere.key(), "message": "Status?"},
            {"id": "a3", "type": "send_message", "agentId": "codex:gone", "message": "Status?"},
        ]}),
    );
    h.ok("chat.send", json!({"text": "Who is working?"})).await;

    let first = h.ok("chat.act", json!({"action_id": "a1"})).await;
    assert_eq!(first["receipt"]["state"], "unconfirmed");
    assert_eq!(first["receipt"]["agent"], "agent-one");
    let again = h.ok("chat.act", json!({"action_id": "a1"})).await;
    assert_eq!(again["receipt"], first["receipt"]);
    assert_eq!(h.cloud.calls(IDENTITY).len(), 1);

    let refused = h
        .call("chat.act", json!({"action_id": "a2"}))
        .await
        .unwrap_err();
    assert_eq!(refused.data.kind, ErrorKind::Refused);
    let gone = h
        .call("chat.act", json!({"action_id": "a3"}))
        .await
        .unwrap_err();
    assert_eq!(gone.data.kind, ErrorKind::NotFound);
    let unknown = h
        .call("chat.act", json!({"action_id": "nope"}))
        .await
        .unwrap_err();
    assert_eq!(unknown.data.kind, ErrorKind::NotFound);
    assert_eq!(h.cloud.calls(IDENTITY).len(), 1);
}

#[tokio::test]
async fn refresh_sends_the_previous_map_and_keeps_the_view() {
    let h = Harness::new();
    let before = h.ok("chat.projects", json!({})).await;
    assert_eq!(before["report"], Value::Null);
    assert_eq!(before["stale"], true);
    assert_eq!(before["durable"], false);
    assert!(h
        .cloud
        .calls("POST /workspaces/workspace/skip/projects")
        .is_empty());

    h.answer_projects(projects_report("a", "blocked_on_mars", None));
    let first = h.ok("chat.projects.refresh", json!({})).await;
    assert_eq!(
        h.cloud
            .last_body("POST /workspaces/workspace/skip/projects"),
        json!({"timezone": "Europe/Berlin", "previous": []})
    );
    assert_eq!(first["report"]["projects"][0]["state"], "idle");
    assert_eq!(
        first["report"]["projects"][0]["sessions"][0]["push_key"],
        Value::Null
    );
    assert_eq!(first["refreshing"], false);

    h.ok("chat.projects.refresh", json!({})).await;
    assert_eq!(
        h.cloud
            .last_body("POST /workspaces/workspace/skip/projects")["previous"],
        json!([{"id": "proj_1", "name": "Search", "sessions": ["codex:a"]}])
    );
    assert_eq!(h.ok("chat.projects", json!({})).await, first);
}

#[tokio::test]
async fn chat_carries_the_project_view_linked_to_the_roster() {
    let h = Harness::new();
    let target = codex("thread-1");
    h.add_session(&target, "/Users/me/storefront");
    h.answer_projects(projects_report("thread-1", "working", None));
    h.ok("chat.projects.refresh", json!({})).await;
    h.answer_chat(reply("Search is moving."));
    h.ok("chat.send", json!({"text": "Status?"})).await;
    let body = h.cloud.last_body("POST /workspaces/workspace/skip/chat");
    assert_eq!(body["projects"][0]["name"], "Search");
    assert_eq!(body["projects"][0]["state"], "working");
    assert_eq!(
        body["projects"][0]["sessions"][0],
        json!({"sessionId": "thread-1", "source": "codex", "title": "Search",
               "state": "working", "agentId": "codex:thread-1"})
    );
}

#[tokio::test]
async fn a_push_is_recorded_before_dispatch_and_never_resent() {
    let h = Harness::new();
    let thread = thread_id();
    let target = codex(&thread);
    h.connect_account_workspace();
    h.register("builder", &target, CLOUD_KEY);
    h.add_session(&target, "/tmp/storefront");
    h.answer_projects(projects_report(&thread, "ready", Some("Open the PR.")));
    let view = h.ok("chat.projects.refresh", json!({})).await;
    let key = view["report"]["projects"][0]["sessions"][0]["push_key"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(key, format!("codex:{thread}@"));

    let pushed = h.ok("chat.push", json!({"push_keys": [key, key]})).await;
    assert_eq!(pushed["results"][0]["outcome"], "unconfirmed");
    assert_eq!(pushed["results"][1]["outcome"], "already_pushed");
    assert_eq!(h.cloud.calls(IDENTITY).len(), 1);
    let receipt = &pushed["projects"]["report"]["projects"][0]["sessions"][0]["receipt"];
    assert_eq!(receipt["agent"], "builder");
    assert_eq!(receipt["state"], "unconfirmed");

    // A refresh that rewords the nudge, or briefly leaves the session out,
    // keeps the receipt: nothing new happened in the session.
    h.answer_projects(projects_report("someone-else", "working", None));
    h.ok("chat.projects.refresh", json!({})).await;
    h.answer_projects(projects_report(
        &thread,
        "ready",
        Some("Open the PR now, please."),
    ));
    h.ok("chat.projects.refresh", json!({})).await;
    let again = h.ok("chat.push", json!({"push_keys": [key]})).await;
    assert_eq!(again["results"][0]["outcome"], "already_pushed");
    assert_eq!(h.cloud.calls(IDENTITY).len(), 1);
    let saved: SavedProjects = load(&h.projects_path()).unwrap();
    assert!(saved.receipts.contains_key(&key));
}

#[tokio::test]
async fn a_push_reports_why_it_did_not_send() {
    let h = Harness::new();
    let thread = thread_id();
    h.answer_projects(projects_report(&thread, "ready", Some("Continue.")));
    h.ok("chat.projects.refresh", json!({})).await;
    let key = format!("codex:{thread}@");

    let result = h
        .ok("chat.push", json!({"push_keys": [key, "codex:x@"]}))
        .await;
    assert_eq!(result["results"][0]["outcome"], "not_on_this_computer");
    assert_eq!(result["results"][1]["outcome"], "not_pushable");

    h.add_session(&codex(&thread), "/tmp/storefront");
    let result = h.ok("chat.push", json!({"push_keys": [key]})).await;
    assert_eq!(
        result["results"][0]["outcome"],
        "account_workspace_not_connected"
    );

    // Not on the relay, and this computer's workspace is not the account's:
    // it is never registered elsewhere.
    h.connect_account_workspace();
    let result = h.ok("chat.push", json!({"push_keys": [key]})).await;
    assert_eq!(result["results"][0]["outcome"], "other_workspace");
    assert!(h.core.store.read(|s| s.registrations.is_empty()));
    assert!(h.cloud.calls(IDENTITY).is_empty());
    // Nothing was sent, so nothing is recorded: fixing the cause makes it
    // pushable again.
    let saved: SavedProjects = load(&h.projects_path()).unwrap();
    assert!(saved.receipts.is_empty());
}

#[tokio::test]
async fn project_reads_use_cloud_cache_without_admitting_inference() {
    let h = Harness::new();
    let report = projects_report("a", "done", None);
    h.cloud.answer(
        "GET /workspaces/workspace/skip/projects",
        Ok(json!({
            "enabled": true, "result": report, "status": "complete", "stale": false
        })),
    );
    let view = h.ok("chat.projects", json!({})).await;
    assert_eq!(
        view["report"]["projects"][0]["sessions"][0]["session_id"],
        "a"
    );
    assert_eq!(view["stale"], false);
    assert_eq!(view["refreshing"], false);
    assert_eq!(view["durable"], true);
    assert!(h
        .cloud
        .calls("POST /workspaces/workspace/skip/projects")
        .is_empty());
}

#[tokio::test]
async fn accepted_refresh_keeps_saved_report_until_reading_completion() {
    let h = Harness::new();
    h.answer_projects(projects_report("old", "idle", None));
    let saved = h.ok("chat.projects.refresh", json!({})).await;
    h.answer_projects(
        json!({ "enabled": true, "result": null, "status": "queued", "stale": true }),
    );
    let pending = h.ok("chat.projects.refresh", json!({})).await;
    assert_eq!(pending["report"], saved["report"]);
    assert_eq!(pending["refreshing"], true);
    assert_eq!(pending["stale"], true);
    h.cloud.answer("GET /workspaces/workspace/skip/projects", Ok(json!({
        "enabled": true, "result": projects_report("new", "done", None), "status": "complete", "stale": false
    })));
    let completed = h.ok("chat.projects", json!({})).await;
    assert_eq!(
        completed["report"]["projects"][0]["sessions"][0]["session_id"],
        "new"
    );
    assert_eq!(completed["refreshing"], false);
    assert_eq!(
        h.cloud
            .calls("POST /workspaces/workspace/skip/projects")
            .len(),
        2
    );
}

#[tokio::test]
async fn missing_cache_and_configuration_failure_are_distinct_from_unreadable_reports() {
    let h = Harness::new();
    h.cloud.answer(
        "GET /workspaces/workspace/skip/projects",
        Ok(json!({
            "enabled": true, "result": null, "status": "missing", "stale": false
        })),
    );
    let empty = h.ok("chat.projects", json!({})).await;
    assert_eq!(empty["report"], Value::Null);
    assert_eq!(empty["refreshing"], false);
    h.answer_projects(json!({ "enabled": true, "result": null, "status": "blocked_configuration", "stale": true }));
    let error = h
        .call("chat.projects.refresh", json!({}))
        .await
        .unwrap_err();
    assert!(error.message.contains("service configuration"));
    assert_eq!(error.data.kind, ErrorKind::CloudFailed);
}

#[tokio::test]
async fn disabled_cloud_cache_preserves_legacy_mode_without_posting_from_read() {
    let h = Harness::new();
    h.cloud.answer(
        "GET /workspaces/workspace/skip/projects",
        Ok(json!({ "enabled": false, "result": null })),
    );
    let view = h.ok("chat.projects", json!({})).await;
    assert_eq!(view["durable"], false);
    assert_eq!(view["stale"], true);
    assert!(h
        .cloud
        .calls("POST /workspaces/workspace/skip/projects")
        .is_empty());
}

#[tokio::test]
async fn first_project_read_during_outage_returns_disk_report_with_warning_without_admission() {
    for error in [
        CloudError::Unreachable,
        CloudError::Status {
            status: 503,
            message: None,
        },
    ] {
        let h = Harness::new();
        let report = serde_json::from_value(projects_report("saved", "done", None)).unwrap();
        save(
            &h.projects_path(),
            &SavedProjects {
                report,
                receipts: Default::default(),
            },
        )
        .unwrap();
        h.cloud
            .answer("GET /workspaces/workspace/skip/projects", Err(error));
        let view = h.ok("chat.projects", json!({})).await;
        assert_eq!(
            view["report"]["projects"][0]["sessions"][0]["session_id"],
            "saved"
        );
        assert_eq!(view["stale"], true);
        assert_eq!(view["refreshing"], false);
        assert_eq!(view["durable"], Value::Null);
        assert!(view["error"]
            .as_str()
            .unwrap()
            .contains("saved project report"));
        assert!(h
            .cloud
            .calls("POST /workspaces/workspace/skip/projects")
            .is_empty());
        h.cloud.answer("GET /workspaces/workspace/skip/projects", Ok(json!({
            "enabled": true, "result": projects_report("fresh", "done", None), "status": "complete", "stale": false
        })));
        let recovered = h.ok("chat.projects", json!({})).await;
        assert_eq!(recovered["error"], Value::Null);
        assert_eq!(recovered["stale"], false);
    }
}

#[tokio::test]
async fn project_disk_fallback_does_not_hide_auth_errors_or_outages_without_saved_content() {
    let h = Harness::new();
    h.cloud.answer(
        "GET /workspaces/workspace/skip/projects",
        Err(CloudError::Unreachable),
    );
    assert_eq!(
        h.call("chat.projects", json!({}))
            .await
            .unwrap_err()
            .data
            .kind,
        ErrorKind::CloudFailed
    );
    let report = serde_json::from_value(projects_report("saved", "done", None)).unwrap();
    save(
        &h.projects_path(),
        &SavedProjects {
            report,
            receipts: Default::default(),
        },
    )
    .unwrap();
    for error in [
        CloudError::Rejected,
        CloudError::Status {
            status: 401,
            message: None,
        },
        CloudError::Status {
            status: 403,
            message: None,
        },
    ] {
        h.cloud
            .answer("GET /workspaces/workspace/skip/projects", Err(error));
        assert!(h.call("chat.projects", json!({})).await.is_err());
    }
}

#[tokio::test]
async fn failed_project_read_after_sign_out_cannot_return_disk_content() {
    let h = Harness::new();
    let report = serde_json::from_value(projects_report("saved", "done", None)).unwrap();
    save(
        &h.projects_path(),
        &SavedProjects {
            report,
            receipts: Default::default(),
        },
    )
    .unwrap();
    h.cloud.answer(
        "GET /workspaces/workspace/skip/projects",
        Err(CloudError::Unreachable),
    );
    *h.cloud.hold.lock().unwrap() = Some("GET /workspaces/workspace/skip/projects".into());
    let core = h.core.clone();
    let reading = tokio::spawn(async move { call(&core, "chat.projects", json!({})).await });
    h.until_held().await;
    forget(&h.data(), &h.cloud.account().unwrap());
    h.cloud.release.notify_waiters();
    assert_eq!(
        reading.await.unwrap().unwrap().unwrap_err().data.kind,
        ErrorKind::NotSignedIn
    );
}
