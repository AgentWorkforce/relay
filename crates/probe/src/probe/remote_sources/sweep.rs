use super::*;

/// Whether a remote session moved since its evidence was last applied:
/// the same fence [`hydrate_with`] answers before any API round trip.
pub(super) fn needs_fetch(
    store: &SessionStore,
    ready: &[(&'static str, &'static str)],
    source: &str,
    session_id: &str,
) -> Result<bool> {
    for (connector, connector_source) in ready.iter().filter(|(_, s)| *s == source) {
        let state = store.source_observation(&key(connector, connector_source, session_id))?;
        let Some(observation) = state.observation else {
            continue;
        };
        return Ok(state
            .checkpoint
            .is_none_or(|checkpoint| observation.updated_ms > checkpoint.updated_ms));
    }
    Ok(false)
}

/// Which remote sessions the install will upload, so no other is
/// downloaded: one excluded from upload (by the person, by a folder they
/// stopped sharing, or as older than setup under "new") never is, and
/// under "selected" only a chosen one is. Without an install config (a
/// preview, a test) only exclusions apply.
pub(super) struct Wanted {
    conn: Option<rusqlite::Connection>,
    chosen: Option<BTreeSet<(String, String)>>,
}

impl Wanted {
    fn load(db: &Path) -> Wanted {
        let conn = agent_relay_probe::delivery::open_db(db).ok();
        let chosen = db
            .parent()
            .and_then(|directory| super::super::read_config(directory).ok())
            .filter(|config| {
                super::super::bridge::mode(config) == super::super::bridge::SharingMode::Selected
            })
            .and_then(|config| {
                let conn = conn.as_ref()?;
                // A selected install's job is a session job: its members,
                // not its selection, are the chosen sessions.
                let members =
                    agent_relay_probe::delivery::job_selected_sessions(conn, &config.job_id)
                        .ok()?;
                Some(
                    members
                        .into_iter()
                        .map(|id| (id.source, id.session_id))
                        .collect(),
                )
            });
        Wanted { conn, chosen }
    }

    fn wants(&self, source: &str, session_id: &str) -> bool {
        let shareable = self.conn.as_ref().is_none_or(|conn| {
            agent_relay_probe::delivery::is_shareable(
                conn,
                &agent_relay_probe::delivery::SessionIdentity {
                    source: source.to_string(),
                    session_id: session_id.to_string(),
                },
            )
            .unwrap_or(false)
        });
        shareable
            && self
                .chosen
                .as_ref()
                .is_none_or(|chosen| chosen.contains(&(source.to_string(), session_id.to_string())))
    }
}

/// What one [`sweep`] did: rows hydrated and rows whose hydration failed,
/// and the enumeration it ran, when one was due. Per-session failures are
/// counted, not fatal — one unreachable connector must not fail the local
/// sweep it rides.
pub struct SweepOutcome {
    pub hydrated: usize,
    pub failed: usize,
    pub enumeration: Option<Enumeration>,
    /// What pacing held back, for the remote diagnostic.
    pub pacing: Value,
}

/// Broad capture's remote leg: refresh remote catalog rows when due, then
/// hydrate every remote-only session whose observation moved — the parity
/// of `store.sync`'s enumerate-then-hydrate for sessions only a connector
/// can reach. The moved-since-applied fence lives in [`hydrate`] so every
/// caller shares it: whichever path last enumerated, a row whose
/// observation has not changed since its evidence applied costs one index
/// read, not an API call. A connector whose listing failed is skipped
/// until its next listing. `Ok(None)` when no connector is signed in or the
/// stop fired first; both are inert, not failures.
pub fn sweep(
    db: &Path,
    store: &SessionStore,
    stopped: impl Fn() -> bool,
) -> Result<Option<SweepOutcome>> {
    let home = store.roots().home.clone();
    sweep_with(&Host::system(&home, db), db, store, stopped)
}

pub(super) fn sweep_with(
    host: &Host,
    db: &Path,
    store: &SessionStore,
    stopped: impl Fn() -> bool,
) -> Result<Option<SweepOutcome>> {
    if stopped() || reaches(host).iter().all(|(_, _, r)| *r == Reach::Absent) {
        return Ok(None);
    }
    let pass = Pass::new(host);
    let mut outcome = SweepOutcome {
        hydrated: 0,
        failed: 0,
        enumeration: None,
        pacing: Value::Null,
    };
    if due(db) {
        let report = enumerate_ready(&pass, store)?;
        mark_enumerated(db, &report)?;
        outcome.enumeration = Some(report);
    }
    let ready = ready(host, Some(db));
    if ready.is_empty() {
        return Ok(Some(outcome));
    }
    let mut run = Run {
        pass: &pass,
        ready: &ready,
        store,
        db,
        now: now_ms(),
        pacing: Pacing::load(db),
        started: std::time::Instant::now(),
        attempts: 0,
        signed_out: BTreeSet::new(),
    };
    run.pacing.held_back = held_back_reason(db, &run.pacing);
    let mut waiting = 0;
    for row in due_rows(store, &ready, &Wanted::load(db))? {
        let source = row.source.as_str();
        if !run
            .pacing
            .session_open(source, &row.session_id, row.last_activity_ms, run.now)
        {
            continue;
        }
        waiting += 1;
        if stopped() || run.spent(source) {
            continue;
        }
        if run.download(&row, &stopped, &mut outcome) {
            waiting -= 1;
        }
    }
    run.pacing.waiting = waiting;
    outcome.pacing = run.pacing.json();
    run.pacing.save(db)?;
    Ok(Some(outcome))
}

/// Why downloads must wait, as the diagnostic says it.
fn held_back_reason(db: &Path, pacing: &Pacing) -> Option<String> {
    pacing::hold_back(pacing, pacing::free_bytes(db)).map(str::to_string)
}

/// The remote-only sessions this install will upload whose listing moved
/// since they were last downloaded, newest first: the ones a person is most
/// likely to look for. Collected before any download, because the catalog
/// iterator holds a read snapshot that downloads' writes must not race.
fn due_rows(
    store: &SessionStore,
    ready: &[(&'static str, &'static str)],
    wanted: &Wanted,
) -> Result<Vec<ai_hist::CatalogSession>> {
    let mut rows = Vec::new();
    let mut query = ai_hist::CatalogQuery::default();
    query.scope = ai_hist::SessionScope::All;
    for row in store.sessions(query) {
        let row = row?;
        let source = row.source.as_str();
        if !row.locations.is_empty()
            && row.locations.iter().all(|l| l == "remote")
            && ready.iter().any(|(_, s)| *s == source)
            && wanted.wants(source, &row.session_id)
            && needs_fetch(store, ready, source, &row.session_id)?
        {
            rows.push(row);
        }
    }
    rows.sort_by_key(|row| std::cmp::Reverse(row.last_activity_ms));
    Ok(rows)
}

/// One sweep's downloads and what limits them.
struct Run<'p, 'h, 'a> {
    pass: &'p Pass<'h, 'a>,
    ready: &'p [(&'static str, &'static str)],
    store: &'p SessionStore,
    db: &'p Path,
    now: i64,
    pacing: Pacing,
    started: std::time::Instant,
    attempts: usize,
    /// A source whose sign-in failed on one session fails the same way on
    /// every other: the rest of the pass leaves it alone.
    signed_out: BTreeSet<String>,
}

impl Run<'_, '_, '_> {
    fn connector(&self, source: &str) -> &'static str {
        self.ready
            .iter()
            .find(|(_, s)| *s == source)
            .map_or("", |(connector, _)| *connector)
    }

    /// Whether this pass may download nothing more from `source`.
    fn spent(&self, source: &str) -> bool {
        self.pacing.held_back.is_some()
            || self.attempts >= pacing::PASS_SESSIONS
            || self.started.elapsed() >= pacing::PASS_TIME
            || self.signed_out.contains(source)
            || !self.pacing.connector_open(self.connector(source), self.now)
    }

    /// Download one session; whether it is no longer waiting.
    fn download(
        &mut self,
        row: &ai_hist::CatalogSession,
        stopped: &impl Fn() -> bool,
        outcome: &mut SweepOutcome,
    ) -> bool {
        let source = row.source.as_str();
        let connector = self.connector(source);
        self.attempts += 1;
        let before = pacing::stored_bytes(self.db);
        let result = hydrate_with(
            self.pass,
            self.ready,
            self.store,
            source,
            &row.session_id,
            stopped,
        );
        let error = match result {
            Ok(result) => {
                outcome.hydrated += usize::from(result == Some(true));
                self.pacing.succeeded(connector, source, &row.session_id);
                let grown = pacing::stored_bytes(self.db).saturating_sub(before);
                self.pacing.grown_bytes = self.pacing.grown_bytes.saturating_add(grown);
                self.pacing.held_back = held_back_reason(self.db, &self.pacing);
                return true;
            }
            Err(error) => error,
        };
        if keychain_not_ready(&error) {
            // Not a failure: Claude is not ready until the Keychain allows it.
            self.signed_out.insert(source.to_string());
            return false;
        }
        outcome.failed += 1;
        if error.is::<Unready>() || error.to_string().starts_with("AUTHENTICATION_EXPIRED") {
            self.signed_out.insert(source.to_string());
            return false;
        }
        let failure = error
            .downcast_ref::<ConnectorFailure>()
            .map_or(Failure::Transient, |failure| failure.failure);
        let activity = row.last_activity_ms;
        self.pacing.failed(
            connector,
            source,
            &row.session_id,
            activity,
            failure,
            self.now,
        );
        false
    }
}
