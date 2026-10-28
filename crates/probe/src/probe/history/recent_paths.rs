//! Bounded stat safety polling, including create notices without identity yet.
use super::*;
use std::collections::{HashMap, VecDeque};
use std::time::SystemTime;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    changed: (i64, i64, u64),
}
impl Stamp {
    fn read(path: &Path) -> std::io::Result<Self> {
        let metadata = std::fs::metadata(path)?;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            #[cfg(unix)]
            changed: (metadata.ctime(), metadata.ctime_nsec(), metadata.ino()),
        })
    }
}

#[derive(Clone, Default)]
pub struct RecentPaths {
    polled: HashMap<PathBuf, Stamp>,
    catalog_cursor: usize,
    // A create callback may precede the first parsable record. Keep at most
    // 32 exact admitted locators until catalogued, missing or superseded.
    noticed: VecDeque<(Source, PathBuf, Stamp)>,
}
impl RecentPaths {
    /// One catalog page and at most 32 file stats. New/changed recent files
    /// enter the existing bounded exact-path lane; cold coverage stays fair.
    #[cfg(test)]
    pub fn poll(&mut self, store: &SessionStore) -> Result<Vec<(Source, PathBuf)>> {
        self.poll_with_roots(store, extra_claude_roots(store.roots()))
    }

    pub fn poll_with_roots(
        &mut self,
        store: &SessionStore,
        extra: Vec<ProviderRoots>,
    ) -> Result<Vec<(Source, PathBuf)>> {
        let mut query = CatalogQuery::default();
        query.page_size = 32;
        let rows = store
            .sessions(query)
            .take(32)
            .collect::<Result<Vec<_>, _>>()?;
        let mut current = HashMap::new();
        let mut changed = Vec::new();
        let mut checked = 0;
        // At most eight event locators per turn, rotated fairly within 32.
        // Catalogued locators transfer to the ordinary recent catalog window.
        for _ in 0..self.noticed.len().min(8) {
            let Some((source, path, before)) = self.noticed.pop_front() else {
                break;
            };
            if !admitted(store, &extra, source, &path) {
                continue;
            }
            checked += 1;
            let Ok(stamp) = Stamp::read(&path) else {
                continue;
            };
            if stamp != before {
                changed.push((source, path.clone()));
            }
            current.insert(path.clone(), stamp.clone());
            self.noticed.push_back((source, path, stamp));
        }
        let budget = 32 - checked;
        let start = self.catalog_cursor % rows.len().max(1);
        for row in rows.iter().cycle().skip(start).take(budget.min(rows.len())) {
            let Some(path) = row.raw_path.as_ref() else {
                continue;
            };
            if current.contains_key(path) {
                continue;
            }
            if !admitted(store, &extra, row.source, path) {
                continue;
            }
            let Ok(stamp) = Stamp::read(path) else {
                continue;
            };
            if self.polled.get(path) != Some(&stamp) {
                changed.push((row.source, path.clone()));
            }
            current.insert(path.clone(), stamp);
        }
        self.catalog_cursor = (start + budget) % rows.len().max(1);
        // Transfer only AFTER comparing the hint's stamp. Merely appearing in
        // the catalog (possibly with incomplete evidence) is not capture proof.
        self.noticed.retain(|(_, path, _)| {
            !(current.contains_key(path)
                && rows.iter().any(|row| row.raw_path.as_ref() == Some(path)))
        });
        // A budget-limited turn is not a changed file. Carry stamps for the
        // rest of this same catalog window, rather than forgetting them and
        // manufacturing first-seen work when they next get a stat slot.
        self.polled = rows
            .iter()
            .filter_map(|row| {
                let path = row.raw_path.as_ref()?;
                let stamp = current.get(path).or_else(|| self.polled.get(path))?;
                Some((path.clone(), stamp.clone()))
            })
            .collect();
        Ok(changed)
    }

    /// Capture the stamp BEFORE acquisition, so later writes cannot be
    /// mistaken for bytes that the just-completed hot attempt already read.
    /// Callers supply only locators admitted by their validated watch roots.
    pub fn remember(&mut self, paths: impl IntoIterator<Item = (Source, PathBuf)>) {
        for (source, path) in paths {
            let Ok(stamp) = Stamp::read(&path) else {
                continue;
            };
            self.noticed.retain(|(_, known, _)| known != &path);
            self.noticed.push_front((source, path, stamp));
            self.noticed.truncate(32);
        }
    }
}

pub fn admitted(
    store: &SessionStore,
    extra: &[ProviderRoots],
    source: Source,
    path: &Path,
) -> bool {
    std::iter::once(store.roots())
        .chain(extra.iter().filter(|_| source == Source::Claude))
        .flat_map(|roots| source.capabilities().watch_roots(roots))
        .any(|root| covers(&root, path))
}

fn covers(root: &WatchedPath, path: &Path) -> bool {
    let admits = |base: &Path| match root.scope {
        ai_hist::WatchScope::File => path == base,
        ai_hist::WatchScope::Directory => {
            path.parent() == Some(base) && path.file_name().is_some_and(|name| root.admits(name))
        }
        _ => path.starts_with(base),
    };
    admits(&root.path) || root.path.canonicalize().is_ok_and(|base| admits(&base))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn hint_budget_does_not_forget_unchanged_catalog_stamps_or_starve_its_tail() {
        let Some(home)=crate::live::tests::isolated_home("history::recent_paths::tests::hint_budget_does_not_forget_unchanged_catalog_stamps_or_starve_its_tail") else {return};
        let store = super::super::open(&home.join("probe/history.db")).unwrap();
        let project = home.join(".claude/projects/budget");
        std::fs::create_dir_all(&project).unwrap();
        for n in 0..32 {
            let id = format!("known-{n:02}");
            crate::live::tests::append(
                &project.join(format!("{id}.jsonl")),
                &crate::live::tests::transcript_line(&id, "one"),
            );
        }
        store
            .discover(DiscoveryOptions::default().sources([Source::Claude]))
            .unwrap();
        let mut recent = RecentPaths::default();
        let initial = recent.poll(&store).unwrap();
        assert_eq!(initial.len(), 32);
        // One hot batch remembers only eight of the initial32; all eight
        // overlap the first24 catalog candidates, exactly like the trace.
        recent.remember(initial.iter().take(8).cloned());
        assert!(recent.poll(&store).unwrap().is_empty());
        assert!(
            recent.poll(&store).unwrap().is_empty(),
            "a stat-budget change must not reintroduce identical files as new work"
        );
        assert_eq!(recent.polled.len(), 32);
        // Persistent empty-create hints still leave every stable catalog row
        // a fair stat turn; the last eight cannot be excluded indefinitely.
        for n in 0..8 {
            let path = project.join(format!("empty-{n}.jsonl"));
            std::fs::write(&path, "").unwrap();
            recent.remember([(Source::Claude, path)]);
        }
        let tail = initial.last().unwrap().1.clone();
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&tail)
            .unwrap();
        writer
            .write_all(crate::live::tests::transcript_line("known-31", "two").as_bytes())
            .unwrap();
        writer.flush().unwrap();
        let changes: Vec<_> = (0..2).flat_map(|_| recent.poll(&store).unwrap()).collect();
        assert_eq!(changes, vec![(Source::Claude, tail)]);
        for _ in 0..4 {
            assert!(recent.poll(&store).unwrap().is_empty());
            assert_eq!(recent.polled.len(), 32);
            assert!(recent.noticed.len() <= 32);
        }
        drop(writer);
    }

    #[test]
    fn an_empty_create_keeps_bounded_stat_retry_until_identity_arrives() {
        let Some(home)=crate::live::tests::isolated_home("history::recent_paths::tests::an_empty_create_keeps_bounded_stat_retry_until_identity_arrives") else {return};
        let store = super::super::open(&home.join("probe/history.db")).unwrap();
        let path = home.join(".claude/projects/late/late.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut writer = std::fs::File::create(&path).unwrap();
        let mut recent = RecentPaths::default();
        recent.remember([(Source::Claude, path.clone())]);
        super::super::sweep_paths_once(
            &store,
            true,
            Some(vec![Source::Claude]),
            Some(vec![path.clone()]),
            || false,
        )
        .unwrap();
        assert!(store.sessions(CatalogQuery::default()).next().is_none());
        assert!(
            recent.poll(&store).unwrap().is_empty(),
            "unchanged empty files must not be reacquired every poll"
        );
        writer
            .write_all(crate::live::tests::transcript_line("late", "late-first-record").as_bytes())
            .unwrap();
        writer.flush().unwrap();
        assert_eq!(
            recent.poll(&store).unwrap(),
            vec![(Source::Claude, path.clone())]
        );
        super::super::sweep_paths_once(
            &store,
            true,
            Some(vec![Source::Claude]),
            Some(vec![path.clone()]),
            || false,
        )
        .unwrap();
        assert_eq!(
            store
                .sessions(CatalogQuery::default())
                .next()
                .unwrap()
                .unwrap()
                .session_id,
            "late"
        );
        // The just-catalogued row is not proof that a later append was read.
        writer
            .write_all(crate::live::tests::transcript_line("late", "late-second-record").as_bytes())
            .unwrap();
        writer.flush().unwrap();
        assert_eq!(
            recent.poll(&store).unwrap(),
            vec![(Source::Claude, path.clone())]
        );
        assert!(recent.noticed.is_empty());
        assert!(recent.poll(&store).unwrap().is_empty());
        drop(writer);
        for n in 0..64 {
            let file = path.with_file_name(format!("empty-{n}.jsonl"));
            std::fs::write(&file, "").unwrap();
            recent.remember([(Source::Claude, file)]);
        }
        assert_eq!(
            recent.noticed.len(),
            32,
            "newer admitted locators evict old hints"
        );
        let mut expected = std::collections::HashSet::new();
        for n in 0..64 {
            let file = path.with_file_name(format!("empty-{n}.jsonl"));
            std::fs::write(&file, "later bytes").unwrap();
            if n >= 32 {
                expected.insert(file);
            }
        }
        let mut changed = std::collections::HashSet::new();
        for _ in 0..4 {
            let turn = recent.poll(&store).unwrap();
            assert!(
                turn.len() <= 8,
                "only eight uncatalogued hints are serviced per turn"
            );
            changed.extend(turn.into_iter().map(|(_, path)| path));
            assert!(recent.polled.len() <= 32);
        }
        assert_eq!(
            changed, expected,
            "all retained hints rotate fairly; evicted hints rely on cold coverage"
        );
        assert!(
            recent.poll(&store).unwrap().is_empty(),
            "unchanged hint bytes do not reacquire repeatedly"
        );
    }
}
