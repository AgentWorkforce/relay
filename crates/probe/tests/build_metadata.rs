#[path = "../build_version.rs"]
mod build_version;

use agent_relay_probe::{BUILD_REVISION, HISTORY_VERSION, VERSION};

#[test]
fn build_identity_is_a_stamped_release_or_git_development_build() {
    if let Some(release) = option_env!("AGENT_RELAY_PROBE_VERSION").filter(|s| !s.is_empty()) {
        assert_eq!(VERSION, release);
    } else {
        assert_ne!(
            VERSION,
            env!("CARGO_PKG_VERSION"),
            "Do not expose the internal Cargo package version"
        );
        let base = option_env!("AGENT_RELAY_PROBE_BASE_VERSION")
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(env!("CARGO_PKG_VERSION"));
        assert_eq!(
            VERSION,
            build_version::development_version(base, BUILD_REVISION)
        );
    }
}

#[test]
fn history_version_matches_the_resolved_dependency() {
    let lock = include_str!("../Cargo.lock");
    assert!(lock.contains(&format!(
        "name = \"ai-hist\"\nversion = \"{HISTORY_VERSION}\""
    )));
}

#[test]
fn development_identity_discards_release_suffixes() {
    for release in [
        "2026.10.5",
        "2026.10.5-rc.1",
        "2026.10.5+build.42",
        "2026.10.5-rc.1+build.42",
    ] {
        assert_eq!(
            build_version::development_version(release, "abc123"),
            "2026.10.5-dev+abc123",
            "release heading: {release}"
        );
    }
}
