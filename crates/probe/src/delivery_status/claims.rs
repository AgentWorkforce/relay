//! The collector's claim and reports in an install directory: which build
//! last ran it, whether that run is still live, and what it last reported.
use crate::cloud::RenewalFailure;
use anyhow::Result;
use std::fs;
use std::path::Path;

pub fn running(directory: &Path) -> Result<bool> {
    if !directory.join("collector.lock").exists() {
        return Ok(false);
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join("collector.lock"))?;
    match fs2::FileExt::try_lock_exclusive(&file) {
        Ok(()) => Ok(false),
        Err(error) if crate::platform::fs::lock_held(&error) => Ok(true),
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
pub fn collector_version(directory: &Path) -> Option<String> {
    runtime(directory).and_then(|runtime| runtime["version"].as_str().map(str::to_owned))
}
/// A build version in semver precedence order: release numbers, then a
/// prerelease below its release, then prerelease identifiers in turn. Build
/// metadata does not order builds. None for a version that is not
/// `major.minor.patch[-prerelease][+build]`.
#[derive(Debug, PartialEq, Eq)]
pub struct Release {
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
pub fn release(version: &str) -> Option<Release> {
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
pub const UPDATE_REQUIRED: &str =
    "A newer Agent Relay uploads this workspace. Update Agent Relay to reconnect it.";
/// Whether the collector was launched by an older build than this one, which
/// this build replaces. A collector from before builds were recorded, or with
/// a version this build cannot order, counts as older. A newer build's
/// collector is never outdated: replacing it would downgrade uploads.
pub fn outdated(directory: &Path) -> bool {
    let Some(runtime) = runtime(directory) else {
        return false;
    };
    match (
        runtime["version"].as_str().and_then(release),
        release(crate::VERSION),
    ) {
        (Some(collector), Some(this)) => {
            collector < this
                || (collector == this
                    && this.prerelease == ["dev"]
                    && runtime["version"].as_str() != Some(crate::VERSION))
        }
        _ => runtime["version"].as_str() != Some(crate::VERSION),
    }
}
/// Whether a newer build than this one last ran the collector, so it may have
/// written config or store this build cannot read.
pub fn newer_build(directory: &Path) -> bool {
    match (
        collector_version(directory).as_deref().and_then(release),
        release(crate::VERSION),
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
pub fn newer_build_live(directory: &Path) -> bool {
    newer_build(directory) && running(directory).unwrap_or(false)
}

/// The last report, if the collector run `runtime.json` names wrote it. A
/// report from an earlier run, including one from before reports named their
/// run, says nothing about the collector now running, whose first capture
/// pass may take many minutes on a large history.
pub fn current_cycle_report(directory: &Path) -> Option<serde_json::Value> {
    let read = |name: &str| {
        fs::read(directory.join(name))
            .ok()
            .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
    };
    let run = read("runtime.json")?["startup_id"].as_str()?.to_owned();
    read("cycle.json").filter(|report| report["startup_id"] == run.as_str())
}

/// Why the last renewal failed, while it stands.
pub const RENEWAL_REPORT: &str = "renewal.json";
/// The failure the last renewal recorded; `None` after one succeeded.
pub fn renewal_failure(directory: &Path) -> Option<RenewalFailure> {
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join(RENEWAL_REPORT)).ok()?).ok()?;
    RenewalFailure::parse(report["failure"].as_str()?)
}
/// What a person reads for a renewal failure: a fixed sentence per cause.
pub fn renewal_failure_message(failure: RenewalFailure) -> &'static str {
    match failure {
        RenewalFailure::NoCloudSession => {
            "Uploads need you to sign in to Agent Relay again. Queued records are preserved."
        }
        RenewalFailure::CloudRefused => {
            "Agent Relay Cloud refused to renew the upload sign-in. Check your workspace access, then sign in again. Queued records are preserved."
        }
        RenewalFailure::CloudUnreachable => {
            "Agent Relay Cloud is unreachable or busy, so the upload sign-in could not be renewed. Agent Relay will retry. Queued records are preserved."
        }
        RenewalFailure::WrongDestination => {
            "Agent Relay Cloud renewed the upload sign-in for another workspace. Connect this computer again. Queued records are preserved."
        }
    }
}
/// Whether `stop.json` asks the collector run `startup_id` to stop.
pub fn stop_file_requested(directory: &Path, startup_id: &str) -> bool {
    fs::read(directory.join("stop.json"))
        .ok()
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
        .is_some_and(|value| value["startup_id"] == startup_id)
}
/// True only while another build's live collector has received its own,
/// generation-scoped stop request. This distinguishes an update replacement
/// from an arbitrary stale stop file.
pub fn replacement_in_progress(directory: &Path) -> bool {
    if !outdated(directory) || !running(directory).unwrap_or(false) {
        return false;
    }
    let Ok(control) = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("desktop.lock"))
    else {
        return false;
    };
    if fs2::FileExt::try_lock_exclusive(&control).is_ok() {
        return false;
    }
    fs::read(directory.join("runtime.json"))
        .ok()
        .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
        .and_then(|runtime| runtime["startup_id"].as_str().map(str::to_owned))
        .is_some_and(|startup_id| stop_file_requested(directory, &startup_id))
}
