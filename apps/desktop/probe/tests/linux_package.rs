//! `scripts/build-linux.sh` builds the tree `linux_app::install` describes,
//! and the app's updater installs that tarball: the app finds its core, the
//! systemd unit runs the tree's core, and the launcher entry runs the tree's
//! app. Stand-in scripts take the place of the built binaries.
//!
//! Linux packaging only: Windows builds its zip with `scripts/build-windows.sh`.
#![cfg(unix)]

use agent_relay_probe::linux_app::install::{self, APP, ICON, LAUNCHER_ENTRY, PROBE, UNIT};
use agent_relay_probe::linux_app::updates::{self, CommandOutput, FetchError, Host, Release};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const VERSION: &str = "2026.10.9";

fn stand_in(path: &Path) {
    fs::write(path, "#!/bin/sh\n").unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn is_executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

/// Runs the packaging script from outside the repository; returns `--out`.
fn package(directory: &Path) -> PathBuf {
    let (app, probe) = (directory.join("app"), directory.join("probe"));
    stand_in(&app);
    stand_in(&probe);
    let out = directory.join("out");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/build-linux.sh");
    let built = Command::new("bash")
        .arg(script)
        .args(["--version", VERSION, "--arch", "x64", "--app"])
        .arg(&app)
        .arg("--probe")
        .arg(&probe)
        .arg("--out")
        .arg(&out)
        .current_dir(directory)
        .output()
        .unwrap();
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    out
}

fn no_env(_: &str) -> Option<OsString> {
    None
}

#[test]
fn the_package_is_the_tree_the_app_expects() {
    let directory = tempfile::tempdir().unwrap();
    let out = package(directory.path());
    let tree = out.join("AgentRelay-linux-x64");

    for path in [APP, PROBE, LAUNCHER_ENTRY, ICON, UNIT] {
        assert!(tree.join(path).is_file(), "{path} is packaged");
    }
    for path in [APP, PROBE] {
        assert!(is_executable(&tree.join(path)), "{path} is executable");
    }
    assert!(
        !tree.join("usr/bin/agent-relay").exists(),
        "the desktop package must leave the CLI name available"
    );
    let app = tree.join(APP).canonicalize().unwrap();
    assert_eq!(
        install::bundled_probe(&app, &no_env),
        Some(tree.canonicalize().unwrap().join(PROBE))
    );

    let unit = fs::read_to_string(tree.join(UNIT)).unwrap();
    assert!(
        unit.lines()
            .any(|line| line == format!("ExecStart=/{PROBE} relay serve --headless")),
        "{unit}"
    );
    let entry = fs::read_to_string(tree.join(LAUNCHER_ENTRY)).unwrap();
    let desktop_name = Path::new(APP).file_name().unwrap().to_str().unwrap();
    assert!(
        entry
            .lines()
            .any(|line| line == format!("Exec={desktop_name} %u")),
        "{entry}"
    );
    let icon = Path::new(ICON).file_stem().unwrap().to_str().unwrap();
    assert!(
        entry.lines().any(|line| line == format!("Icon={icon}")),
        "{entry}"
    );

    // Where `dpkg-deb` runs (Linux CI), the package holds the same tree and
    // depends on GTK 4, not Python.
    if Command::new("dpkg-deb").arg("--version").output().is_ok() {
        let deb = out.join(format!("AgentRelay-{VERSION}-Linux-x64.deb"));
        let field = |name: &str| {
            let output = Command::new("dpkg-deb")
                .arg("-f")
                .arg(&deb)
                .arg(name)
                .output()
                .unwrap();
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        assert_eq!(field("Version"), VERSION);
        assert_eq!(
            field("Depends"),
            "libc6 (>= 2.34), libgtk-4-1 (>= 4.6), librsvg2-common"
        );
        let listing = Command::new("dpkg-deb")
            .arg("-c")
            .arg(&deb)
            .output()
            .unwrap();
        let listing = String::from_utf8(listing.stdout).unwrap();
        for path in [APP, PROBE, LAUNCHER_ENTRY, ICON, UNIT] {
            assert!(listing.contains(&format!("./{path}")), "{path}:\n{listing}");
        }
        assert!(!listing.contains("./usr/bin/agent-relay\n"), "{listing}");
        // Running user managers reload the unit, whose core may have moved.
        let postinst = Command::new("dpkg-deb")
            .arg("-I")
            .arg(&deb)
            .arg("postinst")
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&postinst.stdout).contains("daemon-reload"));
    }
}

#[test]
fn the_updater_installs_the_packaged_tarball() {
    let directory = tempfile::tempdir().unwrap();
    let out = package(directory.path());
    let tarball = fs::read(out.join(format!("AgentRelay-{VERSION}-Linux-x64.tar.gz"))).unwrap();
    let published =
        fs::read(out.join(format!("AgentRelay-{VERSION}-Linux-x64.tar.gz.sha256"))).unwrap();
    assert_eq!(
        updates::checksum(&String::from_utf8_lossy(&published)),
        Some(
            Sha256::digest(&tarball)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        )
    );

    let home = directory.path().join("home");
    let fetch = |url: &str| -> Result<Vec<u8>, FetchError> {
        Ok(if url.ends_with(".sha256") {
            published.clone()
        } else {
            tarball.clone()
        })
    };
    let run = |_: &[&str], _: Duration| {
        Ok(CommandOutput {
            code: Some(0),
            ..CommandOutput::default()
        })
    };
    let host = Host {
        home: home.clone(),
        env: &no_env,
        fetch: &fetch,
        run: &run,
    };
    let release = Release {
        version: VERSION.into(),
        tarball_url: "https://example.invalid/AgentRelay.tar.gz".into(),
        tarball_checksum_url: "https://example.invalid/AgentRelay.tar.gz.sha256".into(),
        deb_url: None,
        deb_checksum_url: None,
        page_url: "https://example.invalid/release".into(),
    };
    let root = home.join(".local/lib/agent-relay");
    let unit = updates::default_unit_path(&home);
    let installed = updates::install_tarball(&release, &root, &unit, &host).unwrap();

    let tree = root.join(VERSION).join("AgentRelay-linux-x64");
    assert_eq!(installed, tree.join(APP));
    assert_eq!(
        install::bundled_probe(&installed, &no_env),
        Some(tree.join(PROBE))
    );
    let unit = fs::read_to_string(unit).unwrap();
    assert!(
        unit.lines().any(|line| line
            == format!(
                "ExecStart={} relay serve --headless",
                tree.join(PROBE).display()
            )),
        "{unit}"
    );
    let entry =
        fs::read_to_string(home.join(".local/share/applications/agent-relay.desktop")).unwrap();
    assert!(
        entry
            .lines()
            .any(|line| line == format!("Exec={} %u", tree.join(APP).display())),
        "{entry}"
    );
}
