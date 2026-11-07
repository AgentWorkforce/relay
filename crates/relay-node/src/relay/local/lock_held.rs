//! Sessions proven by a file their process holds open: a Devin session's
//! `session_locks/<id>.lock` and a Cursor CLI conversation's `store.db`.
//! Discovery, caller identification, reply commands and delivery for both.
use super::*;
use crate::relay::process::ProcessInfo;

/// The live Devin sessions, and the Devin Cloud sessions the build's
/// remote session sources list, appended to `found`.
pub(super) fn discover_devin(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    found: &mut Vec<DiscoveredSession>,
) {
    // Devin sessions a person has running: each `devin` process proves
    // its session by the `session_locks/<id>.lock` it holds open.
    found.extend(devin::discover(&config.devin, table, config.uid));
    // Devin Cloud sessions stay registered and deliverable while their
    // source can reach them: the registration surface a cloud-only session
    // could never reach through a local lock. A session held locally keeps
    // its local row.
    let held: HashSet<String> = found
        .iter()
        .map(|session| session.target.id.clone())
        .collect();
    found.extend(
        config
            .sources
            .remote
            .sessions(config, SessionKind::Devin)
            .into_iter()
            .filter(|session| !held.contains(&session.target.id)),
    );
}

/// The caller `pid`, when the walk up from it reaches a `devin` or
/// `cursor-agent` process of this user's at `current`: the session whose
/// file it holds open, or nobody. A Devin or Cursor command that is not a
/// session never lends a caller the outer session's identity. At a Cursor
/// editor window's extension host, the conversation the caller's own
/// `CURSOR_CONVERSATION_ID` names, or nobody. `None` lets the walk go on.
pub(super) fn caller(
    config: &LocalConfig,
    table: &dyn ProcessTable,
    pid: i32,
    current: i32,
    process: ProcessInfo,
) -> Option<Result<Target, CallerMiss>> {
    if process.uid != config.uid {
        return None;
    }
    if cursor_cli::editor::is_editor_host(table, current) {
        let session = cursor_cli::editor_caller(&config.cursor, table, pid, current);
        let same = table.process(current) == Some(process);
        return Some(
            session
                .filter(|_| same)
                .map(|id| Target::new(SessionKind::CursorCli, id))
                .ok_or(CallerMiss::NotASession),
        );
    }
    let (kind, session) = if devin::is_devin_process(table, current) {
        (
            SessionKind::Devin,
            devin::held_session(&config.devin, table, current),
        )
    } else if cursor_cli::is_cursor_process(table, current) {
        let session = cursor_cli::held_session(&config.cursor, table, current);
        if session.is_none() && cursor_cli::editor::is_editor_worker(table, current) {
            return None;
        }
        (SessionKind::CursorCli, session)
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
            cursor_cli::running(&config.cursor, table, config.uid, &target.id)
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
                // Nothing local holds the session: a remote source may still
                // reach a cloud session. `None` keeps the local answer — a
                // stopped local session is waiting, not lost.
                InjectOutcome::Waiting(reason) => config
                    .sources
                    .remote
                    .send(config, target, text)
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

/// Shared runtimes without a readable per-chat tag cannot name a socket caller.
/// In particular, Copilot's MCP/tool process may not choose a held chat or borrow
/// an enclosing session's inherited identity.
pub(super) fn unattributed_runtime(table: &dyn ProcessTable, pid: i32, stop_at_grok: bool) -> bool {
    crate::relay::hook_agents::is_copilot_process(table, pid)
        || (stop_at_grok && crate::relay::existing_session::grok::is_leader(&table.arguments(pid)))
}
