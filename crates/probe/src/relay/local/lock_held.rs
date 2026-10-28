//! Sessions proven by a file their process holds open: a Devin session's
//! `session_locks/<id>.lock` and a Cursor CLI conversation's `store.db`.
//! Discovery, caller identification, reply commands and delivery for both.
use super::*;
use crate::relay::process::ProcessInfo;

/// The live Devin sessions, and the Devin Cloud sessions the
/// history catalog lists, appended to `found`.
pub(super) fn discover_devin(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    found: &mut Vec<DiscoveredSession>,
) {
    // Devin sessions a person has running: each `devin` process proves
    // its session by the `session_locks/<id>.lock` it holds open.
    found.extend(devin::discover(&config.devin, table, config.uid));
    // Devin Cloud sessions the history catalog lists as remote stay
    // registered and deliverable while the connector's sign-in
    // resolves — the registration surface a cloud-only session could
    // never reach through a local lock. A session held locally keeps
    // its local row.
    if let Some(root) = &config.probe_root {
        let held: HashSet<String> = found
            .iter()
            .map(|session| session.target.id.clone())
            .collect();
        found.extend(
            crate::relay::devin_cloud::discover(&config.devin, root)
                .into_iter()
                .filter(|session| !held.contains(&session.target.id)),
        );
    }
}

/// The caller, when the walk reaches a `devin` or `cursor-agent` process of
/// this user's at `current`: the session whose file it holds open, or
/// nobody. A Devin or Cursor command that is not a session never lends a
/// caller the outer session's identity. `None` lets the walk go on.
pub(super) fn caller(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    current: i32,
    process: ProcessInfo,
) -> Option<Result<Target, CallerMiss>> {
    if process.uid != config.uid {
        return None;
    }
    let (kind, session) = if devin::is_devin_process(table, current) {
        (
            SessionKind::Devin,
            devin::held_session(&config.devin, table, current),
        )
    } else if cursor_cli::is_cursor_process(table, current) {
        (
            SessionKind::CursorCli,
            cursor_cli::held_session(&config.cursor, table, current),
        )
    } else {
        return None;
    };
    // Still the same process after its files were read.
    let same = table.process(current) == Some(process);
    Some(
        session
            .filter(|_| same)
            .map(|id| Target::new(kind, id))
            .ok_or(CallerMiss::NotASession),
    )
}

/// Whether a reply command can be named: the session's tools run under its
/// live holding process.
pub(super) fn can_reply(config: &LocalConfig, table: &dyn ProcessTable, target: &Target) -> bool {
    match target.kind {
        SessionKind::Devin => devin::held(&config.devin, table, config.uid, &target.id).is_some(),
        SessionKind::CursorCli => {
            cursor_cli::held(&config.cursor, table, config.uid, &target.id).is_some()
        }
        _ => false,
    }
}

/// One delivery into a Devin or Cursor CLI session. Each one's inbox is the
/// session's own queue, so no binding can point it at another session.
pub(super) fn inject(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    target: &Target,
    message_id: &str,
    text: &str,
) -> InjectOutcome {
    match target.kind {
        SessionKind::Devin => {
            match devin::send(
                &config.devin,
                table,
                config.uid,
                &target.id,
                message_id,
                text,
            ) {
                // Nothing local holds the session: a cloud-format id may
                // still be reachable through devin-cloud's send route.
                // `None` keeps the local answer — a stopped local session
                // is waiting, not lost.
                InjectOutcome::Waiting(reason) => crate::relay::devin_cloud::send_cloud(
                    &config.devin,
                    config.probe_root.as_deref(),
                    &target.id,
                    text,
                )
                .unwrap_or(InjectOutcome::Waiting(reason)),
                outcome => outcome,
            }
        }
        // Agent Relay's inbox for the session, which its hooks drain.
        SessionKind::CursorCli => cursor_cli::send(
            &config.cursor,
            table,
            config.uid,
            &target.id,
            message_id,
            text,
        ),
        _ => InjectOutcome::Refused("This session is not held by a file.".into()),
    }
}
