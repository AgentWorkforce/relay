//! The PostHog project telemetry sends to: an ingestion key and an https
//! origin, validated before anything is sent. Release builds receive these
//! values from the release environment; source and development builds contain
//! no project configuration.

/// A PostHog project: an ingestion key and an https origin.
#[derive(Clone, PartialEq, Eq)]
pub struct PostHogProject {
    pub(super) api_key: String,
    host: String,
}

impl std::fmt::Debug for PostHogProject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PostHogProject")
            .field("host", &self.host)
            .finish_non_exhaustive()
    }
}

impl PostHogProject {
    pub fn new(api_key: &str, host: &str) -> Option<PostHogProject> {
        let key_ok = api_key.starts_with("phc_")
            && api_key.len() < 256
            && api_key
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        let url = url::Url::parse(host).ok()?;
        let host_ok = url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && (url.path().is_empty() || url.path() == "/");
        (key_ok && host_ok).then(|| PostHogProject {
            api_key: api_key.to_string(),
            host: url.origin().ascii_serialization(),
        })
    }

    /// The release project. Debug builds and builds without both release
    /// variables have none, so forks, development and tests never send.
    pub fn bundled() -> Option<PostHogProject> {
        if cfg!(debug_assertions) {
            None
        } else {
            PostHogProject::new(
                option_env!("AGENT_RELAY_POSTHOG_API_KEY")?,
                option_env!("AGENT_RELAY_POSTHOG_HOST")?,
            )
        }
    }

    /// The origin, without a trailing slash.
    pub fn host(&self) -> &str {
        &self.host
    }
}
