//! The bridge methods for the account, the uploader, Skip chat, contractor
//! access, telemetry, incoming messages and launch at
//! login. Every type is the registry's (`relay::contract`); see
//! `docs/relay-core.md` for the contract.

use crate::relay::account::Account;
use crate::relay::contract::account::{
    JournalCompacted, SessionsUpdated, SharingChanged, UploadPreview, UploadSessions,
    UploaderDisconnected, UploaderPaused, UploaderStarted, UploaderStatus, UploadsRetried,
};
use crate::relay::contract::incoming::{Approved, IncomingStatus, Rejected};
use crate::relay::contract::platform::LoginItemState;
use crate::relay::contract::{answer, method, Done};
use crate::relay::daemon::Core;
use crate::relay::incoming::IncomingState;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::state::Listing;
use crate::relay::telemetry::{TelemetryFailure, TelemetryOperation, TelemetryOutcome};
use crate::relay::uploader::read_answer;
use crate::relay::{cloud_chat, contractor_access, login_item};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::future::Future;
use std::sync::Arc;

/// The telemetry failure code for an uploader command's error.
fn failure(error: &RpcError) -> TelemetryFailure {
    if error.message.contains("took too long") {
        TelemetryFailure::TimedOut
    } else if error.message == crate::relay::uploader::MISSING {
        TelemetryFailure::HelperMissing
    } else {
        TelemetryFailure::HelperFailed
    }
}

/// Runs an uploader command, records it, and tells subscribers the
/// uploader changed.
async fn tracked<T: DeserializeOwned>(
    core: &Arc<Core>,
    account: &Account,
    operation: TelemetryOperation,
    work: impl Future<Output = Result<Value, RpcError>>,
) -> Result<T, RpcError> {
    let result = work.await.and_then(read_answer::<T>);
    match &result {
        Ok(_) => account.track(operation, TelemetryOutcome::Succeeded, None),
        Err(error) if error.data.kind == ErrorKind::NotSignedIn => {}
        Err(error) => account.track(operation, TelemetryOutcome::Failed, Some(failure(error))),
    }
    if result.is_ok() {
        core.hub.invalidated(Listing::Uploader);
    }
    result
}

/// Records a failed read the person did not ask for by name.
fn track_read<T>(account: &Account, operation: TelemetryOperation, result: &Result<T, RpcError>) {
    if let Err(error) = result {
        if error.data.kind != ErrorKind::NotSignedIn {
            account.track(operation, TelemetryOutcome::Failed, Some(failure(error)));
        }
    }
}

/// Adds the core's filesystem-aware project identity to raw uploader rows.
/// `Some("")` deliberately distinguishes relay infrastructure from an old
/// core that did not send this field and whose clients retain their legacy
/// folder-name fallback.
async fn resolve_projects(
    names: &crate::relay::project::Names,
    sessions: &mut [crate::relay::contract::account::UploadSession],
) {
    let resolved = names
        .list(sessions.iter().filter_map(|session| session.cwd.as_deref()))
        .await;
    for session in sessions {
        session.project = Some(
            session
                .cwd
                .as_ref()
                .and_then(|cwd| resolved.get(cwd).cloned().flatten())
                .unwrap_or_default(),
        );
    }
}

async fn upload_sessions(
    core: &Core,
    account: &Account,
    uploader: &crate::relay::uploader::Uploader,
    limit: Option<usize>,
) -> Result<UploadSessions, RpcError> {
    let mut result = uploader
        .sessions_list(limit)
        .await
        .and_then(read_answer::<UploadSessions>);
    if let Ok(result) = &mut result {
        resolve_projects(&core.project_names, &mut result.sessions).await;
    }
    track_read(account, TelemetryOperation::RefreshSessions, &result);
    result
}

async fn upload_preview(
    core: &Core,
    uploader: &crate::relay::uploader::Uploader,
    limit: Option<usize>,
    refresh: bool,
) -> Result<UploadPreview, RpcError> {
    let mut result = uploader
        .sessions_preview(limit, refresh)
        .await
        .and_then(read_answer::<UploadPreview>)?;
    resolve_projects(&core.project_names, &mut result.sessions).await;
    Ok(result)
}

/// Answers `method`, or `None` when this module has no such method.
pub async fn call(core: &Arc<Core>, method: &str, raw: Value) -> Option<Result<Value, RpcError>> {
    if let Some(result) = cloud_chat::call(core, method, raw.clone()).await {
        return Some(result);
    }
    if let Some(result) = contractor_access::call(core, method, raw.clone()).await {
        return Some(result);
    }
    let config = core.config();
    match method {
        method::LoginItemSet::NAME => {
            return Some(
                answer::<method::LoginItemSet, _>(raw, |request| async move {
                    login_item::set(&config.home, &config.env, request.enabled).map(|_| Done {})
                })
                .await,
            )
        }
        method::LoginItemStatus::NAME => {
            return Some(
                answer::<method::LoginItemStatus, _>(raw, |_| async {
                    login_item::status(&config.home, &config.env)
                        .map(|enabled| LoginItemState { enabled })
                })
                .await,
            )
        }
        _ => {}
    }
    let account = core.plugins.account.clone()?;
    let uploader = account.uploader.clone();
    let account = &account;
    if let Some(result) = uploader_control(core, account, method, raw.clone()).await {
        return Some(result);
    }
    Some(match method {
        method::AccountStatus::NAME => {
            answer::<method::AccountStatus, _>(raw, |_| async { Ok(account.report()) }).await
        }
        method::AccountSignIn::NAME => {
            answer::<method::AccountSignIn, _>(raw, |request| account.sign_in(request)).await
        }
        method::AccountSelectWorkspace::NAME => {
            answer::<method::AccountSelectWorkspace, _>(raw, |request| async move {
                account
                    .select_workspace(&request.workspace_id)
                    .map(|_| Done {})
            })
            .await
        }
        method::AccountSignInCancel::NAME => {
            answer::<method::AccountSignInCancel, _>(raw, |_| async {
                account.cancel();
                Ok(Done {})
            })
            .await
        }
        method::AccountSignOut::NAME => {
            answer::<method::AccountSignOut, _>(raw, |_| async {
                let result = account.sign_out().await.map(|_| Done {});
                for what in [Listing::Incoming, Listing::Chat, Listing::Projects] {
                    core.hub.invalidated(what);
                }
                result
            })
            .await
        }
        method::AccountConnectWorkspace::NAME => {
            answer::<method::AccountConnectWorkspace, _>(raw, |request| async move {
                account.connect_workspace(&request.workspace_id).await
            })
            .await
        }
        method::UploaderStatus::NAME => {
            answer::<method::UploaderStatus, _>(raw, |_| async {
                let result = uploader.cached_status().await;
                track_read(account, TelemetryOperation::RefreshStatus, &result);
                result.map(|status| UploaderStatus::from_probe(&status))
            })
            .await
        }
        method::UploaderStart::NAME => {
            answer::<method::UploaderStart, _>(raw, |_| {
                tracked::<UploaderStarted>(
                    core,
                    account,
                    TelemetryOperation::StartUploader,
                    uploader.start(),
                )
            })
            .await
        }
        method::UploaderDisconnect::NAME => {
            answer::<method::UploaderDisconnect, _>(raw, |_| async {
                let result = tracked::<UploaderDisconnected>(
                    core,
                    account,
                    TelemetryOperation::Disconnect,
                    uploader.disconnect(),
                )
                .await;
                if result.is_ok() {
                    account.cancel();
                    // Incoming messages belong to the connection just removed.
                    if let Some(incoming) = &account.incoming {
                        incoming.stop(true).await;
                        core.hub.invalidated(Listing::Incoming);
                    }
                }
                result
            })
            .await
        }
        method::UploaderSharingSet::NAME => {
            answer::<method::UploaderSharingSet, _>(raw, |request| {
                tracked::<SharingChanged>(
                    core,
                    account,
                    TelemetryOperation::SharingMode,
                    uploader.sharing_set(request.mode),
                )
            })
            .await
        }
        method::UploaderSessionsList::NAME => {
            answer::<method::UploaderSessionsList, _>(raw, |request| {
                upload_sessions(core, account, &uploader, request.limit)
            })
            .await
        }
        method::SessionsTranscript::NAME => {
            answer::<method::SessionsTranscript, _>(raw, |request| async move {
                uploader.transcript(request).await.and_then(
                    read_answer::<crate::relay::contract::transcript::LocalTranscriptPage>,
                )
            })
            .await
        }
        method::UploaderSessionsPreview::NAME => {
            answer::<method::UploaderSessionsPreview, _>(raw, |request| {
                upload_preview(core, &uploader, request.limit, request.refresh)
            })
            .await
        }
        method::UploaderSessionsInclude::NAME => {
            answer::<method::UploaderSessionsInclude, _>(raw, |request| async move {
                tracked::<SessionsUpdated>(
                    core,
                    account,
                    TelemetryOperation::IncludeSessions,
                    uploader.sessions_change(true, &request.session_keys),
                )
                .await
            })
            .await
        }
        method::UploaderSessionsReset::NAME => {
            answer::<method::UploaderSessionsReset, _>(raw, |request| async move {
                let result = uploader
                    .sessions_reset(&request.confirmation)
                    .await
                    .and_then(read_answer::<crate::relay::contract::account::SessionsReset>);
                result
            })
            .await
        }
        method::UploaderSessionsDelete::NAME => {
            answer::<method::UploaderSessionsDelete, _>(raw, |request| async move {
                tracked::<SessionsUpdated>(
                    core,
                    account,
                    TelemetryOperation::ExcludeSessions,
                    uploader.sessions_delete(&request.session_keys),
                )
                .await
            })
            .await
        }
        method::UploaderSessionsExclude::NAME => {
            answer::<method::UploaderSessionsExclude, _>(raw, |request| async move {
                tracked::<SessionsUpdated>(
                    core,
                    account,
                    TelemetryOperation::ExcludeSessions,
                    uploader.sessions_change(false, &request.session_keys),
                )
                .await
            })
            .await
        }
        method::TelemetryRecord::NAME => {
            // Validated alike, then dropped, without telemetry.
            answer::<method::TelemetryRecord, _>(raw, |event| async move {
                if let Some(telemetry) = &account.telemetry {
                    telemetry.record(event);
                }
                Ok(Done {})
            })
            .await
        }
        method::IncomingStatus::NAME => {
            answer::<method::IncomingStatus, _>(raw, |_| async {
                Ok(match &account.incoming {
                    Some(incoming) => incoming.status().await,
                    None => IncomingStatus {
                        state: IncomingState::Stopped,
                        error: None,
                        threads: Vec::new(),
                        held: Vec::new(),
                        can_approve: false,
                    },
                })
            })
            .await
        }
        method::IncomingShare::NAME => {
            answer::<method::IncomingShare, _>(raw, |request| async move {
                let incoming = incoming(account)?;
                let result = incoming
                    .share(
                        &request.thread_id,
                        request.mode,
                        request.allows_unrestricted,
                    )
                    .await
                    .map(|_| Done {})
                    .map_err(refused);
                core.hub.invalidated(Listing::Incoming);
                result
            })
            .await
        }
        method::IncomingApprove::NAME => {
            answer::<method::IncomingApprove, _>(raw, |request| async move {
                let incoming = incoming(account)?;
                let result = incoming
                    .approve(&request.id)
                    .await
                    .map(|approved| Approved { approved })
                    .map_err(refused);
                core.hub.invalidated(Listing::Incoming);
                result
            })
            .await
        }
        method::IncomingReject::NAME => {
            answer::<method::IncomingReject, _>(raw, |request| async move {
                let incoming = incoming(account)?;
                let result = incoming
                    .reject(&request.id)
                    .await
                    .map(|rejected| Rejected { rejected })
                    .map_err(refused);
                core.hub.invalidated(Listing::Incoming);
                result
            })
            .await
        }
        _ => return None,
    })
}

/// `uploader.pause` / `uploader.resume`: incoming messages pause with
/// uploads; a failed resume keeps them paused.
/// The control actions on the upload job: pause, resume, retry and compact.
async fn uploader_control(
    core: &Arc<Core>,
    account: &Account,
    method: &str,
    raw: Value,
) -> Option<Result<Value, RpcError>> {
    let uploader = &account.uploader;
    Some(match method {
        method::UploaderPause::NAME => {
            answer::<method::UploaderPause, _>(raw, |_| pause(core, account, true)).await
        }
        method::UploaderResume::NAME => {
            answer::<method::UploaderResume, _>(raw, |_| pause(core, account, false)).await
        }
        method::UploaderRetry::NAME => {
            answer::<method::UploaderRetry, _>(raw, |_| {
                let work = uploader.retry();
                tracked::<UploadsRetried>(core, account, TelemetryOperation::RetryUploads, work)
            })
            .await
        }
        method::UploaderCompact::NAME => {
            answer::<method::UploaderCompact, _>(raw, |_| {
                let work = uploader.compact();
                tracked::<JournalCompacted>(core, account, TelemetryOperation::CompactJournal, work)
            })
            .await
        }
        _ => return None,
    })
}

async fn pause(
    core: &Arc<Core>,
    account: &Account,
    paused: bool,
) -> Result<UploaderPaused, RpcError> {
    let operation = if paused {
        TelemetryOperation::PauseUploader
    } else {
        TelemetryOperation::ResumeUploader
    };
    let result =
        tracked::<UploaderPaused>(core, account, operation, account.uploader.pause(paused)).await;
    if let Some(incoming) = &account.incoming {
        if paused || result.is_ok() {
            incoming.pause(paused);
            core.hub.invalidated(Listing::Incoming);
        }
    }
    result
}

fn incoming(account: &Account) -> Result<Arc<crate::relay::incoming::Incoming>, RpcError> {
    account.incoming.clone().ok_or_else(|| {
        RpcError::new(
            ErrorKind::NotSignedIn,
            "Incoming messages are not connected.",
        )
    })
}

fn refused(message: String) -> RpcError {
    RpcError::new(ErrorKind::Refused, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::contract::account::UploadSession;
    use serde_json::json;

    fn upload(cwd: &std::path::Path) -> UploadSession {
        serde_json::from_value(json!({
            "source": "codex", "session_id": "s", "title": "Work", "cwd": cwd,
            "is_agent": false, "included": false, "status": "not_shared"
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn uploader_rows_carry_resolved_and_explicitly_suppressed_projects() {
        let temp = tempfile::tempdir().unwrap();
        let relay_home = temp.path().join("relay");
        let controller = relay_home.join("test-mini-node");
        let checkout = temp.path().join("relay-desktop-231");
        std::fs::create_dir_all(&controller).unwrap();
        std::fs::create_dir_all(checkout.join(".git")).unwrap();
        std::fs::write(
            checkout.join(".git/config"),
            "[remote \"origin\"]\nurl = https://github.com/AgentWorkforce/relay-desktop.git\n",
        )
        .unwrap();
        let mut rows = vec![upload(&controller), upload(&checkout)];
        resolve_projects(&crate::relay::project::Names::new(relay_home), &mut rows).await;
        assert_eq!(rows[0].project.as_deref(), Some(""));
        assert_eq!(rows[1].project.as_deref(), Some("relay-desktop"));
    }
}
