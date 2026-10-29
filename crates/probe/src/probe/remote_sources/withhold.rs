use super::*;

/// Sharing mode `new` shares only sessions started after setup. Setup's
/// baseline withholds every session catalogued then, but a cloud session
/// is catalogued only when its connector first lists it — later, for a
/// connector a build adds or a sign-in made after setup. So a remote
/// session first seen here that started before this install's upload job
/// (or with no start time, or before the job exists) is withheld the same
/// way, before its row lands. Only a first sighting is withheld: a session
/// the person later includes stays included. `all` and `selected` need
/// nothing — `selected` uploads only the sessions the person chose.
pub(super) fn withhold_predating_setup(
    store: &SessionStore,
    source: &str,
    observations: &[SourceObservation],
) -> Result<()> {
    let db = store.db_path();
    let Some(directory) = db.parent() else {
        return Ok(());
    };
    // The reader's cache and a pre-setup preview are not an install.
    let Ok(config) = super::super::read_config(directory) else {
        return Ok(());
    };
    if super::super::bridge::mode(&config) != super::super::bridge::SharingMode::New {
        return Ok(());
    }
    let Some(parsed) = ai_hist::Source::parse(source) else {
        return Ok(());
    };
    let conn = agent_relay_probe::delivery::open_db(db)?;
    // Setup's time is the install's first job's. Changing one session's
    // sharing replaces the job, so the current job's time would move the
    // cutoff and withhold sessions that started after setup.
    let setup_ms: i64 = conn
        .query_row("SELECT MIN(created_ms) FROM delivery_jobs", [], |row| {
            row.get::<_, Option<i64>>(0)
        })?
        .unwrap_or(i64::MAX);
    let refs: Vec<ai_hist::SessionRef> = observations
        .iter()
        .map(|o| ai_hist::SessionRef::id(parsed, &o.session.session_id))
        .collect();
    let known = super::super::history::catalog_rows(store, &refs)?;
    for (observation, known) in observations.iter().zip(known) {
        let started = observation.session.first_activity_ms;
        if known.is_none() && started.is_none_or(|ms| ms < setup_ms) {
            agent_relay_probe::delivery::set_session_excluded(
                &conn,
                &agent_relay_probe::delivery::SessionIdentity {
                    source: source.to_string(),
                    session_id: observation.session.session_id.clone(),
                },
                true,
            )?;
        }
    }
    Ok(())
}
