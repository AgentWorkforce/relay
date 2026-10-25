//! One bounded snapshot shared by the session table and search suggestions.
use super::{merge_local_sessions, LocalSessionRow};
use crate::relay::contract::{account::UploadSession, agents::LocalSession};
use std::rc::Rc;

pub struct LocalSessionSearchData {
    pub rows: Vec<LocalSessionRow>,
    pub sources: Vec<String>,
    pub projects: Vec<String>,
}

#[derive(Default)]
pub struct LocalSessionSearchCache {
    uploads: Vec<UploadSession>,
    sessions: Vec<LocalSession>,
    data: Option<Rc<LocalSessionSearchData>>,
}

impl LocalSessionSearchCache {
    /// Query edits reuse the same rows and options. Compare complete source
    /// values so metadata edits, upload toggles and account resets cannot leave
    /// stale rows, even when a caller mutates a session in place.
    pub fn get(
        &mut self,
        uploads: &[UploadSession],
        sessions: &[LocalSession],
    ) -> Rc<LocalSessionSearchData> {
        if let Some(data) = &self.data {
            if self.uploads == uploads && self.sessions == sessions {
                return Rc::clone(data);
            }
        }
        let rows = merge_local_sessions(uploads, sessions);
        let mut sources: Vec<_> = rows.iter().map(|row| row.source().to_string()).collect();
        sources.sort();
        sources.dedup();
        let mut projects: Vec<_> = rows
            .iter()
            .map(LocalSessionRow::project)
            .filter(|name| !name.is_empty())
            .collect();
        projects.sort();
        projects.dedup();
        self.uploads = uploads.to_vec();
        self.sessions = sessions.to_vec();
        let data = Rc::new(LocalSessionSearchData {
            rows,
            sources,
            projects,
        });
        self.data = Some(Rc::clone(&data));
        data
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux_app::models::{LocalSessionQuery, LocalSessionSort, SessionUploadState};
    use serde_json::json;

    fn upload(id: &str, title: &str, time: Option<i64>) -> UploadSession {
        serde_json::from_value(json!({"source": "codex", "session_id": id,
            "title": title, "cwd": "/work/cloud", "included": false, "is_agent": false,
            "status": "not_shared", "last_activity_ms": time}))
        .unwrap()
    }

    fn local(id: &str, title: &str) -> LocalSession {
        serde_json::from_value(json!({"target": {"kind": "codex", "id": id},
            "title": title, "live": true, "project": "desktop", "registration": null,
            "suggested_name": "session", "updated_at_ms": 200}))
        .unwrap()
    }

    #[test]
    fn query_edits_share_rows_and_options_without_rebuilding() {
        let uploads = vec![
            upload("a", "Fix login", Some(100)),
            upload("b", "Write docs", None),
        ];
        let sessions = vec![local("a", "Local login"), local("c", "Desktop")];
        let mut cache = LocalSessionSearchCache::default();
        let first = cache.get(&uploads, &sessions);
        assert_eq!(first.sources, ["codex"]);
        assert_eq!(first.projects, ["cloud", "desktop"]);
        let expected = merge_local_sessions(&uploads, &sessions);
        for raw in [
            "",
            "login",
            "project:cloud",
            "-harness:claude",
            "is:active",
            "id:c",
        ] {
            let next = cache.get(&uploads, &sessions);
            assert!(
                Rc::ptr_eq(&first, &next),
                "query {raw} rebuilt the snapshot"
            );
            let query = LocalSessionQuery::new(raw);
            let filter = |rows: &[LocalSessionRow]| {
                rows.iter()
                    .filter(|row| {
                        query.matches(
                            row,
                            row.upload.as_ref().map(|u| SessionUploadState::of(u, None)),
                        )
                    })
                    .map(LocalSessionRow::key)
                    .collect::<Vec<_>>()
            };
            assert_eq!(filter(&next.rows), filter(&expected), "query {raw}");
        }
        let mut sorted = first.rows.clone();
        LocalSessionSort::default().sort(&mut sorted, |_| None, |_| None, |_| None);
        assert!(
            sorted == first.rows,
            "cached default order matches table order"
        );
    }

    #[test]
    fn source_edits_refresh_metadata_options_toggles_and_account_reset() {
        let mut uploads = vec![upload("a", "Before", Some(100))];
        let mut sessions = vec![local("a", "Local"), local("b", "Other")];
        let mut cache = LocalSessionSearchCache::default();
        let first = cache.get(&uploads, &sessions);
        uploads[0].title = "After".into();
        uploads[0].cwd = Some("/work/renamed".into());
        uploads[0].included = true;
        let changed = cache.get(&uploads, &sessions);
        assert!(!Rc::ptr_eq(&first, &changed));
        let row = changed
            .rows
            .iter()
            .find(|row| row.key() == "codex:a")
            .unwrap();
        assert_eq!(row.title(), "After");
        assert!(row.upload.as_ref().unwrap().included);
        assert_eq!(changed.projects, ["desktop", "renamed"]);
        sessions[1].title = "New local title".into();
        sessions[1].live = false;
        let local_changed = cache.get(&uploads, &sessions);
        assert!(!Rc::ptr_eq(&changed, &local_changed));
        assert!(local_changed
            .rows
            .iter()
            .any(|r| r.matches("title:\"New local title\"")));
        let reset = cache.get(&[], &[]);
        assert!(!Rc::ptr_eq(&local_changed, &reset));
        assert!(reset.rows.is_empty() && reset.sources.is_empty() && reset.projects.is_empty());
        assert!(Rc::ptr_eq(&reset, &cache.get(&[], &[])));
    }

    #[test]
    fn indexed_join_keeps_first_duplicate_and_unmatched_local_rows() {
        let uploads = vec![upload("same", "Upload", Some(100))];
        let sessions = vec![
            local("same", "First"),
            local("same", "Second"),
            local("other", "Other"),
        ];
        let mut cache = LocalSessionSearchCache::default();
        let data = cache.get(&uploads, &sessions);
        assert_eq!(data.rows.len(), 2);
        assert_eq!(data.rows[0].key(), "codex:other");
        assert_eq!(data.rows[1].relay.as_ref().unwrap().title, "First");
    }
}
