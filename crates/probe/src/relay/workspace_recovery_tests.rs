//! In-process fake Cloud and Relaycast; no real keys, daemons or providers.
use super::*;
use crate::relay::account::Account;
use crate::relay::cloud_session::CloudAccess;
use crate::relay::store::{CloudSession, CloudWorkspace};
use crate::relay::uploader::{ProcessRunner, Uploader};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::Notify;

const CLOUD_ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OLD: &str = concat!("rk_live_", "00000000000000000000000000000000");
const NEW: &str = concat!("rk_live_", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN_12");

struct FakeState {
    calls: Vec<(String, String)>,
    old_status: u16,
    new_status: u16,
    resolve_status: u16,
    refresh_status: u16,
    resolved: Value,
    new_workspace_id: String,
    hold: Option<&'static str>,
    /// Other Relaycast calls with the old key get `old_status` too.
    refuse_old_elsewhere: bool,
}
struct Fake {
    site: String,
    state: Arc<Mutex<FakeState>>,
    entered: Arc<Notify>,
    resume: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Fake {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let site = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(FakeState {
            calls: vec![],
            old_status: 401,
            new_status: 200,
            resolve_status: 200,
            refresh_status: 200,
            resolved: json!({"data":{"relaycastApiKey": NEW, "relaycastWorkspaceId":"rw_review",
                "cloudWorkspaceId":CLOUD_ID, "urls":{"relaycastUrl":site}}}),
            new_workspace_id: "rw_review".into(),
            hold: None,
            refuse_old_elsewhere: false,
        }));
        let entered = Arc::new(Notify::new());
        let resume = Arc::new(Notify::new());
        let shared = state.clone();
        let enter = entered.clone();
        let release = resume.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let shared = shared.clone();
                let enter = enter.clone();
                let release = release.clone();
                tokio::spawn(async move {
                    let (read, mut write) = stream.into_split();
                    let mut reader = BufReader::new(read);
                    let mut line = String::new();
                    reader.read_line(&mut line).await.unwrap();
                    let path = line.split_whitespace().nth(1).unwrap().to_string();
                    let mut bearer = String::new();
                    let mut length = 0;
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).await.unwrap();
                        if header.trim().is_empty() {
                            break;
                        }
                        let (name, value) = header.trim().split_once(':').unwrap();
                        if name.eq_ignore_ascii_case("authorization") {
                            bearer = value.trim().strip_prefix("Bearer ").unwrap_or("").into();
                        }
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                    }
                    let mut bytes = vec![0; length];
                    reader.read_exact(&mut bytes).await.unwrap();
                    let held = {
                        let mut s = shared.lock().unwrap();
                        s.calls.push((path.clone(), bearer.clone()));
                        s.hold.is_some_and(|p| path.ends_with(p))
                    };
                    if held {
                        enter.notify_one();
                        release.notified().await;
                    }
                    let (status, body) = {
                        let s = shared.lock().unwrap();
                        if path.ends_with("/auth/token/refresh") {
                            (
                                s.refresh_status,
                                json!({"accessToken":"renewed-access","refreshToken":"renewed-refresh","accessTokenExpiresAt":"2099-01-01T00:00:00Z"}),
                            )
                        } else if path.ends_with("/resolve") {
                            (s.resolve_status, s.resolved.clone())
                        } else if path == "/v1/workspace" {
                            let status = if bearer == NEW {
                                s.new_status
                            } else {
                                s.old_status
                            };
                            if status == 200 {
                                (
                                    200,
                                    json!({"ok":true,"data":{"id":s.new_workspace_id,"name":"Review"}}),
                                )
                            } else {
                                (
                                    status,
                                    json!({"ok":false,"error":{"code":"unauthorized","message":"Refused"}}),
                                )
                            }
                        } else if s.refuse_old_elsewhere
                            && path.starts_with("/v1/")
                            && bearer == OLD
                            && s.old_status != 200
                        {
                            (
                                s.old_status,
                                json!({"ok":false,"error":{"code":"unauthorized","message":"Refused"}}),
                            )
                        } else {
                            (200, json!({}))
                        }
                    };
                    let body = body.to_string();
                    let response=format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                    let _ = write.write_all(response.as_bytes()).await;
                });
            }
        });
        Self {
            site,
            state,
            entered,
            resume,
            task,
        }
    }
    fn count(&self, path: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|(p, _)| p.ends_with(path))
            .count()
    }
    fn new_gets(&self) -> usize {
        self.state
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|(p, b)| p == "/v1/workspace" && b == NEW)
            .count()
    }
    async fn wait_entered(&self) {
        tokio::time::timeout(Duration::from_secs(5), self.entered.notified())
            .await
            .unwrap();
    }
}
struct Harness {
    fake: Fake,
    core: Arc<Core>,
    account: Arc<Account>,
    _temp: tempfile::TempDir,
}
impl Harness {
    async fn new() -> Self {
        let fake = Fake::start().await;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let app_data_dir = home.join("app");
        let env = BTreeMap::new();
        let account = Arc::new(Account::new(
            Some(&fake.site),
            &home,
            &env,
            &app_data_dir,
            Arc::new(Uploader::new(Arc::new(ProcessRunner::new(
                home.join("unused-probe"),
            )))),
        ));
        let config = Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home,
            app_data_dir,
            env,
            version: "test".into(),
            host_name: "Test".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        let plugins = Plugins {
            account: Some(account.clone()),
            cloud: account.clone() as Arc<dyn CloudAccess>,
            ..Plugins::default()
        };
        let (core, _) = Core::with_plugins(config, plugins);
        core.store
            .update(|s| {
                s.cloud = Some(CloudWorkspace {
                    key: Secret::new(OLD),
                    base_url: fake.site.clone(),
                    workspace_id: Some("rw_review".into()),
                    account_workspace_id: Some(CLOUD_ID.into()),
                    name: None,
                    relayfile_workspace_id: None,
                });
                s.cloud_session = Some(CloudSession {
                    access_token: Secret::new("old-access"),
                    refresh_token: Some(Secret::new("old-refresh")),
                    site_url: fake.site.clone(),
                    access_token_expires_at: Some("2099-01-01T00:00:00Z".into()),
                    refresh_token_expires_at: None,
                });
            })
            .unwrap();
        core.rediscover_workspace();
        Self {
            fake,
            core,
            account,
            _temp: temp,
        }
    }
    fn cloud_key_is(&self, expected: &str) -> bool {
        self.core
            .store
            .read(|s| s.cloud.as_ref().unwrap().key.expose() == expected)
    }
    async fn verify(&self) -> Result<WorkspaceStatus, RpcError> {
        tokio::time::timeout(Duration::from_secs(5), self.core.verify_workspace())
            .await
            .unwrap()
    }
}
#[tokio::test]
async fn recovery_old_401_or_403_refreshes_and_retries_once() {
    for status in [401, 403] {
        let h = Harness::new().await;
        h.fake.state.lock().unwrap().old_status = status;
        assert_eq!(
            h.verify().await.unwrap().verification,
            Verification::Verified
        );
        assert!(h.cloud_key_is(NEW));
        assert_eq!(h.fake.count("/auth/token/refresh"), 1);
        assert_eq!(h.fake.count("/resolve"), 1);
        assert_eq!(h.fake.count("/v1/workspace"), 2);
        assert_eq!(h.fake.new_gets(), 1);
        assert!(h.core.workspace().unwrap().key.expose() == NEW);
    }
}
#[tokio::test]
async fn recovery_refuses_bad_resolution_without_overwriting() {
    for bad in [
        json!({"relaycastApiKey":"rk_live_YOUR_KEY"}),
        json!({"relaycastApiKey":concat!("rk_test_", "11111111111111111111111111111111")}),
        json!({"relaycastApiKey":OLD}),
        json!({"relaycastWorkspaceId":"rw_someone_else"}),
        json!({"cloudWorkspaceId":"11111111-1111-1111-1111-111111111111"}),
        json!({"urls":{"relaycastUrl":"https://evil.example"}}),
        json!({"urls":{"relaycastUrl":"http://evil.example"}}),
        json!({"urls":{}}),
    ] {
        let h = Harness::new().await;
        {
            let mut state = h.fake.state.lock().unwrap();
            for (key, value) in bad.as_object().unwrap() {
                state.resolved["data"][key] = value.clone();
            }
        }
        assert!(h.verify().await.is_err());
        assert!(h.cloud_key_is(OLD));
        assert_eq!(h.fake.new_gets(), 0);
    }
}
#[tokio::test]
async fn recovery_new_key_must_actually_belong_to_same_workspace() {
    let h = Harness::new().await;
    h.fake.state.lock().unwrap().new_workspace_id = "rw_someone_else".into();
    assert!(h.verify().await.is_err());
    assert!(h.cloud_key_is(OLD));
    assert_eq!(h.fake.new_gets(), 1);
}
#[tokio::test]
async fn recovery_failed_retry_never_starts_another_refresh_loop() {
    let h = Harness::new().await;
    h.fake.state.lock().unwrap().new_status = 401;
    assert!(h.verify().await.is_err());
    assert!(h.verify().await.is_err());
    assert!(h.cloud_key_is(OLD));
    assert_eq!(h.fake.count("/auth/token/refresh"), 1);
    assert_eq!(h.fake.count("/resolve"), 1);
    assert_eq!(h.fake.new_gets(), 1);
}
#[tokio::test]
async fn recovery_rejects_non_200_and_closes_refused_cloud_session() {
    for status in [201, 204, 401, 403, 500] {
        let h = Harness::new().await;
        h.fake.state.lock().unwrap().resolve_status = status;
        assert!(h.verify().await.is_err());
        assert!(h.cloud_key_is(OLD));
        assert_eq!(h.fake.new_gets(), 0);
        assert_eq!(
            h.core.store.read(|s| s.cloud_session.is_none()),
            matches!(status, 401 | 403)
        );
    }
}
#[tokio::test]
async fn recovery_sign_out_during_resolution_or_retry_keeps_nothing() {
    for held in ["/resolve", "/v1/workspace"] {
        let h = Harness::new().await;
        h.fake.state.lock().unwrap().hold = Some("/resolve");
        let core = h.core.clone();
        let verify = tokio::spawn(async move { core.verify_workspace().await });
        h.fake.wait_entered().await;
        if held == "/v1/workspace" {
            h.fake.state.lock().unwrap().hold = Some(held);
            h.fake.resume.notify_one();
            h.fake.wait_entered().await;
        }
        h.account.sign_out().await.unwrap();
        h.fake.resume.notify_one();
        assert!(tokio::time::timeout(Duration::from_secs(5), verify)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(h.cloud_key_is(OLD));
        assert!(h.core.store.read(|s| s.cloud_session.is_none()));
    }
}
#[tokio::test]
async fn recovery_does_not_replace_a_workspace_changed_during_resolution() {
    let h = Harness::new().await;
    h.fake.state.lock().unwrap().hold = Some("/resolve");
    let core = h.core.clone();
    let verify = tokio::spawn(async move { core.verify_workspace().await });
    h.fake.wait_entered().await;
    h.core
        .store
        .update(|s| s.cloud.as_mut().unwrap().workspace_id = Some("rw_new_selection".into()))
        .unwrap();
    h.core.rediscover_workspace();
    h.fake.resume.notify_one();
    let _ = tokio::time::timeout(Duration::from_secs(5), verify)
        .await
        .unwrap()
        .unwrap();
    assert!(h.cloud_key_is(OLD));
    assert_eq!(h.fake.new_gets(), 0);
}
#[tokio::test]
async fn recovery_background_auth_failure_schedules_safe_verification() {
    let h = Harness::new().await;
    h.fake.state.lock().unwrap().old_status = 200;
    h.verify().await.unwrap();
    h.fake.state.lock().unwrap().old_status = 401;
    let workspace = h.core.workspace().unwrap();
    let scope = h.core.relaycast_scope(&workspace.base_url, &workspace.key);
    let result = client::workspace_info(&workspace).await;
    h.core.observe_relaycast_result(&scope, &result);
    assert_eq!(
        h.core.status().workspace.verification,
        Verification::Pending
    );
    assert_eq!(
        h.core.refresh_workspace().await.verification,
        Verification::Verified
    );
    assert!(h.cloud_key_is(NEW));
}

#[tokio::test]
async fn recovery_concurrent_rejections_share_one_cloud_refresh() {
    let h = Harness::new().await;
    let (first, second) = tokio::join!(h.verify(), h.verify());
    first.unwrap();
    second.unwrap();
    assert!(h.cloud_key_is(NEW));
    assert_eq!(h.fake.count("/auth/token/refresh"), 1);
    assert_eq!(h.fake.count("/resolve"), 1);
    assert_eq!(h.fake.new_gets(), 1);
    assert!(h
        .fake
        .state
        .lock()
        .unwrap()
        .calls
        .iter()
        .filter(|(path, _)| path.ends_with("/resolve"))
        .all(|(_, bearer)| bearer == "renewed-access"));
}

#[tokio::test]
async fn recovery_refresh_failure_preserves_workspace_and_requires_reconnect() {
    for status in [401, 403, 500] {
        let h = Harness::new().await;
        h.fake.state.lock().unwrap().refresh_status = status;
        assert!(h.verify().await.is_err());
        assert!(h.cloud_key_is(OLD));
        assert_eq!(h.fake.count("/resolve"), 0);
        assert_eq!(h.fake.new_gets(), 0);
        assert_eq!(
            h.core.status().workspace.verification,
            Verification::Rejected
        );
    }
}

#[tokio::test]
async fn recovery_sign_out_waiting_for_token_refresh_wins_before_commit() {
    let h = Harness::new().await;
    h.fake.state.lock().unwrap().hold = Some("/auth/token/refresh");
    let core = h.core.clone();
    let verify = tokio::spawn(async move { core.verify_workspace().await });
    h.fake.wait_entered().await;
    let account = h.account.clone();
    let sign_out = tokio::spawn(async move { account.sign_out().await });
    tokio::task::yield_now().await;
    h.fake.resume.notify_one();
    tokio::time::timeout(Duration::from_secs(5), sign_out)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(5), verify)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(h.cloud_key_is(OLD));
    assert!(h.core.store.read(|s| s.cloud_session.is_none()));
    assert_eq!(h.fake.new_gets(), 0);
}

#[tokio::test]
async fn recovery_updates_only_matching_registration_pins() {
    let h = Harness::new().await;
    let other_key = concat!("rk_live_", "22222222222222222222222222222222");
    h.core
        .store
        .update(|s| {
            for (name, origin, key) in [
                ("ours", h.fake.site.as_str(), OLD),
                ("other-key", h.fake.site.as_str(), other_key),
                ("other-origin", "https://other.example", OLD),
            ] {
                let r: Registration = serde_json::from_value(json!({"name":name,"agentID":name,
                "target":{"kind":"codex","id":name},"title":name,"baseURL":origin,
                "registeredAt":"2026-10-11T00:00:00Z","workspaceKey":key}))
                .unwrap();
                s.registrations.push(r);
            }
        })
        .unwrap();
    h.verify().await.unwrap();
    h.core.store.read(|s| {
        assert!(
            s.registration_named("ours")
                .unwrap()
                .workspace_key
                .as_ref()
                .unwrap()
                .expose()
                == NEW
        );
        assert!(
            s.registration_named("other-key")
                .unwrap()
                .workspace_key
                .as_ref()
                .unwrap()
                .expose()
                == other_key
        );
        assert!(
            s.registration_named("other-origin")
                .unwrap()
                .workspace_key
                .as_ref()
                .unwrap()
                .expose()
                == OLD
        );
    });
}

#[tokio::test]
async fn recovery_preserves_legacy_numeric_provider_identity() {
    let h = Harness::new().await;
    h.core
        .store
        .update(|s| s.cloud.as_mut().unwrap().workspace_id = Some("12345".into()))
        .unwrap();
    h.core.rediscover_workspace();
    {
        let mut state = h.fake.state.lock().unwrap();
        state.resolved["data"]["relaycastWorkspaceId"] = json!("12345");
        state.resolved["data"]["workspaceId"] = json!("rw_review");
        state.new_workspace_id = "12345".into();
    }
    assert_eq!(
        h.verify().await.unwrap().workspace_id.as_deref(),
        Some("12345")
    );
    assert!(h.cloud_key_is(NEW));
    assert_eq!(h.fake.new_gets(), 1);
}

#[tokio::test]
async fn recovery_compares_saved_origin_after_canonicalization() {
    let h = Harness::new().await;
    h.core
        .store
        .update(|s| s.cloud.as_mut().unwrap().base_url.push('/'))
        .unwrap();
    h.core.rediscover_workspace();
    assert_eq!(
        h.verify().await.unwrap().verification,
        Verification::Verified
    );
    assert!(h.cloud_key_is(NEW));
}

#[tokio::test]
async fn recovery_legacy_null_mapping_still_requires_same_relaycast_workspace() {
    let h = Harness::new().await;
    h.fake.state.lock().unwrap().resolved["data"]["cloudWorkspaceId"] = Value::Null;
    assert_eq!(
        h.verify().await.unwrap().verification,
        Verification::Verified
    );
    assert!(h.cloud_key_is(NEW));
    assert_eq!(h.fake.new_gets(), 1);
}

/// A key that verified and was later revoked (a rotation whose grace lapsed)
/// is re-checked by the refresh loop once its verification is stale, and
/// recovered without a manual `workspace.verify`.
#[tokio::test]
async fn recovery_background_loop_rechecks_a_key_revoked_after_verify() {
    let h = Harness::new().await;
    h.fake.state.lock().unwrap().old_status = 200;
    h.verify().await.unwrap();
    h.fake.state.lock().unwrap().old_status = 401;

    // Freshly verified: the refresh pass trusts it and asks nobody.
    assert_eq!(
        h.core.refresh_workspace().await.verification,
        Verification::Verified
    );
    assert!(h.cloud_key_is(OLD));
    assert_eq!(h.fake.count("/v1/workspace"), 1);
    assert_eq!(h.fake.count("/resolve"), 0);

    // Once the verification is older than the re-check interval, the next
    // pass asks Relaycast again, sees the refusal and recovers the key.
    let stale_ms = workspace_stale_ms();
    h.core.hub.update(|status| {
        status.workspace.checked_at_ms = Some(now_ms() - stale_ms);
    });
    assert_eq!(
        h.core.refresh_workspace().await.verification,
        Verification::Verified
    );
    assert!(h.cloud_key_is(NEW));
    assert!(h.core.workspace().unwrap().key.expose() == NEW);
    assert_eq!(h.fake.count("/auth/token/refresh"), 1);
    assert_eq!(h.fake.count("/resolve"), 1);
    assert_eq!(h.fake.new_gets(), 1);

    // The recovered key is fresh again: no further checks.
    h.core.refresh_workspace().await;
    assert_eq!(h.fake.count("/v1/workspace"), 3);
}

/// A refused workspace-key WRITE (presence, registration) schedules the
/// same safe verification a refused read does, so the next refresh pass
/// recovers the rotated key without a manual verify.
#[tokio::test]
async fn recovery_refused_presence_write_schedules_recovery() {
    let h = Harness::new().await;
    h.fake.state.lock().unwrap().old_status = 200;
    h.verify().await.unwrap();
    {
        let mut state = h.fake.state.lock().unwrap();
        state.old_status = 401;
        state.refuse_old_elsewhere = true;
    }
    let workspace = h.core.workspace().unwrap();
    let scope = h.core.relaycast_scope(&workspace.base_url, &workspace.key);
    let result =
        client::update_agent_status(&workspace.base_url, &workspace.key, "review-agent", "idle")
            .await;
    assert!(result.as_ref().is_err_and(|e| e.is_auth_rejection()));
    h.core.observe_relaycast_write_result(&scope, &result);
    assert_eq!(
        h.core.status().workspace.verification,
        Verification::Pending
    );
    assert_eq!(
        h.core.refresh_workspace().await.verification,
        Verification::Verified
    );
    assert!(h.cloud_key_is(NEW));
    assert_eq!(h.fake.count("/resolve"), 1);
    assert_eq!(h.fake.new_gets(), 1);
}

/// A key still refused after recovery was tried for it is not re-checked
/// in a loop by the refresh pass, and Cloud is asked only once.
#[tokio::test]
async fn recovery_refused_key_is_not_rechecked_in_a_loop() {
    let h = Harness::new().await;
    h.fake.state.lock().unwrap().new_status = 401;
    assert!(h.verify().await.is_err());
    assert_eq!(
        h.core.status().workspace.verification,
        Verification::Rejected
    );
    let stale_ms = workspace_stale_ms();
    h.core.hub.update(|status| {
        status.workspace.checked_at_ms = Some(now_ms() - stale_ms);
    });
    let checks = h.fake.count("/v1/workspace");
    h.core.refresh_workspace().await;
    h.core.refresh_workspace().await;
    assert_eq!(h.fake.count("/v1/workspace"), checks);
    assert_eq!(h.fake.count("/resolve"), 1);
    assert!(h.cloud_key_is(OLD));
}

fn workspace_stale_ms() -> i64 {
    super::key_rotation::REVERIFY_VERIFIED_AFTER.as_millis() as i64 + 1_000
}

/// Points this machine's `agent-relay` CLI at `key`, bound to `site`.
fn select_cli_workspace(h: &Harness, key: &str) {
    let relay = h._temp.path().join(".agentworkforce/relay");
    std::fs::create_dir_all(&relay).unwrap();
    std::fs::write(
        relay.join("workspaces.json"),
        json!({"active":"local","workspaces":{"local":{"key":key}}}).to_string(),
    )
    .unwrap();
    std::fs::write(
        relay.join("relaycast-origins.json"),
        json!({"version":1,"origins":{
            crate::relay::workspace::origin_binding::credential_fingerprint(key): h.fake.site,
        }})
        .to_string(),
    )
    .unwrap();
}

/// A refused key the CLI named is never recovered through the Cloud
/// account, even when it is the account's key too: the CLI owns it.
#[tokio::test]
async fn recovery_never_applies_to_a_cli_workspace() {
    let h = Harness::new().await;
    select_cli_workspace(&h, OLD);
    h.core.rediscover_workspace();
    let workspace = h.core.workspace().unwrap();
    assert!(!workspace.source.is_cloud());
    assert_eq!(workspace.base_url, h.fake.site);
    assert!(h.verify().await.is_err());
    assert_eq!(
        h.core.status().workspace.verification,
        Verification::Rejected
    );
    assert_eq!(h.fake.count("/auth/token/refresh"), 0);
    assert_eq!(h.fake.count("/resolve"), 0);
    assert!(h.cloud_key_is(OLD));
}

/// A key rotated in the CLI's `workspaces.json` is picked up and verified by
/// the next refresh pass, without asking Cloud.
#[tokio::test]
async fn refresh_picks_up_a_key_rotated_in_the_cli_store() {
    let h = Harness::new().await;
    h.fake.state.lock().unwrap().old_status = 200;
    select_cli_workspace(&h, OLD);
    assert_eq!(
        h.core.refresh_workspace().await.verification,
        Verification::Verified
    );
    select_cli_workspace(&h, NEW);
    let status = h.core.refresh_workspace().await;
    assert_eq!(status.verification, Verification::Verified);
    assert_eq!(status.workspace_id.as_deref(), Some("rw_review"));
    assert_eq!(h.core.workspace().unwrap().key.expose(), NEW);
    assert_eq!(h.fake.new_gets(), 1);
    assert_eq!(h.fake.count("/resolve"), 0);
    // The account's own key is untouched.
    assert!(h.cloud_key_is(OLD));
}

/// A CLI selection that may not be used leaves the daemon with no
/// workspace rather than falling back to the account's.
#[tokio::test]
async fn a_refused_cli_selection_does_not_fall_back_to_the_account() {
    let h = Harness::new().await;
    assert!(h.core.workspace().unwrap().source.is_cloud());
    select_cli_workspace(&h, OLD);
    std::fs::write(
        h._temp
            .path()
            .join(".agentworkforce/relay/relaycast-origins.json"),
        "{",
    )
    .unwrap();
    assert!(!h.core.rediscover_workspace());
    assert!(h.core.workspace().is_none());
}
