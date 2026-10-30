use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Executable(PathBuf);
impl Executable {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "relay-opencode-version-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::write(&path, "synthetic-test-executable").unwrap();
        Self(path)
    }
}
impl Drop for Executable {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[test]
fn failed_version_probe_retries_after_backoff_and_keeps_recovered_version() {
    let executable = Executable::new();
    let asked = AtomicUsize::new(0);
    let probe =
        |_: &Path| (asked.fetch_add(1, Ordering::SeqCst) > 0).then(|| "1.18.35".to_string());
    let cache = VersionCache::default();
    let now = Instant::now();
    assert_eq!(cache.get_at(&executable.0, &probe, now), None);
    assert_eq!(
        cache.get_at(
            &executable.0,
            &probe,
            now + VERSION_RETRY - Duration::from_nanos(1)
        ),
        None
    );
    assert_eq!(asked.load(Ordering::SeqCst), 1);
    assert_eq!(
        cache
            .get_at(&executable.0, &probe, now + VERSION_RETRY)
            .as_deref(),
        Some("1.18.35")
    );
    assert_eq!(
        cache
            .get_at(&executable.0, &probe, now + Duration::from_secs(3600))
            .as_deref(),
        Some("1.18.35")
    );
    assert_eq!(asked.load(Ordering::SeqCst), 2);
}

#[test]
fn malformed_output_retries_but_known_unsupported_version_does_not() {
    let executable = Executable::new();
    let now = Instant::now();
    let asked = AtomicUsize::new(0);
    let probe = |_: &Path| {
        Some(
            if asked.fetch_add(1, Ordering::SeqCst) == 0 {
                "temporary error"
            } else {
                "2.0.0"
            }
            .to_string(),
        )
    };
    let cache = VersionCache::default();
    assert_eq!(
        cache.get_at(&executable.0, &probe, now).as_deref(),
        Some("temporary error")
    );
    assert_eq!(
        cache
            .get_at(&executable.0, &probe, now + VERSION_RETRY)
            .as_deref(),
        Some("2.0.0")
    );
    assert_eq!(
        cache
            .get_at(&executable.0, &probe, now + Duration::from_secs(3600))
            .as_deref(),
        Some("2.0.0")
    );
    assert_eq!(asked.load(Ordering::SeqCst), 2);
}

#[test]
fn changed_executable_is_reprobed_before_failure_backoff_expires() {
    let executable = Executable::new();
    let now = Instant::now();
    let asked = AtomicUsize::new(0);
    let probe = |_: &Path| {
        asked.fetch_add(1, Ordering::SeqCst);
        None
    };
    let cache = VersionCache::default();
    cache.get_at(&executable.0, &probe, now);
    std::fs::write(&executable.0, "replacement").unwrap();
    cache.get_at(&executable.0, &probe, now + Duration::from_secs(1));
    assert_eq!(asked.load(Ordering::SeqCst), 2);
}

// `opencode --version` creates OpenCode's XDG folders; detection points them
// at a throwaway folder, so it leaves none behind in the person's home.
#[cfg(unix)]
#[test]
fn the_version_probe_keeps_opencodes_folders_out_of_the_home() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let seen = dir.path().join("seen");
    let script = dir.path().join("opencode");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nmkdir -p \"$XDG_CONFIG_HOME/opencode\" \"$XDG_DATA_HOME/opencode\" \
             \"$XDG_CACHE_HOME/opencode\" \"$XDG_STATE_HOME/opencode\" || exit 1\n\
             echo \"$XDG_CONFIG_HOME\" > '{}'\necho 1.14.22\n",
            seen.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(system_version(&script).as_deref(), Some("1.14.22"));
    let config = PathBuf::from(std::fs::read_to_string(&seen).unwrap().trim());
    assert!(
        config.file_name().is_some_and(|name| name == "config")
            && config
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name
                    .to_string_lossy()
                    .starts_with("agent-relay-opencode-version-")),
        "{}",
        config.display()
    );
    assert!(!config.exists(), "the scratch folder is removed afterwards");
}
