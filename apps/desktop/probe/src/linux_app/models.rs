//! The view layer's words: what the GTK app says about the relay core's
//! typed answers (the registry's own types), its relative times and its
//! filters. The Mac's `RelayDesktopCore` presentation logic and
//! `shared/RelaySessionOverview` are the reference; user-visible sentences
//! match them word for word unless the platform differs. Nothing here reads
//! a file, the network or the core.
//!
//! | Module | Owns |
//! |---|---|
//! | `time` | Relative times and local clock times |
//! | `uploads` | Sharing modes, the uploader's status in words, session upload states, filters and stages |
//! | `agents` | Session presence and rows, the roster's groups and summaries, machine and search filters, the fleet |
//! | `messages` | The composer: delivery notes, recipient warnings, endpoints; recent deliveries |
//! | `openclaw_tools` | The Settings row that gives OpenClaw agents Agent Relay's tools |
//! | `overview` | The Cloud session brief and the session's original request |
//! | `capy_setup` | The Sessions page's Capy setup card |
//! | `devin_setup` | The Sessions page's offer to turn on Devin's hooks |
//! | `agent_settings` | New agents joining #general; the settings agents changed |
//! | `settings` | Sign-in wording, Claude Code direct delivery, the SessionStart hook, workspace and incoming labels, diagnostics |
//! | `spawn` | Spawned agents: the spawn node's status line and each harness's full-access row, from the core's descriptors |
//! | `spawn_handover` | Joining a spawned agent (its live transcript and message box) and taking it over |

mod agent_kind;
mod agent_names;
mod agent_settings;
mod agents;
mod capy_setup;
mod capy_spawn;
mod devin_setup;
mod local_sessions;
mod menu_summary;
mod messages;
mod openclaw_tools;
mod optimistic;
mod overview;
mod pending;
mod relaycast_upgrade;
mod saved_session_views;
mod session_activity;
mod session_columns;
mod session_opening;
mod session_project;
mod session_query;
mod session_search_cache;
mod session_titles;
mod settings;
mod spawn;
mod spawn_handover;
mod startup;
mod time;
mod uploads;

pub use agent_names::*;
pub use agent_settings::*;
pub use agents::*;
pub use capy_setup::*;
pub use capy_spawn::*;
pub use devin_setup::*;
pub use local_sessions::*;
pub use menu_summary::*;
pub use messages::*;
pub use openclaw_tools::*;
pub use overview::*;
pub use pending::*;
pub use relaycast_upgrade::*;
pub use saved_session_views::*;
pub use session_activity::*;
pub use session_columns::*;
pub use session_opening::*;
pub use session_project::*;
pub use session_query::*;
pub use session_search_cache::*;
pub use session_titles::*;
pub use settings::*;
pub use spawn::*;
pub use spawn_handover::*;
pub use startup::*;
pub use time::*;
pub use uploads::*;

/// `1,234`: a count grouped by thousands.
fn grouped(count: u64) -> String {
    let digits = count.to_string();
    let mut text = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            text.push(',');
        }
        text.push(digit);
    }
    text
}

/// Each word's first letter upper case and the rest lower case.
fn capitalized(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut start = true;
    for character in text.chars() {
        if start {
            result.extend(character.to_uppercase());
        } else {
            result.extend(character.to_lowercase());
        }
        start = !character.is_alphanumeric();
    }
    result
}

/// `session` or `sessions`.
fn sessions_noun(count: usize) -> &'static str {
    if count == 1 {
        "session"
    } else {
        "sessions"
    }
}

/// Whether any of `fields` contains `query`, ignoring case; an empty query
/// matches everything.
fn search_matches<'a>(query: &str, fields: impl IntoIterator<Item = &'a str>) -> bool {
    let needle = query.trim().to_lowercase();
    needle.is_empty()
        || fields
            .into_iter()
            .any(|field| field.to_lowercase().contains(&needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_are_grouped_by_thousands() {
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_000), "1,000");
        assert_eq!(grouped(1_234_567), "1,234,567");
    }
}
