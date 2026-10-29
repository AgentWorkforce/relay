//! Bounded member-file safety checks independent of native callback delivery.
use super::*;

#[derive(Default)]
pub(super) struct Poll {
    next: usize,
    due: Option<Instant>,
}
impl Poll {
    /// Normal periodic rounds stat at most 32 file locators. Initial hydration,
    /// explicit callbacks, actual loss and the full member backstop retain their
    /// existing semantics and may compare more. Membership/catalog handling
    /// outside this selector still scales with the selected member set.
    pub(super) fn pick(
        &mut self,
        members: &[delivery::SessionIdentity],
        locators: &HashMap<delivery::SessionIdentity, Locator>,
        interval: Duration,
        now: Instant,
    ) -> HashSet<delivery::SessionIdentity> {
        if self.due.is_some_and(|due| now < due) || members.is_empty() {
            return HashSet::new();
        }
        self.due = Some(now + interval);
        let start = self.next % members.len();
        let mut polled = HashSet::new();
        let mut visited = 0;
        while visited < members.len() && polled.len() < 32 {
            let member = &members[(start + visited) % members.len()];
            if matches!(locators.get(member), Some(Locator::File(Some(_)))) {
                polled.insert(member.clone());
            }
            visited += 1;
        }
        self.next = (start + visited) % members.len();
        polled
    }
}

/// Each member's stamp now.
pub(super) fn stamps(
    store: &ai_hist::SessionStore,
    members: &[delivery::SessionIdentity],
    locators: &HashMap<delivery::SessionIdentity, Locator>,
) -> anyhow::Result<Vec<Stamp>> {
    let catalog: Vec<SessionRef> = members
        .iter()
        .filter_map(|member| match locators.get(member) {
            Some(Locator::Catalog(reference)) => Some(reference.clone()),
            _ => None,
        })
        .collect();
    let mut rows = if catalog.is_empty() {
        Vec::new()
    } else {
        history::catalog_rows(store, &catalog)?
    }
    .into_iter();
    Ok(members
        .iter()
        .map(|member| match locators.get(member) {
            Some(Locator::File(Some(path))) => std::fs::metadata(path)
                .ok()
                .and_then(|meta| Some(Stamp::File(meta.modified().ok()?, meta.len())))
                .unwrap_or(Stamp::Unknown),
            Some(Locator::Catalog(_)) => rows.next().flatten().map_or(Stamp::Unknown, |row| {
                Stamp::Catalog(row.source_stamp, row.last_activity_ms)
            }),
            _ => Stamp::Unknown,
        })
        .collect())
}

/// A freshly opened legacy reader must not replace a cached denied snapshot.
pub(super) fn refresh(readers: &mut Readers, state: &mut Members) -> anyhow::Result<()> {
    let changed = state.roots.refresh(&mut readers.store)?;
    if !changed && !readers.snapshot {
        readers.store = state.roots.bind(&readers.store)?;
    }
    readers.snapshot = true;
    if changed {
        state.locators.clear();
        state.denied.clear();
        state.seen.clear();
        state.watch = None;
        state.backstop = None;
    }
    Ok(())
}

pub(super) fn locate(
    store: &ai_hist::SessionStore,
    state: &mut Members,
    members: &[delivery::SessionIdentity],
) -> anyhow::Result<()> {
    let unknown: Vec<_> = members
        .iter()
        .filter(|member| !state.locators.contains_key(*member))
        .cloned()
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    {
        let refs: Vec<_> = unknown
            .iter()
            .map(|member| {
                Source::parse(&member.source)
                    .map(|source| SessionRef::id(source, member.session_id.clone()))
            })
            .collect();
        let known: Vec<SessionRef> = refs.iter().flatten().cloned().collect();
        let extra = state.roots.extra_claude_roots(store)?;
        let mut paths = history::raw_paths(store, &known)?.into_iter();
        for (member, reference) in unknown.into_iter().zip(refs) {
            let locator = match reference {
                // The store's own rule for whether a path names one session.
                Some(reference) if !reference.source().capabilities().hydrates_by_path => {
                    paths.next();
                    Locator::Catalog(reference)
                }
                Some(_) => Locator::File(paths.next().flatten()),
                None => Locator::File(None),
            };
            let locator = member_safety::admit(store, &extra, &member, locator, &mut state.denied);
            state.locators.insert(member, locator);
        }
    }
    Ok(())
}

pub(super) fn admit(
    store: &ai_hist::SessionStore,
    extra: &[ai_hist::ProviderRoots],
    member: &delivery::SessionIdentity,
    locator: Locator,
    denied: &mut HashSet<delivery::SessionIdentity>,
) -> Locator {
    if Source::parse(&member.source) == Some(Source::Claude) {
        if let Locator::File(Some(path)) = &locator {
            if !history::path_admitted(store, extra, Source::Claude, path) {
                denied.insert(member.clone());
                return Locator::File(None);
            }
        }
    }
    denied.remove(member);
    locator
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_acquisition_keeps_validated_denial_across_malformed_choices() {
        let Some(home)=crate::live::tests::isolated_home("live::member_safety::tests::selected_acquisition_keeps_validated_denial_across_malformed_choices") else {return};
        use agent_relay_probe::relay::{
            claude_dirs::ClaudeDirs, process::FakeProcesses, workspace::relay_home,
        };
        let env = |key: &str| std::env::var(key).ok();
        let dirs = ClaudeDirs::from_env(&env, &home, &relay_home(&env, &home));
        dirs.remember_running(&FakeProcesses::default());
        let private = home.join(".claude-work/projects/private/private.jsonl");
        let allowed = home.join(".claude-personal/projects/allowed/allowed.jsonl");
        let base_private = home.join(".claude/projects/base-private/base-private.jsonl");
        for (path, id) in [
            (&private, "private"),
            (&allowed, "allowed"),
            (&base_private, "base-private"),
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            crate::live::tests::append(path, &crate::live::tests::transcript_line(id, "one"));
        }
        let directory = home.join("probe");
        let db = directory.join("history.db");
        let conn = delivery::open_db(&db).unwrap();
        history::discover(&db, None, || false).unwrap();
        let job =
            delivery::create_session_job(&conn, &crate::live::tests::job_config(), 0).unwrap();
        let identity = |id: &str| delivery::SessionIdentity {
            source: "claude".into(),
            session_id: id.into(),
        };
        for id in ["private", "allowed", "base-private"] {
            delivery::set_job_session(&conn, &job.job_id, &identity(id), true).unwrap();
        }
        dirs.set_shared(
            home.join(".claude-work").to_str().unwrap(),
            false,
            &home.join(".claude"),
        )
        .unwrap();
        dirs.set_shared(
            home.join(".claude").to_str().unwrap(),
            false,
            &home.join(".claude"),
        )
        .unwrap();
        let valid = std::fs::read(dirs.file.as_ref().unwrap()).unwrap();
        let mut state = Members::default();
        let mut readers = Readers::open(&db).unwrap();
        refresh(&mut readers, &mut state).unwrap();
        std::fs::write(dirs.file.as_ref().unwrap(), b"{").unwrap();
        // Reopened legacy readers must also bind to the cached denied roots.
        let mut readers = Readers::open(&db).unwrap();
        refresh(&mut readers, &mut state).unwrap();
        assert!(readers.snapshot);
        let events = |id: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM session_events WHERE session_id=?",
                [id],
                |row| row.get(0),
            )
            .unwrap()
        };
        let extra = state.roots.extra_claude_roots(&readers.store).unwrap();
        // Isolate the targeted helper's authority too, rather than letting
        // the outer locator gate hide a permissive fallback inside hydration.
        let denied =
            history::hydrate_snapshot(&readers.store, extra, "claude", "private", || false);
        assert_eq!(events("private"),0,"the actual targeted helper must not acquire denied evidence through a malformed fallback");
        assert!(denied.is_err());
        state.readers = Some(readers);
        let cancelled = Arc::new(AtomicBool::new(false));
        let shared = Shared::default();
        let round = |state: &mut Members| {
            poll_and_judge(
                &directory,
                &db,
                &job.job_id,
                &cancelled,
                &shared,
                state,
                &crate::live::tests::options(),
            )
        };
        round(&mut state);
        assert_eq!(
            (events("private"), events("allowed")),
            (0, 1),
            "actual selected acquisition must preserve cached denial and allowed control"
        );
        assert_eq!(
            events("base-private"),
            0,
            "reopened legacy reader must retain the validated default-folder denial"
        );
        assert!(state.denied.contains(&identity("private")));
        assert!(
            matches!(
                state.locators.get(&identity("private")),
                Some(Locator::File(None))
            ),
            "denied path must not reach stat/watch registration"
        );
        crate::live::tests::append(
            &allowed,
            &crate::live::tests::transcript_line("allowed", "two"),
        );
        crate::live::tests::append(
            &private,
            &crate::live::tests::transcript_line("private", "two"),
        );
        state.safety = Poll::default();
        state.roots.invalidate();
        round(&mut state);
        assert_eq!(
            (events("private"), events("allowed")),
            (0, 1),
            "malformed refresh must block even an allowed moving member"
        );
        assert!(state.readers.is_none());
        round(&mut state);
        assert_eq!(
            (events("private"), events("allowed")),
            (0, 1),
            "cached refresh failure cannot reopen permissive readers"
        );
        std::fs::write(dirs.file.as_ref().unwrap(), &valid).unwrap();
        dirs.set_shared(
            home.join(".claude-work").to_str().unwrap(),
            true,
            &home.join(".claude"),
        )
        .unwrap();
        state.safety = Poll::default();
        state.roots.invalidate();
        round(&mut state);
        assert_eq!(
            (events("private"), events("allowed")),
            (2, 2),
            "valid explicit reenablement must resume both members"
        );
    }

    #[test]
    fn periodic_file_checks_are_bounded_and_fair_across_47000_members() {
        let members: Vec<_> = (0..47000)
            .map(|n| delivery::SessionIdentity {
                source: "claude".into(),
                session_id: n.to_string(),
            })
            .collect();
        let locators = members
            .iter()
            .map(|member| {
                (
                    member.clone(),
                    Locator::File(Some(PathBuf::from(format!(
                        "synthetic/{}",
                        member.session_id
                    )))),
                )
            })
            .collect();
        let mut poll = Poll::default();
        let mut now = Instant::now();
        let interval = Duration::from_secs(1);
        let mut seen = HashSet::new();
        for _ in 0..47000usize.div_ceil(32) {
            let turn = poll.pick(&members, &locators, interval, now);
            assert_eq!(turn.len(), 32);
            seen.extend(turn);
            assert!(
                poll.pick(&members, &locators, interval, now).is_empty(),
                "an event round cannot spend a second periodic budget early"
            );
            now += interval;
        }
        assert_eq!(
            seen.len(),
            47000,
            "every retained file locator gets a fair turn"
        );
        let removed = &members[..3];
        assert_eq!(
            poll.pick(removed, &locators, interval, now).len(),
            3,
            "membership shrink cannot strand the cursor"
        );
    }
}
