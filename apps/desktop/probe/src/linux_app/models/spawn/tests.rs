use super::*;
use crate::relay::harness;
use serde_json::json;

/// What the core publishes.
fn core_descriptors() -> Vec<HarnessDescriptor> {
    harness::published()
}

#[test]
fn muse_descriptor_uses_the_core_access_default_and_label() {
    let muse = descriptor("muse");
    assert_eq!(muse.label, "Muse");
    assert!(!muse.full_access.unwrap().default_on);
}

fn status(state: SpawnState, node: Option<&str>, error: Option<&str>) -> SpawnStatus {
    SpawnStatus {
        state,
        node_name: node.map(str::to_string),
        harnesses: vec!["codex".into(), "claude".into()],
        error: error.map(str::to_string),
        slots: None,
        harness_descriptors: Some(core_descriptors()),
        claim: None,
    }
}

fn descriptor(id: &str) -> HarnessDescriptor {
    core_descriptors()
        .into_iter()
        .find(|descriptor| descriptor.id == id)
        .unwrap()
}

#[test]
fn spawn_wording_matches_the_mac() {
    assert_eq!(SPAWN_TITLE, "Spawned agents");
    assert_eq!(
        SPAWN_DESCRIPTION,
        "Agent Relay can start agents on this computer, headless, with the agent command lines installed here. You message them like any other agent here."
    );
    assert_eq!(SPAWN_ACCEPT_TITLE, "Accept spawns from Agent Relay");
    assert_eq!(
        SPAWN_ACCEPT_DETAIL,
        "Let your workspace start agents here. They run in the background as you, in the folder the spawn names, and stop when they are released."
    );
    assert_eq!(
        spawn_full_access_title(&descriptor("codex")),
        "Codex: full access"
    );
    assert_eq!(
        spawn_full_access_detail(&descriptor("codex")),
        "Full access removes the sandbox for spawned Codex. Approval requests can be answered remotely; off keeps Codex in its workspace folder."
    );
    assert_eq!(
        spawn_full_access_title(&descriptor("claude")),
        "Claude: full access"
    );
    assert_eq!(
        spawn_full_access_detail(&descriptor("claude")),
        "Spawned Claude runs with --dangerously-skip-permissions. Off lets it edit files; anything else that would ask can be answered remotely."
    );
    assert!(!SPAWN_DESCRIPTION.contains("Codex"));
    assert_eq!(SPAWN_MAX_AGENTS_TITLE, "Max spawned agents");
    assert_eq!(
        SPAWN_MAX_AGENTS_DETAIL,
        "Leave empty for no limit. An optional cap limits how many spawned agents may run here at once. An idle agent keeps its place until it is released; a spawn beyond the cap is refused, never queued."
    );
    assert_eq!(SPAWN_MAX_AGENTS_RANGE, 1..=32);
    assert_eq!(SPAWN_MAX_AGENTS_DEFAULT, 0);
    assert_eq!(SPAWN_TEAMMATES_TITLE, "Allow teammates to spawn here");
    assert_eq!(
        SPAWN_TEAMMATES_DETAIL,
        "Off: only you can start agents on this computer. On: workspace owners and admins can too."
    );
}

#[test]
fn spawn_harnesses_are_listed_by_name() {
    let descriptors = core_descriptors();
    let list = |names: &[&str]| {
        spawn_harness_list(
            &names.iter().map(|n| n.to_string()).collect::<Vec<_>>(),
            &descriptors,
        )
    };
    assert_eq!(list(&[]), "agents");
    assert_eq!(list(&["codex"]), "Codex");
    assert_eq!(list(&["codex", "claude"]), "Codex and Claude");
    // One the core does not describe is capitalized.
    assert_eq!(
        list(&["codex", "claude", "droid"]),
        "Codex, Claude and Droid"
    );
    assert_eq!(spawn_harness_label("droid", &[]), "Droid");
    assert_eq!(spawn_harness_label("codex", &[]), "Codex");
}

/// OpenCode is drawn from the core's descriptor like any other harness, with
/// no OpenCode code in the app; the Mac's `SpawnCopyTests` says the same.
#[test]
fn opencode_is_drawn_from_its_descriptor() {
    let opencode = descriptor("opencode");
    assert_eq!(spawn_full_access_title(&opencode), "OpenCode: full access");
    assert_eq!(
        spawn_full_access_detail(&opencode),
        "Spawned OpenCode runs with every permission set to allow. Off lets it read and edit files in its folder and refuses everything else, shell commands included."
    );
    assert!(spawn_full_access(None, &opencode));
    let descriptors = core_descriptors();
    let names = ["codex", "claude", "opencode"].map(String::from);
    assert_eq!(
        spawn_harness_list(&names, &descriptors),
        "Codex, Claude and OpenCode"
    );
    let offered = SpawnStatus {
        harnesses: vec!["opencode".into(), "codex".into()],
        ..status(SpawnState::Live, Some("mac-desktop"), None)
    };
    let rows: Vec<String> = spawn_full_access_harnesses(Some(&offered))
        .into_iter()
        .map(|descriptor| descriptor.id)
        .collect();
    assert_eq!(rows, ["codex", "opencode"]);
}

#[test]
fn a_full_access_row_shows_for_each_offered_harness_with_the_setting() {
    assert!(spawn_full_access_harnesses(None).is_empty());
    let both = status(SpawnState::Live, Some("mac-desktop"), None);
    let ids = |status: &SpawnStatus| -> Vec<String> {
        spawn_full_access_harnesses(Some(status))
            .into_iter()
            .map(|descriptor| descriptor.id)
            .collect()
    };
    assert_eq!(ids(&both), ["codex", "claude"]);
    // In the core's order, whatever order the node lists them in.
    let reversed = SpawnStatus {
        harnesses: vec!["claude".into(), "codex".into()],
        ..both.clone()
    };
    assert_eq!(ids(&reversed), ["codex", "claude"]);
    let codex_only = SpawnStatus {
        harnesses: vec!["codex".into()],
        ..both.clone()
    };
    assert_eq!(ids(&codex_only), ["codex"]);
    // An older core describes none: no rows.
    let older = SpawnStatus {
        harness_descriptors: None,
        ..both.clone()
    };
    assert!(ids(&older).is_empty());
    // A harness without the setting has no row.
    let mut descriptors = core_descriptors();
    descriptors[1].full_access = None;
    let without = SpawnStatus {
        harness_descriptors: Some(descriptors),
        ..both
    };
    assert_eq!(ids(&without), ["codex"]);
}

#[test]
fn full_access_is_the_choice_made_else_the_harness_default() {
    let claude = descriptor("claude");
    assert!(spawn_full_access(None, &claude));
    let settings = |value: serde_json::Value| -> SettingsValues {
        serde_json::from_value(json!({
            "allow_self_registration": true, "auto_activate": true,
            "spawn_harnesses": value,
        }))
        .unwrap()
    };
    let off = settings(json!({"claude": {"full_access": false, "billing": "api"}}));
    assert!(!spawn_full_access(Some(&off), &claude));
    assert!(spawn_full_access(Some(&off), &descriptor("codex")));
    let change = serde_json::to_value(spawn_full_access_change("claude", false)).unwrap();
    assert_eq!(
        change,
        json!({"spawn_harnesses": {"claude": {"full_access": false}}})
    );
}

#[test]
fn the_spawn_status_line_follows_the_node() {
    assert_eq!(spawn_status_line(None), None);
    assert_eq!(
        spawn_status_line(Some(&status(SpawnState::Off, None, None))),
        None
    );
    assert_eq!(
        spawn_status_line(Some(&status(
            SpawnState::Off,
            None,
            Some("No agent command line Agent Relay can spawn is installed on this computer.")
        ))),
        Some("No agent command line Agent Relay can spawn is installed on this computer.".into())
    );
    assert_eq!(
        spawn_status_line(Some(&status(SpawnState::Live, Some("mac-desktop"), None))),
        Some("Agent Relay can spawn Codex and Claude here as mac-desktop. Spawned agents are addressed name@mac-desktop.".into())
    );
    let with_places = SpawnStatus {
        harnesses: vec!["codex".into()],
        slots: Some(SpawnSlots {
            max: 8,
            held: 2,
            reserved: 1,
        }),
        ..status(SpawnState::Live, Some("mac-desktop"), None)
    };
    assert_eq!(
        spawn_status_line(Some(&with_places)),
        Some("Agent Relay can spawn Codex here as mac-desktop. Spawned agents are addressed name@mac-desktop. 2 of 8 places in use.".into())
    );
    assert_eq!(
        spawn_status_line(Some(&status(SpawnState::Connecting, None, None))),
        Some("Connecting to Agent Relay…".into())
    );
    assert_eq!(
        spawn_status_line(Some(&status(
            SpawnState::Waiting,
            None,
            Some("Could not reach Agent Relay.")
        ))),
        Some("Not connected: Could not reach Agent Relay. Trying again.".into())
    );
    let owned = "This computer's spawn node belongs to another account. It takes no spawns until that account, or an owner of your workspace, releases it in Agent Relay.";
    assert_eq!(owned, crate::relay::spawn::OWNED_BY_OTHER);
    assert_eq!(
        spawn_status_line(Some(&status(
            SpawnState::Live,
            Some("mac-desktop"),
            Some(owned)
        ))),
        Some(owned.into())
    );
    let healthy = |state, error: Option<&str>| {
        spawn_status_is_healthy(Some(&status(state, Some("mac-desktop"), error)))
    };
    assert!(healthy(SpawnState::Live, None));
    assert!(!healthy(SpawnState::Live, Some(owned)));
    assert!(!healthy(SpawnState::Waiting, None));
    assert!(!spawn_status_is_healthy(None));
}

#[test]
fn the_claim_line_says_whose_the_node_is() {
    let claim = |state, note: Option<&str>| SpawnClaim {
        state,
        note: note.map(str::to_string),
    };
    let line = |state, note| spawn_claim_line(Some(&claim(state, note)));
    let not_yet = "Not claimed yet: no agent can be spawned on this computer through Agent Relay Cloud until it is.";
    assert_eq!(spawn_claim_line(None), None);
    assert_eq!(
        line(SpawnClaimState::Claimed, None).as_deref(),
        Some("Claimed by you in Agent Relay Cloud.")
    );
    assert_eq!(
        line(SpawnClaimState::OwnedByOther, Some("x")).as_deref(),
        Some("Claimed by another account in Agent Relay Cloud.")
    );
    assert_eq!(
        line(SpawnClaimState::Pending, None).as_deref(),
        Some(not_yet)
    );
    let signed_out = "Sign in to Agent Relay to record this computer's spawn node as yours.";
    assert_eq!(
        line(SpawnClaimState::SignedOut, Some(signed_out)),
        Some(format!("{not_yet} {signed_out}"))
    );
    assert_eq!(
        line(
            SpawnClaimState::Failed,
            Some("Agent Relay could not be reached.")
        ),
        Some(format!("{not_yet} Agent Relay could not be reached."))
    );
    let failed = claim(
        SpawnClaimState::Failed,
        Some("Agent Relay could not be reached."),
    );
    assert!(spawn_claim_can_retry(Some(&failed)));
    assert!(!spawn_claim_can_retry(Some(&claim(
        SpawnClaimState::SignedOut,
        None
    ))));
    assert!(!spawn_claim_can_retry(Some(&claim(
        SpawnClaimState::Claimed,
        None
    ))));
    assert!(!spawn_claim_can_retry(None));
    assert_eq!(SPAWN_CLAIM_RETRY, "Retry");
    // Until it is claimed, Cloud spawns nothing here.
    let unclaimed = SpawnStatus {
        harnesses: vec!["codex".into()],
        claim: Some(claim(SpawnClaimState::Pending, None)),
        ..status(SpawnState::Live, Some("mac-desktop"), None)
    };
    assert_eq!(
        spawn_status_line(Some(&unclaimed)).as_deref(),
        Some("Connected to Agent Relay as mac-desktop. No agent can be spawned on this computer through Agent Relay Cloud until its spawn node is claimed.")
    );
    assert!(!spawn_status_is_healthy(Some(&unclaimed)));
    let claimed = SpawnStatus {
        claim: Some(claim(SpawnClaimState::Claimed, None)),
        ..unclaimed
    };
    assert!(spawn_status_is_healthy(Some(&claimed)));
    assert_eq!(
        spawn_status_line(Some(&claimed)).as_deref(),
        Some("Agent Relay can spawn Codex here as mac-desktop. Spawned agents are addressed name@mac-desktop.")
    );
}

#[test]
fn devin_publishes_the_same_setting_and_safe_default_as_mac() {
    let descriptor = crate::relay::harness::published()
        .into_iter()
        .find(|d| d.id == "devin")
        .unwrap();
    assert_eq!(spawn_full_access_title(&descriptor), "Devin: full access");
    assert_eq!(spawn_full_access_detail(&descriptor), "Spawned Devin uses dangerous permission mode. Off uses accept-edits and permits only the private Agent Relay send tool; other approval requests are refused.");
    assert!(!spawn_full_access(None, &descriptor));
}

#[test]
fn optional_cap_input_and_unlimited_copy() {
    assert_eq!(SPAWN_NO_LIMIT, "No limit");
    for text in ["", "  "] {
        assert_eq!(spawn_max_agents_input(text), Some(0));
    }
    assert_eq!(spawn_max_agents_input("12"), Some(12));
    assert_eq!(spawn_max_agents_input("32"), Some(32));
    for text in ["0", "33", "-1", "1.5", "abc", "+2"] {
        assert_eq!(spawn_max_agents_input(text), None);
    }
    assert_eq!(
        spawn_places(&SpawnSlots {
            max: 0,
            held: 42,
            reserved: 3
        }),
        "42 places in use. No limit."
    );
}
