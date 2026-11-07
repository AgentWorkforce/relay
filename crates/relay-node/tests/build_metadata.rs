#[path = "../build_version.rs"]
mod build_version;

use agent_relay_node::{BUILD_REVISION, VERSION};

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
        // As build.rs: the base version, else a builder's changelog's newest
        // release, else the crate version.
        // Read only without a base override, as build.rs does.
        let overridden = option_env!("AGENT_RELAY_PROBE_BASE_VERSION")
            .is_some_and(|base| !base.trim().is_empty());
        let changelog = option_env!("AGENT_RELAY_PROBE_CHANGELOG")
            .filter(|path| !path.is_empty() && !overridden)
            .map(|path| std::fs::read_to_string(path).unwrap());
        let from_changelog = changelog.as_deref().and_then(|text| {
            text.lines()
                .filter_map(|line| line.strip_prefix("## v"))
                .map(str::trim)
                .find(|heading| !heading.is_empty())
        });
        let base = option_env!("AGENT_RELAY_PROBE_BASE_VERSION")
            .filter(|s| !s.trim().is_empty())
            .or(from_changelog)
            .unwrap_or(env!("CARGO_PKG_VERSION"));
        assert_eq!(
            VERSION,
            build_version::development_version(base, BUILD_REVISION)
        );
    }
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
