//! The credential Cloud requests go out with, held for requests that must
//! all be made as one person (`spawn::claim`).

use super::Account;
use crate::relay::cloud_session::CloudAccess;
use crate::relay::workspace::Secret;

impl Account {
    /// The site and bearer the next request would use, refreshed if stale,
    /// or with `refused` (a bearer Cloud refused) the session renewed;
    /// `None` when signed out.
    pub(super) async fn pinned_credential(
        &self,
        refused: Option<Secret>,
    ) -> Option<(String, Secret)> {
        let site = self.account()?.site_url;
        let bearer = match refused {
            Some(refused) => self.renew(&refused).await.ok()?.access_token,
            None => self.bearer(&site).await?.0,
        };
        Some((site, bearer))
    }
}
