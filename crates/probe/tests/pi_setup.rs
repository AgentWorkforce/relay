//! Pi setup failures must survive startup in the snapshot both desktop apps read.
use agent_relay_probe::relay::daemon::{Config, Core};
use agent_relay_probe::relay::local;
use agent_relay_probe::relay::paths::CorePaths;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

fn config(home: &Path, enabled: bool) -> Config {
    Config {
        paths: CorePaths::for_socket(home.join("run/core.sock")).unwrap(),
        home: home.to_path_buf(),
        app_data_dir: home.join("app-data"),
        env: BTreeMap::from([
            ("AGENT_RELAY_ENABLE_OPENCLAW".into(), "0".into()),
            ("AGENT_RELAY_ENABLE_HERMES".into(), "0".into()),
            (
                "AGENT_RELAY_ENABLE_PI".into(),
                if enabled { "1" } else { "0" }.into(),
            ),
        ]),
        version: "test".into(),
        host_name: "Pi setup test".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: Default::default(),
        delivery_timing: Default::default(),
    }
}

fn snapshot(config: Config) -> serde_json::Value {
    let plugins = local::plugins(&config);
    let (core, _) = Core::with_plugins(config, plugins);
    serde_json::to_value(core.hub().snapshot()).unwrap()
}

#[test]
fn a_conflicting_pi_extension_reports_a_persistent_actionable_error_and_recovers() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join(".pi/agent/extensions");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("agent-relay.js");
    std::fs::write(&path, "// personal extension").unwrap();
    let failed = snapshot(config(temp.path(), true));
    let error = failed["agents"]["integration_error"]
        .as_str()
        .expect("Pi install failure must be visible to clients connecting after startup");
    assert!(
        error.contains("Pi extension could not be installed"),
        "{error}"
    );
    assert!(error.contains("agent-relay.js"), "{error}");
    assert!(error.contains("Restart Agent Relay"), "{error}");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "// personal extension"
    );
    std::fs::remove_file(&path).unwrap();
    assert!(snapshot(config(temp.path(), true))["agents"]["integration_error"].is_null());
    assert!(std::fs::read_to_string(path)
        .unwrap()
        .starts_with("// AGENT_RELAY_PI_EXTENSION="));
}

#[test]
fn a_pi_extension_write_failure_is_reported_but_opt_out_is_quiet() {
    let temp = tempfile::tempdir().unwrap();
    let agent = temp.path().join(".pi/agent");
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(agent.join("extensions"), "a file blocks the directory").unwrap();
    assert!(
        snapshot(config(temp.path(), true))["agents"]["integration_error"]
            .as_str()
            .is_some(),
        "Pi extension write failure must not disappear"
    );
    assert!(snapshot(config(temp.path(), false))["agents"]["integration_error"].is_null());
}
