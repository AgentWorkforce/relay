//! The collector's runtime.json claim and lock: which build last ran it,
//! whether that run is still live, and when a start must defer to it.

use super::*;

pub(crate) fn running(directory: &Path) -> Result<bool> {
    if !directory.join("collector.lock").exists() {
        return Ok(false);
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join("collector.lock"))?;
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(false),
        Err(error) if agent_relay_probe::platform::fs::lock_held(&error) => Ok(true),
        Err(error) => Err(error.into()),
    }
}
/// The runtime record of the last collector started in `directory`.
fn runtime(directory: &Path) -> Option<serde_json::Value> {
    fs::read(directory.join("runtime.json"))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
}
/// The build that last ran the collector in `directory`, when it recorded one.
pub(crate) fn collector_version(directory: &Path) -> Option<String> {
    runtime(directory).and_then(|runtime| runtime["version"].as_str().map(str::to_owned))
}
/// A build version in semver precedence order: release numbers, then a
/// prerelease below its release, then prerelease identifiers in turn. Build
/// metadata does not order builds. None for a version that is not
/// `major.minor.patch[-prerelease][+build]`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Release {
    numbers: [u64; 3],
    prerelease: Vec<String>,
}
impl Ord for Release {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        self.numbers.cmp(&other.numbers).then_with(|| {
            match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => {
                    for (left, right) in self.prerelease.iter().zip(&other.prerelease) {
                        let order = match (left.parse::<u64>(), right.parse::<u64>()) {
                            (Ok(left), Ok(right)) => left.cmp(&right),
                            (Ok(_), Err(_)) => Ordering::Less,
                            (Err(_), Ok(_)) => Ordering::Greater,
                            (Err(_), Err(_)) => left.cmp(right),
                        };
                        if order != Ordering::Equal {
                            return order;
                        }
                    }
                    self.prerelease.len().cmp(&other.prerelease.len())
                }
            }
        })
    }
}
impl PartialOrd for Release {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
pub(crate) fn release(version: &str) -> Option<Release> {
    let version = version.split('+').next()?;
    let (core, prerelease) = match version.split_once('-') {
        Some((core, prerelease)) => (core, Some(prerelease)),
        None => (version, None),
    };
    let mut parts = core.split('.').map(|part| part.parse().ok());
    let numbers = [parts.next()??, parts.next()??, parts.next()??];
    if parts.next().is_some() {
        return None;
    }
    let prerelease: Vec<String> = match prerelease {
        Some(text) => text.split('.').map(str::to_owned).collect(),
        None => Vec::new(),
    };
    if prerelease.iter().any(String::is_empty) {
        return None;
    }
    Some(Release {
        numbers,
        prerelease,
    })
}
/// What a person is told when a newer build than this one runs, or last ran,
/// a workspace's collector.
pub(crate) const UPDATE_REQUIRED: &str =
    "A newer Agent Relay uploads this workspace. Update Agent Relay to reconnect it.";
/// Whether the collector was launched by an older build than this one, which
/// this build replaces. A collector from before builds were recorded, or with
/// a version this build cannot order, counts as older. A newer build's
/// collector is never outdated: replacing it would downgrade uploads.
pub(crate) fn outdated(directory: &Path) -> bool {
    let Some(runtime) = runtime(directory) else {
        return false;
    };
    match (
        runtime["version"].as_str().and_then(release),
        release(agent_relay_probe::VERSION),
    ) {
        (Some(collector), Some(this)) => {
            collector < this
                || (collector == this
                    && this.prerelease == ["dev"]
                    && runtime["version"].as_str() != Some(agent_relay_probe::VERSION))
        }
        _ => runtime["version"].as_str() != Some(agent_relay_probe::VERSION),
    }
}
/// Whether a newer build than this one last ran the collector, so it may have
/// written config or store this build cannot read.
pub(crate) fn newer_build(directory: &Path) -> bool {
    match (
        collector_version(directory).as_deref().and_then(release),
        release(agent_relay_probe::VERSION),
    ) {
        (Some(collector), Some(this)) => collector > this,
        _ => false,
    }
}

/// Whether a newer build's claim is held by a live collector. Ownership is
/// the collector lock, not the recorded pid — a dead claimant's pid can be
/// recycled while its claim stays, so only the held lock proves the run
/// lives. A dead claim is a record, not an owner: if it did migrate the
/// store, this build's own open fails and reports the cause.
pub(crate) fn newer_build_live(directory: &Path) -> bool {
    newer_build(directory) && running(directory).unwrap_or(false)
}

/// Refuses to start this build's collector over a store a live newer build
/// claims. A dead claim refuses nothing: if it did migrate the store, the
/// collector's own open fails and says so rather than a stale record
/// refusing every later start.
pub(crate) fn ensure_no_live_newer_claim(directory: &Path) -> Result<()> {
    ensure!(!newer_build_live(directory), user_error(UPDATE_REQUIRED));
    Ok(())
}
