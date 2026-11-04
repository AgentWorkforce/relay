//! What the core reports about its own bridge operations: a closed vocabulary
//! of operations and outcomes, so no message, name or path ever leaves as
//! usage. A build's account decides what happens to them
//! (`AccountPlugin::record_usage`); without one they go nowhere.

use crate::relay::daemon::Core;
use crate::relay::protocol::RpcError;
use crate::relay::store::SessionKind;
use std::future::Future;

/// An operation the core reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageOperation {
    AgentRegister,
    AgentUnregister,
    MessageSend,
    MessageTest,
}

/// How far an operation got.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UsageOutcome {
    Started,
    Succeeded,
    Failed,
}

/// One operation to report. Only these codes and flags are ever carried.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UsageEvent {
    pub operation: UsageOperation,
    pub outcome: UsageOutcome,
    pub agent_kind: Option<SessionKind>,
    pub already_registered: Option<bool>,
    pub is_reply: Option<bool>,
}

impl UsageEvent {
    pub fn started(operation: UsageOperation) -> UsageEvent {
        UsageEvent {
            operation,
            outcome: UsageOutcome::Started,
            agent_kind: None,
            already_registered: None,
            is_reply: None,
        }
    }

    /// This event as `result` finished it.
    pub fn completed<T>(mut self, result: &Result<T, RpcError>) -> UsageEvent {
        self.outcome = if result.is_ok() {
            UsageOutcome::Succeeded
        } else {
            UsageOutcome::Failed
        };
        self
    }
}

/// Reports `event` to the build's account, when it has one.
pub fn record(core: &Core, event: UsageEvent) {
    if let Some(account) = &core.plugins.account {
        account.record_usage(event);
    }
}

/// Runs `work`, reporting that it started and how it finished.
pub async fn action<T>(
    core: &Core,
    event: UsageEvent,
    work: impl Future<Output = Result<T, RpcError>>,
) -> Result<T, RpcError> {
    record(core, event);
    let result = work.await;
    record(core, event.completed(&result));
    result
}
