#![cfg(all(feature = "embedded-build-info", not(feature = "test-build-info")))]

use agent_relay_node::{build_revision, install_build_info, version, BuildInfo};
use std::process::Command;

const IDENTITY: BuildInfo = BuildInfo {
    version: "2026.11.4-beta.2",
    revision: "abcdef012345",
};

// Each scenario gets a fresh process: OnceLock cannot be reset, and concurrent
// test execution must never decide which fixture identity a test observes.
#[test]
fn embedded_identity_scenarios() {
    for scenario in ["uninitialized", "installed", "concurrent", "daemon"] {
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "embedded_identity_child", "--nocapture"])
            .env("RELAY_BUILD_INFO_TEST_SCENARIO", scenario)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{scenario}: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn embedded_identity_child() {
    let Ok(scenario) = std::env::var("RELAY_BUILD_INFO_TEST_SCENARIO") else {
        return;
    };
    match scenario.as_str() {
        "uninitialized" => {
            assert!(std::panic::catch_unwind(version).is_err());
            assert!(std::panic::catch_unwind(build_revision).is_err());
        }
        "installed" => {
            install_build_info(IDENTITY).unwrap();
            assert_eq!(version(), IDENTITY.version);
            assert_eq!(build_revision(), IDENTITY.revision);
            assert_eq!(install_build_info(IDENTITY), Err(IDENTITY));
            let replacement = BuildInfo {
                version: "9999.1.1",
                revision: "other",
            };
            assert_eq!(install_build_info(replacement), Err(replacement));
            assert_eq!(version(), IDENTITY.version);
            assert_eq!(build_revision(), IDENTITY.revision);
        }
        "concurrent" => {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
            let threads: Vec<_> = (0..8)
                .map(|index| {
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        let identity = if index % 2 == 0 {
                            IDENTITY
                        } else {
                            BuildInfo {
                                version: "2026.11.4-beta.3",
                                revision: "012345abcdef",
                            }
                        };
                        barrier.wait();
                        let result = install_build_info(identity);
                        (identity, result, (version(), build_revision()))
                    })
                })
                .collect();
            let outcomes: Vec<_> = threads
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect();
            let winners: Vec<_> = outcomes
                .iter()
                .filter(|(_, result, _)| result.is_ok())
                .collect();
            assert_eq!(winners.len(), 1);
            let winner = winners[0].0;
            for (_, _, observed) in outcomes {
                assert_eq!(observed, (winner.version, winner.revision));
            }
            assert_eq!(version(), winner.version);
            assert_eq!(build_revision(), winner.revision);
        }
        "daemon" => daemon_reports_executable_identity(),
        _ => panic!("unexpected scenario"),
    }
}

fn daemon_reports_executable_identity() {
    use agent_relay_node::relay::daemon::{Config, Core};
    use agent_relay_node::relay::paths::CorePaths;
    use std::collections::BTreeMap;
    use std::time::Duration;

    install_build_info(IDENTITY).unwrap();
    let home = tempfile::tempdir().unwrap();
    let config = Config {
        paths: CorePaths::for_socket(home.path().join("run/core.sock")).unwrap(),
        home: home.path().to_path_buf(),
        app_data_dir: home.path().join("app-data"),
        env: BTreeMap::new(),
        version: version().to_owned(),
        host_name: "embedded build fixture".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: Default::default(),
        delivery_timing: Default::default(),
    };
    let (core, _) = Core::new(config);
    let daemon = core.status().daemon;
    assert_eq!(daemon.version, IDENTITY.version);
    assert_eq!(daemon.build_revision.as_deref(), Some(IDENTITY.revision));
}
