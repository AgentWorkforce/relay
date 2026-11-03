//! How a collector pass reports the receiver's older ai-hist uploader check.
use super::receiver_state;
use crate::destination::LegacySchedulesHeld;
use anyhow::Result;
use serde_json::json;

/// Hold the pass while the check cannot finish (and the person has not
/// acknowledged that), naming that cause in the cycle report instead of a
/// generic offline pass; the next pass inspects again. An `active` older
/// uploader is not held here: the receiver records it on the job as the
/// retried `legacy_uploader_active`, which status reports with how to
/// remove it.
pub(super) fn hold_uninspected(acknowledged: bool) -> Result<()> {
    let state = receiver_state().legacy_scheduler_state();
    if state == "active" {
        return Ok(());
    }
    super::super::legacy_schedule_verdict(state, acknowledged).map_err(|error| {
        LegacySchedulesHeld {
            state,
            message: error
                .downcast_ref::<super::super::UserError>()
                .map_or("Older upload schedules hold uploads.", |e| e.0),
        }
        .into()
    })
}

/// The cycle class of a pass the check held.
pub(super) fn class(error: &anyhow::Error) -> Option<&'static str> {
    let held = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<LegacySchedulesHeld>())?;
    Some(if held.state == "active" {
        "legacy_uploader_active"
    } else {
        "legacy_schedules_unknown"
    })
}

/// What the last check found, while it is not clear: fixed labels only, so
/// status and telemetry can say why uploads wait.
pub(super) fn report(report: &mut serde_json::Value) {
    if let Some(schedules) = receiver_state()
        .last_legacy_schedules()
        .filter(|schedules| schedules.state != "clear")
    {
        report["legacy_schedules"] = json!(schedules);
    }
}
