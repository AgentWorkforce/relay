//! This computer's address component on Relaycast.
//!
//! Every registered session gets its own direct node, addressed
//! `name@<prefix>-<agent id>`. The prefix is an address-safe form of the host
//! name, sent as `direct_machine_prefix` at registration and persisted with
//! the registration: an issued address never changes when the host is renamed.

use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

const PREFIX_MAX: usize = 40;

/// The address-safe computer name for `host_name`: the mDNS `.local` domain
/// dropped, diacritics folded, anything outside `[a-z0-9]` a single dash, at
/// most 40 characters, and `computer` when nothing is left.
pub fn machine_prefix(host_name: &str) -> String {
    let host = host_name.strip_suffix('.').unwrap_or(host_name);
    let host = if host.to_lowercase().ends_with(".local") {
        &host[..host.len() - ".local".len()]
    } else {
        host
    };
    let folded: String = host
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                c
            } else {
                '-'
            }
        })
        .collect();
    let joined = folded
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let truncated: String = joined.chars().take(PREFIX_MAX).collect();
    let trimmed = truncated.trim_matches('-');
    if trimmed.is_empty() {
        "computer".into()
    } else {
        trimmed.into()
    }
}

/// `<prefix>-<agent id>`: the machine half of one direct node's address.
pub fn machine_name(prefix: &str, agent_id: &str) -> String {
    format!("{prefix}-{agent_id}")
}

/// This host's name as the OS reports it.
pub fn host_name() -> String {
    hostname::get()
        .ok()
        .and_then(|name| name.into_string().ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors shared with InjectableRepliesTests (macOS) and
    // test_machine_name_is_normalized_stable_and_unique_per_direct_node (Linux).
    #[test]
    fn prefixes_are_normalized_and_stable() {
        assert_eq!(
            machine_prefix("Ada’s Laptop.local"),
            "ada-s-laptop"
        );
        assert_eq!(machine_prefix("Desk.LOCAL."), "desk");
        assert_eq!(machine_prefix("desk-local"), "desk-local");
        assert_eq!(machine_prefix("desk.local.example"), "desk-local-example");
        assert_eq!(machine_prefix("!!!"), "computer");
        assert_eq!(machine_prefix(""), "computer");
        assert_eq!(machine_prefix("Café Ｗｉｄｅ"), "cafe-wide");
        assert_eq!(machine_prefix(&"a".repeat(60)), "a".repeat(40));
        assert_eq!(
            machine_prefix(&format!("{}-b", "a".repeat(39))),
            "a".repeat(39)
        );
    }

    #[test]
    fn machine_names_are_unique_per_direct_node() {
        let prefix = machine_prefix("Ada’s Laptop.local");
        assert_eq!(
            machine_name(&prefix, "agent-1"),
            "ada-s-laptop-agent-1"
        );
        assert_ne!(
            machine_name(&prefix, "agent-1"),
            machine_name(&prefix, "agent-2")
        );
    }
}
