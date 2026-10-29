//! Picking 1:1 conversations out of Relaycast's listing.

use super::text;
use serde_json::Value;
use std::collections::HashSet;

/// Every participant name a conversation lists.
fn participant_names(conversation: &Value) -> HashSet<String> {
    let mut names: HashSet<String> = conversation["participants"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| text(&p["agent_name"]))
        .collect();
    names.extend(
        conversation["participant_names"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(text),
    );
    names
}

fn is_one_to_one(conversation: &Value) -> bool {
    conversation["type"].is_null() || conversation["type"] == "1:1"
}

/// Your current 1:1 conversations, from `/v1/dm/conversations`.
pub fn direct_conversations(listing: &[Value], me: &str) -> Vec<Value> {
    listing
        .iter()
        .filter(|c| {
            is_one_to_one(c) && text(&c["id"]).is_some() && participant_names(c).contains(me)
        })
        .cloned()
        .collect()
}

/// The 1:1 conversation between `me` and `peer`, by name.
pub fn find_conversation(conversations: &[Value], me: &str, peer: &str) -> Option<String> {
    let wanted: HashSet<String> = [me.to_string(), peer.to_string()].into();
    conversations
        .iter()
        .filter(|c| is_one_to_one(c))
        .find(|c| participant_names(c) == wanted)
        .and_then(|c| text(&c["id"]))
}
