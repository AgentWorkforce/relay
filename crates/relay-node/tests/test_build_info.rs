#![cfg(feature = "test-build-info")]

use agent_relay_node::{build_revision, install_build_info, version, BuildInfo};
use std::process::Command;

const EXECUTABLE: BuildInfo = BuildInfo {
    version: "2026.11.4-beta.2",
    revision: "abcdef012345",
};

#[test]
fn explicit_fixture_scenarios() {
    for scenario in ["parallel", "immutable", "explicit-first"] {
        // A fresh process isolates the process-lifetime OnceLock. Conflicting
        // runtime environment values prove the fixture never consults them.
        let result = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "fixture_identity_child", "--nocapture"])
            .env("RELAY_TEST_BUILD_INFO_SCENARIO", scenario)
            .env("AGENT_RELAY_PROBE_VERSION", "9999.99.99")
            .env("RELAY_DESKTOP_REVISION", "runtime-value-must-not-be-read")
            .output()
            .unwrap();
        assert!(
            result.status.success() && String::from_utf8_lossy(&result.stdout).contains("1 passed"),
            "{scenario}: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn fixture_identity_child() {
    let Ok(scenario) = std::env::var("RELAY_TEST_BUILD_INFO_SCENARIO") else {
        return;
    };
    match scenario.as_str() {
        "parallel" => {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
            let readers: Vec<_> = (0..8)
                .map(|_| {
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        (version(), build_revision())
                    })
                })
                .collect();
            for reader in readers {
                assert_eq!(reader.join().unwrap(), ("0.0.0-dev+test", "test-fixture"));
            }
        }
        "immutable" => {
            assert_eq!(version(), "0.0.0-dev+test");
            assert_eq!(install_build_info(EXECUTABLE), Err(EXECUTABLE));
            assert_eq!(version(), "0.0.0-dev+test");
            assert_eq!(build_revision(), "test-fixture");
        }
        "explicit-first" => {
            install_build_info(EXECUTABLE).unwrap();
            assert_eq!(version(), EXECUTABLE.version);
            assert_eq!(build_revision(), EXECUTABLE.revision);
            assert_eq!(install_build_info(EXECUTABLE), Err(EXECUTABLE));
        }
        _ => panic!("unexpected scenario"),
    }
}
