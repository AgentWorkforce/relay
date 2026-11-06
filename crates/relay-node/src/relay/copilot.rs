//! Copilot in VS Code: native, kernel-held sessions and lifecycle-hook delivery.
//! History acquisition remains in RelayHistory's `copilot` provider.
use crate::relay::codex::turn_hook::TurnInbox;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
pub mod proof;
mod settings;
pub use settings::CopilotSettings;
mod sessions;
pub use sessions::{discover, hook_answer, session};
mod receipts;
pub use receipts::{context_accepted, final_answer};
mod delivery;
pub use delivery::send;

#[derive(Clone)]
pub struct CopilotConfig {
    pub home: PathBuf,
    pub data_dir: PathBuf,
    pub development: bool,
    inbox: Arc<TurnInbox>,
    helper: Arc<RwLock<PathBuf>>,
}
impl std::fmt::Debug for CopilotConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CopilotConfig")
            .field("home", &self.home)
            .field("data_dir", &self.data_dir)
            .field("development", &self.development)
            .finish()
    }
}
impl CopilotConfig {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Self {
        let data_dir = env("COPILOT_HOME")
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".copilot"));
        Self {
            home: home.into(),
            data_dir,
            development: false,
            inbox: Arc::new(TurnInbox::default()),
            helper: Arc::new(RwLock::new(
                std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-relay-node")),
            )),
        }
        .development(false)
    }
    pub fn development(mut self, development: bool) -> Self {
        self.development = development;
        self.inbox = Arc::new(TurnInbox::open(self.state().join("claims.json")).retain_claims());
        self
    }
    pub fn sessions(&self) -> PathBuf {
        self.data_dir.join("session-state")
    }
    pub fn state(&self) -> PathBuf {
        self.home
            .join(".agentworkforce/desktop")
            .join(if self.development {
                "copilot-dev"
            } else {
                "copilot"
            })
    }
    pub fn hooks_file(&self) -> PathBuf {
        self.data_dir.join("hooks").join(if self.development {
            "agent-relay-dev.json"
        } else {
            "agent-relay.json"
        })
    }
    /// The embedder chooses the installed helper, independently of user hook JSON.
    pub fn set_helper(&self, executable: PathBuf) {
        *self.helper.write().unwrap_or_else(|e| e.into_inner()) = executable;
    }
    fn helper(&self) -> PathBuf {
        self.helper
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn enabled(&self) -> bool {
        settings::installed_state(self).unwrap_or(false)
    }
    fn prepare(&self) -> std::io::Result<()> {
        crate::platform::fs::create_private_dir_all(&self.state())
    }
}

#[cfg(test)]
mod tests;

/// Aliases share their owner's hook inbox. A replaced registration is not an
/// alias and cannot acquire the replacement's delivery binding.
pub(crate) fn delivery_registration(
    store: &crate::relay::store::Store,
    registration: &crate::relay::store::Registration,
) -> Option<crate::relay::store::Registration> {
    if registration.target.kind != crate::relay::store::SessionKind::Copilot {
        return Some(registration.clone());
    }
    let owner = store.registration_for(&registration.target)?;
    if registration.agent_id == owner.agent_id && registration.registered_at != owner.registered_at
    {
        return None;
    }
    owner
        .agent_ids()
        .contains(&registration.agent_id)
        .then(|| owner.clone())
}
