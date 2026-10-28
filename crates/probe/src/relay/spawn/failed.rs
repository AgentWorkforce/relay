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
        // Out of `failed` and into `deregistering` under one lock: in between,
        // a same-name retry could take the agent over and this cleanup would
        // then take the retry's agent offline.
        let cleanup = {
            let ledger = self.ledger();
            let mut state = ledger.lock();
            let cleanup = state.failed.remove(invocation);
            if let Some(agent_id) = cleanup.as_ref().and_then(|c| c.intent.agent_id.as_ref()) {
                state.claim_deregistering(agent_id);
            }
            cleanup
        };
        if let Some(cleanup) = cleanup {
            if let Some(agent_id) = cleanup.intent.agent_id.clone() {
                super::recover::deregister_claimed(
                    cleanup.link,
                    self.ledger(),
                    self.config.app_data_dir.clone(),
                    agent_id,
                    cleanup.intent,
                );
            }
        }
    }
}
