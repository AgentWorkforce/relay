//! Typed usage events and bounded, in-memory upload observations.
use super::{
    TelemetryFailure, TelemetryOperation, TelemetryOutcome, TelemetrySurface, MAX_SESSION_COUNT,
};
use crate::relay::contract::account::{DeliveryFailureCode, LegacyScheduleJob};
use crate::relay::uploader::SharingMode;
use serde_json::{Map, Value};
use std::collections::HashMap;

impl TelemetryOperation {
    /// Background polls: a repeated failure of one of these is dropped
    /// entirely while its exception is deduplicated, so polling never floods
    /// product analytics. Explicit attempts always count.
    pub(super) fn is_polling(self) -> bool {
        matches!(
            self,
            TelemetryOperation::RefreshStatus
                | TelemetryOperation::RefreshSessions
                | TelemetryOperation::StartUploader
                | TelemetryOperation::UploadHealth
        )
    }
}

/// One operation to record: `telemetry.record`'s parameters. Only these
/// codes and numbers are ever sent.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize, schemars::JsonSchema,
)]
pub struct TelemetryEvent {
    pub operation: TelemetryOperation,
    pub outcome: TelemetryOutcome,
    pub failure: Option<TelemetryFailure>,
    pub count: Option<i64>,
    pub mode: Option<SharingMode>,
    pub surface: Option<TelemetrySurface>,
    pub agent_kind: Option<crate::relay::store::SessionKind>,
    pub already_registered: Option<bool>,
    pub is_reply: Option<bool>,
    /// What the last inspection of older upload schedules found, for an
    /// `upload_health` failure. Set by the core only: never a parameter.
    #[serde(skip)]
    pub legacy_schedule_jobs: LegacyScheduleJobs,
}

/// A set of [`LegacyScheduleJob`] labels, the closed vocabulary
/// `migration::JOB_CODES` names: no path, command or scheduler output.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LegacyScheduleJobs(u16);

impl LegacyScheduleJobs {
    const ALL: [LegacyScheduleJob; 8] = [
        LegacyScheduleJob::LaunchdPlist,
        LegacyScheduleJob::LaunchdLoaded,
        LegacyScheduleJob::ManagedCron,
        LegacyScheduleJob::LaunchdPlistStatusUnknown,
        LegacyScheduleJob::LaunchdStatusUnknown,
        LegacyScheduleJob::CronStatusUnknown,
        LegacyScheduleJob::HomeUnavailable,
        LegacyScheduleJob::LegacyInstallerUnsupported,
    ];

    pub fn from_jobs(jobs: &[LegacyScheduleJob]) -> LegacyScheduleJobs {
        LegacyScheduleJobs(
            Self::ALL
                .iter()
                .enumerate()
                .filter(|(_, job)| jobs.contains(job))
                .fold(0, |bits, (index, _)| bits | 1 << index),
        )
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// The labels, in vocabulary order.
    pub fn labels(self) -> Vec<&'static str> {
        Self::ALL
            .iter()
            .enumerate()
            .filter(|(index, _)| self.0 & (1 << index) != 0)
            .map(|(_, job)| job.as_str())
            .collect()
    }
}

impl TelemetryEvent {
    pub fn new(operation: TelemetryOperation, outcome: TelemetryOutcome) -> TelemetryEvent {
        TelemetryEvent {
            operation,
            outcome,
            failure: None,
            count: None,
            mode: None,
            surface: None,
            agent_kind: None,
            already_registered: None,
            is_reply: None,
            legacy_schedule_jobs: LegacyScheduleJobs::default(),
        }
    }

    pub fn legacy_schedule_jobs(mut self, jobs: LegacyScheduleJobs) -> TelemetryEvent {
        self.legacy_schedule_jobs = jobs;
        self
    }

    pub fn surface(mut self, surface: TelemetrySurface) -> Self {
        self.surface = Some(surface);
        self
    }

    pub fn completed<T>(mut self, result: &Result<T, crate::relay::protocol::RpcError>) -> Self {
        self.outcome = if result.is_ok() {
            TelemetryOutcome::Succeeded
        } else {
            TelemetryOutcome::Failed
        };
        self.failure = result
            .as_ref()
            .err()
            .map(|_| TelemetryFailure::RequestFailed);
        self
    }

    pub fn failure(mut self, failure: TelemetryFailure) -> TelemetryEvent {
        self.failure = Some(failure);
        self
    }

    pub fn count(mut self, count: i64) -> TelemetryEvent {
        self.count = Some(count);
        self
    }

    pub fn mode(mut self, mode: SharingMode) -> TelemetryEvent {
        self.mode = Some(mode);
        self
    }
}

/// Records explicit bridge/UI usage through the account's opt-out and identity.
pub fn record_for(core: &crate::relay::daemon::Core, event: TelemetryEvent) {
    if let Some(account) = &core.plugins.account {
        account.record_usage(event);
    }
}

pub async fn action<T>(
    core: &crate::relay::daemon::Core,
    event: TelemetryEvent,
    work: impl std::future::Future<Output = Result<T, crate::relay::protocol::RpcError>>,
) -> Result<T, crate::relay::protocol::RpcError> {
    record_for(core, event);
    let result = work.await;
    record_for(core, event.completed(&result));
    result
}

/// A bounded, in-memory baseline of observed session uploads. IDs stay here;
/// only a count of transitions to `uploaded` is emitted. Initial listings and
/// pagination are baselines, not fresh uploads. Late reads cannot rewind it.
#[derive(Default)]
pub struct UploadObservations {
    revision: u64,
    sample: u64,
    sessions: HashMap<(String, String), bool>,
}

impl UploadObservations {
    pub fn observe(
        &mut self,
        revision: u64,
        sample: u64,
        rows: &[crate::relay::contract::account::UploadSession],
    ) -> i64 {
        use crate::relay::contract::account::UploadShareStatus;
        if sample <= self.sample {
            return 0;
        }
        self.sample = sample;
        if revision != self.revision {
            self.sessions.clear();
            self.revision = revision;
        }
        let mut completed = 0;
        let mut next = HashMap::new();
        for row in rows.iter().take(MAX_SESSION_COUNT as usize) {
            let key = (row.source.clone(), row.session_id.clone());
            let uploaded = row.status == UploadShareStatus::Uploaded;
            if uploaded && self.sessions.get(&key) == Some(&false) {
                completed += 1;
            }
            // Checking/unknown does not prove that another upload began.
            let pending = row.included
                && matches!(
                    row.status,
                    UploadShareStatus::Uploading | UploadShareStatus::Queued
                );
            if uploaded || pending {
                next.insert(key, uploaded);
            } else if let Some(previous) = self.sessions.get(&key) {
                next.insert(key, *previous);
            }
        }
        self.sessions = next;
        completed
    }
}

impl TelemetryEvent {
    pub(super) fn add_usage_properties(self, object: &mut Map<String, Value>) {
        if let Some(surface) = self.surface {
            object.insert("surface".into(), surface.as_str().into());
        }
        if let Some(kind) = self.agent_kind {
            object.insert("agent_kind".into(), kind.as_str().into());
        }
        if let Some(value) = self.already_registered {
            object.insert("already_registered".into(), value.into());
        }
        if let Some(value) = self.is_reply {
            object.insert("is_reply".into(), value.into());
        }
        if !self.legacy_schedule_jobs.is_empty() {
            let labels = self.legacy_schedule_jobs.labels();
            object.insert("legacy_schedule_jobs".into(), labels.into());
        }
    }
}

/// A running, unpaused uploader's health: `Some(Some(failure))` while
/// delivery or its last cycle fails (an upgrade in progress is not a
/// failure) or its queue is `stalled`, `Some(None)` when healthy, `None`
/// when it is not uploading.
pub fn upload_health(status: &Value) -> Option<Option<TelemetryFailure>> {
    if status["running"] != Value::Bool(true) || status["paused"] == Value::Bool(true) {
        return None;
    }
    let failure = &status["delivery"]["failure"];
    let delivery_failed = !failure.is_null() && failure.as_str() != Some("");
    let cycle_failed = status["last_cycle"]["ok"] == Value::Bool(false)
        && status["upgrading"] != Value::Bool(true);
    Some(if delivery_failed {
        Some(delivery_failure(&status["delivery"]["failure_code"]))
    } else if cycle_failed {
        // A pass the older-uploader check held is named for that check.
        Some(match status["last_cycle"]["error_class"].as_str() {
            Some("legacy_uploader_active") => TelemetryFailure::UploadLegacyUploaderActive,
            Some("legacy_schedules_unknown") => TelemetryFailure::ScheduleInspection,
            _ => TelemetryFailure::UploadCycle,
        })
    } else if status["stalled"] == Value::Bool(true) {
        Some(TelemetryFailure::UploadStalled)
    } else {
        None
    })
}

/// The older-upload-schedule labels a status reports, for the
/// `upload_health` failure event: fixed codes only.
pub fn upload_legacy_schedule_jobs(status: &Value) -> LegacyScheduleJobs {
    LegacyScheduleJobs::from_jobs(&LegacyScheduleJob::from_probe(status))
}

/// The telemetry code for a delivery failure's allowlisted `failure_code`.
fn delivery_failure(code: &Value) -> TelemetryFailure {
    match serde_json::from_value(code.clone()) {
        Ok(DeliveryFailureCode::Transient) => TelemetryFailure::UploadTransient,
        Ok(DeliveryFailureCode::RateLimited) => TelemetryFailure::UploadRateLimited,
        Ok(DeliveryFailureCode::AuthenticationRequired) => {
            TelemetryFailure::UploadAuthenticationRequired
        }
        Ok(DeliveryFailureCode::PermissionDenied) => TelemetryFailure::UploadPermissionDenied,
        Ok(DeliveryFailureCode::InvalidPayload) => TelemetryFailure::UploadInvalidPayload,
        Ok(DeliveryFailureCode::ReceiverRejected) => TelemetryFailure::UploadReceiverRejected,
        Ok(DeliveryFailureCode::UnsupportedEvidence) => TelemetryFailure::UploadUnsupportedEvidence,
        Ok(DeliveryFailureCode::MappingVersionMismatch) => {
            TelemetryFailure::UploadMappingVersionMismatch
        }
        Ok(DeliveryFailureCode::DeliveryConflict) => TelemetryFailure::UploadDeliveryConflict,
        Ok(DeliveryFailureCode::LegacyUploaderActive) => {
            TelemetryFailure::UploadLegacyUploaderActive
        }
        Err(_) => TelemetryFailure::UploadDelivery,
    }
}
