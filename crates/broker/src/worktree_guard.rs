//! Guards for files the broker writes into an agent's project working tree.
//!
//! Harness configuration that must live in the project (`.cursor/mcp.json`,
//! `opencode.json`, Gemini's `.gemini/settings.json`) references Relay
//! credentials by environment-variable name only; the broker sets the values
//! on the agent process environment. This module is the last line of defence
//! behind that rule:
//!
//! - [`write_project_file`] refuses to write content that carries a
//!   credential-shaped value (`rk_live_…`, `at_live_…`, `nt_live_…`, and the
//!   `_test_` variants), so a regression cannot silently put a live key in a
//!   file a later "commit everything" step sweeps up.
//! - [`ensure_git_ignored`] keeps broker-written project files out of
//!   `git status` by adding them to the repository's `.git/info/exclude`
//!   (never the project's own `.gitignore`).
//! - [`agent_session_root`] resolves a private per-user directory outside the
//!   working tree for configuration that must carry values (Muse settings).

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

/// Prefixes of Relay credentials: workspace keys (`rk_`), agent tokens
/// (`at_`) and node tokens (`nt_`), live and test.
pub const CREDENTIAL_PREFIXES: [&str; 6] = [
    "rk_live_", "rk_test_", "at_live_", "at_test_", "nt_live_", "nt_test_",
];

fn is_token_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
}

/// Return the prefix of the first credential-shaped value in `content`, if
/// any. A match needs a token boundary before the prefix (so `work_live_x`
/// is not a hit) and at least one token character after it. Only the prefix
/// is returned so callers can report the hit without echoing the secret.
pub fn find_credential_prefix(content: &str) -> Option<&'static str> {
    let bytes = content.as_bytes();
    CREDENTIAL_PREFIXES.into_iter().find(|prefix| {
        content.match_indices(prefix).any(|(start, _)| {
            let boundary_before = start == 0 || !is_token_char(bytes[start - 1]);
            let end = start + prefix.len();
            let has_body = bytes
                .get(end)
                .is_some_and(|byte| byte.is_ascii_alphanumeric());
            boundary_before && has_body
        })
    })
}

/// What [`ensure_git_ignored`] found or did for a project path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitIgnoreOutcome {
    /// The path is not inside a git working tree (or git is unavailable).
    NotInRepo,
    /// Already ignored by the project's own rules.
    AlreadyIgnored,
    /// Added to the repository's `info/exclude`.
    Excluded,
    /// Tracked by git; ignore rules cannot hide changes to it.
    Tracked,
}

fn git(dir: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // A broker launched from a git hook inherits these; they would point the
    // probe at another repository than the one containing `path`.
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
    ] {
        command.env_remove(key);
    }
    command
}

fn git_stdout(dir: &Path, args: &[&str]) -> Option<String> {
    let output = git(dir).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_succeeds(dir: &Path, args: &[&str]) -> bool {
    git(dir)
        .args(args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Escape a repo-relative path into an anchored gitignore pattern.
fn exclude_pattern(repo_relative: &str) -> String {
    let mut pattern = String::from("/");
    for ch in repo_relative.chars() {
        if matches!(ch, '\\' | '*' | '?' | '[' | ']' | '!' | '#') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern
}

/// Make sure a broker-written project file never shows up as an untracked
/// file: when `path` sits inside a git working tree and is neither ignored
/// nor tracked, append it to the repository's `info/exclude`. The project's
/// `.gitignore` is never modified. Failures are logged and reported as
/// `NotInRepo`; they never block a spawn.
pub fn ensure_git_ignored(path: &Path) -> GitIgnoreOutcome {
    let (Some(dir), Some(file_name)) = (path.parent(), path.file_name()) else {
        return GitIgnoreOutcome::NotInRepo;
    };
    let Some(file_name) = file_name.to_str() else {
        return GitIgnoreOutcome::NotInRepo;
    };
    if !dir.is_dir() {
        return GitIgnoreOutcome::NotInRepo;
    }
    if git_stdout(dir, &["rev-parse", "--is-inside-work-tree"]).as_deref() != Some("true") {
        return GitIgnoreOutcome::NotInRepo;
    }
    if git_succeeds(dir, &["ls-files", "--error-unmatch", "--", file_name]) {
        tracing::warn!(
            path = %path.display(),
            "broker-written agent config is tracked by git; it carries no credentials, but changes to it will show in git status"
        );
        return GitIgnoreOutcome::Tracked;
    }
    if git_succeeds(dir, &["check-ignore", "-q", "--", file_name]) {
        return GitIgnoreOutcome::AlreadyIgnored;
    }
    let (Some(prefix), Some(exclude)) = (
        git_stdout(dir, &["rev-parse", "--show-prefix"]),
        git_stdout(dir, &["rev-parse", "--git-path", "info/exclude"]),
    ) else {
        return GitIgnoreOutcome::NotInRepo;
    };
    let exclude = {
        let exclude = PathBuf::from(exclude);
        if exclude.is_absolute() {
            exclude
        } else {
            dir.join(exclude)
        }
    };
    let pattern = exclude_pattern(&format!("{prefix}{file_name}"));
    let result = (|| -> io::Result<()> {
        if let Some(parent) = exclude.parent() {
            fs::create_dir_all(parent)?;
        }
        let existing = fs::read_to_string(&exclude).unwrap_or_default();
        if existing.lines().any(|line| line.trim() == pattern) {
            return Ok(());
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&exclude)?;
        let separator = if existing.is_empty() || existing.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        writeln!(file, "{separator}{pattern}")
    })();
    match result {
        Ok(()) => {
            tracing::info!(
                path = %path.display(),
                exclude = %exclude.display(),
                "added broker-written agent config to git info/exclude"
            );
            GitIgnoreOutcome::Excluded
        }
        Err(error) => {
            tracing::warn!(
                path = %path.display(),
                error = %error,
                "could not add broker-written agent config to git info/exclude"
            );
            GitIgnoreOutcome::NotInRepo
        }
    }
}

/// Refuse when `contents` carries a credential-shaped value. The error names
/// the path and the matched prefix, never the value.
pub fn refuse_credentials(path: &Path, contents: &str) -> io::Result<()> {
    match find_credential_prefix(contents) {
        Some(prefix) => {
            tracing::error!(
                path = %path.display(),
                prefix,
                "refusing to write a credential into a project file"
            );
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "refusing to write {}: content contains a credential-shaped value ({prefix}…). \
                     Relay credentials must never be written into a project working tree; \
                     remove the value (or reference it as an environment variable) and retry",
                    path.display()
                ),
            ))
        }
        None => Ok(()),
    }
}

/// Write a broker-generated file inside a project working tree: refuse
/// credential-shaped content, keep the path out of `git status`, then write.
pub fn write_project_file(path: &Path, contents: &str) -> io::Result<()> {
    refuse_credentials(path, contents)?;
    ensure_git_ignored(path);
    fs::write(path, contents)
}

/// Environment override for [`agent_session_root`].
pub const AGENT_RELAY_HOME_ENV: &str = "AGENT_RELAY_HOME";

/// Private per-user directory for per-agent harness state that must carry
/// credential values: `$AGENT_RELAY_HOME/sessions`, else
/// `~/.agentworkforce/relay/sessions`, else the system temp dir. A candidate
/// inside `working_tree` is skipped so the state can never land in the
/// project. Pure path resolution: writers create it and restrict it to `0700`
/// with [`restrict_dir`].
pub fn agent_session_root(working_tree: &Path) -> PathBuf {
    let working_tree = absolute(working_tree);
    let candidates = [
        std::env::var_os(AGENT_RELAY_HOME_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .map(|path| path.join("sessions")),
        dirs::home_dir().map(|home| home.join(".agentworkforce/relay/sessions")),
        Some(std::env::temp_dir().join(format!("agent-relay-sessions-{}", user_tag()))),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|candidate| !absolute(candidate).starts_with(&working_tree))
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("agent-relay-sessions-{}", user_tag()))
        })
}

fn absolute(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn user_tag() -> String {
    #[cfg(unix)]
    {
        // SAFETY: getuid(2) has no preconditions and cannot fail.
        unsafe { nix::libc::getuid() }.to_string()
    }
    #[cfg(not(unix))]
    {
        std::env::var("USERNAME").unwrap_or_else(|_| "user".to_string())
    }
}

/// Best-effort `0700` on a credential-holding directory (Unix only).
pub fn restrict_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(dir: &Path) {
        let status = Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .status()
            .expect("git init");
        assert!(status.success());
    }

    #[test]
    fn detects_credential_prefixes_with_token_boundaries() {
        for value in [
            "rk_live_abc",
            "{\"k\":\"rk_test_123\"}",
            "RELAY_AGENT_TOKEN=at_live_x9",
            "at_test_1",
            "nt_live_Z",
            "nt_test_0",
            "[{\"api_key\":\"rk_live_ws1\"}]",
        ] {
            assert!(find_credential_prefix(value).is_some(), "{value}");
        }
        for value in [
            "rk_live_",
            "${env:RELAY_API_KEY}",
            "{env:RELAY_AGENT_TOKEN}",
            "work_live_abc",
            "mark_test_case",
            "network_live_x",
            "",
        ] {
            assert!(find_credential_prefix(value).is_none(), "{value}");
        }
    }

    #[test]
    fn write_project_file_refuses_credential_shaped_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        let error =
            write_project_file(&path, "{\"RELAY_API_KEY\":\"rk_live_secretvalue\"}").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let message = error.to_string();
        assert!(message.contains("credential-shaped"), "{message}");
        assert!(
            !message.contains("secretvalue"),
            "refusal must not echo the secret: {message}"
        );
        assert!(!path.exists(), "refused content must not be written");
    }

    #[test]
    fn write_project_file_excludes_untracked_file_via_info_exclude() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        fs::create_dir(dir.path().join(".cursor")).unwrap();
        let path = dir.path().join(".cursor/mcp.json");
        write_project_file(
            &path,
            "{\"env\":{\"RELAY_API_KEY\":\"${env:RELAY_API_KEY}\"}}",
        )
        .unwrap();
        assert_eq!(ensure_git_ignored(&path), GitIgnoreOutcome::AlreadyIgnored);
        let exclude = fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert_eq!(
            exclude
                .lines()
                .filter(|l| *l == "/.cursor/mcp.json")
                .count(),
            1,
            "{exclude}"
        );
        assert!(
            !dir.path().join(".gitignore").exists(),
            "the project's .gitignore must not be touched"
        );
        let status = Command::new("git")
            .args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&status.stdout).trim().is_empty(),
            "{}",
            String::from_utf8_lossy(&status.stdout)
        );
    }

    #[test]
    fn ensure_git_ignored_outside_repo_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            ensure_git_ignored(&dir.path().join("opencode.json")),
            GitIgnoreOutcome::NotInRepo
        );
    }

    #[test]
    fn agent_session_root_is_never_inside_the_working_tree() {
        let tree = tempfile::tempdir().unwrap();
        let root = agent_session_root(tree.path());
        assert!(root.is_absolute(), "{root:?}");
        assert!(
            !absolute(&root).starts_with(absolute(tree.path())),
            "{root:?} inside {:?}",
            tree.path()
        );
    }
}
