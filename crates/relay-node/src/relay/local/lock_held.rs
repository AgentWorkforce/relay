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
/// session never lends a caller the outer session's identity. Factory Droid
/// uses the private verified launch record whose child pid is `current`;
/// an inherited marker never lends a nested unmanaged worker that identity.
/// At a Cursor
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
    if let Some(droid) = crate::relay::droid::caller(
        &crate::relay::droid::DroidConfig::from_local(config),
        table,
        current,
    ) {
        let same = table.process(current) == Some(process);
        return Some(droid.and_then(|id| {
            if same && crate::relay::harness::droid::unavailable_reason().is_none() {
                Ok(Target::new(SessionKind::Droid, id))
            } else {
                Err(CallerMiss::NotASession)
            }
        }));
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
        SessionKind::Droid if crate::relay::harness::droid::unavailable_reason().is_some() => false,
        SessionKind::Droid => crate::relay::droid::records(
            &crate::relay::droid::DroidConfig::from_local(config),
            table,
        )
        .iter()
        .any(|r| r.session_id == target.id),
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
        SessionKind::Droid => crate::relay::harness::droid::deliver(
            &crate::relay::droid::DroidConfig::from_local(config),
            table,
            &target.id,
            message_id,
            text,
        )
        .unwrap_or_else(|| {
            InjectOutcome::Waiting("The Relay-owned Droid runtime is not running.".into())
        }),
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

#[cfg(all(test, unix))]
mod droid_hold_tests {
    use super::*;
    use crate::relay::harness::droid::{runtime, Record, MARKER, STARTUP_ISOLATION_GUIDANCE};
    use crate::relay::process::{FakeProcess, FakeProcesses};
    use crate::relay::spawn::launch::SpawnedProcess;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    #[test]
    fn an_existing_verified_droid_cannot_receive_reply_or_register_while_held() {
        let home = tempfile::tempdir().unwrap();
        let config = LocalConfig::from_env(&|_| None, home.path());
        let droid = crate::relay::droid::DroidConfig::from_local(&config);
        let directory = runtime(&droid);
        crate::relay::paths::socket_directory(&directory).unwrap();
        let session = "11111111-2222-4333-8444-555555555555";
        let launch = "22222222-2222-4333-8444-555555555555";
        let executable = home.path().join("droid");
        std::fs::write(&executable, "synthetic provider identity").unwrap();
        let table = FakeProcesses::default();
        let environment = std::collections::HashMap::from([(MARKER.into(), launch.into())]);
        table.insert(
            40,
            FakeProcess {
                uid: config.uid,
                start: 1,
                environment: environment.clone(),
                ..Default::default()
            },
        );
        table.insert(
            41,
            FakeProcess {
                uid: config.uid,
                parent: 40,
                start: 2,
                environment,
                executable: Some(executable.clone()),
                ..Default::default()
            },
        );
        let record = Record {
            launch_id: launch.into(),
            session_id: session.into(),
            host: SpawnedProcess { pid: 40, start: 1 },
            child: SpawnedProcess { pid: 41, start: 2 },
            socket: home.path().join("control.sock"),
            executable,
            directory: home.path().into(),
            initial_message_id: None,
        };
        for filename in [format!("{session}.json"), format!("{launch}.ready.json")] {
            let path = directory.join(filename);
            std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let listener = UnixListener::bind(&record.socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        // Positive fixture control: the pre-hold ownership proof is valid.
        assert!(
            matches!(crate::relay::droid::caller(&droid, &table, 41), Some(Ok(id)) if id == session)
        );
        let process = table.process(41).unwrap();
        assert!(matches!(
            caller(&config, &table, 41, 41, process),
            Some(Err(CallerMiss::NotASession))
        ));
        let target = Target::new(SessionKind::Droid, session);
        assert!(!can_reply(&config, &table, &target));
        assert!(crate::relay::droid::discover(&droid, &table).is_empty());
        assert!(
            matches!(inject(&config, &table, &target, "one", "synthetic held turn"), InjectOutcome::Refused(reason) if reason == STARTUP_ISOLATION_GUIDANCE)
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
