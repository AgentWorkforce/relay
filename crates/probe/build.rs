mod build_site;
mod build_version;

use std::{env, fs, path::PathBuf, process::Command};

/// Git in the builder's repository: AGENT_RELAY_PROBE_GIT_DIR when a crate
/// building this one as a dependency names its own checkout (relay-desktop
/// does), else this crate's.
fn git(args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    if let Some(dir) = env::var_os("AGENT_RELAY_PROBE_GIT_DIR").filter(|dir| !dir.is_empty()) {
        command.arg("-C").arg(dir);
    }
    let output = command.args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// A Git file's absolute path, which Cargo needs for its watch: relative
/// answers are relative to the directory git ran in, not this crate. Git
/// before 2.31 has no `--path-format`, so its answer is made absolute here.
fn git_path(name: &str) -> Option<PathBuf> {
    if let Some(path) = git(&["rev-parse", "--path-format=absolute", "--git-path", name]) {
        return Some(PathBuf::from(path));
    }
    let path = PathBuf::from(git(&["rev-parse", "--git-path", name])?);
    if path.is_absolute() {
        return Some(path);
    }
    let base = env::var_os("AGENT_RELAY_PROBE_GIT_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| env::current_dir().ok())?;
    Some(base.join(path))
}

fn main() {
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_PROBE_VERSION");
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_PROBE_BASE_VERSION");
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_PROBE_CHANGELOG");
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_PROBE_GIT_DIR");
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_POSTHOG_API_KEY");
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_POSTHOG_HOST");
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_SITE_URL");
    println!("cargo:rerun-if-env-changed=AGENT_RELAY_URL_SCHEME");
    println!("cargo:rerun-if-changed=build_site.rs");
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=build_version.rs");
    // Resolve through git so linked worktrees also track their own HEAD.
    for name in ["HEAD", "index"] {
        if let Some(path) = git_path(name) {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
    if let Some(reference) = git(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git_path(&reference) {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
    let revision = git(&["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "unknown".into());
    // A release passes its full version in AGENT_RELAY_PROBE_VERSION (relay
    // releases pass the relay version; relay-desktop passes its CalVer). A
    // development build is `<base>-dev+<revision>`: the base is
    // AGENT_RELAY_PROBE_BASE_VERSION, or the newest release in
    // AGENT_RELAY_PROBE_CHANGELOG, when the builder orders its own builds,
    // else the crate version. The Git revision is build metadata only: hashes have no
    // chronological ordering.
    // AGENT_RELAY_PROBE_CHANGELOG names, by absolute path, a changelog whose
    // newest non-empty `## v` heading is that base, read on every build that
    // changes it, so a builder whose own builds are ordered by its releases
    // (relay-desktop's CalVer) need not keep a version in step by hand. A
    // configured changelog that cannot be read, or names no release, fails
    // the build rather than stamping a version that orders below them all.
    // Read only when no override supplies the version: an override must
    // build whatever the changelog holds.
    let overridden = [
        "AGENT_RELAY_PROBE_VERSION",
        "AGENT_RELAY_PROBE_BASE_VERSION",
    ]
    .iter()
    .any(|key| env::var(key).is_ok_and(|value| !value.trim().is_empty()));
    let changelog_base = env::var_os("AGENT_RELAY_PROBE_CHANGELOG")
        .filter(|path| !path.is_empty() && !overridden)
        .map(PathBuf::from)
        .map(|path| {
            println!("cargo:rerun-if-changed={}", path.display());
            let text = fs::read_to_string(&path).unwrap_or_else(|error| {
                panic!("AGENT_RELAY_PROBE_CHANGELOG {}: {error}", path.display())
            });
            text.lines()
                .filter_map(|line| line.strip_prefix("## v"))
                .map(str::trim)
                .find(|heading| !heading.is_empty())
                .unwrap_or_else(|| {
                    panic!(
                        "AGENT_RELAY_PROBE_CHANGELOG {} has no `## v<version>` release heading",
                        path.display()
                    )
                })
                .to_owned()
        });
    let base = env::var("AGENT_RELAY_PROBE_BASE_VERSION")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or(changelog_base)
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap());
    let version = env::var("AGENT_RELAY_PROBE_VERSION")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| build_version::development_version(&base, &revision));
    println!("cargo:rustc-env=RELAY_DESKTOP_VERSION={version}");
    println!("cargo:rustc-env=RELAY_DESKTOP_REVISION={revision}");
    built_in_site();
    windows_resources(&version);

    // Only the `history` feature links RelayHistory, so only it reports a
    // history version. Cargo.lock is the resolved dependency, not the
    // manifest's version range.
    if env::var_os("CARGO_FEATURE_HISTORY").is_none() {
        return;
    }
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

/// The Cloud site and link scheme this build is made for, fixed here and
/// nowhere at run time: `AGENT_RELAY_SITE_URL` (`links::built_in_site_url`,
/// `https://agentrelay.com` when unset) and `AGENT_RELAY_URL_SCHEME`
/// (`links::built_in_url_scheme`, `agentrelay` when unset). Each is checked
/// (`build_site.rs`) so a build for a wrong site or scheme fails here, with
/// the reason, and the checked, normalized value is what `option_env!` reads.
fn built_in_site() {
    let read = |key: &str| {
        env::var(key)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    if let Some(value) = read("AGENT_RELAY_SITE_URL") {
        let origin = build_site::site_origin(&value).unwrap_or_else(|reason| {
            panic!(
                "AGENT_RELAY_SITE_URL `{value}` is not a site this build can talk to: {reason}. \
                 Set it to https://<host>, or to http://localhost[:port] or \
                 http://127.0.0.1[:port] for a site served on this computer, with no \
                 user info, path, query or fragment; or leave it unset for https://agentrelay.com."
            )
        });
        println!("cargo:rustc-env=AGENT_RELAY_SITE_URL={origin}");
    }
    if let Some(value) = read("AGENT_RELAY_URL_SCHEME") {
        let scheme = build_site::url_scheme(&value).unwrap_or_else(|reason| {
            panic!(
                "AGENT_RELAY_URL_SCHEME `{value}` is not a scheme for the app's links: {reason}. \
                 Leave it unset for agentrelay."
            )
        });
        println!("cargo:rustc-env=AGENT_RELAY_URL_SCHEME={scheme}");
    }
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
