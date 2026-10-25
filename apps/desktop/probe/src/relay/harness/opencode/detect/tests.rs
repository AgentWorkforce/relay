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
