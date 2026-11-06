//! Durable claims reuse the core's running-turn journal. A lost hook response
//! stays in doubt unless Copilot's own journal records acceptance of its ref.
use super::receipts::recorded;
use super::{sessions, CopilotConfig};
use crate::relay::codex::turn_hook::Claimed;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use std::time::Duration;

pub fn send(
    config: &CopilotConfig,
    table: &dyn ProcessTable,
    uid: u32,
    sid: &str,
    binding: &str,
    message_id: &str,
    text: &str,
) -> InjectOutcome {
    if !super::proof::SUPPORTED {
        return InjectOutcome::Refused(
            "Copilot chat delivery is currently available only in VS Code on macOS.".into(),
        );
    }
    if !crate::relay::store::is_uuid(sid) {
        return InjectOutcome::Refused("Invalid Copilot session id.".into());
    }
    let thread = format!("{sid}:{binding}");
    // Claim identity survives registration replacement; only its takeable
    // thread is registration-scoped. A delivered message can never become Free.
    let claim_id = format!("{sid}:{message_id}");
    match config.inbox.claimed(&claim_id) {
        Claimed::Hook { at_ms } => {
            if recorded(config, sid, message_id) {
                return InjectOutcome::Delivered;
            }
            if config.inbox.since(at_ms) < Duration::from_secs(30) {
                return InjectOutcome::Accepted("Copilot is accepting the hook message.".into());
            }
            return InjectOutcome::InDoubt("The Copilot hook claimed this message, but native acceptance is unconfirmed; it will not be submitted again.".into());
        }
        Claimed::Unknown | Claimed::Elsewhere => {
            return InjectOutcome::InDoubt(
                "The Copilot delivery claim is unavailable or belongs to another route.".into(),
            )
        }
        Claimed::Free if recorded(config, sid, message_id) => return InjectOutcome::Delivered,
        _ => {}
    }
    if sessions::session(config, table, uid, sid).is_none() {
        return InjectOutcome::Waiting("That Copilot chat has no verified live VS Code hook. Start a new Copilot chat after connecting it.".into());
    }
    if config
        .prepare()
        .and_then(|()| config.inbox.offer(&thread, &claim_id, text))
        .is_err()
    {
        return InjectOutcome::Retry("Could not record the Copilot delivery offer.".into());
    }
    InjectOutcome::Waiting(
        "Waiting for this Copilot chat's next tool call or its waiting stop hook.".into(),
    )
}
