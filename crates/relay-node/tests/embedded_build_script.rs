//! Release identity changes must not become inputs to the embedded library.
use std::{path::Path, process::Command};

fn run(script: &Path, directory: &Path, site: &str, version: &str) -> std::process::Output {
    Command::new(script)
        .current_dir(directory)
        .env("CARGO_CFG_TARGET_OS", "windows")
        .env("AGENT_RELAY_PROBE_VERSION", version)
        .env("AGENT_RELAY_PROBE_GIT_DIR", directory.join("missing-git"))
        .env(
            "AGENT_RELAY_PROBE_CHANGELOG",
            directory.join("missing-changelog"),
        )
        .env(
            "AGENT_RELAY_WINDOWS_ICON",
            directory.join("missing-icon.ico"),
        )
        .env("AGENT_RELAY_SITE_URL", site)
        .env("AGENT_RELAY_URL_SCHEME", "relay-test")
        .output()
        .unwrap()
}

#[test]
fn embedded_build_watches_profile_but_not_release_identity() {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory
        .path()
        .join(format!("build-script{}", std::env::consts::EXE_SUFFIX));
    let compiled = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
        .arg("--edition=2021")
        .args(["--cfg", "feature=\"embedded-build-info\""])
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs"))
        .arg("-o")
        .arg(&executable)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let first = run(
        &executable,
        directory.path(),
        "https://example.com",
        "2026.11.4",
    );
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let second = run(
        &executable,
        directory.path(),
        "https://example.com",
        "2026.11.5-beta.1",
    );
    assert!(second.status.success());
    assert_eq!(first.stdout, second.stdout);
    let output = String::from_utf8(first.stdout).unwrap();
    assert!(output.contains("cargo:rustc-env=AGENT_RELAY_SITE_URL=https://example.com"));
    assert!(output.contains("cargo:rustc-env=AGENT_RELAY_URL_SCHEME=relay-test"));
    for forbidden in [
        "AGENT_RELAY_PROBE_",
        "AGENT_RELAY_WINDOWS_ICON",
        "RELAY_DESKTOP_VERSION",
        "RELAY_DESKTOP_REVISION",
        "missing-",
    ] {
        assert!(
            !output.contains(forbidden),
            "Unexpected identity input: {output}"
        );
    }
    let invalid_site = run(
        &executable,
        directory.path(),
        "https://example.com/not-an-origin",
        "2026.11.4",
    );
    assert!(
        !invalid_site.status.success(),
        "Embedded mode must retain site validation"
    );
}
