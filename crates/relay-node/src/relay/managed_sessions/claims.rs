//! Private immutable registry claims used by caller identity verification.
use super::*;
impl ManagedSessions {
    /// Every Grok binding this registry holds, live or not and whether or not
    /// its flag is on. The already-open route treats each as a claim on its
    /// session and its leader. An unreadable registry is an error, never an
    /// empty claim set.
    pub fn grok_claims(&self) -> std::io::Result<Vec<existing_session::Binding>> {
        Ok(self
            .read_records()?
            .into_iter()
            .filter_map(|record| match record.binding {
                ManagedBinding::Grok(binding) => Some(binding),
                ManagedBinding::OpenCode(_) => None,
            })
            .collect())
    }

    pub fn opencode_claims(&self) -> std::io::Result<Vec<opencode_existing::Binding>> {
        Ok(self
            .read_records()?
            .into_iter()
            .filter_map(|record| match record.binding {
                ManagedBinding::OpenCode(binding) => Some(binding),
                ManagedBinding::Grok(_) => None,
            })
            .collect())
    }
}
