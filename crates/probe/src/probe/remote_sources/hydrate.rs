use super::*;

/// The fenced acquire-and-apply both hydrate paths share: fetch the
/// snapshot through the connector, land it under the revision read before
/// the fetch, retry once when the fence moved mid-flight. `unchanged` is
/// intake's verdict on the applied snapshot — the caller, not the host,
/// decides nothing moved.
pub(super) fn acquire_apply(
    pass: &Pass,
    store: &SessionStore,
    key: &ObservationKey,
    observation: ai_hist::SessionObservation,
    revision: String,
    connector: &str,
) -> Result<ai_hist::HydrateSessionResult> {
    let acquire = |observation| pass.acquire(connector, observation);
    let submission = SourceEvidenceSubmission::new(key.clone(), revision, acquire(observation)?);
    match store.apply_source_evidence(submission) {
        Ok(result) => Ok(result),
        Err(ai_hist::Error::SourceRevisionConflict(_)) => {
            let state = store.source_observation(key)?;
            let Some(observation) = state.observation else {
                anyhow::bail!("remote observation withdrawn mid-hydration");
            };
            let revision = state
                .revision
                .context("remote observation carries no revision fence")?;
            Ok(store.apply_source_evidence(SourceEvidenceSubmission::new(
                key.clone(),
                revision,
                acquire(observation)?,
            ))?)
        }
        Err(error) => Err(error.into()),
    }
}

/// Hydrate one remote catalogued session through its connector: read the
/// observation and its revision fence, acquire the snapshot, apply it under
/// that fence — `unchanged` is intake's verdict on the evidence itself,
/// never a stamp the host guesses at. `Ok(Some(false))` for an unchanged
/// apply. `Ok(None)` when no ready connector enumerated this session.
pub fn hydrate(
    store: &SessionStore,
    home: &Path,
    source: &str,
    session_id: &str,
    stopped: impl Fn() -> bool,
) -> Result<Option<bool>> {
    let host = Host::system(home, store.db_path());
    let ready = ready(&host, Some(store.db_path()));
    hydrate_with(
        &Pass::new(&host),
        &ready,
        store,
        source,
        session_id,
        stopped,
    )
}

pub(super) fn hydrate_with(
    pass: &Pass,
    ready: &[(&'static str, &'static str)],
    store: &SessionStore,
    source: &str,
    session_id: &str,
    stopped: impl Fn() -> bool,
) -> Result<Option<bool>> {
    for (connector, connector_source) in ready
        .iter()
        .filter(|(_, connector_source)| *connector_source == source)
    {
        let key = key(connector, connector_source, session_id);
        let state = store.source_observation(&key)?;
        let Some(observation) = state.observation else {
            continue;
        };
        if stopped() {
            return Ok(Some(false));
        }
        // The observation and checkpoint stamps live in different
        // namespaces — the provider's listing digest versus the evidence
        // hash — so they cannot be compared directly. Their `updated_ms`
        // can be: the observation's bumps only when the guarded upsert sees
        // a material change, the checkpoint's on every apply. An
        // observation no newer than the checkpoint cannot hold anything
        // the apply didn't already see — skip before the API round trip.
        // Equal milliseconds is the common case: the apply writes the
        // observation row before the checkpoint in one transaction.
        if let Some(checkpoint) = &state.checkpoint {
            if observation.updated_ms <= checkpoint.updated_ms {
                return Ok(Some(false));
            }
        }
        let revision = state
            .revision
            .context("remote observation carries no revision fence")?;
        let result = acquire_apply(pass, store, &key, observation, revision, connector)?;
        if stopped() {
            return Ok(Some(false));
        }
        return Ok(Some(result.status != "unchanged"));
    }
    Ok(None)
}

/// Hydrate a remote session into `store` when `store` is not the catalog
/// that observed it — the transcript reader's private cache, which never
/// runs remote enumeration. A missing observation row is landed as a
/// placeholder first so the evidence still applies under a revision fence.
/// `Ok(None)` when no ready connector serves this source. A person opening
/// the session asked for it, so a connector held back since its last
/// listing failed is still tried.
pub fn hydrate_reader(
    store: &SessionStore,
    source: &str,
    session_id: &str,
    stopped: impl Fn() -> bool,
) -> Result<Option<bool>> {
    let home = store.roots().home.clone();
    let host = Host::system(&home, store.db_path());
    hydrate_reader_with(&host, store, source, session_id, stopped)
}

pub(super) fn hydrate_reader_with(
    host: &Host,
    store: &SessionStore,
    source: &str,
    session_id: &str,
    stopped: impl Fn() -> bool,
) -> Result<Option<bool>> {
    let Some((connector, connector_source)) = ready(host, None)
        .into_iter()
        .find(|(_, connector_source)| *connector_source == source)
    else {
        return Ok(None);
    };
    let key = key(connector, connector_source, session_id);
    let state = store.source_observation(&key)?;
    let (observation, revision) = match (state.observation, state.revision) {
        (Some(observation), Some(revision)) => (observation, revision),
        _ => {
            store.apply_source_observations(SourceObservationBatch::new(
                connector,
                INSTANCE,
                SessionLocation::Remote,
                vec![SourceObservation {
                    session: ai_hist::ShallowSession {
                        source: connector_source.to_string(),
                        session_id: session_id.to_string(),
                        ..Default::default()
                    },
                    raw_locator: None,
                }],
            ))?;
            let state = store.source_observation(&key)?;
            (
                state
                    .observation
                    .context("placeholder remote observation did not land")?,
                state
                    .revision
                    .context("remote observation carries no revision fence")?,
            )
        }
    };
    if stopped() {
        return Ok(Some(false));
    }
    acquire_apply(
        &Pass::asked(host),
        store,
        &key,
        observation,
        revision,
        connector,
    )?;
    Ok(Some(true))
}
