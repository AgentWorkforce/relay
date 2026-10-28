mod build_version;

use std::{env, fs, path::PathBuf, process::Command};

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn main() {
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_PROBE_VERSION");
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_PROBE_BASE_VERSION");
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_POSTHOG_API_KEY");
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_POSTHOG_HOST");
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=build_version.rs");
    // Resolve through git so linked worktrees also track their own HEAD.
    for name in ["HEAD", "index"] {
        if let Some(path) = git(&["rev-parse", "--git-path", name]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git(&["rev-parse", "--git-path", &reference]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    let revision = git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".into());
    // A release passes its full version in AGENT_RELAY_PROBE_VERSION (relay
    // releases pass the relay version; relay-desktop passes its CalVer). A
    // development build is `<base>-dev+<revision>`: the base is
    // AGENT_RELAY_PROBE_BASE_VERSION when the builder orders its own builds
    // (relay-desktop passes its newest CalVer release), else the crate
    // version. The Git revision is build metadata only: hashes have no
    // chronological ordering.
    let base = env::var("AGENT_RELAY_PROBE_BASE_VERSION")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap());
    let version = env::var("AGENT_RELAY_PROBE_VERSION")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| build_version::development_version(&base, &revision));
    println!("cargo:rustc-env=RELAY_DESKTOP_VERSION={version}");
    println!("cargo:rustc-env=RELAY_DESKTOP_REVISION={revision}");
    windows_resources(&version);

    // Cargo.lock is the resolved dependency, not the manifest's version range.
    let lock = fs::read_to_string(
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("Cargo.lock"),
    )
    .unwrap();
    let history = lock
        .split("[[package]]")
        .find_map(|package| {
            let mut name = None;
            let mut version = None;
            for line in package.lines() {
                if let Some(value) = line.strip_prefix("name = \"") {
                    name = value.strip_suffix('"');
                }
                if let Some(value) = line.strip_prefix("version = \"") {
                    version = value.strip_suffix('"');
                }
            }
            (name == Some("ai-hist")).then_some(version).flatten()
        })
        .expect("Cargo.lock must include the resolved ai-hist version");
    println!("cargo:rustc-env=RELAY_HISTORY_VERSION={history}");
}

/// On Windows, embeds the Agent Relay icon and the release version in the
/// executables when `AGENT_RELAY_WINDOWS_ICON` names an `.ico`, as
/// `scripts/build-windows.sh` does: Explorer, the Start menu shortcut and the
/// taskbar show the icon, and Properties › Details the version. Without it the
/// executables build as before, with no resources.
fn windows_resources(version: &str) {
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_WINDOWS_ICON");
    println!("cargo:rerun-if-env-changed=WINDRES");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let Some(icon) = env::var_os("AGENT_RELAY_WINDOWS_ICON").filter(|icon| !icon.is_empty()) else {
        return;
    };
    let icon = PathBuf::from(icon);
    assert!(
        icon.is_file(),
        "AGENT_RELAY_WINDOWS_ICON is not a file: {}",
        icon.display()
    );
    println!("cargo:rerun-if-changed={}", icon.display());

    // FILEVERSION takes four 16-bit numbers: 2026.10.9-rc.1 is 2026,10,9,0.
    let mut numbers: Vec<u16> = version
        .split(['.', '-', '+'])
        .take(3)
        .map(|part| part.parse().unwrap_or(0))
        .collect();
    numbers.resize(4, 0);
    let numeric = numbers
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let quoted = |text: &str| text.replace('\\', "/").replace('"', "\"\"");
    let script = format!(
        "1 ICON \"{icon}\"\n\
         1 VERSIONINFO\n\
         FILEVERSION {numeric}\n\
         PRODUCTVERSION {numeric}\n\
         BEGIN\n\
         \x20 BLOCK \"StringFileInfo\"\n\
         \x20 BEGIN\n\
         \x20   BLOCK \"040904B0\"\n\
         \x20   BEGIN\n\
         \x20     VALUE \"FileDescription\", \"Agent Relay\"\n\
         \x20     VALUE \"ProductName\", \"Agent Relay\"\n\
         \x20     VALUE \"FileVersion\", \"{version}\"\n\
         \x20     VALUE \"ProductVersion\", \"{version}\"\n\
         \x20   END\n\
         \x20 END\n\
         \x20 BLOCK \"VarFileInfo\"\n\
         \x20 BEGIN\n\
         \x20   VALUE \"Translation\", 0x409, 1200\n\
         \x20 END\n\
         END\n",
        icon = quoted(&icon.display().to_string()),
        version = quoted(version),
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let rc = out.join("agent-relay.rc");
    let object = out.join("agent-relay-resources.o");
    fs::write(&rc, script).unwrap();
    // MSYS2's clang toolchain ships windres (llvm-windres); the script needs
    // no C preprocessor.
    let windres = env::var("WINDRES").unwrap_or_else(|_| "windres".into());
    let status = Command::new(&windres)
        .args(["--no-preprocess", "-O", "coff", "-i"])
        .arg(&rc)
        .arg("-o")
        .arg(&object)
        .status()
        .unwrap_or_else(|error| panic!("could not run {windres}: {error}"));
    assert!(
        status.success(),
        "{windres} could not compile {}",
        rc.display()
    );
    println!("cargo:rustc-link-arg-bins={}", object.display());
}
