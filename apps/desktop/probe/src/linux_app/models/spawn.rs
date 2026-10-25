//! Spawned agents in words: Agent Relay starting agents here, headless,
//! through the core's spawn node. On unless turned off, and each harness
//! runs with full access unless turned off. Nothing here is tied to
//! particular harnesses: the core describes each one it knows
//! (`SpawnStatus::harness_descriptors`: its label, what full access means
//! for it and its default) and reports which ones it offers. The Mac's
//! `SpawnCopy` matches these word for word.

use crate::relay::contract::agents::{SettingsChange, SettingsValues, SpawnHarnessSettings};
use crate::relay::state::{
    HarnessDescriptor, SpawnClaim, SpawnClaimState, SpawnSlots, SpawnState, SpawnStatus,
};

pub const SPAWN_TITLE: &str = "Spawned agents";
pub const SPAWN_DESCRIPTION: &str = "Agent Relay can start agents on this computer, headless, with the agent command lines installed here. You message them like any other agent here.";
pub const SPAWN_ACCEPT_TITLE: &str = "Accept spawns from Agent Relay";
pub const SPAWN_ACCEPT_DETAIL: &str = "Let your workspace start agents here. They run in the background as you, in the folder the spawn names, and stop when they are released.";

pub const SPAWN_TEAMMATES_TITLE: &str = "Allow teammates to spawn here";
pub const SPAWN_TEAMMATES_DETAIL: &str =
    "Off: only you can start agents on this computer. On: workspace owners and admins can too.";

pub const SPAWN_MAX_AGENTS_TITLE: &str = "Max spawned agents";
pub const SPAWN_MAX_AGENTS_DETAIL: &str = "Leave empty for no limit. An optional cap limits how many spawned agents may run here at once. An idle agent keeps its place until it is released; a spawn beyond the cap is refused, never queued.";
/// The range the field accepts when filled in; the empty default (0) means no limit.
pub const SPAWN_MAX_AGENTS_RANGE: std::ops::RangeInclusive<u32> = 1..=32;
pub const SPAWN_MAX_AGENTS_DEFAULT: u32 = 0;

pub const SPAWN_NO_LIMIT: &str = "No limit";

pub fn spawn_max_agents_input(text: &str) -> Option<u32> {
    let text = text.trim();
    if text.is_empty() {
        return Some(0);
    }
    if !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse()
        .ok()
        .filter(|n| SPAWN_MAX_AGENTS_RANGE.contains(n))
}

/// `2 of 8 places in use.`
pub fn spawn_places(slots: &SpawnSlots) -> String {
    if slots.max == 0 {
        format!("{} places in use. No limit.", slots.held)
    } else {
        format!("{} of {} places in use.", slots.held, slots.max)
    }
}

/// The harnesses the core describes, in its order; none from an older
/// core.
fn descriptors(status: Option<&SpawnStatus>) -> &[HarnessDescriptor] {
    status
        .and_then(|status| status.harness_descriptors.as_deref())
        .unwrap_or_default()
}

/// A harness by its product name, as the core describes it; an id it does
/// not describe is capitalized.
pub fn spawn_harness_label(harness: &str, descriptors: &[HarnessDescriptor]) -> String {
    if let Some(descriptor) = descriptors.iter().find(|d| d.id == harness) {
        return descriptor.label.clone();
    }
    let mut letters = harness.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => String::new(),
    }
}

/// `Codex`, `Codex and Claude`, `Codex, Claude and Gemini`.
pub fn spawn_harness_list(harnesses: &[String], descriptors: &[HarnessDescriptor]) -> String {
    let labels: Vec<String> = harnesses
        .iter()
        .map(|harness| spawn_harness_label(harness, descriptors))
        .collect();
    match labels.as_slice() {
        [] => "agents".into(),
        [only] => only.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The harnesses with a full-access row: each one the node offers that has
/// the setting, in the core's order.
pub fn spawn_full_access_harnesses(status: Option<&SpawnStatus>) -> Vec<HarnessDescriptor> {
    let offered = status
        .map(|status| status.harnesses.as_slice())
        .unwrap_or_default();
    descriptors(status)
        .iter()
        .filter(|descriptor| descriptor.full_access.is_some())
        .filter(|descriptor| offered.contains(&descriptor.id))
        .cloned()
        .collect()
}

pub fn spawn_full_access_title(harness: &HarnessDescriptor) -> String {
    format!("{}: full access", harness.label)
}

pub fn spawn_full_access_detail(harness: &HarnessDescriptor) -> String {
    harness
        .full_access
        .as_ref()
        .map(|full_access| full_access.detail.clone())
        .unwrap_or_default()
}

/// Whether `harness` runs with full access: the person's choice, else its
/// default.
pub fn spawn_full_access(settings: Option<&SettingsValues>, harness: &HarnessDescriptor) -> bool {
    settings
        .and_then(|settings| settings.spawn_harnesses.as_ref())
        .and_then(|harnesses| harnesses.get(&harness.id))
        .and_then(|chosen| chosen.full_access)
        .or_else(|| harness.full_access.as_ref().map(|f| f.default_on))
        .unwrap_or(false)
}

/// Turns full access for `harness` on or off.
pub fn spawn_full_access_change(harness: &str, enabled: bool) -> SettingsChange {
    let settings = SpawnHarnessSettings {
        full_access: Some(enabled),
        ..SpawnHarnessSettings::default()
    };
    SettingsChange {
        spawn_harnesses: Some([(harness.to_string(), settings)].into_iter().collect()),
        ..SettingsChange::default()
    }
}

/// What the spawn node is doing, or `None` when there is nothing to say.
/// A live node that takes no spawns (another account owns it) says why,
/// and one not claimed yet says that Cloud spawns nothing here until it is.
pub fn spawn_status_line(status: Option<&SpawnStatus>) -> Option<String> {
    let descriptors = descriptors(status);
    let status = status?;
    match status.state {
        SpawnState::Live if status.error.is_some() => status.error.clone(),
        SpawnState::Live => {
            let node = status.node_name.as_deref().unwrap_or("this computer");
            if status
                .claim
                .as_ref()
                .is_some_and(|c| c.state != SpawnClaimState::Claimed)
            {
                return Some(format!(
                    "Connected to Agent Relay as {node}. {SPAWN_NOT_CLAIMED}"
                ));
            }
            let line = format!(
                "Agent Relay can spawn {} here as {node}. Spawned agents are addressed name@{node}.",
                spawn_harness_list(&status.harnesses, descriptors)
            );
            Some(match &status.slots {
                Some(slots) => format!("{line} {}", spawn_places(slots)),
                None => line,
            })
        }
        SpawnState::Connecting => Some("Connecting to Agent Relay…".into()),
        SpawnState::Waiting => Some(match &status.error {
            Some(error) => format!("Not connected: {error} Trying again."),
            None => "Not connected. Trying again.".into(),
        }),
        SpawnState::Off => status.error.clone(),
    }
}

/// Whether the status line reads as a healthy status, not a warning.
pub fn spawn_status_is_healthy(status: Option<&SpawnStatus>) -> bool {
    status.is_some_and(|status| {
        status.state == SpawnState::Live
            && status.error.is_none()
            && status
                .claim
                .as_ref()
                .is_none_or(|claim| claim.state == SpawnClaimState::Claimed)
    })
}

/// Until the claim succeeds, Cloud refuses every spawn onto this computer.
pub const SPAWN_NOT_CLAIMED: &str = "No agent can be spawned on this computer through Agent Relay Cloud until its spawn node is claimed.";
pub const SPAWN_CLAIM_RETRY: &str = "Retry";

/// Whether the claim failed in a way Retry can help with.
pub fn spawn_claim_can_retry(claim: Option<&SpawnClaim>) -> bool {
    claim.is_some_and(|claim| claim.state == SpawnClaimState::Failed)
}

/// Whether Agent Relay Cloud records this computer's spawn node as the
/// person's, shown under "Allow teammates to spawn here"; `None` while the
/// core reports no claim.
pub fn spawn_claim_line(claim: Option<&SpawnClaim>) -> Option<String> {
    let claim = claim?;
    Some(match claim.state {
        SpawnClaimState::Claimed => "Claimed by you in Agent Relay Cloud.".into(),
        SpawnClaimState::OwnedByOther => "Claimed by another account in Agent Relay Cloud.".into(),
        SpawnClaimState::Pending | SpawnClaimState::SignedOut | SpawnClaimState::Failed => {
            let line = "Not claimed yet: no agent can be spawned on this computer through Agent Relay Cloud until it is.";
            match &claim.note {
                Some(note) => format!("{line} {note}"),
                None => line.into(),
            }
        }
    })
}

#[cfg(test)]
mod tests;
