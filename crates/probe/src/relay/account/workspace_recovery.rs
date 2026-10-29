//! Recovering a refused account workspace key without replaying writes.

use super::*;
use crate::relay::store::{CloudWorkspace, Store};
use crate::relay::workspace::Workspace;

impl Account {
    /// Refreshes this app's retained Cloud session and re-resolves only the
    /// refused account key. One safe workspace GET proves the replacement's
    /// destination before committing, so bad answers never overwrite local state.
    pub(crate) async fn recover_workspace_key(
        &self,
        refused: &crate::relay::workspace::Workspace,
        workspace_id: &str,
    ) -> Option<(
        crate::relay::workspace::Workspace,
        crate::relay::client::WorkspaceInfo,
    )> {
        let core = self.core()?;
        if core.discover().as_ref() != Some(refused) {
            return None;
        }
        let epoch = self.epoch.load(Ordering::SeqCst);
        let mut recovery = self.workspace_recovery.lock().await;
        if recovery.as_ref() == Some(&(epoch, refused.clone())) {
            return None;
        }
        let (before, session) = self.recovery_context(&core, refused, epoch)?;
        let account_workspace = before.account_workspace_id.as_deref()?;
        *recovery = Some((epoch, refused.clone()));
        // Renew uses the app's kept session and serializes Cloud token
        // rotation with sign-out.
        let renewed = self.renew(&session.access_token).await.ok()?;
        if self.epoch.load(Ordering::SeqCst) != epoch {
            return None;
        }
        let mut resolved = match cloud_session::resolve_workspace_for_recovery(
            &renewed.site_url,
            &renewed.access_token,
            account_workspace,
            refused,
            workspace_id,
        )
        .await
        {
            Ok(resolved) => resolved,
            Err(cloud_session::ResolveError::Cloud(CloudError::Rejected)) => {
                let _one = self.refreshing.lock().await;
                if self.epoch.load(Ordering::SeqCst) == epoch
                    && self.load_session().as_ref() == Some(&renewed)
                {
                    let _ = self.save_session(None);
                }
                return None;
            }
            Err(_) => return None,
        };
        if self.epoch.load(Ordering::SeqCst) != epoch || core.discover().as_ref() != Some(refused) {
            return None;
        }
        let replacement = Workspace {
            key: resolved.key.clone(),
            base_url: resolved.base_url.clone(),
            workspace_id: resolved.workspace_id.clone(),
        };
        // This is the sole safe retry; a mutation that triggered recovery is never replayed.
        let info = crate::relay::client::workspace_info(&replacement)
            .await
            .ok()?;
        if info.id != workspace_id {
            return None;
        }
        // Persist the identity actually reported by Relaycast, including legacy ids.
        resolved.workspace_id = Some(info.id.clone());
        let replacement = Workspace {
            workspace_id: Some(info.id.clone()),
            ..replacement
        };
        let _one = self.refreshing.lock().await;
        if self.epoch.load(Ordering::SeqCst) != epoch || core.discover().as_ref() != Some(refused) {
            return None;
        }
        let committed = core
            .store
            .update(|store| {
                commit_recovery(store, &before, &renewed, refused, resolved, &replacement)
            })
            .ok()?;
        if !committed {
            return None;
        }
        core.rediscover_workspace();
        Some((replacement, info))
    }

    fn recovery_context(
        &self,
        core: &Core,
        refused: &Workspace,
        epoch: u64,
    ) -> Option<(CloudWorkspace, CloudSession)> {
        let before = core.store.read(|store| store.cloud.clone())?;
        let session = self.load_session()?;
        if session.site_url != self.site_url
            || before.key != refused.key
            || validated_base_url(&before.base_url).as_deref() != Some(refused.base_url.as_str())
            || self.epoch.load(Ordering::SeqCst) != epoch
            || core.discover().as_ref() != Some(refused)
        {
            return None;
        }
        Some((before, session))
    }
}

fn commit_recovery(
    store: &mut Store,
    before: &CloudWorkspace,
    renewed: &CloudSession,
    refused: &Workspace,
    resolved: CloudWorkspace,
    replacement: &Workspace,
) -> bool {
    if store.cloud.as_ref() != Some(before) || store.cloud_session.as_ref() != Some(renewed) {
        return false;
    }
    store.cloud = Some(resolved);
    // Existing registrations pin this account key. Change only entries
    // with its exact previous credential and origin; preserve all others.
    for registration in &mut store.registrations {
        if registration.base_url == refused.base_url
            && registration.workspace_key.as_ref() == Some(&refused.key)
        {
            registration.workspace_key = Some(replacement.key.clone());
        }
    }
    true
}
