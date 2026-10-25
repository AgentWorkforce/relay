//! Preserve the failure result before withdrawing the failed agent. As
//! with release, an inventory/deregistration must not settle the invocation
//! on Relaycast before the harness's reason reaches it.
use super::intents::Intent;
use super::ledger::Releasing;
use super::node::{NodeLink, RESULT_KEEP};
use super::wire::InventoryAgent;
use crate::relay::daemon::Core;
use std::time::Instant;

pub(super) struct Cleanup {
    pub(super) link: NodeLink,
    pub(super) intent: Intent,
    pub(super) since: Instant,
    pub(super) error: Option<super::invoke::SpawnError>,
}

impl Core {
    pub(super) fn defer_failed_cleanup(&self, link: &NodeLink, intent: &Intent) {
        let Some(agent_id) = &intent.agent_id else {
            return;
        };
        let ledger = self.ledger();
        let mut state = ledger.lock();
        let since = Instant::now();
        state
            .failed
            .retain(|_, cleanup| cleanup.since.elapsed() < RESULT_KEEP);
        state.releasing.insert(
            intent.invocation_id.clone(),
            Releasing {
                since,
                listed: (
                    link.node.node_id.clone(),
                    InventoryAgent {
                        agent_id: agent_id.clone(),
                        name: intent.name.clone(),
                        invocation_id: intent.invocation_id.clone(),
                        session_ref: super::session_ref(&intent.invocation_id),
                    },
                ),
            },
        );
        state.failed.insert(
            intent.invocation_id.clone(),
            Cleanup {
                link: link.clone(),
                intent: intent.clone(),
                since,
                error: None,
            },
        );
    }

    pub(super) fn failed_spawn_result_sent(&self, invocation: &str) {
        let cleanup = self.ledger().lock().failed.remove(invocation);
        if let Some(cleanup) = cleanup {
            if let Some(agent_id) = &cleanup.intent.agent_id {
                super::recover::deregister(
                    cleanup.link,
                    self.config.app_data_dir.clone(),
                    agent_id.clone(),
                    cleanup.intent,
                );
            }
        }
    }
}
