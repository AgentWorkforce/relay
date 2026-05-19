/// The broker version reported in health/session/telemetry payloads and
/// by `agent-relay-broker --version`.
///
/// Released binaries are compiled with `AGENT_RELAY_VERSION` set to the
/// shipped `agent-relay` / `@agent-relay/sdk` product version so that
/// `broker_version` in telemetry, `/api/config`, and the health/session
/// responses matches the artifact users installed. Local `cargo build`
/// invocations have no such env var; in that case we fall back to the
/// Rust crate's `CARGO_PKG_VERSION`, which is a reasonable developer-build
/// label rather than a release-line identifier.
pub const BROKER_VERSION: &str = match option_env!("AGENT_RELAY_VERSION") {
    // Treat an empty `AGENT_RELAY_VERSION` as unset — CI workflows that
    // forward an unresolved expression (e.g. `${{ needs.build.outputs.new_version }}`
    // before the upstream job ran) can leave the var defined but blank,
    // which would otherwise surface as an empty broker version string.
    Some(v) if !v.is_empty() => v,
    _ => env!("CARGO_PKG_VERSION"),
};

/// Returns the broker version. Prefer this helper over `env!("CARGO_PKG_VERSION")`
/// so all components report the same release-line version.
pub fn broker_version() -> &'static str {
    BROKER_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_version_is_non_empty() {
        // Either AGENT_RELAY_VERSION (release builds) or CARGO_PKG_VERSION
        // (developer builds) must produce a non-empty string.
        assert!(!broker_version().is_empty());
        assert_eq!(broker_version(), BROKER_VERSION);
    }

    #[test]
    fn broker_version_matches_compile_time_env() {
        // When AGENT_RELAY_VERSION is set to a non-empty string at build
        // time, the helper surfaces that exact value; empty or unset
        // falls back to the Cargo crate version.
        match option_env!("AGENT_RELAY_VERSION") {
            Some(v) if !v.is_empty() => assert_eq!(broker_version(), v),
            _ => assert_eq!(broker_version(), env!("CARGO_PKG_VERSION")),
        }
    }
}
