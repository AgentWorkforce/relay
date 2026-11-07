//! Which discovered sessions join the relay by themselves. The build's
//! [`SessionPolicy`] decides; a core without one admits every one.
//!
//! [`SessionPolicy`]: crate::relay::daemon::SessionPolicy

use crate::relay::daemon::Core;
use crate::relay::store::Target as SessionTarget;
use std::collections::HashSet;

/// Which sessions the session policy lets Agent Relay put on the relay by
/// itself.
#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    /// Every one.
    All,
    /// Only these.
    Only(HashSet<SessionTarget>),
    /// Not known this time, and why when it is worth saying: nothing new
    /// joins and no one leaves until a later pass reads it.
    Unknown(Option<String>),
}

impl Admission {
    pub fn admits(&self, target: &SessionTarget) -> bool {
        match self {
            Admission::All => true,
            Admission::Only(admitted) => admitted.contains(target),
            Admission::Unknown(_) => false,
        }
    }
}

/// Keeps in `found` only the sessions the session policy lets join the
/// relay by themselves, and returns those still eligible to stay there.
/// Why the policy could not be read goes on `failures`. For an automatically
/// activated agent `/clear` just `moved` to a conversation the policy does
/// not admit, the activity log gets the policy's own line.
pub async fn admit<T>(
    core: &Core,
    found: &mut std::collections::HashMap<SessionTarget, T>,
    moved: &[SessionTarget],
    failures: &mut Vec<String>,
) -> HashSet<SessionTarget> {
    if found.is_empty() {
        return HashSet::new();
    }
    let admission = match &core.plugins.session_policy {
        Some(policy) => policy.admitted(core, found.keys().cloned().collect()).await,
        None => Admission::All,
    };
    let eligible: HashSet<SessionTarget> = match &admission {
        Admission::Unknown(why) => {
            failures.extend(why.clone());
            found.keys().cloned().collect()
        }
        _ => found
            .keys()
            .filter(|target| admission.admits(target))
            .cloned()
            .collect(),
    };
    let leaving: Vec<String> = core.store.read(|store| {
        moved
            .iter()
            .filter(|target| !eligible.contains(*target))
            .filter_map(|target| store.registration_for(target))
            .filter(|r| r.auto_activated == Some(true))
            .map(|r| r.display_name().to_owned())
            .collect()
    });
    if !leaving.is_empty() {
        let line = core
            .plugins
            .session_policy
            .as_ref()
            .and_then(|policy| policy.leaving_after_clear(&leaving));
        if let Some(line) = line {
            core.hub.activity(crate::relay::state::Level::Info, line);
        }
    }
    found.retain(|target, _| admission.admits(target));
    eligible
}
