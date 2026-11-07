//! What a build of the core knows about sessions beyond what this
//! computer's discovery finds: sessions that run off this computer, such as
//! Devin Cloud and Claude Code on the web, which it lists and delivers into,
//! and where a harness keeps the sessions its catalog names. An unsupported
//! internal seam, like
//! [`AccountPlugin`](crate::relay::daemon::plugins::AccountPlugin): a core
//! without sources lists only the sessions this computer holds.

use crate::relay::inject::InjectOutcome;
use crate::relay::local::LocalConfig;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{SessionKind, Target};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

/// Where Hermes keeps the sessions a build's catalog names by
/// `<namespace>:<hex native id>`.
pub trait HermesRoots: Send + Sync + 'static {
    /// Every Hermes home to look in, and the native default one (`~/.hermes`)
    /// when it is among them; `None` when they cannot be read.
    fn roots(&self) -> Option<(Vec<PathBuf>, Option<PathBuf>)>;
}

/// The session sources a build adds.
#[derive(Clone, Default)]
pub struct SessionSources {
    /// The sessions off this computer, asked in order.
    pub remote: RemoteSources,
    /// Hermes's homes, which make Hermes titles editable; without them they
    /// are not.
    pub hermes: Option<Arc<dyn HermesRoots>>,
}

impl std::fmt::Debug for SessionSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionSources")
            .field("remote", &self.remote)
            .field("hermes", &self.hermes.is_some())
            .finish()
    }
}

/// One source of remote sessions.
pub trait RemoteSessions: Send + Sync + 'static {
    /// The remote sessions of `kind` this source lists for a discovery pass.
    fn sessions(&self, config: &LocalConfig, kind: SessionKind) -> Vec<DiscoveredSession>;

    /// Sessions that are never listed, nor shown offline once registered.
    fn hidden(&self, _config: &LocalConfig) -> HashSet<Target> {
        HashSet::new()
    }

    /// Whether `session`, which this source listed, may join the relay by
    /// itself; `None` when it is not this source's.
    fn may_join(&self, _session: &DiscoveredSession) -> Option<bool> {
        None
    }

    /// Delivers `text` into `target` when nothing on this computer holds it;
    /// `None` when this source cannot reach it.
    fn send(&self, _config: &LocalConfig, _target: &Target, _text: &str) -> Option<InjectOutcome> {
        None
    }
}

/// The remote session sources a build adds, asked in order.
#[derive(Clone, Default)]
pub struct RemoteSources(pub Vec<Arc<dyn RemoteSessions>>);

impl std::fmt::Debug for RemoteSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RemoteSources({})", self.0.len())
    }
}

impl RemoteSources {
    pub fn sessions(&self, config: &LocalConfig, kind: SessionKind) -> Vec<DiscoveredSession> {
        self.0
            .iter()
            .flat_map(|source| source.sessions(config, kind))
            .collect()
    }

    pub fn hidden(&self, config: &LocalConfig) -> HashSet<Target> {
        self.0
            .iter()
            .flat_map(|source| source.hidden(config))
            .collect()
    }

    /// Whether a listed remote session may join by itself: what its source
    /// says, or no.
    pub fn may_join(&self, session: &DiscoveredSession) -> bool {
        self.0
            .iter()
            .find_map(|source| source.may_join(session))
            .unwrap_or(false)
    }

    pub fn send(&self, config: &LocalConfig, target: &Target, text: &str) -> Option<InjectOutcome> {
        self.0
            .iter()
            .find_map(|source| source.send(config, target, text))
    }
}
