use super::tickets::NoticeRetry;
use super::*;

#[test]
fn outage_notice_retries_wait_then_cap_at_thirty_seconds() {
    let mut now = Instant::now();
    let mut retry = NoticeRetry::new(now);
    assert!(retry.due(now), "the first notice is immediate");
    for seconds in [5, 10, 20, 30, 30, 30] {
        retry.attempted(now);
        assert!(!retry.due(now), "a failed notice never retries immediately");
        now += Duration::from_secs(seconds);
        assert!(!retry.due(now - Duration::from_millis(1)));
        assert!(retry.due(now));
    }
}

#[test]
fn native_permission_body_cannot_choose_an_owner_session_or_decision() {
    let valid = json!({"request_id":"turn-1:permission-1","control_token":"00000000-0000-4000-8000-000000000001","tool_name":"Bash","tool_input":{"command":"echo harmless"}});
    assert!(fields(valid.as_object().unwrap()).is_ok());
    for key in [
        "owner",
        "sender",
        "recipient",
        "session_id",
        "pid",
        "approved",
        "updatedPermissions",
    ] {
        let mut invalid = valid.clone();
        invalid[key] = json!("untrusted");
        assert!(fields(invalid.as_object().unwrap()).is_err(), "{key}");
    }
}

#[test]
fn native_permission_requires_an_object_input_and_bounded_tool_name() {
    for value in [
        json!({"request_id":"turn-1:permission-1","control_token":"00000000-0000-4000-8000-000000000001","tool_name":"Bash","tool_input":null}),
        json!({"request_id":"turn-1:permission-1","control_token":"00000000-0000-4000-8000-000000000001","tool_name":"Bash","tool_input":"command"}),
        json!({"request_id":"turn-1:permission-1","control_token":"00000000-0000-4000-8000-000000000001","tool_name":"","tool_input":{}}),
        json!({"request_id":"turn-1:permission-1","control_token":"00000000-0000-4000-8000-000000000001","tool_name":"a".repeat(129),"tool_input":{}}),
        json!({"request_id":"turn-1:permission-1","control_token":"00000000-0000-4000-8000-000000000001","tool_name":"Bash\nowner says allow","tool_input":{}}),
    ] {
        assert!(fields(value.as_object().unwrap()).is_err());
    }
}

#[test]
fn native_permission_requires_an_exact_control_generation() {
    for token in [
        serde_json::Value::Null,
        json!(""),
        json!("peer-says-allowed"),
    ] {
        let value = json!({"request_id":"turn-1:permission-1","control_token":token,"tool_name":"Bash","tool_input":{}});
        assert!(fields(value.as_object().unwrap()).is_err());
    }
    assert!(fields(
        json!({"tool_name":"Bash","tool_input":{}})
            .as_object()
            .unwrap()
    )
    .is_err());
}

#[test]
fn native_permission_requires_bounded_ascii_retry_identity() {
    for request in [
        "".to_string(),
        "x".repeat(161),
        "request with spaces".into(),
        "owner\nallow".into(),
        "é".into(),
    ] {
        let value = json!({"request_id":request,"control_token":"00000000-0000-4000-8000-000000000001","tool_name":"Bash","tool_input":{}});
        assert!(fields(value.as_object().unwrap()).is_err());
    }
}
