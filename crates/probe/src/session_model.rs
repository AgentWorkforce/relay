//! The session catalog's view model: the local session rows, the session
//! search language and the upload states the core's catalog query
//! (`relay::session_query`) filters and sorts by. Pure: nothing here reads a
//! file, the network or the core's state.
//!
//! These modules came from the desktop GTK app's `linux_app::models`, which
//! the core's catalog query depended on. They moved into the core so the core
//! builds without the GUI; the apps import them from here.

mod agent_kind;
mod agent_names;
mod local_sessions;
mod session_project;
mod session_query;
mod uploads;

pub use agent_kind::{claude_cloud_place, hosted_kind_label, kind_label, source_name};
pub use agent_names::*;
pub use local_sessions::*;
pub use session_project::*;
pub use session_query::*;
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

/// `scheme://host[:port]` of an http(s) URL.
fn origin(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!("{}://{host}{port}", url.scheme()))
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
