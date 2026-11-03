//! The collector's runtime.json claim and lock: which build last ran it,
//! whether that run is still live, and when a start must defer to it.

use super::*;

#[cfg(test)]
pub(crate) use crate::delivery_status::release;
pub(crate) use crate::delivery_status::{
    collector_version, newer_build, newer_build_live, outdated, running, UPDATE_REQUIRED,
};

/// Refuses to start this build's collector over a store a live newer build
/// claims. A dead claim refuses nothing: if it did migrate the store, the
/// collector's own open fails and says so rather than a stale record
/// refusing every later start.
pub(crate) fn ensure_no_live_newer_claim(directory: &Path) -> Result<()> {
    ensure!(!newer_build_live(directory), user_error(UPDATE_REQUIRED));
    Ok(())
}
