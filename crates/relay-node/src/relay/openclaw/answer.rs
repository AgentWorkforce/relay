//! Reading a session's history: which user turn a delivery made, whether
//! a turn is still running, and the agent's answer, on every supported
//! Gateway.
use super::delivery::{remembered, Sent, HISTORY_LIMIT};
use super::*;

/// The least time a turn may still be running on a Gateway that cannot
/// say: past its cap, a send no longer waits for it.
pub(super) const RUN_CAP_MS: u64 = 30 * 60 * 1000;

/// Added to the agent timeout: a run ends a little after its timeout.
const RUN_CAP_MARGIN_MS: u64 = 5 * 60 * 1000;

/// How long a run may last on this Gateway, `None` for no time cap: the
/// agent timeout every `chat.send` runs under (`agents.defaults.timeoutSeconds`
/// in `openclaw.json`, else the release's default, ten minutes on 2026.3.13
/// and 48 hours from 2026.3.22) plus a margin, and at least [`RUN_CAP_MS`].
/// OpenClaw's schema accepts only a positive timeout; a `0` there is read
/// as no cap, the meaning `0` has elsewhere in OpenClaw. Without a cap a
/// turn still ends on its answer in the history, a Gateway restart, or
/// `agent.wait` reporting it done.
pub(super) fn run_cap_ms(config: &OpenClawConfig, features: &Features) -> Option<u64> {
    let file = std::fs::read_to_string(&config.config_path)
        .ok()
        .and_then(|text| json5::from_str::<Value>(&text).ok());
    let configured = file
        .as_ref()
        .and_then(|file| file["agents"]["defaults"]["timeoutSeconds"].as_f64())
        .filter(|seconds| *seconds >= 0.0);
    let seconds = match configured {
        Some(0.0) => return None,
        Some(seconds) => seconds,
        None => features.default_timeout_s as f64,
    };
    let timeout_ms = (seconds * 1000.0).min(u64::MAX as f64 / 2.0) as u64;
    Some(RUN_CAP_MS.max(timeout_ms.saturating_add(RUN_CAP_MARGIN_MS)))
}

/// The key OpenClaw records on the user turn a `chat.send` with
/// `idempotency_key` made (from 2026.5.26); OpenClaw lowercases keys.
pub(super) fn user_turn_key(idempotency_key: &str) -> String {
    format!("{}:user", idempotency_key.to_lowercase())
}

/// Agent Relay's attribution line at the top of `text`, which names the
/// message and its reference: what finds the delivery's turn on a Gateway
/// that does not mark user turns.
pub(super) fn marker(text: &str) -> Option<String> {
    let line = text.lines().next()?.trim();
    ((line.starts_with("[via Agent Relay") || line.starts_with("[Relay Connect"))
        && line.ends_with(']')
        && line.contains(" ref "))
    .then(|| line.to_string())
}

pub(super) fn messages(history: &Value) -> &[Value] {
    history["messages"].as_array().map_or(&[], Vec::as_slice)
}

/// Where in `history` the delivery's user turn is: by OpenClaw's user-turn
/// key, or where the Gateway records none, by the attribution line.
pub(super) fn turn_at(
    history: &Value,
    run_id: &str,
    marker: Option<&str>,
    features: &Features,
) -> Option<usize> {
    let wanted = user_turn_key(run_id);
    messages(history).iter().rposition(|message| {
        message["role"] == "user"
            && if features.user_turn_key {
                [
                    &message["idempotencyKey"],
                    &message["__openclaw"]["idempotencyKey"],
                ]
                .iter()
                .any(|key| {
                    key.as_str()
                        .is_some_and(|key| key.eq_ignore_ascii_case(&wanted))
                })
            } else {
                marker.is_some_and(|marker| {
                    message_text(message).is_some_and(|text| text.contains(marker))
                })
            }
    })
}

/// The entries of the turn whose user message is at `at`: up to the next
/// user message, and whether one follows (the turn is then over).
pub(super) fn turn(history: &Value, at: usize) -> (&[Value], bool) {
    let after = messages(history).get(at + 1..).unwrap_or_default();
    match after.iter().position(|message| message["role"] == "user") {
        Some(next) => (&after[..next], true),
        None => (after, false),
    }
}

/// Whether an assistant entry ends its run: anything but a tool call.
pub(super) fn finishes(message: &Value) -> bool {
    let tool_call = |part: &Value| {
        matches!(
            part["type"].as_str(),
            Some("toolCall" | "tool_use" | "toolUse")
        )
    };
    message["role"] == "assistant"
        && match message["stopReason"].as_str() {
            Some(reason) => reason != "toolUse",
            None => !message["content"]
                .as_array()
                .is_some_and(|parts| parts.iter().any(tool_call)),
        }
}

/// A run this core started in a session, for a Gateway that can only be
/// asked about runs by id.
#[derive(Clone, Copy)]
pub(super) struct LastRun<'a> {
    pub(super) run_id: &'a str,
    pub(super) sent_at_ms: u64,
    pub(super) marker: Option<&'a str>,
}

/// Whether `key` is still running a turn. On a Gateway that can only be
/// asked about a run by id, that is the last run this core started there,
/// `last`: over once its turn in the history ends with an answer, the
/// Gateway restarted, or `agent.wait` says so. (Its turn may reach the
/// history only once it ends, and `agent.wait` forgets a run after ten
/// minutes, so neither alone will do.) From 2026.3.22 such a Gateway's
/// `sessions.list` row also says `status: "running"` for any run, the
/// person's own included. Either way a run may last `cap_ms`
/// ([`run_cap_ms`]; `None`, no time cap).
pub(super) fn running(
    connection: &mut Connection,
    (agent, key): (&str, &str),
    history: &Value,
    last: Option<LastRun<'_>>,
    cap_ms: Option<u64>,
) -> Result<bool, GatewayError> {
    match connection.features.active_run {
        ActiveRun::History => Ok(history["sessionInfo"]["hasActiveRun"] == true),
        ActiveRun::Listed => {
            Ok(listed_row(connection, agent, key)?.is_some_and(|row| row["hasActiveRun"] == true))
        }
        ActiveRun::Waited => {
            if connection.features.listed_status
                && listed_row(connection, agent, key)?
                    .is_some_and(|row| listed_running(&connection.features, &row, cap_ms))
            {
                return Ok(true);
            }
            let features = &connection.features;
            let Some(last) = last.filter(|last| {
                may_run(features, last.sent_at_ms, cap_ms)
                    && !answered(history, last.run_id, last.marker, features)
            }) else {
                return Ok(false);
            };
            let waited = connection.call(
                "agent.wait",
                json!({ "runId": last.run_id, "timeoutMs": 0 }),
            );
            Ok(ignore_rejection(waited)?.is_some_and(|waited| waited["status"] == "timeout"))
        }
    }
}

/// The session's `sessions.list` row, if the Gateway lists it.
fn listed_row(
    connection: &mut Connection,
    agent: &str,
    key: &str,
) -> Result<Option<Value>, GatewayError> {
    let listed = connection.call(
        "sessions.list",
        json!({ "agentId": agent, "search": key, "limit": 50 }),
    );
    Ok(ignore_rejection(listed)?.and_then(|listed| {
        listed["sessions"].as_array().and_then(|rows| {
            rows.iter()
                .find(|row| {
                    row["key"]
                        .as_str()
                        .is_some_and(|row_key| row_key.eq_ignore_ascii_case(key))
                })
                .cloned()
        })
    }))
}

/// Whether a row's `status: "running"` is a run still going: the store
/// keeps the status across a restart, so only a run started since the
/// Gateway started, and within its cap, counts.
fn listed_running(features: &Features, row: &Value, cap_ms: Option<u64>) -> bool {
    row["status"] == "running"
        && row["startedAt"]
            .as_u64()
            .is_some_and(|started| may_run(features, started, cap_ms))
}

/// Whether the turn of `run_id` is in the history and ended with an answer
/// or another turn followed it.
fn answered(history: &Value, run_id: &str, marker: Option<&str>, features: &Features) -> bool {
    turn_at(history, run_id, marker, features).is_some_and(|at| {
        let (entries, followed) = turn(history, at);
        followed || entries.iter().any(finishes)
    })
}

/// Whether a run sent at `sent_at_ms` could still be running: the Gateway has not
/// restarted since, and it is not past its cap.
fn may_run(features: &Features, sent_at_ms: u64, cap_ms: Option<u64>) -> bool {
    let restarted = features
        .started_at_ms
        .is_some_and(|started| started > sent_at_ms);
    !restarted && cap_ms.is_none_or(|cap| features::now_ms().saturating_sub(sent_at_ms) < cap)
}

fn ignore_rejection(result: Result<Value, GatewayError>) -> Result<Option<Value>, GatewayError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(GatewayError::Rejected { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

/// The agent's answer to the delivery carrying `message_ref`, once its turn
/// is over; `None` while it runs, when it chose not to answer, or when the
/// Gateway cannot say.
pub fn final_answer(config: &OpenClawConfig, agent: &str, message_ref: &str) -> Option<String> {
    let sent = remembered(config, agent, message_ref)?;
    let gateway = gateway(config).ok()?;
    let mut connection = Connection::open(config, &gateway).ok()?;
    let history = connection
        .call(
            "chat.history",
            json!({ "sessionKey": sent.session_key, "limit": HISTORY_LIMIT }),
        )
        .ok()?;
    // A run's terminal entry where the Gateway marks one; otherwise (every
    // release before 2026.8.1, and runs a newer one leaves unmarked) the
    // turn's last word once the turn is over.
    let answer = match answer_in(&history, &sent.run_id) {
        Some(answer) => answer,
        None if marked_terminal(&history, &sent.run_id) => return None,
        None => unmarked_answer(&mut connection, config, agent, &sent, &history)?,
    };
    crate::relay::delivery::final_answer::capped(&answer)
}

/// Whether the run has a terminal entry, even one without text
/// (`NO_REPLY`): it chose not to answer.
fn marked_terminal(history: &Value, run_id: &str) -> bool {
    messages(history).iter().any(|message| {
        let meta = &message["__openclaw"];
        meta["runTerminal"] == true
            && meta["runId"]
                .as_str()
                .is_some_and(|run| run.eq_ignore_ascii_case(run_id))
    })
}

/// Where the Gateway did not mark the run's terminal entry (every release
/// before 2026.8.1, and most runs since): the last assistant text that ends
/// a run in the delivery's turn, once that turn is over.
fn unmarked_answer(
    connection: &mut Connection,
    config: &OpenClawConfig,
    agent: &str,
    sent: &Sent,
    history: &Value,
) -> Option<String> {
    let features = connection.features.clone();
    let at = turn_at(history, &sent.run_id, sent.marker.as_deref(), &features)?;
    let (entries, followed) = turn(history, at);
    let last = sent.sent_at_ms.map(|sent_at_ms| LastRun {
        run_id: &sent.run_id,
        sent_at_ms,
        marker: sent.marker.as_deref(),
    });
    if !followed
        && running(
            connection,
            (agent, &sent.session_key),
            history,
            last,
            run_cap_ms(config, &features),
        )
        .ok()?
    {
        return None;
    }
    // The run's last word, never a step it took on the way; where entries
    // name their run (from 2026.8.1), only this run's, as OpenClaw's own
    // TUI reads a run that is not marked terminal.
    let own = |message: &&Value| {
        message["__openclaw"]["runId"]
            .as_str()
            .is_none_or(|run| run.eq_ignore_ascii_case(&sent.run_id))
    };
    let text = entries
        .iter()
        .rev()
        .filter(own)
        .filter(|message| finishes(message))
        .find_map(|message| message_text(message).filter(|text| !text.trim().is_empty()))?;
    answer_text(&text)
}

fn answer_text(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty() && text != "NO_REPLY").then(|| text.to_string())
}

/// The text of the run's terminal assistant entry: the one OpenClaw marks
/// `runTerminal` under that run id. An agent that chose not
/// to answer (`NO_REPLY`) leaves none.
pub(super) fn answer_in(history: &Value, run_id: &str) -> Option<String> {
    let answer = messages(history).iter().rev().find(|message| {
        let meta = &message["__openclaw"];
        message["role"] == "assistant"
            && meta["runTerminal"] == true
            && meta["runId"]
                .as_str()
                .is_some_and(|run| run.eq_ignore_ascii_case(run_id))
    })?;
    answer_text(&message_text(answer)?)
}

pub(super) fn message_text(message: &Value) -> Option<String> {
    match &message["content"] {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let text: Vec<&str> = parts
                .iter()
                .filter(|part| part["type"] == "text")
                .filter_map(|part| part["text"].as_str())
                .collect();
            (!text.is_empty()).then(|| text.join("\n"))
        }
        _ => message["text"].as_str().map(str::to_string),
    }
}
