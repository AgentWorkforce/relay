//! GitHub-like local session search; filter menus edit this same query.
use super::{LocalSessionRow, SessionUploadState};
use chrono::NaiveDate;

#[derive(Clone, Debug)]
pub struct SessionSearchTerm {
    pub raw: String,
    pub field: Option<String>,
    pub value: String,
    pub excluded: bool,
    dates: Option<(i64, i64)>,
}
impl SessionSearchTerm {
    pub fn display_title(&self) -> &str {
        if self.field.as_deref() == Some("is")
            && ["on-relay", "off-relay"].contains(&self.value.to_lowercase().as_str())
        {
            if self.value.eq_ignore_ascii_case("on-relay") != self.excluded {
                "Receives messages"
            } else {
                "Does not receive messages"
            }
        } else {
            &self.raw
        }
    }
}
pub struct LocalSessionQuery {
    pub terms: Vec<SessionSearchTerm>,
}
impl LocalSessionQuery {
    pub fn new(query: &str) -> Self {
        let mut words = Vec::new();
        let mut word = String::new();
        let (mut quoted, mut escaped) = (false, false);
        for c in query.chars() {
            if c.is_whitespace() && !quoted {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            } else {
                word.push(c);
                if c == '"' && !escaped {
                    quoted = !quoted;
                }
            }
            escaped = c == '\\' && !escaped;
        }
        if !word.is_empty() {
            words.push(word);
        }
        let mut terms = Vec::new();
        let mut index = 0;
        while index < words.len() {
            let mut raw = words[index].clone();
            if raw.ends_with(':')
                && index + 1 < words.len()
                && (!words[index + 1].contains(':') || words[index + 1].starts_with('"'))
            {
                index += 1;
                raw.push_str(&words[index]);
            }
            let excluded = raw.starts_with('-') && raw.len() > 1;
            let body = if excluded { &raw[1..] } else { &raw };
            let (field, value) = match body.split_once(':') {
                Some((field, value))
                    if [
                        "title", "project", "harness", "source", "path", "id", "agent", "is",
                        "upload", "updated", "after", "before",
                    ]
                    .contains(&field.to_lowercase().as_str()) =>
                {
                    (Some(field.to_lowercase()), value)
                }
                _ => (None, body),
            };
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or(value)
                .replace("\\\"", "\"");
            let dates = field
                .as_deref()
                .filter(|f| ["updated", "after", "before"].contains(f))
                .and_then(|f| date_bounds(&value, f));
            terms.push(SessionSearchTerm {
                raw,
                field,
                value,
                excluded,
                dates,
            });
            index += 1;
        }
        Self { terms }
    }
    pub fn value(&self, field: &str) -> Option<&str> {
        self.terms
            .iter()
            .rev()
            .find(|t| t.field.as_deref() == Some(field) && !t.excluded)
            .map(|t| t.value.as_str())
    }
    pub fn removing_term(&self, index: usize) -> String {
        self.terms
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .map(|(_, term)| term.raw.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn setting(&self, field: &str, value: &str) -> String {
        let mut parts: Vec<_> = self
            .terms
            .iter()
            .filter(|t| t.field.as_deref() != Some(field))
            .map(|t| t.raw.clone())
            .collect();
        if !value.is_empty() {
            let escaped = value.replace('"', "\\\"");
            parts.push(format!(
                "{field}:{}",
                if value.chars().any(char::is_whitespace) {
                    format!("\"{escaped}\"")
                } else {
                    escaped
                }
            ));
        }
        parts.join(" ")
    }
    pub fn contains_selection(&self, field: &str, value: &str) -> bool {
        let canonical = |f: &str| {
            if f == "source" {
                "harness".to_string()
            } else {
                f.to_string()
            }
        };
        self.terms.iter().any(|term| {
            !term.excluded
                && canonical(term.field.as_deref().unwrap_or_default()) == canonical(field)
                && term.value.eq_ignore_ascii_case(value)
        })
    }

    fn opposite(field: &str, left: &str, right: &str) -> bool {
        if !matches!(field, "is" | "upload") {
            return false;
        }
        let (left, right) = (left.to_lowercase(), right.to_lowercase());
        let pair = |a: &str, b: &str| (left == a && right == b) || (left == b && right == a);
        match field {
            "is" => pair("active", "inactive") || pair("on-relay", "off-relay"),
            "upload" => {
                pair("local", "in-progress")
                    || (left != right
                        && (matches!(left.as_str(), "none" | "discovering")
                            || matches!(right.as_str(), "none" | "discovering")))
            }
            _ => false,
        }
    }

    fn without_selection_conflicts(&self, field: &str, value: &str) -> Vec<String> {
        self.terms
            .iter()
            .filter(|term| {
                let same = term.field.as_deref() == Some(field)
                    || (["source", "harness"].contains(&field)
                        && matches!(term.field.as_deref(), Some("source" | "harness")));
                !same
                    || !(if term.excluded {
                        term.value.eq_ignore_ascii_case(value)
                    } else {
                        Self::opposite(field, &term.value, value)
                    })
            })
            .map(|term| term.raw.clone())
            .collect()
    }

    pub fn completing_suggestion(text: &str, field: &str, value: &str, title: &str) -> String {
        let query = Self::new(text);
        let matches = |fragment: &str| {
            !fragment.is_empty()
                && (value.to_lowercase().contains(&fragment.to_lowercase())
                    || title.to_lowercase().contains(&fragment.to_lowercase()))
        };
        let mut removed = 0;
        if let Some(last) = query.terms.last().filter(|term| !term.excluded) {
            if let Some(last_field) = last.field.as_deref() {
                let same = last_field == field
                    || (["harness", "source"].contains(&field)
                        && ["harness", "source"].contains(&last_field));
                if same
                    && !last.value.eq_ignore_ascii_case(value)
                    && (last.value.is_empty() || matches(&last.value))
                {
                    removed = 1;
                }
            } else {
                let mut suffix = Vec::new();
                for term in query.terms.iter().rev() {
                    if term.field.is_some() || term.excluded {
                        break;
                    }
                    suffix.insert(0, term.value.as_str());
                    if matches(&suffix.join(" ")) {
                        removed = suffix.len();
                    }
                }
            }
        }
        let base = if removed == 0 {
            text.to_string()
        } else {
            query.terms[..query.terms.len() - removed]
                .iter()
                .map(|term| term.raw.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        };
        Self::selecting_suggestion(&base, field, value, true)
    }

    pub fn selecting_suggestion(text: &str, field: &str, value: &str, selected: bool) -> String {
        let query = Self::new(text);
        if query.contains_selection(field, value) == selected {
            let kept = query.without_selection_conflicts(field, value);
            if selected && kept.len() != query.terms.len() {
                return format!("{} ", kept.join(" "));
            }
            return text.to_string();
        }
        Self::suggesting(text, field, value)
    }

    /// Toggle a choice, completing only an unfinished qualifier prefix.
    pub fn suggesting(text: &str, field: &str, value: &str) -> String {
        let query = Self::new(text);
        if value.is_empty() {
            return query.applying_filter(field, "");
        }
        let mut parts: Vec<_> = query.terms.iter().map(|term| term.raw.clone()).collect();
        if !text.ends_with(char::is_whitespace) {
            if let Some(last) = query.terms.last() {
                let token = last.raw.to_lowercase();
                let suggestion = format!("{}:{}", field.to_lowercase(), value.to_lowercase());
                let qualifier_prefix = last.field.is_none()
                    && !token.is_empty()
                    && field.to_lowercase().starts_with(&token);
                let value_prefix = last.field.as_deref() == Some(field)
                    && token != suggestion
                    && suggestion.starts_with(&token);
                if !last.excluded && (qualifier_prefix || value_prefix) {
                    parts.pop();
                }
            }
        }
        let base = Self::new(&parts.join(" "));
        if base.contains_selection(field, value) {
            parts = base
                .terms
                .iter()
                .filter(|term| {
                    let same_field = term.field.as_deref() == Some(field)
                        || (["harness", "source"].contains(&field)
                            && matches!(term.field.as_deref(), Some("harness" | "source")));
                    term.excluded || !same_field || !term.value.eq_ignore_ascii_case(value)
                })
                .map(|term| term.raw.clone())
                .collect();
        } else {
            parts = base.without_selection_conflicts(field, value);
            parts.push(Self::new("").setting(field, value));
        }
        if parts.is_empty() {
            return String::new();
        }
        format!("{} ", parts.join(" "))
    }

    pub fn applying_filter(&self, field: &str, value: &str) -> String {
        let aliases: &[&str] = match field {
            "harness" => &["source"],
            "updated" => &["after", "before"],
            _ => &[],
        };
        let mut query = self
            .terms
            .iter()
            .map(|term| term.raw.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        for alias in aliases {
            query = Self::new(&query).setting(alias, "");
        }
        Self::new(&query).setting(field, value)
    }

    fn opposite_selection_error(&self) -> Option<String> {
        for term in self.terms.iter().filter(|term| !term.excluded) {
            if let Some(field) = term.field.as_deref() {
                if !matches!(field, "is" | "upload") {
                    continue;
                }
                if self.terms.iter().any(|other| {
                    !other.excluded
                        && other.field == term.field
                        && Self::opposite(field, &term.value, &other.value)
                }) {
                    return Some(
                        if field == "is"
                            && ["on-relay", "off-relay"]
                                .contains(&term.value.to_lowercase().as_str())
                        {
                            "Choose either receives messages or does not receive messages."
                        } else if field == "is" {
                            "Choose either is:active or is:inactive."
                        } else {
                            "Choose compatible upload filters; opposite states cannot be combined."
                        }
                        .into(),
                    );
                }
            }
        }
        None
    }

    pub fn error(&self) -> Option<String> {
        if let Some(error) = self.opposite_selection_error() {
            return Some(error);
        }
        for term in &self.terms {
            let Some(field) = term.field.as_deref() else {
                continue;
            };
            if term.value.is_empty() {
                return Some(format!("Add a value after {field}:"));
            }
            if ["updated", "after", "before"].contains(&field) && term.dates.is_none() {
                return Some("Use a date like updated:2026-10-01, updated:>=2026-10-01, or updated:2026-10-01..2026-10-11 (UTC).".into());
            }
            if field == "is"
                && !["active", "inactive", "on-relay", "off-relay"]
                    .contains(&term.value.to_lowercase().as_str())
            {
                return Some("Use is:active, is:inactive, is:on-relay, or is:off-relay.".into());
            }
            if field == "upload"
                && ![
                    "in-progress",
                    "none",
                    "local",
                    "discovering",
                    "preparing",
                    "queued",
                    "uploading",
                    "uploaded",
                    "checking",
                    "paused",
                    "blocked",
                    "unknown",
                ]
                .contains(&term.value.to_lowercase().as_str())
            {
                return Some(
                    "Use upload:uploaded, upload:local, upload:in-progress, or upload:discovering."
                        .into(),
                );
            }
        }
        None
    }
    pub fn matches(&self, row: &LocalSessionRow, state: Option<SessionUploadState>) -> bool {
        if self.opposite_selection_error().is_some() {
            return false;
        }
        // Discovery can lead the catalog; absence alone is not an upload failure.
        let state = state
            .or_else(|| row.upload.as_ref().map(|s| SessionUploadState::of(s, None)))
            .unwrap_or(SessionUploadState::Discovering);
        let directory = row
            .upload
            .as_ref()
            .and_then(|s| s.cwd.as_deref())
            .or_else(|| row.relay.as_ref().and_then(|s| s.directory.as_deref()))
            .unwrap_or_default();
        // An alias and the name it points at both find the session.
        let agent = row.agent_names();
        let text = format!(
            "{} {} {} {} {} {}",
            row.title(),
            row.source(),
            row.project(),
            directory,
            row.key(),
            agent
        )
        .to_lowercase();
        let mut alternatives = std::collections::HashMap::new();
        for term in &self.terms {
            let (field, value) = term.searched();
            let matched = match field {
                Some("title") => row.title().to_lowercase().contains(&value),
                Some("project") => row.project().to_lowercase().contains(&value),
                Some("harness" | "source") => row.source().to_lowercase() == value,
                Some("path") => directory.to_lowercase().contains(&value),
                Some("id") => row.key().to_lowercase().contains(&value),
                Some("agent") => agent.to_lowercase().contains(&value),
                Some("is") => match value.as_str() {
                    "active" => row.relay.as_ref().is_some_and(|s| s.live),
                    "inactive" => !row.relay.as_ref().is_some_and(|s| s.live),
                    "on-relay" => row.relay.as_ref().is_some_and(|s| s.registration.is_some()),
                    "off-relay" => !row.relay.as_ref().is_some_and(|s| s.registration.is_some()),
                    _ => false,
                },
                Some("upload") => match value.as_str() {
                    "none" => row.upload.is_none(),
                    "in-progress" => state.is_pending(),
                    _ => format!("{state:?}").to_lowercase() == value,
                },
                Some("updated" | "after" | "before") => row
                    .updated()
                    .zip(term.dates)
                    .is_some_and(|(date, (start, end))| date >= start && date < end),
                _ => text.contains(&value),
            };
            if term.excluded {
                if matched {
                    return false;
                }
            } else if let Some(field @ ("harness" | "source" | "project" | "upload")) =
                term.field.as_deref()
            {
                let key = if field == "source" { "harness" } else { field };
                let entry = alternatives.entry(key).or_insert(false);
                *entry |= matched;
            } else if !matched {
                return false;
            }
        }
        alternatives.values().all(|matched| *matched)
    }
}
impl SessionSearchTerm {
    /// The field and lowercased value this term searches. `@reviewer` is how
    /// agents are written: a term so written searches agent names and
    /// addresses only.
    fn searched(&self) -> (Option<&str>, String) {
        let value = self.value.to_lowercase();
        match self.field.as_deref() {
            None | Some("agent") if value.starts_with('@') => {
                (Some("agent"), value.trim_start_matches('@').to_string())
            }
            field => (field, value),
        }
    }
}
fn date_bounds(value: &str, field: &str) -> Option<(i64, i64)> {
    const DAY: i64 = 86_400_000;
    fn day(value: &str) -> Option<i64> {
        if value.len() != 10 {
            return None;
        }
        let date = NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
        if date.format("%Y-%m-%d").to_string() != value {
            return None;
        }
        Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
    }
    if field == "after" {
        return Some((day(value)? + DAY, i64::MAX));
    }
    if field == "before" {
        return Some((i64::MIN, day(value)?));
    }
    if let Some((start, end)) = value.split_once("..") {
        let start = if start.is_empty() || start == "*" {
            i64::MIN
        } else {
            day(start)?
        };
        let end = if end.is_empty() || end == "*" {
            i64::MAX
        } else {
            day(end)? + DAY
        };
        return (start < end).then_some((start, end));
    }
    for op in [">=", "<=", ">", "<"] {
        if let Some(value) = value.strip_prefix(op) {
            let date = day(value)?;
            return Some(match op {
                ">=" => (date, i64::MAX),
                ">" => (date + DAY, i64::MAX),
                "<=" => (i64::MIN, date + DAY),
                _ => (i64::MIN, date),
            });
        }
    }
    let date = day(value)?;
    Some((date, date + DAY))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_model::merge_local_sessions;
    use serde_json::{json, Value};
    fn row(at: &str, live: bool) -> LocalSessionRow {
        let ms = chrono::DateTime::parse_from_rfc3339(at)
            .unwrap()
            .timestamp_millis();
        let upload = serde_json::from_value(json!({"source":"codex", "session_id":"one", "cwd":"/work/cloud", "title":"Fix login", "included":false, "is_agent":false, "status":"not_shared", "last_activity_ms":ms})).unwrap();
        let local = serde_json::from_value(json!({"target":{"kind":"codex", "id":"one"}, "title":"Local work", "live":live, "suggested_name":"session"})).unwrap();
        merge_local_sessions(&[upload], &[local]).remove(0)
    }
    #[test]
    fn the_session_list_shows_and_finds_the_agent_by_either_name() {
        let session =
            |id: &str, registration: Value| -> crate::relay::contract::agents::LocalSession {
                serde_json::from_value(
                    json!({"target":{"kind":"codex", "id":id}, "title":id, "live":true,
                "suggested_name":"session", "registration":registration}),
                )
                .unwrap()
            };
        let rows = merge_local_sessions(
            &[],
            &[
                session("one", Value::Null),
                session(
                    "two",
                    json!({"name":"codex-api", "alias":"reviewer",
                    "address":"codex-api@desk", "added_by_session":false}),
                ),
            ],
        );
        let off = rows.iter().find(|r| r.title() == "one").unwrap();
        let renamed = rows.iter().find(|r| r.title() == "two").unwrap();
        assert_eq!(off.agent_name(), None);
        assert_eq!(renamed.agent_name(), Some("reviewer"));
        assert_eq!(
            renamed.agent_detail().unwrap(),
            "Renamed from @codex-api. Only @reviewer is shown and replies come from it; messages still sent to @codex-api arrive here."
        );
        // Partial or exact, by alias, name or address, with or without `@`.
        for query in [
            "agent:reviewer",
            "agent:codex-api",
            "reviewer",
            "revi",
            "@reviewer",
            "@codex",
            "agent:@codex-api",
            "codex-api@desk",
            "@codex-api@desk",
        ] {
            let parsed = LocalSessionQuery::new(query);
            let found: Vec<String> = rows
                .iter()
                .filter(|row| parsed.matches(row, None))
                .map(|row| row.title())
                .collect();
            assert_eq!(found, ["two"], "{query}");
        }
    }
    #[test]
    fn shared_search_contract() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/shared/session-search-cases.json"))
                .unwrap();
        for case in cases {
            let text = case["query"].as_str().unwrap();
            let query = LocalSessionQuery::new(text);
            if let Some(expected) = case["matches"].as_bool() {
                assert_eq!(
                    query.matches(&row("2026-10-11T23:59:59Z", true), None),
                    expected,
                    "{text}"
                );
            }
            assert_eq!(
                query.error().is_some(),
                case["invalid"].as_bool().unwrap_or(false),
                "{text}"
            );
        }
    }
    #[test]
    fn shared_filter_menu_actions() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tests/fixtures/shared/session-filter-actions.json"
        ))
        .unwrap();
        for case in cases {
            let query = LocalSessionQuery::new(case["query"].as_str().unwrap());
            assert_eq!(
                query.applying_filter(
                    case["field"].as_str().unwrap(),
                    case["value"].as_str().unwrap()
                ),
                case["expected"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn midnight_and_live_upload_state() {
        assert!(row("2026-10-11T00:00:00Z", true).matches("updated:2026-10-11"));
        assert!(!row("2026-10-12T00:00:00Z", true).matches("updated:2026-10-11"));
        assert!(
            LocalSessionQuery::new("is:active upload:paused project:cloud").matches(
                &row("2026-10-11T00:00:00Z", true),
                Some(SessionUploadState::Paused)
            )
        );
        assert!(row("2026-10-11T00:00:00Z", false).matches("is:inactive"));
    }
    #[test]
    fn menu_edits_preserve_other_qualifiers() {
        let query = LocalSessionQuery::new(
            "title: \"Fix login\" -harness:claude harness:codex updated:>=2026-10-01",
        );
        let changed = query.setting("harness", "cursor");
        assert_eq!(
            changed,
            "title:\"Fix login\" updated:>=2026-10-01 harness:cursor"
        );
        assert_eq!(
            LocalSessionQuery::new(&changed).setting("harness", ""),
            "title:\"Fix login\" updated:>=2026-10-01"
        );
        assert_eq!(
            LocalSessionQuery::new("title: \"Fix: login\"").value("title"),
            Some("Fix: login")
        );
        assert_eq!(
            LocalSessionQuery::new("title:\"Fix \\\"login\\\"\"").value("title"),
            Some("Fix \"login\"")
        );
    }
}

#[cfg(test)]
mod suggestion_tests {
    use super::LocalSessionQuery;
    #[test]
    fn completes_tokens_preserving_prior_filters_and_quoted_values() {
        assert_eq!(
            LocalSessionQuery::suggesting("fix is:active har", "harness", "codex"),
            "fix is:active harness:codex "
        );
        assert_eq!(
            LocalSessionQuery::suggesting("title:\"Fix login\" ", "project", "my project"),
            "title:\"Fix login\" project:\"my project\" "
        );
        assert_eq!(
            LocalSessionQuery::suggesting("source:claude ", "harness", "codex"),
            "source:claude harness:codex "
        );
    }
    #[test]
    fn suggestions_toggle_individual_values() {
        assert_eq!(
            LocalSessionQuery::suggesting("harness:codex", "harness", "claude"),
            "harness:codex harness:claude "
        );
        assert_eq!(
            LocalSessionQuery::suggesting("harness:codex ", "harness", "codex"),
            ""
        );
        assert_eq!(
            LocalSessionQuery::suggesting("fix login", "is", "active"),
            "fix login is:active "
        );
        assert_eq!(
            LocalSessionQuery::suggesting("harness:cl", "harness", "claude"),
            "harness:claude "
        );
    }
    #[test]
    fn deselection_preserves_other_values_exclusions_and_quotes() {
        assert_eq!(
            LocalSessionQuery::suggesting(
                "fix harness:codex harness:claude is:active",
                "harness",
                "codex"
            ),
            "fix harness:claude is:active "
        );
        assert_eq!(
            LocalSessionQuery::suggesting(
                "source:codex harness:codex -harness:codex harness:claude",
                "harness",
                "codex"
            ),
            "-harness:codex harness:claude "
        );
        assert_eq!(
            LocalSessionQuery::suggesting(
                "project:\"my project\" project:cloud title:\"Fix login\"",
                "project",
                "my project"
            ),
            "project:cloud title:\"Fix login\" "
        );
    }
    #[test]
    fn chip_removal_preserves_text_other_values_and_exclusions() {
        let query = LocalSessionQuery::new(
            "fix harness:codex harness:claude -is:inactive project:\"my project\"",
        );
        assert_eq!(
            query.removing_term(1),
            "fix harness:claude -is:inactive project:\"my project\""
        );
        assert_eq!(
            query.removing_term(3),
            "fix harness:codex harness:claude project:\"my project\""
        );
        assert_eq!(LocalSessionQuery::new("is:active").removing_term(0), "");
    }
    #[test]
    fn right_adds_and_left_removes_without_toggling_on_repeat() {
        let added = LocalSessionQuery::selecting_suggestion("is:active", "harness", "codex", true);
        assert_eq!(added, "is:active harness:codex ");
        assert_eq!(
            LocalSessionQuery::selecting_suggestion(&added, "harness", "codex", true),
            added
        );
        let removed = LocalSessionQuery::selecting_suggestion(&added, "harness", "codex", false);
        assert_eq!(removed, "is:active ");
        assert_eq!(
            LocalSessionQuery::selecting_suggestion(&removed, "harness", "codex", false),
            removed
        );
    }
    #[test]
    fn opposite_filters_replace_while_compatible_filters_remain() {
        assert_eq!(
            LocalSessionQuery::suggesting("harness:codex is:active is:on-relay", "is", "inactive"),
            "harness:codex is:on-relay is:inactive "
        );
        assert_eq!(
            LocalSessionQuery::selecting_suggestion("is:inactive", "is", "active", true),
            "is:active "
        );
        assert_eq!(
            LocalSessionQuery::suggesting("upload:local project:cloud", "upload", "in-progress"),
            "project:cloud upload:in-progress "
        );
        assert_eq!(
            LocalSessionQuery::suggesting("upload:uploaded", "upload", "in-progress"),
            "upload:uploaded upload:in-progress "
        );
        assert_eq!(
            LocalSessionQuery::suggesting("upload:none", "upload", "uploaded"),
            "upload:uploaded "
        );
        assert_eq!(
            LocalSessionQuery::suggesting("is:inactive -is:active project:cloud", "is", "active"),
            "project:cloud is:active "
        );
        assert_eq!(
            LocalSessionQuery::selecting_suggestion("is:active is:inactive", "is", "active", true),
            "is:active "
        );
        assert!(LocalSessionQuery::new("is:active is:inactive")
            .error()
            .is_some());
    }
    #[test]
    fn enter_commits_the_completion_instead_of_the_typed_fragment() {
        assert_eq!(
            LocalSessionQuery::completing_suggestion("cloud ", "project", "cloud", "cloud"),
            "project:cloud "
        );
        assert_eq!(
            LocalSessionQuery::completing_suggestion("cloud", "project", "cloud", "cloud"),
            "project:cloud "
        );
        assert_eq!(
            LocalSessionQuery::completing_suggestion(
                "fix harness:codex clo",
                "project",
                "cloud",
                "cloud"
            ),
            "fix harness:codex project:cloud "
        );
        assert_eq!(
            LocalSessionQuery::completing_suggestion(
                "fix In pro",
                "upload",
                "in-progress",
                "In progress"
            ),
            "fix upload:in-progress "
        );
        assert_eq!(
            LocalSessionQuery::completing_suggestion(
                "project:\"clo\"",
                "project",
                "cloud",
                "cloud"
            ),
            "project:cloud "
        );
        assert_eq!(
            LocalSessionQuery::completing_suggestion("project:cloud ", "project", "cloud", "cloud"),
            "project:cloud "
        );
        assert_eq!(
            LocalSessionQuery::completing_suggestion("title:cloud", "project", "cloud", "cloud"),
            "title:cloud project:cloud "
        );
    }
}
