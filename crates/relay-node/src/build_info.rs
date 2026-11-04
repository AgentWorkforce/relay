//! Identity supplied by an embedding executable, before it starts the node.
//!
//! Only the executable's version and source revision belong here. Site,
//! scheme and other build-profile values remain checked at compile time.
//!
//! `test-build-info` is an explicit dev-dependency-only fixture: its first
//! identity query installs a deterministic test identity unless an executable
//! already initialized one. Production bootstrap must be tested separately
//! with `embedded-build-info` and without that fixture feature.

#[cfg(feature = "embedded-build-info")]
use std::sync::OnceLock;

/// The embedding executable's compiled identity. Static strings keep the
/// identity immutable for the process without reading runtime configuration.
#[cfg(feature = "embedded-build-info")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildInfo {
    pub version: &'static str,
    pub revision: &'static str,
}

#[cfg(feature = "embedded-build-info")]
static BUILD_INFO: OnceLock<BuildInfo> = OnceLock::new();

/// Install the executable's identity before calling the CLI or constructing
/// a node. The first caller wins; a later call returns its rejected identity,
/// including when it supplies the same strings as the first call.
#[cfg(feature = "embedded-build-info")]
pub fn install_build_info(info: BuildInfo) -> Result<(), BuildInfo> {
    BUILD_INFO.set(info)
}

#[cfg(feature = "embedded-build-info")]
fn installed() -> &'static BuildInfo {
    #[cfg(feature = "test-build-info")]
    {
        BUILD_INFO.get_or_init(|| BuildInfo {
            version: "0.0.0-dev+test",
            revision: "test-fixture",
        })
    }
    #[cfg(not(feature = "test-build-info"))]
    {
        BUILD_INFO
            .get()
            .expect("embedded build identity must be installed before use")
    }
}

/// The release version, or Git-identified development version, of the node's
/// executable. Embedded builds require `install_build_info` before access,
/// except when the explicit `test-build-info` fixture feature is enabled.
pub fn version() -> &'static str {
    #[cfg(feature = "embedded-build-info")]
    {
        installed().version
    }
    #[cfg(not(feature = "embedded-build-info"))]
    {
        crate::VERSION
    }
}

/// The source revision of the node's executable. Embedded builds require
/// `install_build_info` before access, except with the `test-build-info` fixture.
pub fn build_revision() -> &'static str {
    #[cfg(feature = "embedded-build-info")]
    {
        installed().revision
    }
    #[cfg(not(feature = "embedded-build-info"))]
    {
        crate::BUILD_REVISION
    }
}
