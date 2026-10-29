//! The agent sessions on this computer that can be put on the relay.
//!
//! Discovery (Codex threads, Claude Code terminal sessions, Claude app
//! sessions, process trees, liveness, fleet-managed exclusion) is a
//! `SessionDirectory`. The daemon is built with one; until discovery is in,
//! `NoSessions` finds nothing, and registered sessions are offline.

use crate::relay::contract::agents::SessionHolder;
use crate::relay::managed_sessions::{ManagedAuthority, ManagedLaunch};
use crate::relay::store::{SessionKind, Target};
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;

/// A session found on this computer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DiscoveredSession {
    pub target: Target,
    pub title: String,
    /// The working directory, when known.
    pub directory: Option<String>,
    pub updated_at_ms: Option<i64>,
    /// The app hosting the session, when it is not the provider's own.
    pub host: Option<String>,
    /// Whether the session can take a message right now.
    pub live: bool,
    /// What holds the session's transcript, where a provider has the
    /// notion. Only Claude Code does: its sessions are held by exactly one
    /// process, which is why a second one cannot resume them.
    pub holder: Option<SessionHolder>,
}

impl DiscoveredSession {
    /// The directory's last component, retained for names and Cloud records
    /// whose meaning predates the desktop's filesystem-aware presentation.
    /// A Claude app chat's generated scratch folder is no project, so such a
    /// chat is named by its title.
    pub fn project(&self) -> Option<String> {
        let directory = self.directory.as_deref()?.trim_end_matches('/');
        if crate::relay::claude::app::is_scratch_workspace(directory) {
            return None;
        }
        let name = directory.rsplit('/').next()?;
        (!name.is_empty()).then(|| name.to_string())
    }
}

/// A session's own registry file that exists but cannot be parsed, so the
/// running session it names cannot be identified from it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UnreadableSessionFile {
    pub path: PathBuf,
    /// The process the file is named after.
    pub pid: i32,
    /// Why it does not parse.
    pub error: String,
}

/// Why no session is named for a caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallerMiss {
    /// No supported live session is among the caller's ancestors.
    NotASession,
    /// The nearest session around the caller is running, but its own
    /// registry file does not parse.
    Unreadable(UnreadableSessionFile),
}

/// Independent presentation discovery domains. A completed domain replaces only
/// its own rows; an unavailable domain keeps its previous rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SessionPartition {
    All,
    Codex,
    Claude,
    Grok,
    Muse,
    Pi,
    OpenCode,
    Devin,
    CursorCli,
    OpenClaw,
    Hermes,
}

impl SessionPartition {
    pub fn for_target(target: &Target) -> Self {
        match target.kind {
            SessionKind::Codex => Self::Codex,
            SessionKind::ClaudeTerminal | SessionKind::ClaudeCloud => Self::Claude,
            SessionKind::Grok | SessionKind::GrokOpen => Self::Grok,
            SessionKind::MuseOpen => Self::Muse,
            SessionKind::Pi => Self::Pi,
            SessionKind::OpenCode | SessionKind::OpenCodeOpen => Self::OpenCode,
            SessionKind::Devin => Self::Devin,
            SessionKind::CursorCli => Self::CursorCli,
            SessionKind::OpenClaw => Self::OpenClaw,
            SessionKind::Hermes => Self::Hermes,
        }
    }

    pub fn contains(self, target: &Target) -> bool {
        self == Self::All || self == Self::for_target(target)
    }
}

pub trait SessionDirectory: Send + Sync + 'static {
    /// Unique live Claude session config roots, refreshed during discovery.
    /// Ambiguous IDs must be absent. Capability checks use the core's cache.
    fn mobile_claude_config_roots(&self) -> std::collections::BTreeMap<Target, std::path::PathBuf> {
        Default::default()
    }

    /// Provider registry plus kernel identity; never supplied by an incoming message.
    fn mobile_claude_runtime(
        &self,
        _target: &Target,
        _caller_pid: i32,
    ) -> Option<crate::relay::mobile_handoff::Runtime> {
        None
    }

    /// Kernel evidence independent of a provider's registry rewrite.
    /// `None` is unknown and must not revoke a durable native generation.
    fn mobile_claude_incarnation(
        &self,
        _expected: &crate::relay::mobile_handoff::Runtime,
    ) -> Option<bool> {
        None
    }

    /// The sessions on this computer now, without those a fleet worker
    /// already owns. May block; called on a blocking thread.
    fn sessions(&self) -> Vec<DiscoveredSession>;

    /// Fixed, disjoint discovery domains. At most one presentation task is
    /// in flight per domain. Legacy directories retain their whole-list pass.
    fn presentation_partitions(&self) -> Vec<SessionPartition> {
        vec![SessionPartition::All]
    }

    /// `None` means unavailable, never an authoritative empty listing.
    fn discover_partition(&self, _partition: SessionPartition) -> Option<Vec<DiscoveredSession>> {
        Some(self.sessions())
    }

    /// Shared fleet ownership refresh, once per cadence rather than per domain.
    fn refresh_presentation_authority(&self) {}

    /// Apply the latest shared authority to both fresh and retained rows.
    /// Must use cached data only; called on the presentation task.
    fn filter_presentation(&self, sessions: Vec<DiscoveredSession>) -> Vec<DiscoveredSession> {
        sessions
    }

    /// Fresh lookup for explicit registration. Never use presentation cache as
    /// authority; platform directories restrict discovery to this provider.
    fn find_session(&self, target: &Target) -> Option<DiscoveredSession> {
        self.sessions()
            .into_iter()
            .find(|row| &row.target == target)
    }

    /// Native title support for this exact session. May block on a provider.
    fn title_capability(
        &self,
        _source: &str,
        _session_id: &str,
    ) -> crate::relay::contract::agents::SessionTitleCapability {
        crate::relay::session_titles::unsupported("Session title editing is unavailable.")
    }

    /// Update provider metadata without starting an agent turn. May block.
    fn set_title(&self, _source: &str, _session_id: &str, _title: &str) -> Result<String, String> {
        Err("Session title editing is unavailable.".into())
    }

    /// Live sessions safe to register without an explicit request. The
    /// default suits synthetic directories; platform discovery overrides it
    /// to reject SDK/print commands and temporary working directories.
    fn auto_activation_sessions(&self) -> Vec<DiscoveredSession> {
        self.sessions()
            .into_iter()
            .filter(|session| session.live)
            .collect()
    }

    /// What each of `sessions` (with its working directory, when known) is
    /// doing, from its own records (`relay::activity`). May block.
    fn activity(
        &self,
        _sessions: &[(Target, Option<String>)],
    ) -> std::collections::HashMap<Target, crate::relay::activity::SessionActivity> {
        std::collections::HashMap::new()
    }

    /// Those of `targets` their own provider records as archived: a
    /// definite yes from the provider, never inferred from a session being
    /// absent, so an ended or unreadable session is not archived. May block.
    fn archived(&self, _targets: &[Target]) -> HashSet<Target> {
        HashSet::new()
    }

    /// Those of `targets` whose conversation its own process replaced with
    /// a new one (Claude Code's `/clear`): each with the session running
    /// there now and when it was cleared, in milliseconds since the epoch.
    /// May block.
    fn cleared(&self, _targets: &[Target]) -> Vec<(Target, Target, i64)> {
        Vec::new()
    }

    /// The supported live session the process `pid` runs inside, from the
    /// kernel's evidence alone (its own and its ancestors' pids, start
    /// times, executables, a Codex thread bound to its Codex), whether or
    /// not it is registered or a fleet worker owns it. Never what the
    /// process says about itself. May block.
    fn caller(&self, _pid: i32) -> Result<DiscoveredSession, CallerMiss> {
        Err(CallerMiss::NotASession)
    }

    /// Whether the process `pid` runs below the trusted Codex of this user's
    /// that holds `thread`'s writer lock, as a Codex hook that Codex started
    /// for that thread does (`codex::stop_hook`). From the kernel's evidence
    /// alone. May block.
    fn holds_codex_thread(&self, _pid: i32, _thread: &str) -> bool {
        false
    }

    /// Registry files of running sessions that cannot be parsed, so those
    /// sessions are invisible until the file is readable again. May block.
    fn unreadable_session_files(&self) -> Vec<UnreadableSessionFile> {
        Vec::new()
    }

    /// Whether automatic activation would put `session` on the relay, by
    /// the same check `auto_activation_sessions` applies. May block.
    fn auto_activates(&self, _session: &DiscoveredSession) -> bool {
        false
    }

    /// Whether a fleet worker owns `target` now, read fresh from every
    /// broker; an error (safe to show) when any broker cannot be read, so a
    /// second identity is never created on a guess. May block.
    fn fleet_owned(&self, _target: &Target) -> Result<bool, String> {
        Ok(false)
    }

    /// Starts a probe-owned provider endpoint and returns it only after its
    /// immutable kernel/provider binding has been verified and persisted.
    fn launch_managed(&self, _launch: ManagedLaunch) -> Result<DiscoveredSession, String> {
        Err("Managed provider launch is unavailable.".into())
    }

    /// Registers an already-open Grok leader's session with immutable proof.
    /// The directory finds the leader from the kernel; nothing the caller
    /// sends names a process, socket or binding.
    fn register_existing(
        &self,
        _request: crate::relay::existing_session::enablement::OpenLeaderRequest,
    ) -> Result<DiscoveredSession, String> {
        Err("Already-open session registration is unavailable.".into())
    }

    /// The exact binding identity a registration of `target` is pinned to:
    /// for `grok-open`, its live binding's `existing:grok:` reference.
    fn route_binding(&self, _target: &Target) -> Option<String> {
        None
    }

    /// The live probe-owned authority for a managed target. Registration
    /// requires an exact match; ordinary discovery cannot manufacture one.
    fn managed_authority(&self, _target: &Target) -> Option<ManagedAuthority> {
        None
    }
}

/// No discovery: no session is found.
pub struct NoSessions;

impl SessionDirectory for NoSessions {
    fn sessions(&self) -> Vec<DiscoveredSession> {
        Vec::new()
    }
}
