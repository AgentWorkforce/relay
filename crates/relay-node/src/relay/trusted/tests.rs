use super::*;
use crate::relay::agents::SettingsExtension;

fn dm<'a>(sender: &'a str, address: &'a str) -> DeliveryRoute<'a> {
    DeliveryRoute {
        delivery_id: "del_1",
        message_id: "m-1",
        reason: Some("dm"),
        channel_id: None,
        sender: Some(sender),
        sender_id: None,
        sender_address: Some(address),
        native: false,
    }
}

fn from<'a>(sender: &'a str, id: &'a str) -> DeliveryRoute<'a> {
    DeliveryRoute {
        sender_id: Some(id),
        sender_address: None,
        ..dm(sender, "")
    }
}

fn member(name: &str, id: &str) -> WorkspaceMember {
    WorkspaceMember {
        name: name.into(),
        display_name: None,
        id: id.into(),
    }
}

/// Cloud's people list, every call counted; `None` answers fail.
struct People {
    account: Mutex<Option<CloudAccount>>,
    generation: AtomicU64,
    gate: Mutex<Option<Arc<tokio::sync::Notify>>>,
    started: tokio::sync::Notify,
    answer: std::sync::Mutex<Option<Value>>,
    calls: std::sync::Mutex<Vec<String>>,
}

impl People {
    fn new(answer: Option<Value>) -> Self {
        People {
            account: Mutex::new(Some(CloudAccount {
                site_url: "https://agentrelay.com".into(),
                workspace_id: "ws-1".into(),
                user_id: Some("user-1".into()),
            })),
            generation: AtomicU64::new(0),
            gate: Mutex::new(None),
            started: tokio::sync::Notify::new(),
            answer: std::sync::Mutex::new(answer),
            calls: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn answer(&self, answer: Option<Value>) {
        *self.answer.lock().unwrap() = answer;
    }
}

impl CloudAccess for People {
    fn account(&self) -> Option<crate::relay::cloud_session::CloudAccount> {
        self.account.lock().unwrap().clone()
    }

    fn identity_sync_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
        None
    }

    fn request(
        &self,
        method: &'static str,
        path: String,
        _: Option<Value>,
    ) -> futures_util::future::BoxFuture<'_, Result<Value, crate::relay::cloud_session::CloudError>>
    {
        self.calls.lock().unwrap().push(format!("{method} {path}"));
        let answer = self.answer.lock().unwrap().clone();
        let gate = self.gate.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                self.started.notify_one();
                gate.notified().await;
            }
            answer.ok_or(crate::relay::cloud_session::CloudError::Unreachable)
        })
    }
}

fn people(entries: Value) -> Option<Value> {
    Some(json!({ "people": entries }))
}

#[test]
fn cloud_people_are_read_by_their_identity_id() {
    let members = decode_people(&json!({"people": [
        {"handle": "grace-hopper", "displayName": "Grace Hopper", "agentId": "agent_w"},
        {"handle": "ada-lovelace", "displayName": "ada-lovelace", "agentId": "agent_k"},
        // No id (a Cloud that does not report it): never matched by name.
        {"handle": "no-id", "displayName": "No Id"},
        {"handle": "", "agentId": "agent_x"},
    ]}));
    assert_eq!(
        members,
        [
            member("ada-lovelace", "agent_k"),
            WorkspaceMember {
                display_name: Some("Grace Hopper".into()),
                ..member("grace-hopper", "agent_w")
            },
        ]
    );
    assert!(decode_people(&json!({})).is_empty());
}

#[test]
fn workspace_members_are_trusted_by_id_while_fresh_and_on() {
    let dir = tempfile::tempdir().unwrap();
    let senders = TrustedSenders::new(dir.path());
    let now = 1_000_000_000;
    assert!(senders.trusts_members(), "on unless turned off");
    with_members(&senders, vec![member("grace-hopper", "agent_w")], now);
    assert!(senders.trusts_member_at(&from("grace-hopper", "agent_w"), now));
    // The id decides, not the name: a name registered again, or the
    // member's own agents, stay untrusted.
    assert!(!senders.trusts_member_at(&from("grace-hopper", "agent_new"), now));
    assert!(!senders.trusts_member_at(&from("sam-codex", "agent_wc"), now));
    assert!(!senders.trusts_member_at(&dm("grace-hopper", "grace-hopper@direct"), now));
    // A list Cloud has not confirmed lately trusts no one.
    let stale = now + MEMBERS_FRESH.as_millis() as i64 + 1;
    assert!(!senders.trusts_member_at(&from("grace-hopper", "agent_w"), stale));
    assert!(senders.members_at(stale).is_empty());
    // Turned off, members are not trusted; the hand-made list still is.
    senders.set_trusts_members(false).unwrap();
    assert!(!senders.trusts_member_at(&from("grace-hopper", "agent_w"), now));
    senders.set(&json!(["grace-hopper"])).unwrap();
    assert!(senders.trusts(&from("grace-hopper", "agent_w")));
    senders.set_trusts_members(true).unwrap();
    assert!(!senders.trusts_member_at(&from("grace-hopper", "agent_w"), now));
    let scope = senders.scope().unwrap();
    senders.store_members(scope.clone(), vec![member("grace-hopper", "agent_w")], now);
    assert!(senders.trusts_member_at(&from("grace-hopper", "agent_w"), now));
    senders.store_members(scope, Vec::new(), now);
    assert!(!senders.trusts_member_at(&from("grace-hopper", "agent_w"), now));
    assert!(!dir.path().join("trusted-workspace-members.json").exists());
}

#[tokio::test]
async fn members_are_read_from_cloud_and_a_removal_revokes_trust() {
    let dir = tempfile::tempdir().unwrap();
    let senders = TrustedSenders::new(dir.path());
    let settings = TrustedSettings::new(senders.clone(), || true);
    let cloud = Arc::new(People::new(people(json!([
        {"handle": "grace-hopper", "displayName": "Grace Hopper", "agentId": "agent_w"},
    ]))));
    senders.bind_cloud(cloud.clone());
    assert!(settings.refresh_members(cloud.as_ref()).await);
    assert_eq!(
        cloud.calls.lock().unwrap().as_slice(),
        ["GET /workspaces/ws-1/messaging/people"]
    );
    assert!(senders.trusts(&from("grace-hopper", "agent_w")));
    assert_eq!(
        settings.get()[MEMBERS_LIST],
        json!([{"name": "grace-hopper", "display_name": "Grace Hopper"}])
    );
    assert_eq!(settings.get()[MEMBERS_SETTING], json!(true));
    // Nothing new: no change to show.
    assert!(!settings.refresh_members(cloud.as_ref()).await);
    // A failed read keeps the list until it ages out.
    cloud.answer(None);
    assert!(!settings.refresh_members(cloud.as_ref()).await);
    assert!(senders.trusts(&from("grace-hopper", "agent_w")));
    // Removed from the workspace: untrusted from the next read.
    cloud.answer(people(json!([])));
    assert!(settings.refresh_members(cloud.as_ref()).await);
    assert!(!senders.trusts(&from("grace-hopper", "agent_w")));
    assert_eq!(settings.get()[MEMBERS_LIST], json!([]));
}

#[tokio::test]
async fn members_are_not_read_while_off_and_forgotten_when_signed_out() {
    let dir = tempfile::tempdir().unwrap();
    let senders = TrustedSenders::new(dir.path());
    let settings = TrustedSettings::new(senders.clone(), || true);
    let cloud = Arc::new(People::new(people(
        json!([{"handle": "grace-hopper", "agentId": "agent_w"}]),
    )));
    senders.bind_cloud(cloud.clone());
    settings
        .set(MEMBERS_SETTING, &json!(false))
        .unwrap()
        .unwrap();
    assert!(!settings.refresh_members(cloud.as_ref()).await);
    assert!(cloud.calls.lock().unwrap().is_empty());
    assert_eq!(settings.get()[MEMBERS_SETTING], json!(false));
    assert_eq!(settings.get()[MEMBERS_LIST], json!([]));
    settings
        .set(MEMBERS_SETTING, &json!(true))
        .unwrap()
        .unwrap();
    assert!(settings.refresh_members(cloud.as_ref()).await);
    assert!(senders.trusts(&from("grace-hopper", "agent_w")));
    cloud.calls.lock().unwrap().clear();
    *cloud.account.lock().unwrap() = None;
    // Delivery and Settings fail closed before the async refresh runs.
    assert!(!senders.trusts(&from("grace-hopper", "agent_w")));
    assert_eq!(settings.get()[MEMBERS_LIST], json!([]));
    assert!(settings.refresh_members(cloud.as_ref()).await);
    assert!(cloud.calls.lock().unwrap().is_empty());
    // Read-only, and a choice is true or false.
    assert!(settings.set(MEMBERS_LIST, &json!([])).unwrap().is_err());
    assert!(settings
        .set(MEMBERS_SETTING, &json!("yes"))
        .unwrap()
        .is_err());
}

#[tokio::test]
async fn members_are_not_read_where_no_agent_applies() {
    let dir = tempfile::tempdir().unwrap();
    let settings = TrustedSettings::new(TrustedSenders::new(dir.path()), || false);
    let cloud = Arc::new(People::new(people(
        json!([{"handle": "grace-hopper", "agentId": "agent_w"}]),
    )));
    settings.bind_cloud(cloud.clone());
    assert!(!settings.refresh_members(cloud.as_ref()).await);
    assert!(cloud.calls.lock().unwrap().is_empty());
    assert!(settings.get().is_empty());
}

#[test]
fn senders_match_by_address_or_name() {
    let trusted = vec!["ada-lovelace".to_string(), "Bot@Node-9".to_string()];
    assert!(matches(
        &trusted,
        &dm("Ada-Lovelace", "ada-lovelace@sf-mini")
    ));
    assert!(matches(&trusted, &dm("someone", "bot@node-9")));
    // An address entry never matches a name, and strangers stay out.
    assert!(!matches(&trusted, &dm("bot", "bot@node-1")));
    assert!(!matches(&trusted, &dm("alice", "alice@node-1")));
    assert!(!matches(&[], &dm("ada-lovelace", "ada-lovelace@sf-mini")));
}

#[test]
fn the_list_is_saved_from_settings_while_an_agent_applies() {
    let dir = tempfile::tempdir().unwrap();
    let senders = TrustedSenders::new(dir.path());
    let applies = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let shown = applies.clone();
    let settings = TrustedSettings::new(senders.clone(), move || {
        shown.load(std::sync::atomic::Ordering::SeqCst)
    });
    assert!(settings.get().is_empty());
    applies.store(true, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(settings.get()[SETTING], json!([]));
    settings
        .set(
            SETTING,
            &json!([" ada-lovelace ", "ADA-LOVELACE", "", "bot@node-9"]),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        settings.get()[SETTING],
        json!(["ada-lovelace", "bot@node-9"])
    );
    assert!(settings
        .set(SETTING, &json!("ada-lovelace"))
        .unwrap()
        .is_err());
    assert!(settings.set(SETTING, &json!(["a\nb"])).unwrap().is_err());
    assert!(settings.set("other", &json!([])).is_none());
    assert!(senders.trusts(&dm("ada-lovelace", "ada-lovelace@sf-mini")));
    #[cfg(unix)]
    {
        let mode = std::os::unix::fs::PermissionsExt::mode(
            &std::fs::metadata(dir.path().join("trusted-relay-senders.json"))
                .unwrap()
                .permissions(),
        ) & 0o777;
        assert_eq!(mode, 0o600);
    }
}

/// Confirm a list for delivery integration tests using a live signed-in account.
pub(crate) fn with_members(senders: &TrustedSenders, members: Vec<WorkspaceMember>, now: i64) {
    senders.bind_cloud(Arc::new(People::new(None)));
    senders.store_members(senders.scope().unwrap(), members, now);
}

#[tokio::test]
async fn account_changes_revoke_trust_before_a_refresh_even_when_cloud_fails() {
    for field in ["workspace", "user", "site", "generation", "sign_out"] {
        let dir = tempfile::tempdir().unwrap();
        let senders = TrustedSenders::new(dir.path());
        let settings = TrustedSettings::new(senders.clone(), || true);
        let cloud = Arc::new(People::new(people(json!([
            {"handle": "will", "agentId": "agent_w"}
        ]))));
        settings.bind_cloud(cloud.clone());
        assert!(settings.refresh_members(cloud.as_ref()).await);
        assert!(senders.trusts(&from("will", "agent_w")));
        let previous = cloud.account();
        {
            let mut account = cloud.account.lock().unwrap();
            match field {
                "workspace" => account.as_mut().unwrap().workspace_id = "ws-2".into(),
                "user" => account.as_mut().unwrap().user_id = Some("user-2".into()),
                "site" => account.as_mut().unwrap().site_url = "https://other.example".into(),
                "generation" => {
                    cloud.generation.fetch_add(1, Ordering::SeqCst);
                }
                _ => *account = None,
            }
        }
        assert!(!senders.trusts(&from("will", "agent_w")), "{field}");
        assert_eq!(settings.get()[MEMBERS_LIST], json!([]), "{field}");
        cloud.answer(None);
        assert!(
            settings.refresh_members(cloud.as_ref()).await,
            "invalidate {field}"
        );
        assert!(senders.members.cache.lock().unwrap().is_none());
        // Returning to the old account must require Cloud confirmation too.
        *cloud.account.lock().unwrap() = previous;
        assert!(!senders.trusts(&from("will", "agent_w")));
    }
}

#[tokio::test]
async fn a_failed_or_malformed_read_invalidates_expired_people_once() {
    for answer in [None, Some(json!({"unexpected": []}))] {
        let dir = tempfile::tempdir().unwrap();
        let senders = TrustedSenders::new(dir.path());
        let settings = TrustedSettings::new(senders.clone(), || true);
        let entries = people(json!([{"handle": "will", "agentId": "agent_w"}]));
        let cloud = Arc::new(People::new(entries.clone()));
        settings.bind_cloud(cloud.clone());
        assert!(settings.refresh_members(cloud.as_ref()).await);
        senders
            .members
            .cache
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .read_at_ms -= MEMBERS_FRESH.as_millis() as i64 + 1;
        cloud.answer(answer);
        assert!(settings.refresh_members(cloud.as_ref()).await);
        assert_eq!(settings.get()[MEMBERS_LIST], json!([]));
        assert!(!senders.trusts(&from("will", "agent_w")));
        assert!(!settings.refresh_members(cloud.as_ref()).await);
        // The same people become visible again after Cloud confirms them.
        cloud.answer(entries);
        assert!(settings.refresh_members(cloud.as_ref()).await);
        assert!(senders.trusts(&from("will", "agent_w")));
    }
}

#[tokio::test]
async fn retired_reads_cannot_restore_members() {
    for change in [
        "workspace",
        "user",
        "site",
        "sign_out",
        "generation",
        "off_then_on",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let senders = TrustedSenders::new(dir.path());
        let settings = TrustedSettings::new(senders.clone(), || true);
        let cloud = Arc::new(People::new(people(json!([
            {"handle": "will", "agentId": "agent_w"}
        ]))));
        settings.bind_cloud(cloud.clone());
        let gate = Arc::new(tokio::sync::Notify::new());
        *cloud.gate.lock().unwrap() = Some(gate.clone());
        let (changed, ()) = tokio::join!(settings.refresh_members(cloud.as_ref()), async {
            cloud.started.notified().await;
            match change {
                "off_then_on" => {
                    settings
                        .set(MEMBERS_SETTING, &json!(false))
                        .unwrap()
                        .unwrap();
                    settings
                        .set(MEMBERS_SETTING, &json!(true))
                        .unwrap()
                        .unwrap();
                }
                "generation" => {
                    cloud.generation.fetch_add(1, Ordering::SeqCst);
                }
                "sign_out" => *cloud.account.lock().unwrap() = None,
                field => {
                    let mut account = cloud.account.lock().unwrap();
                    let account = account.as_mut().unwrap();
                    match field {
                        "user" => account.user_id = Some("user-2".into()),
                        "site" => account.site_url = "https://other.example".into(),
                        _ => account.workspace_id = "ws-2".into(),
                    }
                }
            }
            settings.refresh_soon();
            gate.notify_one();
        });
        assert!(!changed, "{change}");
        assert!(!senders.trusts(&from("will", "agent_w")), "{change}");
        assert_eq!(settings.get()[MEMBERS_LIST], json!([]), "{change}");
    }
}

#[tokio::test]
async fn opt_out_and_agent_removal_forget_people_and_reenable_requires_confirmation() {
    for remove_agent in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let senders = TrustedSenders::new(dir.path());
        let applies = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let visible = applies.clone();
        let settings =
            TrustedSettings::new(senders.clone(), move || visible.load(Ordering::SeqCst));
        let cloud = Arc::new(People::new(people(json!([
            {"handle": "will", "agentId": "agent_w"}
        ]))));
        settings.bind_cloud(cloud.clone());
        assert!(settings.refresh_members(cloud.as_ref()).await);
        if remove_agent {
            applies.store(false, Ordering::SeqCst);
        } else {
            settings
                .set(MEMBERS_SETTING, &json!(false))
                .unwrap()
                .unwrap();
        }
        cloud.calls.lock().unwrap().clear();
        assert!(settings.refresh_members(cloud.as_ref()).await);
        assert!(senders.members.cache.lock().unwrap().is_none());
        assert!(cloud.calls.lock().unwrap().is_empty());
        *cloud.account.lock().unwrap() = None;
        settings.refresh_soon();
        settings.refresh_members(cloud.as_ref()).await;
        applies.store(true, Ordering::SeqCst);
        settings
            .set(MEMBERS_SETTING, &json!(true))
            .unwrap()
            .unwrap();
        assert!(!senders.trusts(&from("will", "agent_w")));
        assert_eq!(settings.get()[MEMBERS_LIST], json!([]));
    }
}
