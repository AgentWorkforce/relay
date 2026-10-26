//! The upload stages as the status popover lists them, and an action the
//! person just asked for (retry, compact) shown as under way until the
//! uploader's next status.

use super::StatusView;

/// Where one upload stage stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageState {
    Waiting,
    Active,
    Complete,
    Paused,
    Blocked,
}

/// Something the person can do to unblock a stage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StageAction {
    /// Remove consumed records from the full upload journal
    /// (`uploader.compact`).
    Compact,
    /// Retry uploads a problem stopped (`uploader.retry`).
    Retry,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UploadStage {
    pub title: &'static str,
    pub detail: String,
    pub state: StageState,
    /// Only present when the stage has a bounded total.
    pub fraction: Option<f64>,
    pub action: Option<StageAction>,
}

/// Whether the stages read the journal as full: not while the compaction
/// asked for runs, as on the Mac.
pub(super) fn journal_full(status: Option<&StatusView>, pending: Option<StageAction>) -> bool {
    status.is_some_and(|status| status.journal_full) && pending != Some(StageAction::Compact)
}

/// `stages` with the upload stage shown as under way for `pending`, and
/// the action no longer offered.
pub(super) fn show_pending(
    mut stages: [UploadStage; 3],
    pending: Option<StageAction>,
) -> [UploadStage; 3] {
    let under_way = |stage: &mut UploadStage, detail: &str| {
        stage.detail = detail.to_string();
        stage.state = StageState::Active;
        stage.fraction = None;
        stage.action = None;
    };
    match pending {
        None => {}
        Some(StageAction::Retry) => under_way(&mut stages[2], "Retrying uploads…"),
        Some(StageAction::Compact) => under_way(&mut stages[2], "Compacting the upload journal…"),
    }
    stages
}

#[cfg(test)]
mod tests {
    use super::super::tests::{row, view};
    use super::super::{upload_stages, SessionUploadState, UploadSummary};
    use super::*;
    use serde_json::json;

    #[test]
    fn an_action_asked_for_shows_its_stage_under_way() {
        let stopped = view(
            json!({"stage": "needs_attention", "stage_message": "Stopped.",
            "delivery": {"stopped": true, "failure_code": "invalid_payload"}}),
        );
        let summary = UploadSummary::new(&stopped, &[], 0);
        let offered = upload_stages(
            true,
            3,
            1,
            false,
            None,
            Some(&stopped),
            Some(&summary),
            None,
        );
        assert_eq!(offered[2].action, Some(StageAction::Retry));
        // Asked to retry, the stage is under way until the core answers.
        let retrying = upload_stages(
            true,
            3,
            1,
            false,
            None,
            Some(&stopped),
            Some(&summary),
            Some(StageAction::Retry),
        );
        assert_eq!(retrying[2].state, StageState::Active);
        assert_eq!(retrying[2].detail, "Retrying uploads…");
        assert_eq!(retrying[2].action, None);
        let full = view(json!({"journal_full": true}));
        let summary = UploadSummary::new(&full, &[], 0);
        let compacting = upload_stages(
            true,
            0,
            0,
            false,
            None,
            Some(&full),
            Some(&summary),
            Some(StageAction::Compact),
        );
        // As on the Mac: the journal no longer reads as full, and the
        // upload stage is the one under way.
        assert_eq!(compacting[1].state, StageState::Complete);
        assert_eq!(compacting[2].state, StageState::Active);
        assert_eq!(compacting[2].detail, "Compacting the upload journal…");
        assert_eq!(compacting[2].action, None);
    }

    /// A stopped job never retries on its own, so rows say so and the upload
    /// stage offers the retry instead of claiming one is coming.
    #[test]
    fn stopped_uploads_offer_a_retry() {
        let stopped = view(json!({"stage": "needs_attention",
            "stage_message": "An upload could not be prepared safely.",
            "delivery": {"stopped": true, "failure_code": "invalid_payload"}}));
        assert!(stopped.can_retry);
        let queued = row(json!({"included": true, "status": "queued"}));
        let state = SessionUploadState::of(&queued, Some(&stopped));
        assert_eq!(state, SessionUploadState::Stopped);
        assert_eq!(state.title(), "Upload stopped");
        assert!(state.is_pending());
        let summary = UploadSummary::new(&stopped, &[], 0);
        let stages = upload_stages(
            true,
            3,
            1,
            false,
            None,
            Some(&stopped),
            Some(&summary),
            None,
        );
        assert_eq!(stages[2].state, StageState::Blocked);
        assert_eq!(stages[2].action, Some(StageAction::Retry));

        // Signing in again, not a retry, fixes an expired upload sign-in.
        let sign_in = view(
            json!({"stage": "needs_attention", "stage_message": "Sign in again.",
            "delivery": {"stopped": true, "failure_code": "authentication_required"}}),
        );
        assert!(!sign_in.can_retry);
        let summary = UploadSummary::new(&sign_in, &[], 0);
        let stages = upload_stages(
            true,
            3,
            1,
            false,
            None,
            Some(&sign_in),
            Some(&summary),
            None,
        );
        assert_eq!(stages[2].action, None);
        // A retrying failure is still waiting to retry.
        let stalled = view(json!({"stage": "needs_attention", "stage_message": "Stalled."}));
        assert_eq!(
            SessionUploadState::of(&queued, Some(&stalled)),
            SessionUploadState::Blocked
        );
        assert!(!stalled.can_retry);
    }

    /// A transient failure that has lasted waits out its backoff on its own,
    /// and Retry tries again at once; a rate limit only waits. As on the Mac.
    #[test]
    fn a_lasting_transient_failure_offers_a_retry_and_a_rate_limit_does_not() {
        let transient = view(json!({"stage": "needs_attention",
            "stage_message": "The upload service is temporarily unavailable.",
            "delivery": {"stopped": false, "failure_code": "transient"}}));
        assert!(transient.can_retry);
        let queued = row(json!({"included": true, "status": "queued"}));
        assert_eq!(
            SessionUploadState::of(&queued, Some(&transient)),
            SessionUploadState::Blocked
        );
        let summary = UploadSummary::new(&transient, &[], 0);
        let stages = upload_stages(
            true,
            3,
            1,
            false,
            None,
            Some(&transient),
            Some(&summary),
            None,
        );
        assert_eq!(stages[2].action, Some(StageAction::Retry));

        let limited = view(json!({"stage": "needs_attention",
            "stage_message": "The upload service asked to slow down.",
            "delivery": {"stopped": false, "failure_code": "rate_limited"}}));
        assert!(!limited.can_retry);
        // A transient failure still making progress is a calm upload.
        let calm = view(json!({"stage": "uploading",
            "delivery": {"stopped": false, "failure_code": "transient"}}));
        assert!(!calm.can_retry);
    }
}
