//! Verified managed discovery and native provider title readback.
use super::*;

impl ManagedSessions {
    /// Picker rows are exclusively valid, enabled, live registry records.
    pub fn sessions(&self) -> Vec<DiscoveredSession> {
        if self.enabled.is_empty() {
            return Vec::new();
        }
        self.read_records()
            .unwrap_or_default()
            .into_iter()
            .filter(|record| !record.spawned && self.enabled.contains(&record.binding.kind()))
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
