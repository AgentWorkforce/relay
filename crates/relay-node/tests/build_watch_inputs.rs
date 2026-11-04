//! Exercise the actual build script without compiling the relay dependency graph.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("relay-build-watch-{}-{nonce}", std::process::id()));
        fs::create_dir(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn successful(command: &mut Command) -> String {
    let output: Output = command.output().expect("run build fixture command");
    assert!(
        output.status.success(),
        "{command:?} failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8(output.stdout).unwrap()
}

fn git(repo: &Path, args: &[&str]) -> String {
    successful(
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args([
                "-c",
                "user.name=Build test",
                "-c",
                "user.email=build-test@example.invalid",
            ])
            .args(["-c", "commit.gpgsign=false"])
            .arg("-c")
            .arg(format!(
                "core.hooksPath={}",
                repo.join(".git/no-hooks").display()
            ))
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .args(args),
    )
    .trim()
    .to_owned()
}

fn build_script(executable: &Path, runner: &Path, repo: &Path, release: Option<&str>) -> String {
    let mut command = Command::new(executable);
    command
        .current_dir(runner)
        .env_remove("AGENT_RELAY_PROBE_VERSION")
        .env_remove("AGENT_RELAY_PROBE_BASE_VERSION")
        .env_remove("AGENT_RELAY_SITE_URL")
        .env_remove("AGENT_RELAY_URL_SCHEME")
        .env_remove("AGENT_RELAY_WINDOWS_ICON")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env("CARGO_PKG_VERSION", "0.1.0")
        .env("CARGO_CFG_TARGET_OS", std::env::consts::OS)
        .env("AGENT_RELAY_PROBE_GIT_DIR", repo)
        .env("AGENT_RELAY_PROBE_CHANGELOG", repo.join("CHANGELOG.md"));
    if let Some(version) = release {
        // A release override must not read or watch the development changelog.
        command.env("AGENT_RELAY_PROBE_VERSION", version).env(
            "AGENT_RELAY_PROBE_CHANGELOG",
            repo.join("missing-changelog.md"),
        );
    }
    successful(&mut command)
}

fn stamped<'a>(output: &'a str, name: &str) -> &'a str {
    let prefix = format!("cargo:rustc-env={name}=");
    output
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .unwrap()
}

fn assert_git_watches(output: &str, repo: &Path, runner: &Path, attached: bool) {
    let paths: Vec<_> = output
        .lines()
        .filter_map(|line| line.strip_prefix("cargo:rerun-if-changed="))
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                runner.join(path)
            }
        })
        .filter_map(|path| path.canonicalize().ok())
        .collect();
    let git_path = |name: &str| {
        let path = PathBuf::from(git(repo, &["rev-parse", "--git-path", name]));
        let path = if path.is_absolute() {
            path
        } else {
            repo.join(path)
        };
        path.canonicalize().expect("Git fixture metadata exists")
    };
    assert!(
        paths.contains(&git_path("HEAD")),
        "HEAD must still invalidate build identity"
    );
    if attached {
        let reference = git(repo, &["symbolic-ref", "HEAD"]);
        assert!(
            paths.contains(&git_path(&reference)),
            "commits must still invalidate build identity"
        );
    } else {
        assert!(
            !paths.contains(&git_path("refs/heads/main")),
            "a detached build must not watch the previous branch"
        );
    }
    assert!(
        !paths.contains(&git_path("index")),
        "staging does not change embedded identity"
    );
}

#[test]
fn index_changes_preserve_identity_and_commits_update_it() {
    let fixture = Fixture::new();
    let repo = fixture.0.join("builder");
    let runner = fixture.0.join("runner");
    fs::create_dir(&repo).unwrap();
    fs::create_dir(&runner).unwrap();
    git(&repo, &["init", "--quiet"]);
    git(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    fs::write(repo.join("CHANGELOG.md"), "## v2026.11.4\n\n- A release.\n").unwrap();
    git(&repo, &["add", "CHANGELOG.md"]);
    git(&repo, &["commit", "--quiet", "-m", "initial"]);
    let original_revision = git(&repo, &["rev-parse", "--short=12", "HEAD"]);

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let executable = fixture
        .0
        .join(format!("build-script{}", std::env::consts::EXE_SUFFIX));
    successful(
        Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .arg("--edition=2021")
            .arg(manifest.join("build.rs"))
            .arg("-o")
            .arg(&executable),
    );
    let development = build_script(&executable, &runner, &repo, None);
    assert_git_watches(&development, &repo, &runner, true);
    assert_eq!(
        stamped(&development, "RELAY_DESKTOP_VERSION"),
        format!("2026.11.4-dev+{original_revision}")
    );
    assert_eq!(
        stamped(&development, "RELAY_DESKTOP_REVISION"),
        original_revision
    );

    let release_version = "2026.11.5-beta.2";
    let release = build_script(&executable, &runner, &repo, Some(release_version));
    assert_git_watches(&release, &repo, &runner, true);
    assert_eq!(stamped(&release, "RELAY_DESKTOP_VERSION"), release_version);
    assert_eq!(
        stamped(&release, "RELAY_DESKTOP_REVISION"),
        original_revision
    );
    assert!(!release
        .lines()
        .any(|line| line.starts_with("cargo:rerun-if-changed=") && line.contains("changelog")));

    fs::write(repo.join("staged.txt"), "only the index changes\n").unwrap();
    git(&repo, &["add", "staged.txt"]);
    assert_eq!(build_script(&executable, &runner, &repo, None), development);
    assert_eq!(
        build_script(&executable, &runner, &repo, Some(release_version)),
        release
    );

    git(&repo, &["commit", "--quiet", "-m", "next source revision"]);
    let revision = git(&repo, &["rev-parse", "--short=12", "HEAD"]);
    assert_ne!(revision, original_revision);
    let development = build_script(&executable, &runner, &repo, None);
    assert_eq!(
        stamped(&development, "RELAY_DESKTOP_VERSION"),
        format!("2026.11.4-dev+{revision}")
    );
    let release = build_script(&executable, &runner, &repo, Some(release_version));
    assert_eq!(stamped(&release, "RELAY_DESKTOP_VERSION"), release_version);
    assert_eq!(stamped(&release, "RELAY_DESKTOP_REVISION"), revision);
    assert_git_watches(&release, &repo, &runner, true);

    git(&repo, &["checkout", "--quiet", "--detach", "HEAD"]);
    let detached = build_script(&executable, &runner, &repo, Some(release_version));
    assert_git_watches(&detached, &repo, &runner, false);
    assert_eq!(stamped(&detached, "RELAY_DESKTOP_VERSION"), release_version);
    assert_eq!(stamped(&detached, "RELAY_DESKTOP_REVISION"), revision);

    fs::write(repo.join("detached.txt"), "commit without a branch ref\n").unwrap();
    git(&repo, &["add", "detached.txt"]);
    git(
        &repo,
        &["commit", "--quiet", "-m", "detached source revision"],
    );
    let detached_revision = git(&repo, &["rev-parse", "--short=12", "HEAD"]);
    assert_ne!(detached_revision, revision);
    let detached = build_script(&executable, &runner, &repo, Some(release_version));
    assert_git_watches(&detached, &repo, &runner, false);
    assert_eq!(
        stamped(&detached, "RELAY_DESKTOP_REVISION"),
        detached_revision
    );
    let detached_development = build_script(&executable, &runner, &repo, None);
    assert_eq!(
        stamped(&detached_development, "RELAY_DESKTOP_VERSION"),
        format!("2026.11.4-dev+{detached_revision}")
    );
}
