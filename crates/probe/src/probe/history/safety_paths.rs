//! Safety-only exact paths reuse the SDK's validated native archive proof.
use super::*;

#[derive(Default)]
pub struct SafetyPaths {
    base: Option<ProviderRoots>,
    db: Option<PathBuf>,
    extra: Vec<ProviderRoots>,
    contexts: Vec<ai_hist::Reconciliation>,
    #[cfg(test)]
    builds: usize,
}
impl SafetyPaths {
    #[cfg(test)]
    pub fn context_count(&self) -> usize {
        self.contexts.len()
    }

    pub fn sweep(
        &mut self,
        store: &SessionStore,
        mut extra: Vec<ProviderRoots>,
        sources: Option<Vec<Source>>,
        paths: Vec<PathBuf>,
        stopped: impl Fn() -> bool + Send + 'static,
    ) -> Result<Option<SyncReport>> {
        let stop = Stop::follow(stopped);
        if stop.stopped() {
            return Err(cancelled());
        }
        if paths.is_empty() {
            let mut empty = SyncReport::default();
            empty.head_revision = store.head_revision()?.revision;
            return Ok(Some(empty));
        }
        let before = store.head_revision()?;
        // Compare the SDK's complete root value (including private/custom
        // provider maps), never a hand-maintained subset of provider paths.
        extra.sort_by(|a, b| a.claude.cmp(&b.claude));
        if self.contexts.is_empty()
            || self.base.as_ref() != Some(store.roots())
            || self.db.as_deref() != Some(store.db_path())
            || self.extra != extra
        {
            let mut contexts = vec![store.reconcile()?];
            for roots in &extra {
                contexts.push(
                    open_with(store.db_path(), roots.clone())?
                        .reconcile()?
                        .sources([Source::Claude]),
                );
            }
            self.contexts = contexts;
            #[cfg(test)]
            {
                self.builds += 1;
            }
            self.base = Some(store.roots().clone());
            self.db = Some(store.db_path().to_path_buf());
            self.extra = extra;
        }
        let mut options = SyncOptions::default();
        options.paths = Some(paths);
        options.sources = sources;
        options.force = false;
        options.stop = Some(stop.token());
        let mut report = SyncReport::default();
        for context in &mut self.contexts {
            if stop.stopped() {
                return Err(cancelled());
            }
            let next = match context.capture_paths(options.clone()) {
                Ok(next) => next,
                Err(ai_hist::Error::SyncLocked { .. }) => return Ok(None),
                Err(error) => return Err(error.into()),
            };
            report.head_revision = next.head_revision;
            for session in next.changed {
                if !report.changed.contains(&session) {
                    report.changed.push(session);
                }
            }
        }
        if stop.stopped() {
            return Err(cancelled());
        }
        let after = store.head_revision()?;
        // SDK swept may describe an attempted exact scope even when its
        // native proof skipped every path. Wake delivery only for publication.
        report.swept = before != after;
        report.head_revision = after.revision;
        Ok(Some(report))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn unchanged_native_safety_paths_do_not_rehydrate_or_publish() {
        let Some(home)=crate::live::tests::isolated_home("history::safety_paths::tests::unchanged_native_safety_paths_do_not_rehydrate_or_publish") else{return};
        let store = open(&home.join("probe/history.db")).unwrap();
        let project = home.join(".claude/projects/native");
        std::fs::create_dir_all(&project).unwrap();
        let paths: Vec<_> = (0..32)
            .map(|n| {
                let id = format!("native-{n}");
                let path = project.join(format!("{id}.jsonl"));
                crate::live::tests::append(
                    &path,
                    &crate::live::tests::transcript_line(&id, "first"),
                );
                path
            })
            .collect();
        store
            .sync(SyncOptions::default().sources([Source::Claude]))
            .unwrap();
        let conn = rusqlite::Connection::open(store.db_path()).unwrap();
        let checkpoints = || -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM session_hydration_checkpoints",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            checkpoints(),
            0,
            "fixture must have native proof without Session hydration checkpoints"
        );
        let parser: i64 = conn
            .query_row(
                "SELECT parser_version FROM sessions WHERE session_id='native-0'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            parser, 1,
            "exercise legacy native evidence, not a current Session checkpoint"
        );
        let state_path = store.db_path().parent().unwrap().join(".sync-state.json");
        let mut state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&state_path).unwrap()).unwrap();
        state["unrelated"] = serde_json::Value::Object(
            (0..47000)
                .map(|n| (n.to_string(), serde_json::json!("archived")))
                .collect(),
        );
        std::fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
        let state_before = std::fs::read(&state_path).unwrap();
        let head = store.head_revision().unwrap();
        let mut safety = SafetyPaths::default();
        for _ in 0..3 {
            for batch in paths.chunks(8) {
                let report = safety
                    .sweep(
                        &store,
                        vec![],
                        Some(vec![Source::Claude]),
                        batch.to_vec(),
                        || false,
                    )
                    .unwrap()
                    .unwrap();
                assert_eq!((store.head_revision().unwrap(),checkpoints()),(head,0),"unchanged native paths must neither publish metadata-only revisions nor initialize Session checkpoints");
                assert!(report.changed.is_empty());
                assert!(
                    !report.swept,
                    "attempted scope without publication must not wake delivery"
                );
            }
        }
        assert_eq!(
            safety.builds, 1,
            "a stable root set retains its SDK proof context across batches"
        );
        assert_eq!(
            std::fs::read(&state_path).unwrap(),
            state_before,
            "read-only native proof must not rewrite the47k state document"
        );
        let mut changed_roots = store.roots().clone();
        changed_roots.codex = home.join("different-codex-root");
        let changed_store = open_with(store.db_path(), changed_roots).unwrap();
        safety
            .sweep(
                &changed_store,
                vec![],
                Some(vec![Source::Claude]),
                vec![paths[0].clone()],
                || false,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            safety.builds, 2,
            "a changed non-Claude root must discard contexts for the previous complete root set"
        );
        assert_eq!(store.head_revision().unwrap(), head);
        let mut extra = store.roots().clone();
        extra.claude = home.join(".claude-extra");
        std::fs::create_dir_all(extra.claude.join("projects")).unwrap();
        safety
            .sweep(
                &store,
                vec![extra],
                Some(vec![Source::Claude]),
                vec![paths[0].clone()],
                || false,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            safety.builds, 3,
            "a newly admitted extra root needs its own fresh context"
        );
        assert_eq!(safety.context_count(), 2);
        safety
            .sweep(
                &store,
                vec![],
                Some(vec![Source::Claude]),
                vec![paths[0].clone()],
                || false,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            safety.builds, 4,
            "removed extra roots must not remain in the retained context set"
        );
        assert_eq!(safety.context_count(), 1);
        assert_eq!(store.head_revision().unwrap(), head);
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&paths[0])
            .unwrap();
        writer
            .write_all(crate::live::tests::transcript_line("native-0", "second").as_bytes())
            .unwrap();
        writer.flush().unwrap();
        let report = safety
            .sweep(
                &store,
                vec![],
                Some(vec![Source::Claude]),
                vec![paths[0].clone()],
                || false,
            )
            .unwrap()
            .unwrap();
        assert!(
            report.swept,
            "a real held-open append must still publish and wake delivery"
        );
        let events = || -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM session_events WHERE session_id='native-0'",
                [],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(events(), 2);
        assert_eq!(checkpoints(), 1);
        writer
            .write_all(crate::live::tests::transcript_line("native-0", "third").as_bytes())
            .unwrap();
        writer.flush().unwrap();
        safety
            .sweep(
                &store,
                vec![],
                Some(vec![Source::Claude]),
                vec![paths[0].clone()],
                || false,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            events(),
            3,
            "subsequent append keeps its independent Session cursor"
        );
        drop(writer);
    }
}
