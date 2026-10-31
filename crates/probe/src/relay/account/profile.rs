//! Authenticated account refresh and opt-in Cloud profile synchronization.

use super::*;

impl Account {
    /// Refresh account display metadata independently of Relaycast. Bind the
    /// response to the attached person and workspace; cache it for five minutes.
    pub(super) async fn refresh_workspace_name(&self) {
        if self.busy() {
            return;
        }
        let Some(target) = self.uploader.target() else {
            return;
        };
        let now = tokio::time::Instant::now();
        {
            let mut retry = self.workspace_name_retry.lock().unwrap();
            if retry.not_before.is_some_and(|at| now < at) {
                return;
            }
            retry.failures = retry.failures.saturating_add(1);
            retry.not_before = Some(now + Duration::from_secs(5 * (1 << retry.failures.min(6))));
        }
        let epoch = self.epoch.load(Ordering::SeqCst);
        // Display metadata must not renew credentials or wake upload sign-in.
        let bearer = if let Some(token) = &self.env_token {
            Some(token.clone())
        } else if let Some(session) = self
            .load_session()
            .filter(|s| s.site_url == target.site_url)
        {
            access_is_fresh(&session, Duration::ZERO, crate::relay::state::now_ms())
                .then_some(session.access_token)
        } else {
            cloud_session::cli_session(
                &self.relay_home,
                &target.site_url,
                crate::relay::state::now_ms(),
            )
            .map(|session| session.access_token)
        };
        let Some(bearer) = bearer else {
            return;
        };
        let analytics_enabled = self
            .telemetry
            .as_ref()
            .is_some_and(|t| t.profile_sync_enabled());
        let Ok(identity) =
            cloud_session::whoami_with_analytics(&target.site_url, &bearer, analytics_enabled)
                .await
        else {
            return;
        };
        if target.account_id.as_deref() != Some(identity.user_id.as_str())
            || target.workspace_id != identity.current_workspace_id
            || self.epoch.load(Ordering::SeqCst) != epoch
        {
            return;
        }
        let name = identity
            .current_workspace_name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty());
        {
            let mut retry = self.workspace_name_retry.lock().unwrap();
            retry.failures = 0;
            retry.not_before = Some(now + Duration::from_secs(300));
        }
        self.update(|account| {
            if self.epoch.load(Ordering::SeqCst) == epoch
                && account.site_url.as_deref() == Some(target.site_url.as_str())
                && account.workspace_id == target.workspace_id
                && account
                    .person
                    .as_ref()
                    .and_then(|person| person.id.as_ref())
                    == target.account_id.as_ref()
            {
                if let Some(name) = name {
                    account.workspace_name = Some(name);
                }
                account.workspace_count = identity.workspace_count;
                account.workspace_avatar_url = identity.current_workspace_avatar_url;
            }
        });
    }
}
