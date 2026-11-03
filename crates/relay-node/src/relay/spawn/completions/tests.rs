use super::*;
use crate::relay::harness::{claude, codex};
use serde_json::json;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn request() -> SpawnRequest {
    SpawnRequest {
        invocation_id: "inv/original".into(),
        name: "worker".into(),
        harness: codex::ID,
        task: "private task must not be stored".into(),
        directory: Some("/private/task/directory".into()),
    }
}

#[test]
fn successful_receipts_are_private_immutable_and_token_free() {
    let home = tempfile::tempdir().unwrap();
    let scope = Scope::new("https://relay.example", &Secret::new("workspace-secret"));
    let request = request();
    let original = wire::spawned_unconfirmed(&request.name, "transport_closed");
    scope.save(home.path(), &request, original.clone()).unwrap();
    // A later writer cannot replace the first receipt with a more confident one.
    let replay = scope
        .save(home.path(), &request, wire::spawned(&request.name))
        .unwrap();
    assert_eq!(replay.replay(&request).unwrap(), original);
    let path = scope.path(home.path(), &request.invocation_id);
    let raw = std::fs::read_to_string(&path).unwrap();
    for excluded in ["workspace-secret", &request.task, "/private/task/directory"] {
        assert!(!raw.contains(excluded));
        assert!(!path.to_string_lossy().contains(excluded));
    }
    // File modes are a Unix guarantee; Windows keeps the profile private.
    #[cfg(unix)]
    {
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(home.path().join(DIRECTORY))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}

#[test]
fn receipts_are_scoped_to_workspace_origin_and_invocation() {
    let home = tempfile::tempdir().unwrap();
    let key = Secret::new("workspace-one");
    let scope = Scope::new("https://relay.example", &key);
    let request = request();
    scope
        .save(home.path(), &request, wire::spawned(&request.name))
        .unwrap();
    for other in [
        Scope::new("https://relay.example", &Secret::new("workspace-two")),
        Scope::new("https://other.example", &key),
    ] {
        assert!(other
            .load(home.path(), &request.invocation_id)
            .unwrap()
            .is_none());
        assert_ne!(
            other.lock_key(&request.invocation_id),
            scope.lock_key(&request.invocation_id)
        );
    }
    assert!(scope.load(home.path(), "inv/another").unwrap().is_none());
}

#[test]
fn replay_cannot_rebind_a_completed_invocation() {
    let home = tempfile::tempdir().unwrap();
    let scope = Scope::new("https://relay.example", &Secret::new("workspace-one"));
    let original = request();
    scope
        .save(home.path(), &original, wire::spawned(&original.name))
        .unwrap();
    for changed in [
        SpawnRequest {
            name: "other".into(),
            ..original.clone()
        },
        SpawnRequest {
            harness: claude::ID,
            ..original.clone()
        },
    ] {
        let receipt = scope
            .load(home.path(), &original.invocation_id)
            .unwrap()
            .unwrap();
        assert!(receipt.replay(&changed).is_err());
    }
}

#[test]
fn corrupt_or_misbound_receipts_are_errors_not_new_invocations() {
    let home = tempfile::tempdir().unwrap();
    let scope = Scope::new("https://relay.example", &Secret::new("workspace-one"));
    let request = request();
    scope
        .save(home.path(), &request, wire::spawned(&request.name))
        .unwrap();
    let path = scope.path(home.path(), &request.invocation_id);
    let original: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for (field, bad) in [
        ("version", json!(2)),
        ("scope", json!("other")),
        ("invocation_id", json!("other")),
        ("output", json!({"spawned":true,"name":"wrong"})),
    ] {
        let mut corrupt = original.clone();
        corrupt[field] = bad;
        std::fs::write(&path, serde_json::to_vec(&corrupt).unwrap()).unwrap();
        assert!(scope.load(home.path(), &request.invocation_id).is_err());
    }
    std::fs::write(path, b"truncated{").unwrap();
    assert!(scope.load(home.path(), &request.invocation_id).is_err());
}

#[test]
fn failed_receipts_survive_restart_without_relaunch_or_origin_restoration() {
    let home = tempfile::tempdir().unwrap();
    let scope = Scope::new("https://relay.example", &Secret::new("workspace-one"));
    let request = request();
    let failure = SpawnError::Failure(Box::new(wire::SpawnFailure {
        code: wire::HARNESS_UNAVAILABLE,
        message: "Credentials rejected api_key=private-value".into(),
        node: "desktop".into(),
        harness: Some(request.harness),
        active: None,
        reserved: None,
        max: None,
        observed_at: "2026-10-19T00:00:00Z".into(),
        retryable: false,
    }));
    scope
        .save_failure(home.path(), &request, failure.clone())
        .unwrap();
    let raw = std::fs::read_to_string(scope.path(home.path(), &request.invocation_id)).unwrap();
    assert!(!raw.contains("private-value"));
    let saved = scope
        .load(home.path(), &request.invocation_id)
        .unwrap()
        .unwrap();
    assert!(!saved.confirms(&request.name, request.harness));
    assert_eq!(saved.replay(&request), Err(failure.redacted()));
    let saved = scope
        .save(home.path(), &request, wire::spawned(&request.name))
        .unwrap();
    assert!(
        saved.replay(&request).is_err(),
        "a failure receipt cannot turn into a launch"
    );
}
