use super::*;
pub(super) fn parse_key(key: &str) -> Result<SessionIdentity> {
    let (source, id) = key
        .split_once(':')
        .ok_or_else(|| user_error("Invalid session key. Use SOURCE:ID from sessions list."))?;
    ensure!(
        !source.is_empty() && !id.is_empty(),
        user_error("Invalid session key. Use SOURCE:ID from sessions list.")
    );
    Ok(SessionIdentity {
        source: source.into(),
        session_id: id.into(),
    })
}

pub(super) fn validate_identities(
    conn: &Connection,
    identities_requested: &[SessionIdentity],
) -> Result<()> {
    let mut known = true;
    for id in identities_requested {
        known &= delivery::has_session(conn, id)?;
    }
    ensure!(
        known,
        user_error("Unknown session. Refresh sessions list and try again.")
    );
    for id in identities_requested {
        ensure!(
            delivery::delegating_session(conn, id)?.is_none(),
            user_error("This is a subagent of another session and is shared with it. Select that session instead.")
        );
        ensure!(
            !delivery::native_grok_subagent(conn, id)?,
            user_error("This is a Grok subagent and cannot be selected on its own.")
        );
    }
    Ok(())
}

/// An explicit deny may precede discovery; consent to include still needs evidence.
pub(super) fn validate_mutation_identities(
    conn: &Connection,
    identities: &[SessionIdentity],
    include: bool,
) -> Result<()> {
    if include {
        return validate_identities(conn, identities);
    }
    for id in identities {
        ensure!(
            ai_hist::Source::parse(&id.source).is_some_and(|source| source.as_str() == id.source)
                && !id.session_id.is_empty()
                && !id.session_id.contains('\0'),
            user_error("Invalid session identity.")
        );
        if delivery::has_session(conn, id)? {
            validate_identities(conn, std::slice::from_ref(id))?;
        }
    }
    Ok(())
}
pub(super) fn preflight_plan(
    directory: &Path,
    config: Config,
    requested: Option<SharingMode>,
    identities: &[SessionIdentity],
    include: bool,
    delete: bool,
) -> Result<ChangePlan> {
    plan(
        &read_db(directory)?,
        directory,
        config,
        requested,
        identities,
        include,
        delete,
    )
}
pub(super) fn plan(
    conn: &Connection,
    directory: &Path,
    config: Config,
    requested: Option<SharingMode>,
    identities: &[SessionIdentity],
    include: bool,
    delete: bool,
) -> Result<ChangePlan> {
    validate_deletion(conn, identities, delete)?;
    make_plan(conn, directory, config, requested, identities, include)
}
pub(super) fn validate_deletion(
    conn: &Connection,
    identities: &[SessionIdentity],
    delete: bool,
) -> Result<()> {
    if delete {
        validate_identities(conn, identities)?;
    }
    Ok(())
}
pub(super) fn mutation_unchanged(
    conn: &Connection,
    job: &str,
    id: &SessionIdentity,
    include: bool,
) -> Result<bool> {
    let member = delivery::job_session_included(conn, job, id)?;
    let shareable = delivery::is_shareable(conn, id)?;
    Ok(if include {
        member && shareable
    } else {
        !member && delivery::is_explicitly_excluded(conn, id)?
    })
}
pub(super) fn apply_member_change(
    conn: &Connection,
    job: &str,
    id: &SessionIdentity,
    include: bool,
) -> Result<()> {
    if include {
        delivery::include_job_session(conn, job, id)?;
    } else {
        delivery::set_session_excluded(conn, id, true)?;
        delivery::set_job_session(conn, job, id, false)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::super::tests::{apply, fixture};
    use super::*;
    #[test]
    fn explicit_deny_is_not_lost_when_folder_policy_already_withholds_the_session() {
        let Some(home) =
            crate::live::tests::isolated_home("bridge::selection_validation::tests::explicit_deny_is_not_lost_when_folder_policy_already_withholds_the_session")
        else {
            return;
        };
        let (dir, config) = fixture(SharingMode::Selected);
        let conn = db(dir.path()).unwrap();
        let id = parse_key("claude:cse_policy_withheld").unwrap();
        conn.execute("INSERT INTO sessions(source,session_id,first_prompt) VALUES('claude','cse_policy_withheld','private session')",[]).unwrap();
        assert!(!delivery::is_shareable(&conn, &id).unwrap());
        assert!(!delivery::is_explicitly_excluded(&conn, &id).unwrap());
        delivery::adopt_session_job(&conn, &config.job_id, &[]).unwrap();
        change(
            dir.path(),
            None,
            &["claude:cse_policy_withheld".into()],
            false,
        )
        .unwrap();
        assert!(delivery::is_explicitly_excluded(&conn, &id).unwrap());
        let dirs = crate::relay::claude_dirs::ClaudeDirs::from_env(
            &|key| std::env::var(key).ok(),
            &home,
            &crate::relay::workspace::relay_home(&|key| std::env::var(key).ok(), &home),
        );
        dirs.set_cloud_sessions(true).unwrap();
        assert!(crate::relay::claude_dirs::cloud_sessions_shared_here());
        assert!(
            !delivery::is_shareable(&conn, &id).unwrap(),
            "Lifting folder/login consent must retain the explicit deny"
        );
    }
    #[test]
    fn explicit_exclusion_before_discovery_persists_in_every_mode_and_denies_future_ingest() {
        for mode in [SharingMode::All, SharingMode::Selected, SharingMode::New] {
            let (dir, config) = fixture(mode);
            let conn = db(dir.path()).unwrap();
            let id = parse_key("codex:rw_not_yet_discovered").unwrap();
            assert!(
                make_plan(
                    &conn,
                    dir.path(),
                    config.clone(),
                    None,
                    std::slice::from_ref(&id),
                    true
                )
                .is_err(),
                "Inclusion must still require catalog evidence"
            );
            let deletion = change_with_cloud(
                dir.path(),
                None,
                &["codex:rw_not_yet_discovered".into()],
                false,
                true,
            )
            .unwrap_err();
            assert!(
                deletion.to_string().contains("Unknown session"),
                "Cloud delete must keep its original knowledge guard"
            );
            let config = apply(
                dir.path(),
                config,
                None,
                &["codex:rw_not_yet_discovered"],
                false,
            );
            assert!(
                !delivery::is_shareable(&conn, &id).unwrap(),
                "Future deny must persist in {mode:?}"
            );
            // Repeat is harmless, including the selected-job no-op path.
            change(
                dir.path(),
                None,
                &["codex:rw_not_yet_discovered".into()],
                false,
            )
            .unwrap();
            conn.execute("INSERT INTO sessions(source,session_id,first_prompt) VALUES('codex','rw_not_yet_discovered','future discovered transcript')",[]).unwrap();
            assert!(!delivery::is_shareable(&conn, &id).unwrap());
            assert!(!session_rows(dir.path(), &config, 500)
                .unwrap()
                .iter()
                .find(|r| r["session_id"] == id.session_id)
                .unwrap()["included"]
                .as_bool()
                .unwrap());
            let config = apply(
                dir.path(),
                config,
                None,
                &["codex:rw_not_yet_discovered"],
                true,
            );
            assert!(
                delivery::is_shareable(&conn, &id).unwrap(),
                "Explicit include after discovery can lift deny"
            );
            assert!(session_rows(dir.path(), &config, 500)
                .unwrap()
                .iter()
                .find(|r| r["session_id"] == id.session_id)
                .unwrap()["included"]
                .as_bool()
                .unwrap());
        }
    }
}
