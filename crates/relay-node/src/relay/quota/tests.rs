use super::helper::{forward_helper_env, sterile_config};
use super::*;
use std::ffi::OsString;
use tokio::process::Command;

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-10-14T02:01:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

#[test]
fn all_lanes_are_off_by_default() {
    assert!(QuotaConfig::default().enabled_lanes.is_empty());
    let cache = QuotaCache::default();
    cache.replace(vec![normalize_helper_json(
        QuotaLane::CodexOAuth,
        include_bytes!("fixtures/codex_oauth.json"),
        now(),
    )]);
    assert!(cache.spawn_refresh(QuotaConfig::default()).is_none());
    assert!(cache.snapshot(now()).is_empty());
}

#[test]
fn opencode_api_key_is_only_forwarded_to_its_enabled_lane() {
    let lanes = [
        None,
        Some(QuotaLane::ClaudeOAuth),
        Some(QuotaLane::CodexOAuth),
        Some(QuotaLane::CodexRpc),
        Some(QuotaLane::GrokRpc),
        Some(QuotaLane::MuseCodeOAuth),
    ];
    for lane in lanes {
        let mut command = Command::new("unused");
        let mut looked_up = false;
        forward_helper_env(&mut command, lane, |key| {
            if key == "OPENCODE_API_KEY" {
                looked_up = true;
                Some(OsString::from("fixture-key"))
            } else {
                None
            }
        });
        assert!(!looked_up);
        assert!(!command
            .as_std()
            .get_envs()
            .any(|(key, _)| key == std::ffi::OsStr::new("OPENCODE_API_KEY")));
    }
    let mut command = Command::new("unused");
    forward_helper_env(&mut command, Some(QuotaLane::OpenCodeGoApi), |key| {
        (key == "OPENCODE_API_KEY").then(|| OsString::from("fixture-key"))
    });
    assert!(command.as_std().get_envs().any(|(key, value)| {
        key == std::ffi::OsStr::new("OPENCODE_API_KEY")
            && value == Some(std::ffi::OsStr::new("fixture-key"))
    }));
}

#[test]
fn repeated_failures_back_off_to_thirty_minutes() {
    assert_eq!(retry_delay(0), Duration::from_secs(120));
    assert_eq!(retry_delay(1), Duration::from_secs(120));
    assert_eq!(retry_delay(2), Duration::from_secs(240));
    assert_eq!(retry_delay(3), Duration::from_secs(480));
    assert_eq!(retry_delay(5), Duration::from_secs(1800));
    assert_eq!(retry_delay(100), Duration::from_secs(1800));
}

#[test]
fn sterile_configs_are_private_cookie_free_and_removed() {
    for lane in [
        QuotaLane::ClaudeOAuth,
        QuotaLane::CodexOAuth,
        QuotaLane::CodexRpc,
        QuotaLane::OpenCodeGoApi,
        QuotaLane::GrokRpc,
        QuotaLane::MuseCodeOAuth,
    ] {
        let (dir, path) = sterile_config(Some(lane)).unwrap().unwrap();
        let directory = dir.path().to_path_buf();
        // Windows has no modes; the temporary folder's inherited access
        // list is already this user's only.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let content = std::fs::read_to_string(&path).unwrap();
        let config: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(config["providers"].as_array().unwrap().len(), 1);
        assert_eq!(config["providers"][0]["id"], lane.provider());
        assert_eq!(config["providers"][0]["source"], lane.source_mode());
        assert!(content.contains(r#""cookieSource":"off""#));
        assert!(!content.contains("token"));
        assert!(!content.contains("cookieHeader"));
        drop(dir);
        assert!(!directory.exists());
    }
    assert!(sterile_config(None).unwrap().is_none());

    let mut directory = PathBuf::new();
    let failed: Result<(), UnknownReason> = (|| {
        let (dir, _) = sterile_config(Some(QuotaLane::MuseCodeOAuth))?.unwrap();
        directory = dir.path().to_path_buf();
        Err(UnknownReason::Timeout)
    })();
    assert_eq!(failed, Err(UnknownReason::Timeout));
    assert!(!directory.exists());
}

#[test]
fn heartbeat_cache_ages_readings_without_fetching() {
    let cache = QuotaCache::default();
    let reading = normalize_helper_json(
        QuotaLane::CodexOAuth,
        include_bytes!("fixtures/codex_oauth.json"),
        now(),
    );
    cache.replace(vec![reading]);
    assert_eq!(cache.snapshot(now())[0].state, QuotaState::ApproachingLimit);
    let later = DateTime::parse_from_rfc3339("2026-10-14T02:04:01Z")
        .unwrap()
        .with_timezone(&Utc);
    let stale = cache.snapshot(later);
    assert_eq!(stale[0].state, QuotaState::Unknown);
    assert_eq!(stale[0].reason, Some(UnknownReason::Stale));
    assert!(stale[0].windows.is_empty());
    // Reading the cache did not alter its observation or start another fetch.
    assert_eq!(cache.snapshot(now())[0].state, QuotaState::ApproachingLimit);
}

#[test]
fn codex_approaching_limit_and_fingerprint_is_stable() {
    let bytes = include_bytes!("fixtures/codex_oauth.json");
    let reading = normalize_helper_json(QuotaLane::CodexOAuth, bytes, now());
    assert_eq!(reading.state, QuotaState::ApproachingLimit);
    assert_eq!(reading.windows.len(), 2);
    assert_eq!(reading.windows[0].remaining_percent, 9.0);
    assert_eq!(reading.account_fingerprint.as_ref().unwrap().len(), 64);
    assert_eq!(
        reading.account_fingerprint,
        normalize_helper_json(QuotaLane::CodexOAuth, bytes, now()).account_fingerprint
    );
}

#[test]
fn claude_placeholder_does_not_hide_exhausted_weekly_quota() {
    let reading = normalize_helper_json(
        QuotaLane::ClaudeOAuth,
        include_bytes!("fixtures/claude_oauth.json"),
        now(),
    );
    assert_eq!(reading.state, QuotaState::Blocked);
    assert_eq!(reading.windows.len(), 1);
    assert_eq!(reading.windows[0].kind, "weekly");
}

#[test]
fn grok_rpc_and_muse_oauth_are_quota_not_spend() {
    for (lane, bytes) in [
        (
            QuotaLane::GrokRpc,
            include_bytes!("fixtures/grok_rpc.json").as_slice(),
        ),
        (
            QuotaLane::MuseCodeOAuth,
            include_bytes!("fixtures/muse_oauth.json").as_slice(),
        ),
    ] {
        let reading = normalize_helper_json(lane, bytes, now());
        assert_eq!(reading.state, QuotaState::Available);
        assert_eq!(reading.measurement, MeasurementKind::Quota);
        assert_eq!(reading.billing, BillingKind::Subscription);
        assert!(reading.fresh);
        if lane == QuotaLane::GrokRpc {
            assert_eq!(reading.windows[0].kind, "billing_period");
        }
    }
}

#[test]
fn opencode_go_api_without_upstream_identity_stays_unknown() {
    let reading = normalize_helper_json(
        QuotaLane::OpenCodeGoApi,
        include_bytes!("fixtures/opencodego_api.json"),
        now(),
    );
    assert_eq!(reading.state, QuotaState::Unknown);
    assert_eq!(reading.reason, Some(UnknownReason::UnidentifiedAccount));
    assert!(reading.account_fingerprint.is_none());
    assert_eq!(reading.provider, "opencodego");
}

#[test]
fn stale_data_fails_closed() {
    let reading = normalize_helper_json(
        QuotaLane::CodexOAuth,
        include_bytes!("fixtures/codex_oauth.json"),
        DateTime::parse_from_rfc3339("2026-10-14T02:04:01Z")
            .unwrap()
            .with_timezone(&Utc),
    );
    assert_eq!(reading.state, QuotaState::Unknown);
    assert_eq!(reading.reason, Some(UnknownReason::Stale));
    assert!(!reading.fresh);
}

#[test]
fn source_mismatch_and_error_never_become_quota() {
    let mut value: serde_json::Value =
        serde_json::from_slice(include_bytes!("fixtures/codex_oauth.json")).unwrap();
    value[0]["source"] = "openai-web".into();
    let reading = normalize_helper_json(
        QuotaLane::CodexOAuth,
        &serde_json::to_vec(&value).unwrap(),
        now(),
    );
    assert_eq!(reading.reason, Some(UnknownReason::UntrustedSource));
    value[0]["source"] = "oauth".into();
    value[0]["error"] = serde_json::json!({"message":"do not propagate secrets"});
    let reading = normalize_helper_json(
        QuotaLane::CodexOAuth,
        &serde_json::to_vec(&value).unwrap(),
        now(),
    );
    assert_eq!(reading.reason, Some(UnknownReason::FetchFailed));
    assert_eq!(reading.account_fingerprint, None);
}

#[test]
fn missing_identity_cannot_be_shared_between_nodes() {
    let mut value: serde_json::Value =
        serde_json::from_slice(include_bytes!("fixtures/muse_oauth.json")).unwrap();
    value[0]["usage"]["identity"] = serde_json::Value::Null;
    let reading = normalize_helper_json(
        QuotaLane::MuseCodeOAuth,
        &serde_json::to_vec(&value).unwrap(),
        now(),
    );
    assert_eq!(reading.state, QuotaState::Unknown);
    assert_eq!(reading.reason, Some(UnknownReason::UnidentifiedAccount));
}

#[test]
fn expired_window_does_not_report_blocked() {
    let mut value: serde_json::Value =
        serde_json::from_slice(include_bytes!("fixtures/codex_oauth.json")).unwrap();
    value[0]["usage"]["primary"]["usedPercent"] = 100.into();
    value[0]["usage"]["primary"]["resetsAt"] = "2026-10-14T01:59:00Z".into();
    let reading = normalize_helper_json(
        QuotaLane::CodexOAuth,
        &serde_json::to_vec(&value).unwrap(),
        now(),
    );
    assert_eq!(reading.state, QuotaState::Available);
    assert_eq!(reading.windows.len(), 1);
}
