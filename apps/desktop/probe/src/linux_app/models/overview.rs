//! The saved session brief Agent Relay Cloud generates
//! (`sessions.overview.get`/`.request`), and the session's original request
//! (`sessions.overview.events`) as a labelled fallback when no brief
//! exists. The core passes Cloud's answers through as JSON, so they are
//! read here, tolerantly: Cloud answers in camelCase, and snake_case reads
//! too.

use serde_json::Value;
use std::fmt;

/// Where a brief's generation stands.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OverviewStatus {
    #[default]
    Idle,
    Loading,
    Queued,
    Running,
    Completed,
    Failed,
}

impl OverviewStatus {
    fn parse(value: Option<&Value>) -> Option<OverviewStatus> {
        Some(match value?.as_str()? {
            "idle" => OverviewStatus::Idle,
            "loading" => OverviewStatus::Loading,
            "queued" => OverviewStatus::Queued,
            "running" => OverviewStatus::Running,
            "completed" => OverviewStatus::Completed,
            "failed" => OverviewStatus::Failed,
            _ => return None,
        })
    }
}

/// A session's newest valid brief and where its generation stands.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Overview {
    pub status: OverviewStatus,
    pub title: String,
    pub description: String,
    /// Why generation failed, as a sentence.
    pub error: Option<String>,
}

impl Overview {
    pub fn has_brief(&self) -> bool {
        !self.title.is_empty() && !self.description.is_empty()
    }

    pub fn pending(&self) -> bool {
        matches!(
            self.status,
            OverviewStatus::Queued | OverviewStatus::Running
        )
    }
}

/// Cloud answered about another session than the one asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WrongSession;

impl fmt::Display for WrongSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Cloud returned a summary for another session.")
    }
}

impl std::error::Error for WrongSession {}

/// `key` (camelCase) of `value`, else its snake_case spelling.
fn camel<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    let object = value.as_object()?;
    object.get(key).or_else(|| {
        let mut snake = String::with_capacity(key.len() + 4);
        for (index, character) in key.chars().enumerate() {
            if character.is_ascii_uppercase() && index > 0 {
                snake.push('_');
            }
            snake.push(character.to_ascii_lowercase());
        }
        object.get(&snake)
    })
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    camel(value, key).and_then(Value::as_str)
}

fn objects<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    camel(value, key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.is_object())
}

/// Whether `value` is about `session_id`.
fn about(value: &Value, session_id: &str) -> Result<(), WrongSession> {
    match text(value, "sessionId") {
        Some(id) if id == session_id => Ok(()),
        _ => Err(WrongSession),
    }
}

fn failure(code: Option<&str>) -> &'static str {
    match code {
        Some("session_evidence_incomplete") => {
            "History could not collect a complete conversation. Sync the session and try again."
        }
        Some("session_analysis_ineligible") => {
            "This session has no supported conversation to summarize."
        }
        Some("session_not_found") => "This session is no longer available in History.",
        Some("model_unavailable") => {
            "The summary service is temporarily unavailable. Try again later."
        }
        _ => "Could not generate this summary. Please try again.",
    }
}

/// An analysis's brief, when both its title and description say something.
fn brief(analysis: &Value) -> Option<(&str, &str)> {
    let brief = analysis.get("result")?.get("brief")?;
    let title = brief.get("title")?.as_str()?;
    let description = brief.get("description")?.as_str()?;
    (!title.trim().is_empty() && !description.trim().is_empty()).then_some((title, description))
}

/// The newest valid brief for `session_id` (from `source`'s analyses when
/// given), and where its generation stands.
pub fn parse_overview(
    value: &Value,
    session_id: &str,
    source: Option<&str>,
) -> Result<Overview, WrongSession> {
    about(value, session_id)?;
    let analyses: Vec<&Value> = objects(value, "analyses")
        .filter(|analysis| text(analysis, "sessionId") == Some(session_id))
        .filter(|analysis| source.is_none() || text(analysis, "sourceProvider") == source)
        .collect();
    let request = objects(value, "requests").next();
    let current = request
        .and_then(|request| {
            let id = text(request, "analysisId")?;
            analyses
                .iter()
                .copied()
                .find(|analysis| analysis.get("id").and_then(Value::as_str) == Some(id))
        })
        .or_else(|| analyses.first().copied());
    let status_of = |value: Option<&Value>| OverviewStatus::parse(value?.get("status"));
    let completed = current
        .into_iter()
        .chain(analyses.iter().copied())
        .find_map(|analysis| {
            (status_of(Some(analysis)) == Some(OverviewStatus::Completed))
                .then(|| brief(analysis))
                .flatten()
        });
    let status = status_of(request)
        .or_else(|| status_of(current))
        .unwrap_or_default();
    let error = (status == OverviewStatus::Failed).then(|| {
        let code = request
            .and_then(|request| request.get("error"))
            .or_else(|| current.and_then(|current| current.get("error")))
            .and_then(Value::as_str);
        failure(code).to_string()
    });
    let (title, description) = completed.unwrap_or(("", ""));
    Ok(Overview {
        status,
        title: title.to_string(),
        description: description.to_string(),
        error,
    })
}

/// The first substantive request that started the session, on one line and
/// at most 300 characters: what it was started for, which later work may
/// have moved on from.
pub fn parse_goal(value: &Value, session_id: &str) -> Result<Option<String>, WrongSession> {
    about(value, session_id)?;
    for event in objects(value, "events") {
        let kind = event.get("kind").and_then(Value::as_str);
        if !(text(event, "actorRole") == Some("user") || matches!(kind, Some("prompt" | "user"))) {
            continue;
        }
        let Some(content) = event.get("content").and_then(Value::as_str) else {
            continue;
        };
        // A harness's leading blocks (Conductor's `<system_instruction>`,
        // Codex's `<recommended_plugins>`) are not the person's request.
        let content = crate::relay::conductor::without_preamble(content);
        let line = content.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.chars().count() < 30
            || line.starts_with("<system-reminder")
            || line.starts_with("<task-notification")
        {
            continue;
        }
        return Ok(Some(line.chars().take(300).collect()));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_harness_preamble_is_not_the_original_request() {
        let answer = json!({"sessionId": "s", "events": [{"kind": "prompt", "actorRole": "user",
            "content": "<system_instruction>\nYou are working inside Conductor, a Mac app that lets the user run many coding agents in parallel.\n</system_instruction>\n\nFix the flaky upload test in the probe crate please"}]});
        assert_eq!(
            parse_goal(&answer, "s").unwrap().as_deref(),
            Some("Fix the flaky upload test in the probe crate please")
        );
        // Only a preamble: no request yet.
        let only = json!({"sessionId": "s", "events": [{"kind": "prompt",
            "content": "<system_instruction>You are working inside Conductor, a Mac app.</system_instruction>"}]});
        assert_eq!(parse_goal(&only, "s").unwrap(), None);
        // A person's own snake_case tag is kept as their request.
        let tagged = json!({"sessionId": "s", "events": [{"kind": "prompt", "actorRole": "user",
            "content": "<task_details>Fix the upload test and retain its logs.</task_details>"}]});
        assert_eq!(
            parse_goal(&tagged, "s").unwrap().as_deref(),
            Some("<task_details>Fix the upload test and retain its logs.</task_details>")
        );
    }

    #[test]
    fn overviews_take_the_newest_valid_brief() {
        let answer = json!({"sessionId": "s", "requests": [{"status": "running", "analysisId": "b"}], "analyses": [
            {"id": "b", "sessionId": "s", "status": "running", "result": null},
            {"id": "a", "sessionId": "s", "status": "completed",
             "result": {"brief": {"title": "Fix tests", "description": "Waits replace sleeps."}}}]});
        let overview = parse_overview(&answer, "s", None).unwrap();
        assert_eq!(
            (overview.status, overview.title.as_str(), overview.pending()),
            (OverviewStatus::Running, "Fix tests", true)
        );
        assert!(overview.has_brief());
        assert_eq!(
            parse_overview(&answer, "s", Some("claude")).unwrap(),
            Overview {
                status: OverviewStatus::Running,
                ..Overview::default()
            }
        );
        let failed = parse_overview(
            &json!({"session_id": "s", "requests": [{"status": "failed", "error": "model_unavailable"}],
                    "analyses": []}),
            "s",
            None,
        )
        .unwrap();
        assert!(failed.error.unwrap().contains("temporarily unavailable"));
        let other = json!({"sessionId": "other", "requests": [], "analyses": []});
        assert_eq!(parse_overview(&other, "s", None), Err(WrongSession));
        assert_eq!(
            WrongSession.to_string(),
            "Cloud returned a summary for another session."
        );
        let events = json!({"sessionId": "s", "events": [
            {"actorRole": "user", "content": "short"},
            {"kind": "prompt", "content": "Please make the upload\n tests reliable again"}]});
        assert_eq!(
            parse_goal(&events, "s").unwrap().as_deref(),
            Some("Please make the upload tests reliable again")
        );
        assert_eq!(parse_goal(&events, "x"), Err(WrongSession));
    }
}
