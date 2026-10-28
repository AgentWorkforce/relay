//! The host state a `connect create` resumes or starts.

use anyhow::{ensure, Result};

use super::{parse_iso_ms, random_id, HostState, SafeError};

/// Cloud creates and extends rooms for at most 7 days. The parser still
/// accepts the older 30-day maximum so a host can rejoin a room an earlier CLI
/// created with that duration; only a new room is held to the 7-day cap.
const MAX_NEW_ROOM_MINUTES: u32 = 10_080;

fn check_new_room_minutes(minutes: u32) -> Result<()> {
    ensure!(
        minutes <= MAX_NEW_ROOM_MINUTES,
        SafeError(format!(
            "A Relay Connect room can last at most {MAX_NEW_ROOM_MINUTES} minutes (7 days)."
        ))
    );
    Ok(())
}

/// Resume this session's saved room when it has not expired, otherwise start
/// a new one. A resumed room must be asked for with its original command, and
/// the 7-day cap applies until Cloud has created the room (no link yet), so
/// only rejoining an existing room may carry an older, longer duration.
pub(super) fn for_create(
    saved: Option<HostState>,
    task: String,
    minutes: u32,
    name: Option<String>,
) -> Result<HostState> {
    let live = saved.filter(|state| {
        !state
            .expires_at
            .as_deref()
            .and_then(parse_iso_ms)
            .is_some_and(|expiry| expiry <= agent_relay_probe::relay::state::now_ms())
    });
    let state = match live {
        Some(state) => state,
        None => HostState {
            session: random_id()?,
            request: random_id()?,
            auth: None,
            task: task.clone(),
            minutes,
            name: name.clone(),
            link: None,
            expires_at: None,
            host_claim: None,
        },
    };
    if state.link.is_none() {
        check_new_room_minutes(minutes)?;
    }
    ensure!(
        state.task == task && state.minutes == minutes && state.name == name,
        SafeError("This session already has a pending or active room. Retry its original create command or end it first.".into())
    );
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::super::Command;
    use super::*;

    #[test]
    fn create_caps_new_rooms_at_seven_days_but_parses_old_durations() {
        use clap::Parser;
        #[derive(Parser)]
        struct Cli {
            #[command(subcommand)]
            command: Command,
        }
        let parse = |minutes: &str| {
            Cli::try_parse_from([
                "probe",
                "create",
                "--task",
                "t",
                "--expires-in-minutes",
                minutes,
            ])
        };
        // A host rejoining a room an older CLI created for up to 30 days must
        // still be able to repeat its original command.
        assert!(parse("43200").is_ok());
        assert!(parse("43201").is_err());
        assert!(parse("0").is_err());
        assert!(check_new_room_minutes(10_080).is_ok());
        assert!(check_new_room_minutes(10_081).is_err());
    }

    fn saved(minutes: u32, link: Option<&str>) -> HostState {
        HostState {
            session: "s".into(),
            request: "r".into(),
            auth: None,
            task: "t".into(),
            minutes,
            name: None,
            link: link.map(Into::into),
            expires_at: None,
            host_claim: None,
        }
    }

    #[test]
    fn only_a_created_room_may_resume_beyond_seven_days() {
        // A room an older CLI created for 14 days can still be rejoined.
        let created = saved(20_160, Some("https://agentrelay.com/connect/abc"));
        assert!(for_create(Some(created), "t".into(), 20_160, None).is_ok());
        // An attempt saved before Cloud created it is held to the cap, so
        // the host is refused before signing in.
        assert!(for_create(Some(saved(20_160, None)), "t".into(), 20_160, None).is_err());
        assert!(for_create(None, "t".into(), 20_160, None).is_err());
        assert!(for_create(None, "t".into(), 10_080, None).is_ok());
    }
}
