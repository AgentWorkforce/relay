//! Durable Capy thread-spawn operations and the words both desktop apps use.

use serde::{Deserialize, Serialize};

pub const CAPY_THREAD_SPAWN_KEY: &str = "capyThreadSpawn.v1";
pub const CAPY_STARTING: &str = "Starting Capy thread…";
pub const CAPY_WAITING: &str = "Thread started · Waiting for Capy to join the relay";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapySpawnOperation {
    pub workspace_id: String,
    pub client_request_id: String,
    pub project_id: String,
    pub task: String,
    pub model: Option<String>,
    pub pull_request_author: Option<String>,
    pub report_to: Option<String>,
    pub thread_id: Option<String>,
}

impl CapySpawnOperation {
    pub fn new(
        workspace_id: String,
        client_request_id: String,
        project_id: String,
        task: String,
        model: Option<String>,
        pull_request_author: Option<String>,
        report_to: Option<String>,
    ) -> Self {
        Self {
            workspace_id,
            client_request_id,
            project_id,
            task,
            model,
            pull_request_author,
            report_to,
            thread_id: None,
        }
    }

    pub fn matches(&self, candidate: &Self) -> bool {
        self.workspace_id == candidate.workspace_id
            && self.project_id == candidate.project_id
            && self.task == candidate.task
            && self.model == candidate.model
            && self.pull_request_author == candidate.pull_request_author
            && self.report_to == candidate.report_to
    }
}

pub fn cloud_settings_url(site_url: &str) -> Option<String> {
    let mut url = url::Url::parse(site_url).ok()?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return None;
    }
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    url.set_path("/cloud/dashboard/settings");
    url.set_query(None);
    url.set_fragment(Some("capy"));
    Some(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_matching_ignores_the_client_id_and_thread_result() {
        let mut first = CapySpawnOperation::new(
            "workspace".into(),
            "one".into(),
            "project".into(),
            "task".into(),
            Some("model".into()),
            Some("capy".into()),
            None,
        );
        let retry = CapySpawnOperation::new(
            "workspace".into(),
            "two".into(),
            "project".into(),
            "task".into(),
            Some("model".into()),
            Some("capy".into()),
            None,
        );
        first.thread_id = Some("jam_01THREAD".into());
        assert!(first.matches(&retry));
    }

    #[test]
    fn settings_url_is_bounded_to_the_site() {
        assert_eq!(
            cloud_settings_url("https://user:pw@agentrelay.com/other?q=1#old").as_deref(),
            Some("https://agentrelay.com/cloud/dashboard/settings#capy")
        );
        assert!(cloud_settings_url("file:///tmp").is_none());
    }
}
