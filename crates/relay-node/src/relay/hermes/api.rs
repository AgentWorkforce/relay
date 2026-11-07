//! A Hermes home's loopback API server: where its `.env` says it listens,
//! with which key, and one authenticated exchange with it.
use super::*;

/// The home's API server, as its `.env` describes it.
#[derive(Clone, PartialEq, Eq)]
pub struct Api {
    /// `127.0.0.1` or `[::1]`, as the home's `API_SERVER_HOST` names it.
    pub(super) host: &'static str,
    pub port: u16,
    pub(super) key: String,
}

impl std::fmt::Debug for Api {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Api")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

impl Api {
    pub(super) fn url(&self, path: &str) -> String {
        format!("http://{}:{}{path}", self.host, self.port)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unavailable {
    NotInstalled,
    /// `API_SERVER_ENABLED` is not true in the home's `.env`.
    ApiOff,
    /// The person's own Hermes, for trusted senders, cannot be used.
    Main(Box<Unavailable>),
    /// The API has no `API_SERVER_KEY`, which Hermes requires.
    NoKey,
    /// `API_SERVER_HOST` is not loopback.
    NotLoopback,
    NotRunning,
    /// The API answers without durable run idempotency.
    NotDurable,
    Refused(String),
}

impl Unavailable {
    pub fn reason(&self) -> String {
        match self {
            Unavailable::NotInstalled => {
                "Hermes's relay profile is not set up; run `hermes profile create relay`.".into()
            }
            Unavailable::ApiOff => {
                "The relay profile's API server is off; set API_SERVER_ENABLED=true in its .env.".into()
            }
            Unavailable::Main(inner) => match &**inner {
                Unavailable::ApiOff | Unavailable::NotInstalled => "Your own Hermes's API server is off, so trusted senders can't reach it; set API_SERVER_ENABLED=true in ~/.hermes/.env.".into(),
                Unavailable::NoKey => "Your own Hermes's API server has no API_SERVER_KEY in ~/.hermes/.env.".into(),
                Unavailable::NotLoopback => "Your own Hermes's API server listens beyond this computer; Agent Relay reaches only loopback.".into(),
                Unavailable::NotRunning => "Your own Hermes's gateway is not running.".into(),
                Unavailable::NotDurable => "Your own Hermes cannot keep a run's admission across restarts; update Hermes.".into(),
                Unavailable::Refused(reason) => format!("Your own Hermes refused Agent Relay: {reason}"),
                Unavailable::Main(inner) => Unavailable::Main(inner.clone()).reason(),
            },
            Unavailable::NoKey => "The relay profile's API server has no API_SERVER_KEY in its .env.".into(),
            Unavailable::NotLoopback => {
                "Hermes's API server listens beyond this computer; Agent Relay reaches only 127.0.0.1.".into()
            }
            Unavailable::NotRunning => "The relay profile's Hermes gateway is not running.".into(),
            Unavailable::NotDurable => {
                "This Hermes cannot keep a run's admission across restarts; update Hermes.".into()
            }
            Unavailable::Refused(reason) => format!("Hermes refused Agent Relay: {reason}"),
        }
    }
}

/// `KEY=value` lines of a dotenv file; quotes stripped, comments skipped.
pub(super) fn dotenv(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_prefix("export ").unwrap_or(line);
            if line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
                .unwrap_or(value);
            Some((key.trim().to_string(), value.to_string()))
        })
        .collect()
}

/// The API server the home's `.env` configures.
pub fn api(config: &HermesConfig) -> Result<Api, Unavailable> {
    if !config.installed() {
        return Err(Unavailable::NotInstalled);
    }
    api_at(&config.home)
}

/// The API server of the person's own Hermes home, for trusted senders.
pub fn main_api(config: &HermesConfig) -> Result<Api, Unavailable> {
    api_at(&config.main_home).map_err(|reason| Unavailable::Main(Box::new(reason)))
}

pub(super) fn api_at(home: &Path) -> Result<Api, Unavailable> {
    let vars = std::fs::read_to_string(home.join(".env"))
        .map(|text| dotenv(&text))
        .unwrap_or_default();
    api_from(&vars)
}

pub(super) fn api_from(vars: &BTreeMap<String, String>) -> Result<Api, Unavailable> {
    let on = vars.get("API_SERVER_ENABLED").is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "on"
        )
    });
    if !on {
        return Err(Unavailable::ApiOff);
    }
    let host = vars
        .get("API_SERVER_HOST")
        .map(String::as_str)
        .unwrap_or("127.0.0.1");
    let host = match host.trim() {
        "127.0.0.1" | "localhost" => "127.0.0.1",
        "::1" | "[::1]" => "[::1]",
        _ => return Err(Unavailable::NotLoopback),
    };
    let port = vars
        .get("API_SERVER_PORT")
        .and_then(|port| port.trim().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PORT);
    let key = vars
        .get("API_SERVER_KEY")
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .ok_or(Unavailable::NoKey)?;
    Ok(Api { host, port, key })
}

/// One exchange with the API: `None` when no complete response came.
pub(super) fn request(
    api: &Api,
    method: &str,
    path: &str,
    idempotency: Option<&str>,
    body: Option<&Value>,
) -> Option<(u16, Value)> {
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .try_proxy_from_env(false)
        .timeout(TIMEOUT)
        .timeout_connect(Duration::from_secs(3))
        .build();
    let mut call = agent
        .request(method, &api.url(path))
        .set("Authorization", &format!("Bearer {}", api.key))
        .set("Accept", "application/json");
    if let Some(key) = idempotency {
        call = call.set("Idempotency-Key", key);
    }
    let result = match body {
        Some(body) => call
            .set("Content-Type", "application/json")
            .send_string(&body.to_string()),
        None => call.call(),
    };
    let response = match result {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(ureq::Error::Transport(_)) => return None,
    };
    let status = response.status();
    let mut text = String::new();
    response
        .into_reader()
        .take(2_000_001)
        .read_to_string(&mut text)
        .ok()?;
    let value = serde_json::from_str(&text).unwrap_or(Value::Null);
    Some((status, value))
}

/// Whether this API keeps keyed run admission across restarts.
pub(super) fn check(api: &Api) -> Result<(), Unavailable> {
    match request(api, "GET", "/v1/capabilities", None, None) {
        None => Err(Unavailable::NotRunning),
        Some((401 | 403, _)) => Err(Unavailable::Refused("its API key does not match.".into())),
        Some((200, capabilities)) => {
            let runs = &capabilities["features"]["runs_idempotency"];
            if runs["supported"] == true && runs["durable"] == true {
                Ok(())
            } else {
                Err(Unavailable::NotDurable)
            }
        }
        Some((status, _)) => Err(Unavailable::Refused(format!("HTTP {status}"))),
    }
}
