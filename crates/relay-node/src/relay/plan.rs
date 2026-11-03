//! What the core records of the workspace's plan: the plan Cloud's whoami
//! reports (`status.workspace.plan`) and how much of its caps the
//! workspace uses (`status.workspace.usage`).
//!
//! Usage is read where the core already reads the roster and the members,
//! and once after each plan read, bounded by the caps: a plan with an agent
//! cap has at most about that many agents to list, and a plan without one
//! (enterprise) is never counted.

use crate::relay::cloud_session::CloudAccount;
use crate::relay::contract::plan::{WorkspacePlan, WorkspaceUsage};
use crate::relay::daemon::Core;
use crate::relay::people::members_response;
use crate::relay::sdk_gaps;
use crate::relay::workspace::Workspace;
use serde_json::Value;

impl Core {
    /// Records the plan whoami reported for the account's workspace and
    /// counts what its caps cover.
    pub async fn record_workspace_plan(&self, plan: Option<WorkspacePlan>) {
        let changed = {
            let before = self.status().workspace.plan;
            self.hub
                .update(|status| status.workspace.plan = plan.clone());
            before != plan
        };
        let Some(plan) = plan else {
            // No plan: nothing its counters would be measured against.
            self.hub.update(|status| status.workspace.usage = None);
            return;
        };
        if changed {
            // The usage read for another plan says nothing about this one.
            self.hub.update(|status| status.workspace.usage = None);
        }
        self.refresh_plan_usage(&plan).await;
    }

    /// Counts the agents and humans a plan with caps covers.
    async fn refresh_plan_usage(&self, plan: &WorkspacePlan) {
        if plan.limits.agents.is_some() {
            if let Ok((workspace, http)) = self.roster_client() {
                let scope = self.relaycast_scope(&workspace.base_url, &workspace.key);
                if self.relaycast_poll_allowed(&scope) {
                    let read = sdk_gaps::list_agents(&http, "all").await;
                    self.observe_relaycast_result(&scope, &read);
                    if let Ok(agents) = read {
                        self.record_agent_usage(&workspace, agents.len());
                    }
                }
            }
        }
        if plan.limits.humans.is_some() {
            let account = self.plugins.cloud.account();
            if let Ok(value) = members_response(self.plugins.cloud.as_ref()).await {
                self.record_members_response(account.as_ref(), &value);
            }
        }
    }

    /// `workspace`'s roster has `count` agents, idle ones included. Recorded
    /// only while that key is still the workspace: a read answered after a
    /// sign-out or a switch says nothing about the workspace shown now.
    pub(crate) fn record_agent_usage(&self, workspace: &Workspace, count: usize) {
        if self.workspace().as_ref() != Some(workspace) {
            return;
        }
        self.record_usage(|usage| usage.agents = Some(count as u64));
    }

    /// Cloud's `GET /members` answer, read for `account`.
    pub(crate) fn record_members_response(&self, account: Option<&CloudAccount>, value: &Value) {
        self.record_human_usage(account, value["members"].as_array().map_or(0, Vec::len));
    }

    /// `account`'s workspace has `count` members, the account the read was
    /// made for; recorded only while it is still the signed-in one.
    pub(crate) fn record_human_usage(&self, account: Option<&CloudAccount>, count: usize) {
        if account.is_none() || self.plugins.cloud.account().as_ref() != account {
            return;
        }
        self.record_usage(|usage| usage.humans = Some(count as u64));
    }

    fn record_usage(&self, change: impl FnOnce(&mut WorkspaceUsage)) {
        self.hub.update(|status| {
            let usage = status.workspace.usage.get_or_insert_with(Default::default);
            change(usage);
        });
    }
}
