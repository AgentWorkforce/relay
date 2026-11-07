//! Answers and completion evidence from Muse courier and Paseo turns.
use super::{session_log, MuseConfig};
use serde_json::Value;

/// What one Muse turn did with a relayed message it drained from its inbox.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RelayedTurn {
    /// The session that delivered it: the probe's courier.
    pub sender: String,
    /// That session's name, which Muse may address it by instead.
    pub sender_name: String,
    /// The Muse message id of the drained item, the delivery's receipt.
    pub muse_message_id: String,
    /// Bodies the turn sent back to the sender with `send_session_message`.
    pub replies: Vec<String>,
    /// The turn's last assistant text that is not running commentary.
    pub final_text: Option<String>,
    /// Whether the turn has ended.
    pub ended: bool,
}

/// The turn of `log` that drained the inbox item `matches` picks, from
/// Muse's session log. Muse's log is not a public API, so only the records
/// this needs are read and anything else is skipped.
pub fn relayed_turn(log: &str, matches: &dyn Fn(&Value) -> bool) -> Option<RelayedTurn> {
    let mut found: Option<(String, RelayedTurn)> = None;
    for line in log.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = &record["payload"];
        let event = &payload["event"];
        let run = payload["run_id"].as_str().unwrap_or_default();
        match &mut found {
            None => {
                if event["kind"] == "inbox_item_drained" && matches(event) {
                    let source = &event["delivery_snapshot"]["source"];
                    let run = event["drain_target_run_stream"]["id"]
                        .as_str()
                        .unwrap_or(run)
                        .to_string();
                    found = Some((
                        run,
                        RelayedTurn {
                            sender: source["sender_session_id"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string(),
                            sender_name: source["sender_session_name"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string(),
                            muse_message_id: source["message_id"]
                                .as_str()
                                .unwrap_or_default()
                                .to_string(),
                            ..RelayedTurn::default()
                        },
                    ));
                }
            }
            Some((turn_run, turn)) if run == turn_run.as_str() => {
                turn.observe(event);
                if turn.ended {
                    break;
                }
            }
            Some(_) => {}
        }
    }
    found.map(|(_, turn)| turn)
}

impl RelayedTurn {
    fn observe(&mut self, event: &Value) {
        match event["kind"].as_str() {
            Some("assistant_tool_calls_committed") => {
                for call in event["tool_calls"].as_array().into_iter().flatten() {
                    if let Some(reply) = self.reply(call) {
                        self.replies.push(reply);
                    }
                }
            }
            Some("assistant_message_committed") if event["phase"] != "commentary" => {
                if let Some(text) = event["text"].as_str() {
                    self.final_text = Some(text.to_string());
                }
            }
            Some("terminal") => self.ended = true,
            _ => {}
        }
    }

    fn reply(&self, call: &Value) -> Option<String> {
        if call["name"] != "send_session_message" {
            return None;
        }
        let args: Value = call["args"]
            .as_str()
            .and_then(|args| serde_json::from_str(args).ok())
            .unwrap_or_else(|| call["args"].clone());
        let target = args["target"].as_str().unwrap_or_default();
        if target.is_empty() || (target != self.sender && target != self.sender_name) {
            return None;
        }
        args["body"].as_str().map(str::to_string)
    }
}

/// The turn Paseo started with `turn_queue_submit` whose prompt carries
/// `reference`. The command id is the run id of the events that follow.
/// There is no courier, so the answer is the turn's own text.
fn queued_turn(log: &str, reference: &str) -> Option<RelayedTurn> {
    let mut run_id: Option<String> = None;
    let mut turn = RelayedTurn::default();
    for line in log.lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = &record["payload"];
        if run_id.is_none() {
            if let Some(found) = queued_run(payload, reference) {
                run_id = Some(found);
            }
            continue;
        }
        if payload["run_id"].as_str() != run_id.as_deref() {
            continue;
        }
        let event = &payload["event"];
        match event["kind"].as_str() {
            Some("assistant_message_committed") if event["phase"] != "commentary" => {
                if let Some(text) = event["text"].as_str() {
                    turn.final_text = Some(text.to_string());
                }
            }
            Some("terminal") => {
                turn.ended = true;
                break;
            }
            _ => {}
        }
    }
    run_id.map(|_| turn)
}

/// The command id of a `turn_queue_submit` whose prompt carries `reference`.
fn queued_run(payload: &Value, reference: &str) -> Option<String> {
    if payload["kind"] != "command_intake" {
        return None;
    }
    let record = &payload["record"];
    if record["kind"] != "received" || record["command"]["kind"] != "turn_queue_submit" {
        return None;
    }
    let prompt = &record["command"]["payload"];
    let carries = |value: &Value| {
        value
            .as_str()
            .and_then(crate::relay::delivery::policy::MessageRef::in_text)
            .is_some_and(|found| found == reference)
    };
    if !carries(&prompt["prompt"]) && !carries(&prompt["display_prompt"]) {
        return None;
    }
    record["command_id"].as_str().map(str::to_string)
}

/// The answer a Muse session gave to the relayed message carrying
/// `reference`, once its turn has ended: what it sent back to the courier,
/// else its final text (a refusal, say, so the sender learns of it).
pub fn final_answer(config: &MuseConfig, session_id: &str, reference: &str) -> Option<String> {
    let log = std::fs::read_to_string(session_log(config, session_id)?).ok()?;
    // A TUI turn starts when the courier's message is drained. A Paseo
    // `muse serve` turn starts from `turn_queue_submit` and has no inbox
    // drain; its answer is that turn's own text.
    let turn = relayed_turn(&log, &|event| {
        event["delivery_snapshot"]["body"]
            .as_str()
            .and_then(crate::relay::delivery::policy::MessageRef::in_text)
            .is_some_and(|found| found == reference)
    })
    .or_else(|| queued_turn(&log, reference))?;
    if !turn.ended {
        return None;
    }
    let answer = turn.replies.last().cloned().or(turn.final_text)?;
    crate::relay::delivery::final_answer::capped(&answer)
}

/// Whether the turn that drained the delivery with Muse message id
/// `muse_message_id` has ended, so its courier can go.
pub fn turn_ended(config: &MuseConfig, session_id: &str, muse_message_id: &str) -> bool {
    session_log(config, session_id)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|log| {
            relayed_turn(&log, &|event| {
                event["delivery_snapshot"]["source"]["message_id"] == *muse_message_id
            })
        })
        .is_some_and(|turn| turn.ended)
}
