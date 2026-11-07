//! Edits a build makes on its own to a session's agent name or native
//! title, which apply only while the account and the registration they were
//! based on are still current.

use crate::relay::{cloud_session::CloudAccount, daemon::Core, store::Registration};

/// Whether `account` still speaks for the core's workspace at identity sync
/// `generation`: it is the signed-in account, identities may sync, and the
/// active workspace is the one it signed in to.
pub fn authority(core: &Core, account: &CloudAccount, generation: u64) -> bool {
    let active = core.workspace();
    let verified = core.verified_workspace_id();
    core.plugins.cloud.may_sync_identities()
        && core.plugins.cloud.identity_sync_generation() == generation
        && core.plugins.cloud.account().as_ref() == Some(account)
        && core.store.read(|store| {
            store.cloud.as_ref().is_some_and(|cloud| {
                cloud.account_workspace_id.as_deref() == Some(account.workspace_id.as_str())
                    && active.as_ref().is_some_and(|active| {
                        active.base_url == cloud.base_url
                            && (active.key == cloud.key
                                || (cloud.workspace_id.is_some() && verified == cloud.workspace_id))
                    })
            })
        })
}

/// Whether `row` may be edited on `account`'s behalf: a live, unarchived
/// registration not spawned here, owned by the account's person in its
/// workspace, on the active workspace's key.
pub fn eligible(core: &Core, row: &Registration, account: &CloudAccount) -> bool {
    row.spawn.is_none()
        && row.archived_at.is_none()
        && row.missing_since.is_none()
        && core.store.read(|store| {
            store.agent_owners.get(&row.agent_id).is_some_and(|owner| {
                Some(owner.user_id.as_str()) == account.user_id.as_deref()
                    && owner.workspace_id.as_deref() == Some(account.workspace_id.as_str())
            })
        })
        && core.workspace().is_some_and(|workspace| {
            row.base_url == workspace.base_url && core.key_for(row).as_ref() == Some(&workspace.key)
        })
}

/// Automatic edits carry the account and exact registration they were based
/// on, including across native-title and remote-alias lock waits. They are
/// checked (`current`) just before the write, under the title's own lock;
/// rename, archive and removal take the registration's lock instead, so one
/// landing between that check and the write is not fenced, only made
/// unlikely.
pub struct AutomaticEdit {
    pub registration: Registration,
    pub account: CloudAccount,
    pub generation: u64,
}

impl AutomaticEdit {
    pub fn current(&self, core: &Core) -> bool {
        authority(core, &self.account, self.generation)
            && eligible(core, &self.registration, &self.account)
            && core.store.read(|store| {
                store
                    .registrations
                    .iter()
                    .any(|row| row == &self.registration)
            })
    }
}
