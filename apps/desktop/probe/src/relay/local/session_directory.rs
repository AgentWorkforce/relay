//! Native title operations and the fleet-filtered session listing.
use super::*;

/// Native renames fence older reads, including the fallback used while the
/// Codex database is unavailable. Do not hold this mutex across provider I/O.
#[derive(Default)]
pub(super) struct CodexDiscoveryCache {
    revision: u64,
    threads: Vec<DiscoveredSession>,
}

impl CodexDiscoveryCache {
    fn finish(
        &mut self,
        revision: u64,
        threads: Option<Vec<DiscoveredSession>>,
    ) -> Vec<DiscoveredSession> {
        if revision == self.revision {
            if let Some(threads) = threads {
                self.threads = threads;
            }
        }
        self.threads.clone()
    }

    fn renamed(&mut self, id: &str, title: &str) {
        self.revision = self.revision.wrapping_add(1);
        for thread in &mut self.threads {
            if thread.target.id.eq_ignore_ascii_case(id) {
                thread.title = title.to_owned();
            }
        }
    }
}

impl LocalSessions {
    pub(super) fn discover_codex_threads(&self) -> Vec<DiscoveredSession> {
        let revision = self
            .codex_threads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .revision;
        let threads = codex::try_discover(&self.config.codex, &*self.table, self.config.uid);
        self.codex_threads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .finish(revision, threads)
    }

    pub(super) fn set_codex_title(
        &self,
        session_id: &str,
        write: impl FnOnce() -> Result<String, String>,
    ) -> Result<String, String> {
        let title = write()?;
        self.codex_threads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .renamed(session_id, &title);
        Ok(title)
    }

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
        if source == "codex" {
            return self.set_codex_title(session_id, || {
                crate::relay::session_titles::set(
                    &self.config,
                    &*self.table,
                    source,
                    session_id,
                    title,
                )
            });
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(title: &str) -> DiscoveredSession {
        DiscoveredSession {
            target: Target::new(SessionKind::Codex, "11111111-2222-3333-4444-555555555555"),
            title: title.into(),
            directory: None,
            updated_at_ms: None,
            live: false,
            host: None,
            holder: None,
        }
    }

    #[test]
    fn confirmed_rename_survives_an_unreadable_database() {
        let mut cache = CodexDiscoveryCache::default();
        let id = thread("Old title").target.id;
        cache.finish(0, Some(vec![thread("Old title")]));
        cache.renamed(&id, "Confirmed title");
        // Discovery starts after the rename, but its database read fails.
        let revision = cache.revision;
        assert_eq!(cache.finish(revision, None)[0].title, "Confirmed title");
        // A later successful provider read may still discover an external rename.
        assert_eq!(
            cache.finish(revision, Some(vec![thread("External title")]))[0].title,
            "External title"
        );
    }

    #[test]
    fn an_in_flight_old_read_cannot_poison_the_renamed_fallback() {
        let mut cache = CodexDiscoveryCache::default();
        cache.finish(0, Some(vec![thread("Old title")]));
        let before = cache.revision;
        cache.renamed(&thread("").target.id, "Confirmed title");
        assert_eq!(
            cache.finish(before, Some(vec![thread("Old title")]))[0].title,
            "Confirmed title"
        );
        assert_eq!(
            cache.finish(cache.revision, None)[0].title,
            "Confirmed title"
        );
    }
}
