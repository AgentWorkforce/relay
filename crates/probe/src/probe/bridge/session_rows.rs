use super::*;
mod proof_cache;
#[path = "../../relay/session_query/observation.rs"]
pub(super) mod query_observation;
#[derive(Args)]
pub struct SessionList {
    /// Read the persisted catalog without filesystem discovery or delivery scans.
    #[arg(long)]
    catalog_only: bool,
    /// Enrich only these catalog identities (at most 200); no prefix scan.
    #[arg(long = "key")]
    keys: Vec<String>,
    /// Opaque bounded query-page proof cache; never the global prefix cache.
    #[arg(long)]
    proof_cache_key: Option<String>,
    #[command(flatten)]
    target: Target,
    #[arg(long, default_value_t = 500)]
    limit: usize,
}

pub(super) fn session_rows(directory: &Path, config: &Config, limit: usize) -> Result<Vec<Value>> {
    session_rows_within(directory, config, limit, delivery::SESSION_STATUS_BUDGET)
}
pub(super) fn session_rows_within(
    directory: &Path,
    config: &Config,
    limit: usize,
    budget: Duration,
) -> Result<Vec<Value>> {
    session_rows_selected_within(directory, config, limit, budget, None)
}
pub(super) fn session_rows_selected_within(
    directory: &Path,
    config: &Config,
    limit: usize,
    budget: Duration,
    keys: Option<&[SessionIdentity]>,
) -> Result<Vec<Value>> {
    session_rows_selected_cached_within(directory, config, limit, budget, keys, None)
}
pub(super) fn session_rows_selected_cached_within(
    directory: &Path,
    config: &Config,
    limit: usize,
    budget: Duration,
    keys: Option<&[SessionIdentity]>,
    proof_cache_key: Option<&str>,
) -> Result<Vec<Value>> {
    // A store the upgrade has not reached cannot say what was uploaded.
    delivery::ensure_current(&directory.join("history.db"))?;
    let conn = read_db(directory)?;
    // Positions first: a batch prepared after this is among the pending
    // batches read next, or its changes are still ahead of these positions.
    let positions = delivery::upload_positions(&conn, &config.job_id)?;
    let store = crate::history::open_read(&directory.join("history.db"))?;
    let sessions = candidate_sessions(directory, &store, limit, keys)?;
    let mut listed = Vec::new();
    for ranked in rank_sessions(sessions, limit, &store) {
        let session = ranked.session;
        let identity = SessionIdentity {
            source: session.source.as_str().into(),
            session_id: session.session_id.clone(),
        };
        // Membership comes from the same snapshot as the positions, so a
        // member added during the listing is not yet listed as shared.
        let included = delivery::is_shareable(&conn, &identity)?
            && (!positions.scoped() || positions.member(&identity));
        listed.push((
            session,
            identity,
            included,
            ranked.last_activity_ms,
            ranked.is_agent,
            ranked.metadata,
            ranked.profile.and_then(|profile| profile.avatar),
        ));
    }
    // A shared session's subagents are uploaded with it, so its state is its
    // whole family's: the session and the delegated members that came in
    // with it.
    let families = session_families(
        &store,
        &positions,
        &listed
            .iter()
            .map(|(_, identity, included, _, _, _, _)| (identity.clone(), *included))
            .collect::<Vec<_>>(),
    )?;
    // Keyed pages use the collector's normalized identity index. Legacy
    // prefix clients retain compatibility before this collector has upgraded.
    let pending = if keys.is_some() {
        let identities = families.values().flatten().cloned().collect::<Vec<_>>();
        delivery::pending_sessions(&conn, &config.job_id, &identities)?
    } else {
        pending_batches(&conn, &config.job_id)?
    };
    // A session is uploaded once the job has examined all of its changes and
    // none sits in an unacknowledged batch, whatever the rest of the backlog.
    let settled: Vec<_> = listed
        .iter()
        .filter(|(_, _, included, _, _, _, _)| *included)
        .flat_map(|(_, identity, _, _, _, _, _)| families[identity].iter())
        .filter(|identity| !pending.contains_key(*identity))
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let states = page_states(
        &conn,
        &positions,
        &settled,
        directory,
        budget,
        keys.is_some(),
        proof_cache_key,
        config,
    )?;
    let mut rows = Vec::new();
    for (session, identity, included, last_activity_ms, is_agent, metadata, avatar) in listed {
        let observation = keys.and_then(|_| {
            query_observation::ExecutionObservation::positive(
                metadata.model.clone(),
                metadata.reasoning_effort.clone(),
                session
                    .raw_path
                    .as_deref()
                    .map(query_observation::source_fingerprint),
            )
        });
        let family = &families[&identity];
        let any = |test: &dyn Fn(&SessionIdentity) -> bool| family.iter().any(test);
        let state = if !included {
            "not_shared"
        } else if any(&|member| pending.get(member) == Some(&true)) {
            "uploading"
        } else if any(&|member| pending.contains_key(member)) {
            "queued"
        } else if any(&|member| states.unknown.contains(member)) {
            // Not reached before the listing's budget ran out: neither proven
            // uploaded nor known to be waiting.
            "checking"
        } else if !any(&|member| states.waiting.contains(member)) {
            "uploaded"
        } else {
            "shared"
        };
        let models = metadata
            .model
            .map(|model| vec![model])
            .unwrap_or_else(|| session.models.clone());
        let row = json!({"avatar":avatar,"models": models, "reasoning_effort": metadata.reasoning_effort, "source":identity.source,"session_id":identity.session_id,
            "cwd":session.cwd,"git_branch":session.git_branch,
            "first_activity_ms":session.first_activity_ms,"last_activity_ms":last_activity_ms,
            "is_agent":is_agent,"host":conductor::host(session.cwd.as_deref()),"title":title(&session),"included":included,"status":state});
        rows.push(serde_json::to_value(query_observation::ObservedSession {
            session: row,
            observation,
        })?);
    }
    Ok(rows)
}
pub(super) fn pending_batches(
    conn: &Connection,
    job_id: &str,
) -> Result<HashMap<SessionIdentity, bool>> {
    let mut pending = HashMap::new();
    let mut batches = conn.prepare("SELECT payload,state FROM delivery_batches WHERE job_id=? AND state IN ('pending','leased','retry_wait','blocked') AND payload IS NOT NULL")?;
    for row in batches.query_map([job_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (payload, state) = row?;
        let batch: delivery::HistoryExportBatch = serde_json::from_str(&payload)?;
        for record in batch.records {
            // A relationship is stored under its parent but discloses its
            // child too, and a child's backfill may be what sends it: the
            // child is not uploaded until that edge is acknowledged.
            let child = (record.kind == "relationship")
                .then(|| {
                    record
                        .payload
                        .get("child_session_id")?
                        .as_str()
                        .map(str::to_owned)
                })
                .flatten();
            for id in record.session_id.into_iter().chain(child) {
                mark_pending(
                    &mut pending,
                    SessionIdentity {
                        source: record.source.clone(),
                        session_id: id,
                    },
                    state == "leased",
                );
            }
        }
    }
    Ok(pending)
}

pub(super) fn list(options: SessionList) -> Result<()> {
    let directory = options.target.directory()?;
    let config = read_config(&directory)?;
    ensure!(
        options.keys.len() <= 200,
        "at most 200 session keys per page"
    );
    let keys = options
        .keys
        .iter()
        .map(|key| parse_key(key))
        .collect::<Result<Vec<_>>>()?;
    let rows = (if !keys.is_empty() {
        session_rows_selected_cached_within(
            &directory,
            &config,
            options.limit.min(200),
            delivery::SESSION_STATUS_BUDGET,
            Some(&keys),
            options.proof_cache_key.as_deref(),
        )
    } else if options.catalog_only {
        catalog_session_rows(&directory, &config, options.limit)
    } else {
        session_rows(&directory, &config, options.limit)
    })
    .map_err(|error| {
        if delivery::is_upgrade_pending(&error) {
            user_error(UPGRADING)
        } else {
            error
        }
    })?;
    emit(json!({"sharing_mode":mode(&config), "sessions":rows}));
    Ok(())
}

fn candidate_sessions(
    _directory: &Path,
    store: &ai_hist::SessionStore,
    limit: usize,
    keys: Option<&[SessionIdentity]>,
) -> Result<Vec<ai_hist::CatalogSession>> {
    let sessions = if let Some(keys) = keys {
        let refs = keys
            .iter()
            .take(limit)
            .map(|key| {
                let source =
                    ai_hist::Source::parse(&key.source).context("unknown session source")?;
                Ok(ai_hist::SessionRef::id(source, &key.session_id))
            })
            .collect::<Result<Vec<_>>>()?;
        let forgotten = crate::session_reset::baseline()?;
        // include_text retains the catalog's bounded title excerpts; kinds=[]
        // prevents reading transcript/evidence tables for this metadata lookup.
        let mut query = ai_hist::SessionQuery::default();
        query.kinds = Some(Vec::new());
        query.include_text = true;
        refs.iter()
            .map(|identity| {
                Ok(store
                    .session(identity, query.clone())?
                    .map(|evidence| evidence.session))
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .filter(|row| {
                !forgotten.contains(&SessionIdentity {
                    source: row.source.as_str().into(),
                    session_id: row.session_id.clone(),
                })
            })
            .collect()
    } else {
        crate::history::catalog(
            &store,
            ai_hist::SessionScope::All,
            recency_candidate_limit(limit),
        )?
    };
    Ok(sessions)
}

fn session_families(
    store: &ai_hist::SessionStore,
    positions: &delivery::UploadPositions,
    listed: &[(SessionIdentity, bool)],
) -> Result<HashMap<SessionIdentity, Vec<SessionIdentity>>> {
    let mut families: HashMap<SessionIdentity, Vec<SessionIdentity>> = HashMap::new();
    for (identity, included) in listed {
        let mut family = vec![identity.clone()];
        if *included && positions.scoped() {
            family.extend(
                store
                    .delegated_descendants(&[ai_hist::SessionIdentity::new(
                        identity.source.as_str(),
                        identity.session_id.as_str(),
                    )])?
                    .into_iter()
                    .map(|child| SessionIdentity {
                        source: child.source_name,
                        session_id: child.session_id,
                    })
                    .filter(|child| positions.delegated(child)),
            );
        }
        families.insert(identity.clone(), family);
    }
    Ok(families)
}

fn page_states(
    conn: &Connection,
    positions: &delivery::UploadPositions,
    settled: &[SessionIdentity],
    directory: &Path,
    budget: Duration,
    keyed: bool,
    proof_cache_key: Option<&str>,
    config: &Config,
) -> Result<delivery::SessionStates> {
    // A keyed page must not parse a proof file accumulated by unrelated
    // prefix clients. Its proofs are bounded by the requested candidates.
    if keyed {
        if let Some(key) = proof_cache_key {
            return proof_cache::states(conn, positions, settled, directory, config, budget, key);
        }
        return delivery::session_states_within(
            conn,
            positions,
            settled,
            delivery::StatusCache::default(),
            budget,
        );
    }
    // Proofs from earlier listings spare re-reading sessions that have not
    // changed since. A cache that cannot be read or kept is only slower.
    let cache_path = directory.join(STATUS_CACHE);
    let cache = fs::read(&cache_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let states = delivery::session_states_within(&conn, &positions, &settled, cache, budget)?;
    let _ = save_json(&cache_path, &states.cache);
    Ok(states)
}
