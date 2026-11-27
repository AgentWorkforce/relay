//! Antigravity desktop: kernel-held conversations, transcript-witnessed caller
//! identification, and lifecycle-hook delivery (`~/.gemini/config/hooks.json`).
//! Passive history acquisition remains in RelayHistory's `antigravity` provider.
use crate::relay::codex::turn_hook::TurnInbox;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

pub mod caller;
mod delivery;
pub mod proof;
mod receipts;
mod sessions;
mod settings;
#[cfg(test)]
mod tests;

pub use delivery::send;
pub use receipts::final_answer;
pub use sessions::{discover, hook_answer, session};
pub use settings::AntigravitySettings;

#[derive(Clone)]
pub struct AntigravityConfig {
    pub home: PathBuf,
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
    pub development: bool,
    inbox: Arc<TurnInbox>,
    helper: Arc<RwLock<PathBuf>>,
}

impl std::fmt::Debug for AntigravityConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AntigravityConfig")
            .field("home", &self.home)
            .field("data_dir", &self.data_dir)
            .field("config_dir", &self.config_dir)
            .field("development", &self.development)
            .finish()
    }
}

impl AntigravityConfig {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> Self {
        let data_dir = env("ANTIGRAVITY_APP_DATA_DIR")
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".gemini/antigravity"));
        let config_dir = home.join(".gemini/config");
        Self {
            home: home.into(),
            data_dir,
            config_dir,
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

    pub fn conversations(&self) -> PathBuf {
        self.data_dir.join("conversations")
    }

    pub fn brain(&self) -> PathBuf {
        self.data_dir.join("brain")
    }

    pub fn summaries_db(&self) -> PathBuf {
        self.data_dir.join("conversation_summaries.db")
    }

    pub fn hooks_file(&self) -> PathBuf {
        self.config_dir.join("hooks.json")
    }

    pub fn state(&self) -> PathBuf {
        self.home
            .join(".agentworkforce/desktop")
            .join(if self.development {
                "antigravity-dev"
            } else {
                "antigravity"
            })
    }

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

/// Aliases share their owner's hook inbox. A replaced registration is not an
/// alias and cannot acquire the replacement's delivery binding.
pub(crate) fn delivery_registration(
    store: &crate::relay::store::Store,
    registration: &crate::relay::store::Registration,
) -> Option<crate::relay::store::Registration> {
    if registration.target.kind != crate::relay::store::SessionKind::Antigravity {
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
