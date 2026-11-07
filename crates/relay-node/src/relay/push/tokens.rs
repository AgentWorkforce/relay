//! Direct node tokens, minted once per agent credential and reused on every
//! reconnect.
//!
//! Each `POST /v1/agent/node-token` rotates the agent's direct node token,
//! and a channel used to mint one on every connection, so channels starting
//! together (the core starting, every channel restarted at once) sent a
//! burst of mints Relaycast answered with 429s. A token is now kept until
//! Relaycast refuses it at the socket, mints are taken one at a time with a
//! gap between them, and a mint never starts while the workspace's writes
//! are paused.

use super::{PushContext, PushSignal, PushTarget};
use crate::relay::sdk_gaps;
use relaycast::types::DirectNodeToken;
use relaycast::AgentClient;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;
use tokio_tungstenite::tungstenite;

/// The node tokens held, by agent credential.
#[derive(Default)]
pub struct NodeTokens {
    held: Mutex<HashMap<String, DirectNodeToken>>,
    /// When the last mint ended; taken by one mint at a time.
    last_mint: tokio::sync::Mutex<Option<Instant>>,
}

/// The key a target's token is held under: its origin and agent token,
/// hashed so the map holds no credential.
fn key(target: &PushTarget) -> String {
    let digest = Sha256::digest(
        serde_json::to_vec(&(&target.base_url, target.token.expose())).unwrap_or_default(),
    );
    format!("{digest:x}")
}

/// Whether Relaycast refused the token at the socket.
pub(super) fn refused(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Http(response)
        if matches!(response.status().as_u16(), 401 | 403))
}

impl NodeTokens {
    fn held(&self) -> MutexGuard<'_, HashMap<String, DirectNodeToken>> {
        self.held.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The token `target` connects with: the one held, else a new one.
    /// `None` when none could be minted; the channel's backoff retries.
    pub(super) async fn get(
        &self,
        target: &PushTarget,
        context: &PushContext,
        agent: &AgentClient,
    ) -> Option<DirectNodeToken> {
        let key = key(target);
        if let Some(node) = self.held().get(&key) {
            return Some(node.clone());
        }
        let mut last_mint = self.last_mint.lock().await;
        if let Some(node) = self.held().get(&key) {
            return Some(node.clone());
        }
        if let Some(gap) = last_mint.map(|at| context.timing.mint_gap.saturating_sub(at.elapsed()))
        {
            tokio::time::sleep(gap).await;
        }
        // A 429 another channel's mint just met pauses this one too.
        if context.backoff.write_paused(&target.workspace) {
            return None;
        }
        let minted = sdk_gaps::mint_node_token(agent).await;
        *last_mint = Some(Instant::now());
        match minted {
            Ok(node) => {
                context.backoff.record_write_success(&target.workspace);
                self.held().insert(key, node.clone());
                Some(node)
            }
            Err(error) => {
                if let Some(notice) = context
                    .backoff
                    .record_write_error(&target.workspace, &error)
                {
                    let _ = context.signals.send(PushSignal::Backoff {
                        workspace: target.workspace.clone(),
                        notice,
                    });
                }
                None
            }
        }
    }

    /// Forgets the token Relaycast refused, so the next connection mints.
    pub(super) fn forget(&self, target: &PushTarget) {
        self.held().remove(&key(target));
    }

    /// Keeps only the tokens of `targets`.
    pub(super) fn retain(&self, targets: &[&PushTarget]) {
        let wanted: HashSet<String> = targets.iter().map(|target| key(target)).collect();
        self.held().retain(|key, _| wanted.contains(key));
    }
}
