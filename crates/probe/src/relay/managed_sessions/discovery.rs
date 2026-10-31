//! Verified managed discovery and native provider title readback.
use super::*;

impl ManagedSessions {
    /// Picker rows are exclusively valid, enabled, live registry records.
    pub fn sessions(&self) -> Vec<DiscoveredSession> {
        self.sessions_matching(|_| true)
    }

    /// Restrict verification to the requested provider before any runtime I/O.
    pub fn sessions_for(&self, kind: SessionKind) -> Vec<DiscoveredSession> {
        self.sessions_matching(|candidate| candidate == kind)
    }

    fn sessions_matching(&self, includes: impl Fn(SessionKind) -> bool) -> Vec<DiscoveredSession> {
        if self.enabled.is_empty() {
            return Vec::new();
        }
        self.read_records()
            .unwrap_or_default()
            .into_iter()
            .filter(|record| {
                !record.spawned
                    && self.enabled.contains(&record.binding.kind())
                    && includes(record.binding.kind())
            })
            .filter_map(|record| {
                let title = self.runtime.verified_title(&record.binding).ok()?;
                let mut session = record.session(true);
                if let Some(title) = title {
                    session.title = title;
                }
                Some(session)
            })
            .collect()
    }
}

pub(super) fn verified_title(
    runtime: &SystemManagedRuntime,
    binding: &ManagedBinding,
) -> Result<Option<String>, ()> {
    match binding {
        ManagedBinding::OpenCode(binding) => {
            // This replaces verify's GET, keeping the existing five-second
            // discovery bound and reading subsequent external renames too.
            let metadata = opencode_existing::inspect_session_metadata(
                &*runtime.table,
                &runtime.http,
                binding,
                Duration::from_secs(5),
            )
            .map_err(|_| ())?;
            if metadata.project_id != binding.project_id
                || metadata.workspace_id != binding.opencode_workspace_id
            {
                return Err(());
            }
            Ok(metadata.title)
        }
        ManagedBinding::Grok(native) => {
            if !runtime.verify(binding) {
                return Err(());
            }
            Ok(crate::relay::grok::binding_title(
                native,
                runtime.table.as_ref(),
            ))
        }
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Runtime(Mutex<Vec<SessionKind>>);
    impl ManagedRuntime for Runtime {
        fn launch(&self, _: &ManagedLaunch, _: &Path) -> Result<ManagedBinding, ()> {
            Err(())
        }
        fn verify(&self, binding: &ManagedBinding) -> bool {
            self.0.lock().unwrap().push(binding.kind());
            true
        }
    }

    #[test]
    fn provider_filter_precedes_verification_and_keeps_existing_picker_predicates() {
        let home = tempfile::tempdir().unwrap();
        let runtime = Arc::new(Runtime::default());
        let manager = ManagedSessions::new(
            home.path().join("registry"),
            HashSet::from([SessionKind::Grok, SessionKind::OpenCode]),
            runtime.clone(),
        );
        let binding = ManagedBinding::OpenCode(opencode_existing::Binding {
            relay_workspace_id: "rw_fixture".into(),
            owner_id: "fixture".into(),
            session_id: "ses_fixture".into(),
            endpoint: "http://127.0.0.1:1".into(),
            server_pid: 42,
            server_start: 99,
            server_uid: current_uid(),
            executable: home.path().join("opencode"),
            directory: home.path().join("project"),
            project_id: "project".into(),
            opencode_workspace_id: None,
            credential_reference: format!("probe:opencode:{}", "a".repeat(64)),
        });
        manager.prepare_root().unwrap();
        manager
            .with_registry_lock(|records| {
                records.push(seal(Record {
                    binding: binding.clone(),
                    spawned: false,
                })?);
                records.push(seal(Record {
                    binding,
                    spawned: true,
                })?);
                manager.write_registry(records)
            })
            .unwrap();
        assert!(manager.sessions_for(SessionKind::Grok).is_empty());
        assert!(
            runtime.0.lock().unwrap().is_empty(),
            "unrelated verification never starts"
        );
        let selected = manager.sessions_for(SessionKind::OpenCode);
        assert_eq!(
            selected.len(),
            1,
            "spawned endpoints stay out of the picker"
        );
        assert_eq!(*runtime.0.lock().unwrap(), vec![SessionKind::OpenCode]);
        assert_eq!(manager.sessions(), selected);
    }
}
