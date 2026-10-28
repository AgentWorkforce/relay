//! Retained session updates and serialized Cloud token renewal.
use super::Account;
use crate::relay::cloud_session::{self, can_refresh, CloudError};
use crate::relay::store::CloudSession;
use crate::relay::workspace::Secret;
use std::sync::atomic::Ordering;

impl Account {
    pub(super) fn load_session(&self) -> Option<CloudSession> {
        self.core()?.store.read(|s| s.cloud_session.clone())
    }

    pub(super) fn save_session(&self, session: Option<&CloudSession>) -> Result<(), String> {
        let core = self.core().ok_or("The core is stopping.")?;
        core.store
            .update(|s| s.cloud_session = session.cloned())
            .map_err(|error| error.to_string())
    }

    /// A refresh completing after cancellation must not overwrite a different
    /// account selected in the meantime, or restore credentials after sign-out.
    pub(super) fn replace_session(
        &self,
        expected: &CloudSession,
        next: Option<&CloudSession>,
    ) -> bool {
        self.core().is_some_and(|core| {
            core.store
                .update(|store| {
                    if store.cloud_session.as_ref() != Some(expected) {
                        return false;
                    }
                    store.cloud_session = next.cloned();
                    true
                })
                .unwrap_or(false)
        })
    }

    /// Replaces the kept session whose access token Cloud just refused:
    /// with one another call already renewed, else by refreshing it. Runs
    /// under the refresh lock and saves nothing after a sign-out.
    pub(super) async fn renew(&self, refused: &Secret) -> Result<CloudSession, CloudError> {
        let _one = self.refreshing.lock().await;
        let epoch = self.epoch.load(Ordering::SeqCst);
        let session = self.load_session().ok_or(CloudError::Rejected)?;
        if &session.access_token != refused {
            return Ok(session);
        }
        if !can_refresh(&session, crate::relay::state::now_ms()) {
            self.replace_session(&session, None);
            return Err(CloudError::Rejected);
        }
        match cloud_session::refresh(&session).await {
            Ok(renewed)
                if self.epoch.load(Ordering::SeqCst) == epoch
                    && self.replace_session(&session, Some(&renewed)) =>
            {
                Ok(renewed)
            }
            Ok(_) => Err(CloudError::SignedOut),
            Err(CloudError::Rejected) => {
                if self.replace_session(&session, None) {
                    Err(CloudError::Rejected)
                } else {
                    Err(CloudError::SignedOut)
                }
            }
            Err(error) => Err(error),
        }
    }
}
