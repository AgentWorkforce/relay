//! Provider boundary: an existing window and one proven native mobile turn.
use crate::relay::codex::follower::{
    ApprovalRequest, Decision, DecisionOutcome, Error, Follower, Socket,
};
use crate::relay::codex::{rollout, CodexConfig};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub home: String,
    pub thread: String,
    pub window: String,
    pub generation: String,
    pub message: String,
    pub turn: String,
}

pub trait Control: Send {
    fn scope(&self) -> &Scope;
    fn poll(&mut self) -> Result<Vec<ApprovalRequest>, Error>;
    fn decide(
        &mut self,
        request: &ApprovalRequest,
        decision: Decision,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> DecisionOutcome;
    fn close(&mut self);
}

pub(crate) struct Window {
    follower: Follower<Socket>,
    config: CodexConfig,
    scope: Scope,
}
impl Window {
    pub(crate) fn open(
        config: CodexConfig,
        thread: &str,
        message: &str,
        owner: &str,
    ) -> Option<Self> {
        let home = home_identity(&config)?;
        let summary = rollout::RolloutSummary::read(&rollout::rollout_path(&config, thread)?)?;
        let turn = summary.turn_by_client_message.get(message)?.clone();
        if summary.active_turn.as_ref() != Some(&turn) {
            return None;
        }
        let mut follower = Follower::connect(&config, thread, owner).ok()?;
        follower.synchronize().ok()?;
        let scope = Scope {
            home,
            thread: thread.into(),
            window: owner.into(),
            generation: follower.registry().generation().into(),
            message: message.into(),
            turn,
        };
        Some(Self {
            follower,
            config,
            scope,
        })
    }
    fn current(&self) -> bool {
        current_turn(&self.config, &self.scope)
    }
}
impl Control for Window {
    fn scope(&self) -> &Scope {
        &self.scope
    }
    fn poll(&mut self) -> Result<Vec<ApprovalRequest>, Error> {
        if !self.current() {
            return Err(Error::Unavailable);
        }
        self.follower.poll(Duration::from_millis(500))?;
        self.follower.synchronize()?;
        Ok(self
            .follower
            .registry()
            .pending()
            .iter()
            .filter(|request| request.turn() == self.scope.turn)
            .cloned()
            .collect())
    }
    fn decide(
        &mut self,
        request: &ApprovalRequest,
        decision: Decision,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> DecisionOutcome {
        if request.turn() != self.scope.turn || !self.current() {
            return DecisionOutcome::Refused;
        }
        let config = self.config.clone();
        let scope = self.scope.clone();
        self.follower.decide(request, decision, &|| {
            // This proof is reread after the follower's owner/snapshot preflight.
            let current = current_turn(&config, &scope);
            current && admit()
        })
    }
    fn close(&mut self) {
        let _ = self.follower.close();
    }
}

#[cfg(all(test, unix))]
mod tests;

fn home_identity(config: &CodexConfig) -> Option<String> {
    let home = std::fs::canonicalize(&config.home).ok()?;
    let sqlite = std::fs::canonicalize(&config.sqlite_home).ok()?;
    Some(super::ledger::digest(&[
        home.as_os_str().as_encoded_bytes(),
        sqlite.as_os_str().as_encoded_bytes(),
    ]))
}

fn current_turn(config: &CodexConfig, scope: &Scope) -> bool {
    home_identity(config).as_ref() == Some(&scope.home)
        && rollout::rollout_path(config, &scope.thread)
            .and_then(|path| rollout::RolloutSummary::read(&path))
            .is_some_and(|summary| {
                summary.active_turn.as_ref() == Some(&scope.turn)
                    && summary.turn_by_client_message.get(&scope.message) == Some(&scope.turn)
            })
}
