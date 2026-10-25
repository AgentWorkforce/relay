//! Native title operations and the fleet-filtered session listing.
use super::*;

impl LocalSessions {
    pub(super) fn native_title_capability(
        &self,
        source: &str,
        session_id: &str,
    ) -> crate::relay::contract::agents::SessionTitleCapability {
        if source == "opencode" {
            if let Some(ManagedBinding::OpenCode(binding)) =
                self.managed.as_ref().and_then(|managed| {
                    managed.binding(&Target::new(SessionKind::OpenCode, session_id))
                })
            {
                return if crate::relay::opencode_existing::inspect_session(
                    &*self.table,
                    &crate::relay::opencode_existing::SystemHttp,
                    &binding,
                    Duration::from_secs(5),
                )
                .is_ok()
                {
                    crate::relay::session_titles::supported()
                } else {
                    crate::relay::session_titles::unsupported(
                        "This managed OpenCode session is unavailable.",
                    )
                };
            }
        }
        crate::relay::session_titles::capability(&self.config, &*self.table, source, session_id)
    }

    pub(super) fn set_native_title(
        &self,
        source: &str,
        session_id: &str,
        title: &str,
    ) -> Result<String, String> {
        if source == "opencode" {
            if let Some(ManagedBinding::OpenCode(binding)) =
                self.managed.as_ref().and_then(|managed| {
                    managed.binding(&Target::new(SessionKind::OpenCode, session_id))
                })
            {
                let title = crate::relay::session_titles::validate_title(title)
                    .map_err(|error| error.message)?;
                return crate::relay::session_titles::opencode::set_binding(
                    &*self.table,
                    &crate::relay::opencode_existing::SystemHttp,
                    &binding,
                    &title,
                );
            }
        }
        crate::relay::session_titles::set(&self.config, &*self.table, source, session_id, title)
    }

    pub(super) fn discovered_sessions(&self) -> Vec<DiscoveredSession> {
        // While a broker cannot be read, the last known ownership stands;
        // registering any session reads ownership fresh and fails closed.
        let owned = match self.config.fleet.managed_targets_blocking() {
            Ok(owned) => {
                *self
                    .fleet_owned
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = owned.clone();
                owned
            }
            Err(_) => self
                .fleet_owned
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone(),
        };
        self.all()
            .into_iter()
            .filter(|session| !owned.contains(&fleet_key(&session.target)))
            .collect()
    }
}

pub(super) fn fleet_key(target: &Target) -> Target {
    match target.kind {
        SessionKind::GrokOpen => Target::new(SessionKind::Grok, target.id.clone()),
        _ => target.clone(),
    }
}
