use super::*;
use crate::relay::managed_sessions::{ManagedLaunch, ManagedRuntime};
use crate::relay::process::{FakeProcess, FakeProcesses};
use std::path::Path;
use std::sync::Arc;

struct Runtime;
impl ManagedRuntime for Runtime {
    fn launch(&self, _: &ManagedLaunch, _: &Path) -> Result<ManagedBinding, ()> {
        Err(())
    }
    fn verify(&self, _: &ManagedBinding) -> bool {
        true
    }
}

#[test]
fn managed_reply_needs_exact_process_tag_attestation_and_sealed_session() {
    let home = tempfile::tempdir().unwrap();
    let config = OpenCodeConfig::from_env(&|_| None, home.path());
    crate::relay::paths::socket_directory(&config.runtime).unwrap();
    let executable = home.path().join("opencode");
    std::fs::write(&executable, "").unwrap();
    let table = FakeProcesses::default();
    let marker = "synthetic-owned-marker";
    let process = FakeProcess {
        uid: crate::relay::peer::current_uid(),
        start: 7,
        executable: Some(executable.clone()),
        environment: std::collections::HashMap::from([(
            crate::relay::opencode_serve::MARKER.into(),
            marker.into(),
        )]),
        ..Default::default()
    };
    table.insert(40, process.clone());
    let mut binding = Binding {
        relay_workspace_id: "test-workspace".into(),
        owner_id: "test-owner".into(),
        session_id: "ses_exact".into(),
        endpoint: "http://127.0.0.1:10001".into(),
        server_pid: 40,
        server_start: 7,
        server_uid: crate::relay::peer::current_uid(),
        executable,
        directory: home.path().to_path_buf(),
        project_id: "project-test".into(),
        opencode_workspace_id: None,
        credential_reference: String::new(),
    };
    binding.credential_reference = opencode_existing::credential_reference(&binding, marker);
    let managed = ManagedSessions::new(
        home.path().join("managed"),
        Default::default(),
        Arc::new(Runtime),
    );
    managed
        .adopt(ManagedBinding::OpenCode(binding.clone()))
        .unwrap();
    let target = Target::new(SessionKind::OpenCode, "ses_exact");
    assert!(!can_reply(&managed, &config, &table, &target));
    let attestation = config.runtime.join("40.managed.json");
    std::fs::write(&attestation,serde_json::json!({"version":super::super::PLUGIN_VERSION,"pid":40,"marker_sha256":format!("{:x}",Sha256::digest(marker.as_bytes()))}).to_string()).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&attestation, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(can_reply(&managed, &config, &table, &target));
    assert_eq!(
        caller(&managed, &config, &table, 40, Some("ses_exact")),
        Some(target.clone())
    );
    assert!(caller(&managed, &config, &table, 40, None).is_none());
    assert!(caller(&managed, &config, &table, 40, Some("ses_other")).is_none());
    assert!(caller(&managed, &config, &table, 41, Some("ses_exact")).is_none());
    table.insert(
        40,
        FakeProcess {
            start: 8,
            ..process.clone()
        },
    );
    assert!(!can_reply(&managed, &config, &table, &target));
    table.insert(40, process);
    std::fs::write(&attestation, "{}").unwrap();
    assert!(caller(&managed, &config, &table, 40, Some("ses_exact")).is_none());
}
