//! Typed usage events and bounded, in-memory upload observations.
use super::{
    TelemetryFailure, TelemetryOperation, TelemetryOutcome, TelemetrySurface, MAX_SESSION_COUNT,
};
use crate::relay::account::Account;
use crate::relay::uploader::SharingMode;
use serde_json::{Map, Value};
use std::collections::HashMap;

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
        }
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
    if let Some(telemetry) = core
        .plugins
        .account
        .as_ref()
        .and_then(|account| account.telemetry.as_ref())
    {
        telemetry.record(event);
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
pub(crate) struct UploadObservations {
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
    }
}

impl Account {
    /// Records an explicit sign-in cancellation, then stops the attempt.
    pub fn cancel_sign_in(self: &std::sync::Arc<Self>) {
        if self.busy() {
            self.track(
                TelemetryOperation::SignIn,
                TelemetryOutcome::Cancelled,
                None,
            );
        }
        self.cancel();
    }

    /// Update success is the last RPC before a hosted core can be released.
    /// Give its sender a bounded chance to finish before acknowledging it.
    pub(crate) async fn record_usage(&self, event: TelemetryEvent) {
        let Some(telemetry) = self.telemetry.clone() else {
            return;
        };
        telemetry.record(event);
        if event.operation == TelemetryOperation::UpdateInstall
            && event.outcome == TelemetryOutcome::Succeeded
        {
            let _ = tokio::task::spawn_blocking(move || {
                telemetry.flush(std::time::Duration::from_secs(2))
            })
            .await;
        }
    }

    /// Records one operation, when telemetry is on.
    pub fn track(
        &self,
        operation: TelemetryOperation,
        outcome: TelemetryOutcome,
        failure: Option<TelemetryFailure>,
    ) {
        if let Some(telemetry) = &self.telemetry {
            let mut event = TelemetryEvent::new(operation, outcome);
            if let Some(failure) = failure {
                event = event.failure(failure);
            }
            telemetry.record(event);
        }
    }
}
