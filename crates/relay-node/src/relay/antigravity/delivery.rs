//! Durable hook-inbox delivery for Antigravity conversations.
use super::receipts::recorded;
use super::{sessions, AntigravityConfig};
use crate::relay::codex::turn_hook::Claimed;
use crate::relay::inject::InjectOutcome;
use crate::relay::process::ProcessTable;
use std::time::Duration;

pub fn send(
    config: &AntigravityConfig,
    table: &dyn ProcessTable,
    uid: u32,
    sid: &str,
    binding: &str,
    message_id: &str,
    text: &str,
) -> InjectOutcome {
    if !super::proof::SUPPORTED {
        return InjectOutcome::Refused(
            "Antigravity live delivery is currently available only on macOS.".into(),
        );
    }
    if !crate::relay::store::is_uuid(sid) {
        return InjectOutcome::Refused("Invalid Antigravity conversation id.".into());
    }
    let thread = format!("{sid}:{binding}");
    let claim_id = format!("{sid}:{message_id}");
    if config.prepare().is_err() {
        return InjectOutcome::Retry(
            "Could not open the Antigravity delivery state directory.".into(),
        );
    }
    match config.inbox.claimed(&claim_id) {
        Claimed::Hook { at_ms } => {
            if recorded(config, sid, message_id) {
                return InjectOutcome::Delivered;
            }
            if config.inbox.since(at_ms) < Duration::from_secs(30) {
                return InjectOutcome::Accepted(
                    "Antigravity is accepting the hook message.".into(),
                );
            }
            return InjectOutcome::InDoubt(
                "The Antigravity hook claimed this message, but transcript acceptance is unconfirmed; it will not be submitted again."
                    .into(),
            );
        }
        Claimed::Unknown | Claimed::Elsewhere => {
            return InjectOutcome::InDoubt(
                "The Antigravity delivery claim is unavailable or belongs to another route.".into(),
            );
        }
        Claimed::Free if recorded(config, sid, message_id) => return InjectOutcome::Delivered,
        _ => {}
    }
    if !config.enabled() {
        return InjectOutcome::Waiting(
            "Enable Antigravity hooks in ~/.gemini/config/hooks.json to receive Agent Relay messages."
                .into(),
        );
    }
    if sessions::session(config, table, uid, sid).is_none() {
        return InjectOutcome::Waiting(
            "That Antigravity conversation is not open in a live Antigravity runtime.".into(),
        );
    }
    if config
        .prepare()
        .and_then(|()| config.inbox.offer(&thread, &claim_id, text))
        .is_err()
    {
        return InjectOutcome::Retry("Could not record the Antigravity delivery offer.".into());
    }
    InjectOutcome::Waiting(
        "Waiting for this Antigravity conversation's next invocation or waiting stop hook.".into(),
    )
}
