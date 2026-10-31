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
    pub(super) fn retained(&self) -> Vec<DiscoveredSession> {
        self.threads.clone()
    }

    /// Retained rows describe presentation, never a successful fresh proof.
    /// A native rename also invalidates provider reads that started before it.
    fn finish_fresh(
        &mut self,
        revision: u64,
        threads: Option<Vec<DiscoveredSession>>,
    ) -> Option<Vec<DiscoveredSession>> {
        let threads = threads?;
        if revision != self.revision {
            return None;
        }
        Some(self.finish(revision, Some(threads)))
    }

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
    fn all(&self) -> Vec<DiscoveredSession> {
        self.collect_partitions(|partition| {
            self.provider_sessions(partition).unwrap_or_else(|| {
                self.codex_threads
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .retained()
            })
        })
    }

    /// Automatic admission needs fresh evidence, not retained presentation.
    pub(super) fn fresh_sessions(&self) -> Vec<DiscoveredSession> {
        self.refresh_fleet_ownership();
        self.without_fleet_owned(
            self.collect_partitions(|partition| {
                self.provider_sessions(partition).unwrap_or_default()
            }),
        )
    }

    fn collect_partitions(
        &self,
        discover: impl FnMut(SessionPartition) -> Vec<DiscoveredSession>,
    ) -> Vec<DiscoveredSession> {
        self.presentation_partitions()
            .into_iter()
            .filter(|partition| {
                !matches!(
                    partition,
                    SessionPartition::OpenClaw | SessionPartition::Hermes
                )
            })
            .flat_map(discover)
            .chain(self.gateway_sessions())
            .collect()
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
        self.refresh_fleet_ownership();
        self.without_fleet_owned(self.all())
    }

    pub(super) fn refresh_fleet_ownership(&self) {
        // While a broker cannot be read, the last known ownership stands;
        // registering any session reads ownership fresh and fails closed.
        if let Ok(owned) = self.config.fleet.managed_targets_blocking() {
            *self
                .fleet_owned
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = owned;
        }
    }

    pub(super) fn without_fleet_owned(
        &self,
        mut sessions: Vec<DiscoveredSession>,
    ) -> Vec<DiscoveredSession> {
        // Keep the full pass's existing ID collision rule: a local/earlier
        // provider row shadows a Devin Cloud row, before fleet filtering.
        // Gateways were appended after Devin and do not take part.
        if sessions
            .iter()
            .any(|row| row.host.as_deref() == Some(crate::relay::devin_cloud::CLOUD_HOST))
        {
            let held: HashSet<String> = sessions
                .iter()
                .filter(|row| {
                    row.host.as_deref() != Some(crate::relay::devin_cloud::CLOUD_HOST)
                        && !matches!(row.target.kind, SessionKind::OpenClaw | SessionKind::Hermes)
                })
                .map(|row| row.target.id.clone())
                .collect();
            sessions.retain(|row| {
                row.host.as_deref() != Some(crate::relay::devin_cloud::CLOUD_HOST)
                    || !held.contains(&row.target.id)
            });
        }
        let owned = self
            .fleet_owned
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        sessions.retain(|row| !owned.contains(&fleet_key(&row.target)));
        sessions
    }

    pub(super) fn provider_sessions(
        &self,
        partition: SessionPartition,
    ) -> Option<Vec<DiscoveredSession>> {
        let found = match partition {
            SessionPartition::All => self.all(),
            SessionPartition::Codex => return self.codex_sessions(),
            SessionPartition::Claude => {
                let mut found = claude::discover(&self.config.claude, &*self.table);
                // Claude Code on the web sessions the history catalogs list.
                crate::relay::claude_web::extend(&self.config, &mut found);
                found
            }
            SessionPartition::Grok => self.grok_sessions(),
            SessionPartition::Muse => self.muse_sessions(),
            SessionPartition::Pi => self.pi_sessions(),
            SessionPartition::OpenCode => self.opencode_sessions(),
            SessionPartition::Devin => self.devin_sessions(),
            SessionPartition::CursorCli => {
                cursor_cli::discover(&self.config.cursor, &*self.table, self.config.uid)
            }
            SessionPartition::OpenClaw => self
                .config
                .openclaw
                .as_ref()
                .filter(|c| c.enabled())
                .map(|config| self.openclaw.sessions(config))
                .unwrap_or_default(),
            SessionPartition::Hermes => self
                .config
                .hermes
                .as_ref()
                .filter(|c| c.enabled())
                .map(|config| self.hermes.sessions(config))
                .unwrap_or_default(),
        };
        Some(found)
    }

    fn codex_sessions(&self) -> Option<Vec<DiscoveredSession>> {
        let revision = self
            .codex_threads
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .revision;
        let threads = codex::try_discover(&self.config.codex, &*self.table, self.config.uid);
        self.codex_threads
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .finish_fresh(revision, threads)
    }

    fn grok_sessions(&self) -> Vec<DiscoveredSession> {
        let mut found = Vec::new();
        // Each Grok row is offered exactly when delivery would use it: a
        // managed row is judged by the same per-session claim `grok_route`
        // reads, so a session both routes claim, or one whose claim cannot
        // be read, is listed under neither kind.
        if let Some(managed) = &self.managed {
            let routed = |session: &DiscoveredSession| {
                session.target.kind != SessionKind::Grok
                    || self.config.existing_grok.is_none()
                    || matches!(
                        existing_grok_claim(
                            &self.config,
                            &self.table,
                            self.managed.as_deref(),
                            &session.target.id,
                        ),
                        Ok(ExistingClaim::Absent)
                    )
            };
            found.extend(
                managed
                    .sessions_for(SessionKind::Grok)
                    .into_iter()
                    .filter(routed),
            );
        }
        if let Ok(existing) =
            existing_grok_bindings(&self.config, &self.table, self.managed.as_deref())
        {
            // A proved binding says the leader runs, not that the client
            // does: the shared leader outlives a closed TUI. The row is live
            // only while the session is still deliverable: the TUI registry
            // lists it, or the Paseo stdio client is attached to a leader
            // that is running.
            let open =
                crate::relay::grok::open_sessions(&self.config.grok, &*self.table, self.config.uid);
            let hosted: HashSet<String> =
                crate::relay::grok::paseo_sessions(&*self.table, self.config.uid)
                    .into_iter()
                    .map(|session| session.session_id)
                    .collect();
            found.extend(existing.free.iter().map(|binding| {
                let live = open.iter().any(|session| {
                    session.session_id == binding.session_id
                        && session.cwd.as_deref().is_some_and(|cwd| {
                            Path::new(cwd) == binding.cwd
                                || std::fs::canonicalize(cwd).ok()
                                    == std::fs::canonicalize(&binding.cwd).ok()
                        })
                });
                DiscoveredSession {
                    title: crate::relay::grok::binding_title(binding, &*self.table)
                        .unwrap_or_else(|| format!("Grok {}", binding.model_id)),
                    live,
                    host: hosted
                        .contains(&binding.session_id)
                        .then(|| crate::relay::paseo::HOST.to_string()),
                    ..enablement::session(binding)
                }
            }));
            found.extend(self.open_grok_sessions(&existing));
        }
        found
    }

    fn muse_sessions(&self) -> Vec<DiscoveredSession> {
        let mut found = Vec::new();
        // Open Muse sessions the person started, delivered to through a
        // probe-owned courier. On by default (`AGENT_RELAY_ENABLE_MUSE_OPEN=0`
        // turns it off). A TUI is read from this probe's registry when that
        // directory exists. A `muse serve` session Paseo drives is listed
        // from that process even when this probe has no Muse directory: its
        // log is in the process's own store.
        if self.config.muse_open {
            found.extend(crate::relay::muse::discover(
                &self.config.muse,
                &*self.table,
                self.config.uid,
                true,
                &|_| false,
            ));
        }
        found
    }

    fn pi_sessions(&self) -> Vec<DiscoveredSession> {
        let mut found = Vec::new();
        found.extend(crate::relay::pi::discover(
            &self.config.pi,
            &*self.table,
            self.config.uid,
        ));
        found
    }

    fn opencode_sessions(&self) -> Vec<DiscoveredSession> {
        let mut found = Vec::new();
        if let Some(managed) = &self.managed {
            found.extend(managed.sessions_for(SessionKind::OpenCode));
        }
        // OpenCode sessions held by a process running Agent Relay's plugin,
        // which the person installs from Settings.
        if self.config.opencode_open && self.config.opencode.installed() {
            found.extend(crate::relay::opencode::discover(
                &self.config.opencode,
                &*self.table,
                self.config.uid,
            ));
            // OpenCode windows opened before the plugin was on: listed, not
            // live, until OpenCode restarts.
            found.extend(crate::relay::opencode::needing_restart(
                &self.config.opencode,
                &*self.table,
                self.config.uid,
            ));
        }
        found
    }

    fn devin_sessions(&self) -> Vec<DiscoveredSession> {
        let mut found = Vec::new();
        lock_held::discover_devin(&self.config, &*self.table, &mut found);
        found
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

    #[test]
    fn retained_rename_is_not_fresh_authority_after_failure_or_an_old_read() {
        let mut cache = CodexDiscoveryCache::default();
        cache
            .finish_fresh(0, Some(vec![thread("Old title")]))
            .unwrap();
        let in_flight = cache.revision;
        cache.renamed(&thread("").target.id, "Confirmed title");
        assert!(cache
            .finish_fresh(in_flight, Some(vec![thread("Old title")]))
            .is_none());
        assert_eq!(cache.retained()[0].title, "Confirmed title");
        assert!(cache.finish_fresh(cache.revision, None).is_none());
        assert_eq!(cache.retained()[0].title, "Confirmed title");
        let fresh = cache
            .finish_fresh(cache.revision, Some(vec![thread("External title")]))
            .unwrap();
        assert_eq!(fresh[0].title, "External title");
        assert_eq!(cache.retained()[0].title, "External title");
    }
}
