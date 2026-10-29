//! Session discovery and kernel-authenticated caller operations.
use super::*;
mod mobile_claude_roots;
mod session_activity;

impl SessionDirectory for LocalSessions {
    fn mobile_claude_config_roots(&self) -> std::collections::BTreeMap<Target, PathBuf> {
        mobile_claude_roots::read(&self.config.claude, &*self.table)
    }

    fn mobile_claude_incarnation(
        &self,
        expected: &crate::relay::mobile_handoff::Runtime,
    ) -> Option<bool> {
        Some(self.table.process(expected.pid).is_some_and(|process| {
            process.uid == self.config.uid && process.start == expected.start
        }))
    }

    fn mobile_claude_runtime(
        &self,
        target: &Target,
        caller_pid: i32,
    ) -> Option<crate::relay::mobile_handoff::Runtime> {
        if !crate::relay::claude_mobile_plugin::supported()
            || target.kind != SessionKind::ClaudeTerminal
        {
            return None;
        }
        let registry = claude::registry(&self.config.claude, &*self.table);
        let mut matches = registry
            .sessions
            .iter()
            .filter(|session| session.session_id == target.id);
        let session = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        if !matches!(session.kind.as_deref()?, "background" | "interactive") {
            return None;
        }
        // The native Mods HTTP client runs inside Claude itself. A tool,
        // shell, or bridge-helper child is not a trusted native permission
        // or result source, even when ordinary Relay routes identify it.
        if caller_pid != session.pid {
            return None;
        }
        let process = self.table.process(session.pid)?;
        if process.uid != self.config.uid
            || !claude_start_matches(
                self.table.start_clock(),
                session.proc_start.as_deref()?,
                &process,
            )
        {
            return None;
        }
        Some(crate::relay::mobile_handoff::Runtime {
            pid: process.pid,
            start: process.start,
            idle: session.is_idle(),
        })
    }

    fn title_capability(
        &self,
        source: &str,
        session_id: &str,
    ) -> crate::relay::contract::agents::SessionTitleCapability {
        self.native_title_capability(source, session_id)
    }

    fn set_title(&self, source: &str, session_id: &str, title: &str) -> Result<String, String> {
        self.set_native_title(source, session_id, title)
    }

    fn sessions(&self) -> Vec<DiscoveredSession> {
        self.discovered_sessions()
    }

    fn presentation_partitions(&self) -> Vec<SessionPartition> {
        vec![
            SessionPartition::Codex,
            SessionPartition::Claude,
            SessionPartition::Grok,
            SessionPartition::Muse,
            SessionPartition::Pi,
            SessionPartition::OpenCode,
            SessionPartition::Devin,
            SessionPartition::CursorCli,
            SessionPartition::OpenClaw,
            SessionPartition::Hermes,
        ]
    }

    fn discover_partition(&self, partition: SessionPartition) -> Option<Vec<DiscoveredSession>> {
        self.provider_sessions(partition)
    }

    fn refresh_presentation_authority(&self) {
        self.refresh_fleet_ownership();
    }

    fn filter_presentation(&self, sessions: Vec<DiscoveredSession>) -> Vec<DiscoveredSession> {
        self.without_fleet_owned(sessions)
    }

    fn find_session(&self, target: &Target) -> Option<DiscoveredSession> {
        // Explicit registration does not trust presentation's retained rows.
        self.refresh_fleet_ownership();
        self.without_fleet_owned(self.provider_sessions(SessionPartition::for_target(target))?)
            .into_iter()
            .find(|row| &row.target == target)
    }

    fn auto_activation_sessions(&self) -> Vec<DiscoveredSession> {
        let eligible = self.activation_check();
        self.fresh_sessions()
            .into_iter()
            .filter(|session| eligible(session))
            .collect()
    }

    fn auto_activates(&self, session: &DiscoveredSession) -> bool {
        (self.activation_check())(session)
    }

    fn activity(
        &self,
        sessions: &[(Target, Option<String>)],
    ) -> HashMap<Target, crate::relay::activity::SessionActivity> {
        self.session_activity(sessions)
    }

    fn archived(&self, targets: &[Target]) -> HashSet<Target> {
        let of_kind = |kinds: &[SessionKind]| {
            targets
                .iter()
                .filter(|target| kinds.contains(&target.kind))
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>()
        };
        let codex = of_kind(&[SessionKind::Codex]);
        let codex = codex::threads::archived_ids(&self.config.codex, codex);
        let opencode = of_kind(&[SessionKind::OpenCode, SessionKind::OpenCodeOpen]);
        let opencode = crate::relay::opencode::archived_ids(&self.config.opencode, opencode);
        // A Claude app session's archive is learned from the send it
        // refuses; the other kinds have no archive.
        targets
            .iter()
            .filter(|target| match target.kind {
                SessionKind::Codex => codex.contains(&target.id),
                SessionKind::OpenCode | SessionKind::OpenCodeOpen => opencode.contains(&target.id),
                _ => false,
            })
            .cloned()
            .collect()
    }

    fn cleared(&self, targets: &[Target]) -> Vec<(Target, Target, i64)> {
        targets
            .iter()
            .filter(|target| target.kind == SessionKind::ClaudeTerminal)
            .filter_map(|target| {
                let cleared = claude::cleared(&self.config.claude, &*self.table, &target.id)?;
                Some((
                    target.clone(),
                    Target::new(SessionKind::ClaudeTerminal, cleared.session_id),
                    cleared.at_ms,
                ))
            })
            .collect()
    }

    fn caller(&self, pid: i32) -> Result<DiscoveredSession, CallerMiss> {
        // Everything under this user's OpenClaw Gateway (its Codex runtime
        // and the shells that runs, included) is the Gateway's agent, so
        // an inherited Codex thread tag never names the caller.
        let target = match self.openclaw_caller(pid) {
            Some(caller) => caller?,
            None => self.caller_target(pid)?,
        };
        // Named from the session's own state, never by scanning every
        // process: identifying a caller reads only its ancestry.
        let found = match target.kind {
            SessionKind::Codex => codex::thread(&self.config.codex, &target.id),
            SessionKind::ClaudeTerminal => {
                claude::terminal_session(&self.config.claude, &*self.table, &target.id).map(
                    |session| DiscoveredSession {
                        target: target.clone(),
                        title: session.display_name(),
                        directory: session.cwd.clone(),
                        updated_at_ms: session.updated_at_ms,
                        host: if claude::is_paseo_chat(
                            &*self.table,
                            &session,
                            &claude::registry(&self.config.claude, &*self.table).sessions,
                        ) {
                            Some(crate::relay::paseo::HOST.to_string())
                        } else {
                            crate::relay::conductor::host(session.cwd.as_deref())
                        },
                        live: true,
                        holder: Some(claude::holder(&session)),
                    },
                )
            }
            SessionKind::Grok => grok_caller::session(&self.config, &self.table, &target),
            SessionKind::GrokOpen => crate::relay::grok::discover(
                &self.config.grok,
                &*self.table,
                self.config.uid,
                true,
                &|_| false,
            )
            .into_iter()
            .find(|row| row.target == target),
            SessionKind::MuseOpen => crate::relay::muse::discover(
                &self.config.muse,
                &*self.table,
                self.config.uid,
                true,
                &|_| false,
            )
            .into_iter()
            .find(|row| row.target == target),
            SessionKind::OpenCodeOpen => crate::relay::opencode::discover(
                &self.config.opencode,
                &*self.table,
                self.config.uid,
            )
            .into_iter()
            .find(|row| row.target == target),
            SessionKind::Devin => crate::relay::devin::session(
                &self.config.devin,
                &*self.table,
                self.config.uid,
                &target.id,
            ),
            SessionKind::CursorCli => crate::relay::cursor_cli::session(
                &self.config.cursor,
                &*self.table,
                self.config.uid,
                &target.id,
            ),
            SessionKind::ClaudeCloud
            | SessionKind::OpenCode
            | SessionKind::OpenClaw
            | SessionKind::Hermes
            | SessionKind::Pi => None,
        };
        Ok(found
            .map(|s| DiscoveredSession { live: true, ..s })
            .unwrap_or_else(|| DiscoveredSession {
                title: match target.kind {
                    SessionKind::Codex => "Codex session".into(),
                    SessionKind::ClaudeTerminal | SessionKind::ClaudeCloud => {
                        "Claude Code session".into()
                    }
                    SessionKind::Grok | SessionKind::GrokOpen => "Grok session".into(),
                    SessionKind::OpenCode | SessionKind::OpenCodeOpen => "OpenCode session".into(),
                    SessionKind::MuseOpen => "Muse session".into(),
                    SessionKind::Devin => "Devin session".into(),
                    SessionKind::CursorCli => "Cursor CLI session".into(),
                    SessionKind::OpenClaw => "OpenClaw agent".into(),
                    SessionKind::Hermes => "Hermes".into(),
                    SessionKind::Pi => "Pi session".into(),
                },
                target,
                directory: None,
                updated_at_ms: None,
                holder: None,
                host: None,
                live: true,
            }))
    }

    fn holds_codex_thread(&self, pid: i32, thread: &str) -> bool {
        crate::relay::process::has_codex_writer_for_caller(
            &*self.table,
            pid,
            self.config.uid,
            thread,
        )
    }

    fn unreadable_session_files(&self) -> Vec<UnreadableSessionFile> {
        claude::registry(&self.config.claude, &*self.table).unreadable
    }

    fn fleet_owned(&self, target: &Target) -> Result<bool, String> {
        self.config
            .fleet
            .managed_targets_blocking()
            .map(|owned: HashSet<Target>| owned.contains(&fleet_key(target)))
            .map_err(|error| error.message)
    }

    fn launch_managed(&self, launch: ManagedLaunch) -> Result<DiscoveredSession, String> {
        self.managed
            .as_ref()
            .ok_or_else(|| "Managed provider launch is unavailable.".to_string())?
            .launch(launch)
    }

    fn route_binding(&self, target: &Target) -> Option<String> {
        self.live_route_binding(target)
    }

    fn register_existing(
        &self,
        request: enablement::OpenLeaderRequest,
    ) -> Result<DiscoveredSession, String> {
        self.register_existing_with(request, &|binding, authority| {
            crate::relay::existing_session::grok::inspect_session(
                binding,
                authority,
                EXISTING_GROK_INSPECT_TIMEOUT,
            )
        })
    }

    fn managed_authority(
        &self,
        target: &Target,
    ) -> Option<crate::relay::managed_sessions::ManagedAuthority> {
        if !matches!(target.kind, SessionKind::Grok | SessionKind::GrokOpen) {
            return self.managed.as_ref()?.authority(target);
        }
        match grok_route(&self.config, &self.table, self.managed.as_deref(), target) {
            GrokRoute::Managed(binding) => Some(binding.authority()),
            GrokRoute::Existing(binding) => Some(ManagedAuthority {
                workspace_id: binding.workspace_id,
                owner_id: binding.owner_id,
                owner_uid: binding.owner_uid,
            }),
            GrokRoute::Ambiguous | GrokRoute::Unavailable | GrokRoute::None => None,
        }
    }
}

impl LocalSessions {
    /// Whether automatic activation puts `session` on the relay: one
    /// predicate for activation itself and for `/setup/status`'s
    /// `auto_activates`, so the SessionStart hook never promises a join
    /// activation would not make.
    fn activation_check(&self) -> impl Fn(&DiscoveredSession) -> bool + '_ {
        let claude_sessions = claude::registry(&self.config.claude, &*self.table).sessions;
        let grok_reachable = move |session_id: &str| self.grok_open_reachable(session_id);
        let automated = std::cell::OnceCell::new();
        let started_by_automation = move |session_id: &str| {
            automated
                .get_or_init(|| {
                    self.config
                        .probe_root
                        .as_deref()
                        .map(crate::relay::devin_cloud::started_by_automation)
                        .unwrap_or_default()
                })
                .contains(session_id)
        };
        move |session: &DiscoveredSession| {
            if !session.live {
                return false;
            }
            // A Devin Cloud row's `live` already proved this machine's
            // sign-in can reach it — the caller proof a local lock
            // proves for a local row — so it activates the same way,
            // and a remote directory has nothing local to exclude. One
            // an automation started (a Devin review) has nobody in it
            // to talk to, so it never joins.
            if session.target.kind == SessionKind::Devin
                && session.host.as_deref() == Some(crate::relay::devin_cloud::CLOUD_HOST)
            {
                return !started_by_automation(&session.target.id);
            }
            if let Some(admitted) = self.gateway_admits(session.target.kind) {
                return admitted;
            }
            let Some(directory) = session.directory.as_deref().map(Path::new) else {
                return false;
            };
            if is_under(directory, &self.config.auto_activate_excluded_dirs) {
                return false;
            }
            match session.target.kind {
                SessionKind::ClaudeTerminal => {
                    claude::terminal_session(&self.config.claude, &*self.table, &session.target.id)
                        .is_some_and(|terminal| {
                            claude::is_interactive_terminal(&*self.table, &terminal)
                                || claude::is_conductor_chat(
                                    &*self.table,
                                    self.config.uid,
                                    &terminal,
                                    &claude_sessions,
                                )
                                || claude::is_app_hosted_chat(
                                    &*self.table,
                                    &terminal,
                                    &claude_sessions,
                                )
                        })
                }
                SessionKind::Codex => true,
                SessionKind::ClaudeCloud => false,
                // A Grok TUI session is live only while a leader of this
                // user is running, the one route into it; registering it
                // binds and proves that leader first, and a binding that
                // does not prove is refused, so nothing is sent.
                SessionKind::GrokOpen => grok_reachable(&session.target.id),
                // Launched by the probe, which registers it itself.
                SessionKind::Grok | SessionKind::OpenCode => false,
                // An open Muse session registers like a Codex one: the
                // row already admits only live message-capable sessions,
                // and delivery re-proves each one in Muse's own registry
                // on every send, pinning the courier reference.
                SessionKind::MuseOpen => true,
                // Opt-in, like every provider route the plugin opens.
                SessionKind::OpenCodeOpen | SessionKind::Pi => false,
                // A Devin row exists only while a `devin` process holds
                // the session's lock open, which is also its caller
                // proof. Devin Cloud rows return early above; any other
                // hosted row is never activated.
                SessionKind::Devin => session.host.is_none(),
                // A Cursor CLI row exists only while a `cursor-agent`
                // holds its conversation open, which is also its caller
                // proof; like Codex, it joins only with the opt-in.
                SessionKind::CursorCli => true,
                SessionKind::OpenClaw | SessionKind::Hermes => false,
            }
        }
    }
}
