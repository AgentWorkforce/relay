use super::*;
use crate::relay::cloud_session::{self, AgentOwner, CloudAccount, CloudError};

/// Who owns the binding of an already-open Grok session: the attached
/// install's person, else the signed-in account's. With nobody signed in the
/// session is this computer's OS user's, the same local proof a Claude or
/// Codex session joins on, and the leader proof pins that uid. `None` for an
/// account this process has not learned the person of: its session must not
/// be minted for anyone else, so Cloud is asked instead. A build without
/// session history never attaches an install, so it reaches the account and
/// signed-out cases every time.
fn open_grok_owner(
    owner: Option<AgentOwner>,
    account: Option<CloudAccount>,
    uid: u32,
) -> Option<String> {
    if let Some(owner) = owner {
        return Some(owner.user_id);
    }
    match account {
        Some(account) => account.user_id,
        None => Some(format!("local-user:{uid}")),
    }
}

impl Core {
    /// The workspace and owner an already-open Grok session is bound to and
    /// checked against. Unlike a probe-managed launch, it needs no sign-in.
    pub(crate) async fn open_grok_authority(&self) -> Result<ManagedAuthority, RpcError> {
        self.refresh_workspace().await;
        let workspace_id = self.verified_workspace_id().ok_or_else(|| {
            RpcError::new(
                ErrorKind::NotSignedIn,
                "A verified Agent Relay workspace is required to bind a Grok session.",
            )
        })?;
        let owner_uid = crate::relay::peer::current_uid();
        let known = open_grok_owner(self.agent_owner(), self.plugins.cloud.account(), owner_uid);
        let owner_id = match known {
            Some(owner) => Some(owner),
            None => self.saved_sign_in_person().await,
        }
        .ok_or_else(|| {
            RpcError::new(
                ErrorKind::NotSignedIn,
                "Agent Relay could not confirm who is signed in. Check your connection, or sign in again.",
            )
        })?;
        Ok(ManagedAuthority {
            workspace_id,
            owner_id,
            owner_uid,
        })
    }

    /// Whose the kept Cloud session is, which Cloud alone can say: the person
    /// is held only in memory, so a core restarted with a saved sign-in does
    /// not know it, and without an install nothing tells it. A refused
    /// credential is renewed once.
    async fn saved_sign_in_person(&self) -> Option<String> {
        let mut refused = None;
        for _ in 0..2 {
            let (site, bearer) = self.plugins.cloud.credential(refused.take()).await?;
            match cloud_session::whoami(&site, &bearer).await {
                Ok(identity) => return Some(identity.user_id),
                Err(CloudError::Rejected) => refused = Some(bearer),
                Err(_) => return None,
            }
        }
        None
    }

    pub(super) async fn registration_route_binding(
        &self,
        session: &DiscoveredSession,
    ) -> Result<Option<String>, RpcError> {
        let target = &session.target;
        Ok(if target.kind == SessionKind::GrokOpen {
            let mut binding = self.live_route_binding(target).await;
            if binding.is_none() {
                self.bind_open_grok(session).await?;
                binding = self.live_route_binding(target).await;
            }
            Some(binding.ok_or_else(|| {
                RpcError::new(
                    ErrorKind::Refused,
                    "This already-open Grok session has no live binding.",
                )
            })?)
        } else if target.kind == SessionKind::Pi {
            Some(self.live_route_binding(target).await.ok_or_else(|| {
                RpcError::new(
                    ErrorKind::Refused,
                    "Pi is not connected. Run /reload in the Pi session.",
                )
            })?)
        } else if target.kind == SessionKind::MuseOpen {
            // The courier route needs no persisted binding: delivery proves
            // the session live in Muse's own registry, or as the `muse serve`
            // process Paseo is driving, and launches a courier in its
            // kernel-proven workspace. The registration pins the courier
            // reference so only its agent may send.
            Some(crate::relay::existing_session::muse_open::courier_reference(&target.id))
        } else if target.kind == SessionKind::OpenCodeOpen {
            // Like a Muse session, an open OpenCode session needs no stored
            // binding: delivery finds the one live process holding it and
            // proves that process and its socket before every request. The
            // registration pins the session so only its agent may send.
            Some(crate::relay::opencode::route_reference(&target.id))
        } else {
            None
        })
    }
}

#[cfg(test)]
#[path = "registration_routes_tests.rs"]
mod tests;
