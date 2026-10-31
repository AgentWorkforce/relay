//! One local-only list, joining history to relay discovery by the core upload key.
use super::{session_key, session_project, session_title};
use crate::relay::contract::{account::UploadSession, agents::LocalSession};
use chrono::{Datelike, TimeZone, Utc};
use std::collections::{HashMap, HashSet};

#[derive(Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LocalSessionRow {
    pub upload: Option<UploadSession>,
    pub relay: Option<LocalSession>,
}
impl LocalSessionRow {
    pub fn key(&self) -> String {
        self.upload.as_ref().map(session_key).unwrap_or_else(|| {
            self.relay
                .as_ref()
                .unwrap()
                .target
                .upload_key()
                .unwrap_or_else(|| self.relay.as_ref().unwrap().target.key())
        })
    }
    pub fn title(&self) -> String {
        let title = self
            .upload
            .as_ref()
            .map(session_title)
            .unwrap_or_else(|| self.relay.as_ref().unwrap().title.clone());
        if title.trim().is_empty() {
            "Untitled session".into()
        } else {
            title
        }
    }
    pub fn source(&self) -> &str {
        self.upload
            .as_ref()
            .map(|s| s.source.as_str())
            .unwrap_or_else(|| self.relay.as_ref().unwrap().target.kind.source())
    }
    /// The name this session is messaged by on the relay: its alias once
    /// renamed. `None` while it is off the relay.
    pub fn agent_name(&self) -> Option<&str> {
        let registration = self.relay.as_ref()?.registration.as_ref()?;
        Some(super::agent_display_name(
            &registration.name,
            registration.alias.as_deref(),
        ))
    }
    /// The hover text for the agent name.
    pub fn agent_detail(&self) -> Option<String> {
        let registration = self.relay.as_ref()?.registration.as_ref()?;
        super::alias_detail(&registration.name, registration.alias.as_deref()).or_else(|| {
            Some(format!(
                "Messages to @{} reach this session.",
                registration.name
            ))
        })
    }
    /// Every name that reaches this session, and its address, for search.
    pub fn agent_names(&self) -> String {
        self.relay
            .as_ref()
            .and_then(|s| s.registration.as_ref())
            .map(|r| {
                [
                    Some(r.name.as_str()),
                    r.alias.as_deref(),
                    Some(r.address.as_str()),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ")
            })
            .unwrap_or_default()
    }
    pub fn execution_details(&self) -> String {
        let models: Vec<&str> = self
            .upload
            .as_ref()
            .map(|s| {
                s.models
                    .iter()
                    .flatten()
                    .map(|m| m.trim())
                    .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("unknown"))
                    .collect()
            })
            .unwrap_or_default();
        let mut parts = Vec::new();
        if !models.is_empty() {
            parts.push(models.join(", "));
        }
        let harness = super::source_name(self.source());
        if !harness.is_empty() && !harness.eq_ignore_ascii_case("unknown") {
            parts.push(harness.to_string());
        }
        if let Some(effort) = self
            .upload
            .as_ref()
            .and_then(|s| s.reasoning_effort.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("unknown"))
        {
            parts.push(format!("{effort} reasoning"));
        }
        parts.join(" · ")
    }
    pub fn model_name(&self) -> String {
        let models: Vec<&str> = self
            .upload
            .as_ref()
            .and_then(|s| s.models.as_ref())
            .map(|models| {
                models
                    .iter()
                    .map(|m| m.trim())
                    .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("unknown"))
                    .collect()
            })
            .unwrap_or_default();
        if models.is_empty() {
            "—".into()
        } else {
            models.join(", ")
        }
    }
    pub fn reasoning(&self) -> &str {
        self.upload
            .as_ref()
            .and_then(|s| s.reasoning_effort.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("unknown"))
            .unwrap_or("—")
    }
    pub fn created_at(&self) -> Option<i64> {
        self.upload
            .as_ref()
            .and_then(|s| s.first_activity_ms)
            .filter(|ms| *ms > 0)
    }
    pub fn directory(&self) -> String {
        self.upload
            .as_ref()
            .and_then(|s| s.cwd.clone())
            .or_else(|| self.relay.as_ref().and_then(|s| s.directory.clone()))
            .unwrap_or_default()
    }
    pub fn session_id(&self) -> String {
        self.upload
            .as_ref()
            .map(|s| s.session_id.clone())
            .unwrap_or_else(|| self.relay.as_ref().unwrap().target.id.clone())
    }
    pub fn created(&self) -> String {
        self.upload
            .as_ref()
            .and_then(|s| s.first_activity_ms)
            .filter(|ms| *ms > 0)
            .and_then(|ms| chrono::Local.timestamp_millis_opt(ms).single())
            .map(|date| date.format("%b %-d, %Y, %H:%M").to_string())
            .unwrap_or_else(|| "—".into())
    }
    pub fn project(&self) -> String {
        let upload = self
            .upload
            .as_ref()
            .map(session_project)
            .unwrap_or_default();
        if upload.is_empty() {
            self.relay
                .as_ref()
                .and_then(|s| s.project.clone())
                .unwrap_or_default()
        } else {
            upload
        }
    }
    pub fn updated(&self) -> Option<i64> {
        self.upload
            .as_ref()
            .and_then(|s| s.last_activity_ms)
            .or_else(|| self.relay.as_ref().and_then(|s| s.updated_at_ms))
    }
    pub fn matches(&self, query: &str) -> bool {
        super::LocalSessionQuery::new(query).matches(self, None)
    }
}
pub fn merge_local_sessions(
    uploads: &[UploadSession],
    sessions: &[LocalSession],
) -> Vec<LocalSessionRow> {
    let keys: HashSet<_> = uploads.iter().map(session_key).collect();
    let mut relay_by_key = HashMap::new();
    for session in sessions {
        if let Some(key) = session.target.upload_key() {
            // A stopped managed session and a live window can share a key:
            // keep the live one, then the first, as `relay_session_for` does.
            let kept = relay_by_key.entry(key).or_insert(session);
            if !kept.live && session.live {
                *kept = session;
            }
        }
    }
    let mut rows: Vec<_> = uploads
        .iter()
        .map(|upload| LocalSessionRow {
            relay: relay_by_key.get(&session_key(upload)).map(|s| (*s).clone()),
            upload: Some(upload.clone()),
        })
        .collect();
    rows.extend(
        sessions
            .iter()
            .filter(|s| {
                s.target
                    .upload_key()
                    .is_none_or(|key| !keys.contains(&key) && std::ptr::eq(relay_by_key[&key], *s))
            })
            .map(|s| LocalSessionRow {
                upload: None,
                relay: Some(s.clone()),
            }),
    );
    rows.sort_by(|a, b| {
        b.updated()
            .cmp(&a.updated())
            .then_with(|| a.key().cmp(&b.key()))
    });
    rows
}
/// The relay session a row key names: the live one when a stopped managed
/// session shares its upload key, otherwise the first.
pub fn relay_session_for<'a>(sessions: &'a [LocalSession], key: &str) -> Option<&'a LocalSession> {
    let mut matching = sessions.iter().filter(|session| {
        session
            .target
            .upload_key()
            .unwrap_or_else(|| session.target.key())
            == key
    });
    let first = matching.next()?;
    Some(if first.live {
        first
    } else {
        matching.find(|s| s.live).unwrap_or(first)
    })
}
pub fn local_session_week(timestamp: Option<i64>) -> String {
    let Some(date) = timestamp.and_then(|ms| Utc.timestamp_millis_opt(ms).single()) else {
        return "Unknown week".into();
    };
    let monday =
        date.date_naive() - chrono::Duration::days(date.weekday().num_days_from_monday() as i64);
    format!("Week of {}", monday.format("%b %-d, %Y"))
}

/// Row keys a relay-only session had before it joined its transcript by
/// upload key; hidden sessions saved under them stay hidden.
const RENAMED_ROW_KEYS: &[(&str, &str)] = &[
    ("grok-open:", "grok:"),
    ("opencode-open:", "opencode:"),
    ("muse-open:", "muse:"),
];

/// The current row key for a hidden session saved under an older one.
pub fn current_hidden_key(key: &str) -> String {
    RENAMED_ROW_KEYS
        .iter()
        .find_map(|(old, new)| key.strip_prefix(old).map(|id| format!("{new}{id}")))
        .unwrap_or_else(|| key.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn grok_bot_names_and_avatars_keep_native_conversation_identity() {
        for (id, name, shape, color) in [
            ("one", "posthogrok", "house", "blue"),
            ("two", "washgrok", "blob", "black"),
            ("three", "Recap", "house", "gray"),
        ] {
            let upload: UploadSession =
                serde_json::from_value(json!({"source":"grok-bot", "session_id":id,
                "title":name,"is_agent":false,"included":false,"status":"not_shared",
                "avatar":{"shape":shape,"color":color}}))
                .unwrap();
            let rows = merge_local_sessions(&[upload], &[]);
            assert_eq!(rows[0].title(), name);
            assert_eq!(rows[0].key(), format!("grok-bot:{id}"));
            assert!(rows[0].matches(name));
            let avatar = rows[0].upload.as_ref().unwrap().avatar.as_ref().unwrap();
            assert_eq!(avatar.shape.as_deref(), Some(shape));
            assert_eq!(avatar.color.as_deref(), Some(color));
        }
    }
    fn upload(source: &str, id: &str) -> UploadSession {
        serde_json::from_value(json!({"source": source, "session_id": id, "title": "Fix login", "cwd": "/work/cloud", "is_agent": false, "included": false, "status": "not_shared", "last_activity_ms": 100})).unwrap()
    }
    fn local(kind: &str, id: &str) -> LocalSession {
        serde_json::from_value(json!({"target": {"kind": kind, "id": id}, "title": "Local work", "live": true, "project": "desktop", "registration": null, "suggested_name": "session", "updated_at_ms": 200})).unwrap()
    }
    #[test]
    fn a_live_window_wins_over_a_stopped_managed_session_with_its_key() {
        for (managed, open, source) in [
            ("grok", "grok-open", "grok"),
            ("opencode", "opencode-open", "opencode"),
        ] {
            let mut stopped = local(managed, "s1");
            stopped.live = false;
            let live = local(open, "s1");
            let key = format!("{source}:s1");
            for sessions in [
                vec![stopped.clone(), live.clone()],
                vec![live.clone(), stopped.clone()],
            ] {
                for uploads in [vec![], vec![upload(source, "s1")]] {
                    let rows = merge_local_sessions(&uploads, &sessions);
                    assert_eq!(rows.len(), 1);
                    assert_eq!(
                        rows[0].relay.as_ref().map(|s| &s.target),
                        Some(&live.target)
                    );
                }
                assert_eq!(
                    relay_session_for(&sessions, &key).map(|s| &s.target),
                    Some(&live.target)
                );
            }
            assert!(relay_session_for(&[stopped.clone()], &key).is_some());
        }
    }
    #[test]
    fn hidden_sessions_saved_under_a_relay_row_key_stay_hidden() {
        let id = "01a15bca-891b-7ce2-9318-d0683ee0163a";
        let row = merge_local_sessions(&[], &[local("grok-open", id)]).remove(0);
        assert_eq!(current_hidden_key(&format!("grok-open:{id}")), row.key());
        for (kind, id) in [("opencode-open", "ses_1"), ("muse-open", "m1")] {
            let row = merge_local_sessions(&[], &[local(kind, id)]).remove(0);
            assert_eq!(current_hidden_key(&format!("{kind}:{id}")), row.key());
        }
        assert_eq!(current_hidden_key("codex:same"), "codex:same");
        assert_eq!(
            current_hidden_key("claude-cloud:cse_1"),
            "claude-cloud:cse_1"
        );
    }
    #[test]
    fn joins_by_harness_and_keeps_sessions_without_transcripts() {
        let rows = merge_local_sessions(
            &[upload("codex", "same"), upload("claude", "same")],
            &[
                local("codex", "same"),
                local("claude-terminal", "same"),
                local("claude-cloud", "app"),
            ],
        );
        assert_eq!(rows.len(), 3);
        assert!(rows[0].upload.is_none());
        assert!(rows.iter().all(|row| row.relay.is_some()));
        assert!(rows
            .iter()
            .find(|r| r.key() == "claude:same")
            .unwrap()
            .matches("LOGIN cloud claude"));
    }
    #[test]
    fn identity_survives_history_arrival() {
        let session = local("claude-terminal", "a");
        let before = merge_local_sessions(&[], &[session.clone()]);
        let after = merge_local_sessions(&[upload("claude", "a")], &[session]);
        assert_eq!(before[0].key(), after[0].key());
        assert!(before[0].matches("upload:discovering"));
        assert_eq!(
            super::super::LocalSessionQuery::suggesting("upload:uploaded", "upload", "discovering"),
            "upload:discovering "
        );
        assert_eq!(
            super::super::LocalSessionQuery::suggesting("upload:discovering", "upload", "local"),
            "upload:local "
        );
        assert!(!before[0].matches("upload:local"));
        assert!(!before[0].matches("upload:in-progress"));
        assert!(!after[0].matches("upload:discovering"));
        assert!(after[0].matches("upload:local"));
        assert_eq!(
            super::super::SessionUploadState::Discovering.pipeline_progress(),
            None
        );
    }
    #[test]
    fn resolved_project_wins_and_suppression_uses_live_evidence() {
        let mut resolved = upload("codex", "a");
        resolved.project = Some("relay-desktop".into());
        assert_eq!(
            merge_local_sessions(&[resolved], &[local("codex", "a")])[0].project(),
            "relay-desktop"
        );

        let mut suppressed = upload("codex", "a");
        suppressed.cwd = Some("/relay/test-mini-node".into());
        suppressed.project = Some(String::new());
        assert_eq!(
            merge_local_sessions(&[suppressed], &[local("codex", "a")])[0].project(),
            "desktop"
        );

        let mut legacy = upload("codex", "a");
        legacy.cwd = Some("/relay/test-mini-node".into());
        assert_eq!(
            merge_local_sessions(&[legacy], &[])[0].project(),
            "test-mini-node"
        );
    }
    #[test]
    fn execution_details_omit_unknown_settings() {
        let mut session = upload("codex", "a");
        session.models = Some(vec!["gpt-6".into()]);
        session.reasoning_effort = Some("high".into());
        session.first_activity_ms = Some(1_700_000_000_000);
        let rows = merge_local_sessions(&[session], &[local("codex", "a")]);
        assert_eq!(
            rows[0].execution_details(),
            "gpt-6 · Codex · high reasoning"
        );
        assert_eq!(rows[0].model_name(), "gpt-6");
        assert_eq!(rows[0].reasoning(), "high");
        assert!(rows[0].created().contains("2023"));
        let rows = merge_local_sessions(&[], &[local("codex", "a")]);
        assert_eq!(rows[0].execution_details(), "Codex");
        assert_eq!(rows[0].model_name(), "—");
        assert_eq!(rows[0].reasoning(), "—");
        assert_eq!(rows[0].created(), "—");
    }
    #[test]
    fn column_sorting_matches_shared_contract_in_both_directions() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/shared/session-sort-cases.json"
        ))
        .unwrap();
        let input = fixture["rows"].as_array().unwrap();
        let uploads: Vec<UploadSession> = input
            .iter()
            .map(|r| serde_json::from_value(r["session"].clone()).unwrap())
            .collect();
        let rows = merge_local_sessions(&uploads, &[]);
        let field = |row: &LocalSessionRow, key: &str| {
            input
                .iter()
                .find(|v| {
                    v["session"]["session_id"].as_str()
                        == row.upload.as_ref().map(|s| s.session_id.as_str())
                })
                .unwrap()[key]
                .clone()
        };
        for case in fixture["cases"].as_array().unwrap() {
            let column = LocalSessionSortColumn::ALL
                .into_iter()
                .find(|c| c.title() == case["column"].as_str().unwrap())
                .unwrap();
            let mut sort = LocalSessionSort::default();
            sort.select(column);
            for _ in 0..2 {
                let mut sorted = rows.clone();
                sort.sort(
                    &mut sorted,
                    |r| field(r, "status").as_str().map(str::to_owned),
                    |r| field(r, "relay").as_bool(),
                    |r| field(r, "upload").as_bool(),
                );
                let expected: Vec<String> = serde_json::from_value(
                    case[if sort.ascending {
                        "ascending"
                    } else {
                        "descending"
                    }]
                    .clone(),
                )
                .unwrap();
                assert_eq!(
                    sorted.iter().map(LocalSessionRow::key).collect::<Vec<_>>(),
                    expected,
                    "{:?}",
                    column
                );
                sort.select(column);
            }
        }
        let mut sort = LocalSessionSort::default();
        assert!(!sort.ascending);
        sort.select(LocalSessionSortColumn::Session);
        assert!(sort.ascending);
        sort.select(LocalSessionSortColumn::Session);
        assert!(!sort.ascending);
        sort.select(LocalSessionSortColumn::Updated);
        assert!(!sort.ascending);
    }
    #[test]
    fn weeks_start_on_monday_utc() {
        let sunday = chrono::DateTime::parse_from_rfc3339("2026-01-04T23:59:59Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(local_session_week(Some(sunday)), "Week of Dec 29, 2025");
        assert_eq!(
            local_session_week(Some(sunday + 1000)),
            "Week of Jan 5, 2026"
        );
        assert_eq!(local_session_week(None), "Unknown week");
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum LocalSessionSortColumn {
    Session,
    Project,
    Status,
    Updated,
    Relay,
    Upload,
    Harness,
    Model,
    Reasoning,
    Created,
    Directory,
    SessionID,
}
impl LocalSessionSortColumn {
    pub const ALL: [Self; 12] = [
        Self::Session,
        Self::Project,
        Self::Status,
        Self::Updated,
        Self::Relay,
        Self::Upload,
        Self::Harness,
        Self::Model,
        Self::Reasoning,
        Self::Created,
        Self::Directory,
        Self::SessionID,
    ];
    pub fn title(self) -> &'static str {
        match self {
            Self::Session => "Session",
            Self::Project => "Project",
            Self::Status => "Status",
            Self::Updated => "Updated",
            Self::Relay => "Messages",
            Self::Upload => "Upload",
            Self::Harness => "Harness",
            Self::Model => "Model",
            Self::Reasoning => "Reasoning",
            Self::Created => "Created",
            Self::Directory => "Directory",
            Self::SessionID => "Session ID",
        }
    }
    pub fn query_name(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Project => "project",
            Self::Status => "status",
            Self::Updated => "updated",
            Self::Relay => "relay",
            Self::Upload => "upload",
            Self::Harness => "harness",
            Self::Model => "model",
            Self::Reasoning => "reasoning",
            Self::Created => "created",
            Self::Directory => "directory",
            Self::SessionID => "sessionID",
        }
    }
    pub fn starts_ascending(self) -> bool {
        !matches!(
            self,
            Self::Updated | Self::Created | Self::Relay | Self::Upload
        )
    }
}
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LocalSessionSort {
    pub column: LocalSessionSortColumn,
    pub ascending: bool,
}
impl Default for LocalSessionSort {
    fn default() -> Self {
        Self {
            column: LocalSessionSortColumn::Updated,
            ascending: false,
        }
    }
}
impl LocalSessionSort {
    pub fn select(&mut self, column: LocalSessionSortColumn) {
        self.ascending = if self.column == column {
            !self.ascending
        } else {
            column.starts_ascending()
        };
        self.column = column;
    }
    pub fn sort(
        &self,
        rows: &mut [LocalSessionRow],
        status: impl Fn(&LocalSessionRow) -> Option<String>,
        on_relay: impl Fn(&LocalSessionRow) -> Option<bool>,
        upload_enabled: impl Fn(&LocalSessionRow) -> Option<bool>,
    ) {
        use std::cmp::Ordering;
        fn compare<T: Ord>(left: Option<T>, right: Option<T>, ascending: bool) -> Ordering {
            match (left, right) {
                (None, None) => Ordering::Equal,
                (None, _) => Ordering::Greater,
                (_, None) => Ordering::Less,
                (Some(a), Some(b)) => {
                    if ascending {
                        a.cmp(&b)
                    } else {
                        b.cmp(&a)
                    }
                }
            }
        }
        fn reasoning_key(row: &LocalSessionRow) -> Option<(usize, String)> {
            let value = row.reasoning().to_lowercase();
            if value == "—" {
                return None;
            }
            let rank = [
                "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
            ]
            .iter()
            .position(|level| *level == value)
            .unwrap_or(99);
            Some((rank, value))
        }
        rows.sort_by(|a, b| {
            let order = match self.column {
                LocalSessionSortColumn::Session => compare(
                    Some(a.title().to_lowercase()),
                    Some(b.title().to_lowercase()),
                    self.ascending,
                ),
                LocalSessionSortColumn::Project => compare(
                    Some(a.project().to_lowercase()).filter(|s| !s.is_empty()),
                    Some(b.project().to_lowercase()).filter(|s| !s.is_empty()),
                    self.ascending,
                ),
                LocalSessionSortColumn::Harness => compare(
                    Some(a.source().to_lowercase()),
                    Some(b.source().to_lowercase()),
                    self.ascending,
                ),
                LocalSessionSortColumn::Model => compare(
                    Some(a.model_name().to_lowercase()).filter(|s| s != "—"),
                    Some(b.model_name().to_lowercase()).filter(|s| s != "—"),
                    self.ascending,
                ),
                LocalSessionSortColumn::Reasoning => {
                    compare(reasoning_key(a), reasoning_key(b), self.ascending)
                }
                LocalSessionSortColumn::Status => compare(
                    status(a).map(|s| s.to_lowercase()),
                    status(b).map(|s| s.to_lowercase()),
                    self.ascending,
                ),
                LocalSessionSortColumn::Updated => {
                    compare(a.updated(), b.updated(), self.ascending)
                }
                LocalSessionSortColumn::Created => {
                    compare(a.created_at(), b.created_at(), self.ascending)
                }
                LocalSessionSortColumn::Directory => compare(
                    Some(a.directory().to_lowercase()).filter(|s| !s.is_empty()),
                    Some(b.directory().to_lowercase()).filter(|s| !s.is_empty()),
                    self.ascending,
                ),
                LocalSessionSortColumn::SessionID => compare(
                    Some(a.session_id().to_lowercase()),
                    Some(b.session_id().to_lowercase()),
                    self.ascending,
                ),
                LocalSessionSortColumn::Relay => compare(on_relay(a), on_relay(b), self.ascending),
                LocalSessionSortColumn::Upload => {
                    compare(upload_enabled(a), upload_enabled(b), self.ascending)
                }
            };
            order.then_with(|| a.key().cmp(&b.key()))
        });
    }
}
