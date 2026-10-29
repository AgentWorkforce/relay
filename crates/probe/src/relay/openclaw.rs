//! OpenClaw agents on this computer and the route into them.
//!
//! OpenClaw runs one long-lived Gateway per person (`openclaw gateway`): a
//! WebSocket and HTTP server on loopback port 18789 by default, configured
//! in `~/.openclaw/openclaw.json`. Agent Relay reaches it the way OpenClaw's
//! own apps do, as an operator client on loopback: it answers the Gateway's
//! `connect.challenge` with an Ed25519 device signature (v3, protocol 3 or
//! 4) and the Gateway's shared token, which is read from the person's
//! config each time and never stored. Direct loopback connects are approved
//! without a pairing prompt, and a remote Gateway is never contacted.
//!
//! Every OpenClaw from 2026.3.13 on is supported, without an upgrade:
//! what each request carries follows what the Gateway's `hello-ok` reports
//! ([`Features`]), so an older Gateway's closed schemas never see a field
//! they do not know.
//!
//! - **Discovery** lists the Gateway's agents (`agents.list`), one relay
//!   agent each, `OpenClaw · <name>`.
//! - **Delivery** gives every relay sender a session of its own on that
//!   agent (`agent:<agent>:relay:dm:<sender>-<hash>`, or one per channel),
//!   so relay traffic never lands in the person's main chat, then calls
//!   `chat.send` with the delivery id as its idempotency key, `deliver:
//!   false` (the answer is not routed to Telegram or any other channel the
//!   person connected). From 2026.8.1 that session is answer-only; an older
//!   Gateway cannot limit it, so the sender gets the agent's usual tools and
//!   Settings says so. The text always opens with Agent Relay's attribution
//!   line, so a peer's `/reset` is never at the start of the message, where
//!   OpenClaw reads commands.
//! - **The answer** is read back from `chat.history`: the run's terminal
//!   assistant text, or on a Gateway that does not mark it, the last
//!   assistant text after this delivery's turn once no run is active. An
//!   agent that chooses not to answer (`NO_REPLY`) leaves no text, so
//!   nothing is sent back.

use crate::relay::delivery::policy::MessageRef;
use crate::relay::existing_session::platform;
use crate::relay::inject::{DeliveryRoute, InjectOutcome};
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{SessionKind, Target};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The Gateway's default port (`gateway.port`).
pub const DEFAULT_PORT: u16 = 18789;

/// The client id and mode Agent Relay connects as. OpenClaw's ids are a
/// closed set; `cli` is the one that is paired as a device of its own (and
/// issued a device token), which `displayName` labels in `openclaw devices
/// list`. `gateway-client` is reserved for OpenClaw's internal helpers.
const CLIENT_ID: &str = "cli";
const CLIENT_MODE: &str = "cli";
const ROLE: &str = "operator";
/// `operator.admin` is what lets a send set `suppressCommandInterpretation`
/// and a session take tool limits; the Gateway grants it on loopback with
/// its shared token, which already holds that authority.
const SCOPES: [&str; 3] = ["operator.read", "operator.write", "operator.admin"];
/// The protocols Agent Relay speaks: 3 (OpenClaw before 2026.5.12) and 4
/// (since), as OpenClaw's own apps offer them. Nothing it uses is new in 4.
const MIN_PROTOCOL: u64 = 3;
const MAX_PROTOCOL: u64 = 4;

/// What a relay sender's session may do on the person's computer:
/// OpenClaw's `read-only` permission mode, no command execution and no
/// writes. A peer can ask the agent, not drive it. On the Codex runtime this
/// does not confine reads to the session root.
const RELAY_PERMISSION_MODE: &str = "read-only";

/// GBrain's MCP server, as its OpenClaw bundle plugin names it.
const GBRAIN_SERVER: &str = "gbrain";

/// The one GBrain a relay sender's session may use: an HTTP `gbrain serve`
/// entry whose bearer is a `memory-reader` grant bound to the sources the
/// person chose (`gbrain mcp grant --profile memory-reader --source …`), so
/// GBrain itself limits what a relay sender can read. Every other GBrain the
/// person configured, the local plugin included, is off in relay sessions.
pub const RELAY_BRAIN_SERVER: &str = "gbrain_relay";

/// How long one Gateway exchange may take, connect included.
const TIMEOUT: Duration = Duration::from_secs(20);

/// Where OpenClaw keeps its state and config, and where this core keeps its
/// own OpenClaw device identity and answer index.
#[derive(Clone)]
pub struct OpenClawConfig {
    /// `openclaw.json`: `OPENCLAW_CONFIG_PATH`, else
    /// `<OPENCLAW_STATE_DIR or ~/.openclaw>/openclaw.json`.
    pub config_path: PathBuf,
    /// This core's own directory: the device key, the Gateway's device
    /// token and which session each delivery went to.
    pub data_dir: PathBuf,
    /// The core's environment, for the `${VAR}` values and the token
    /// overrides OpenClaw's own CLI honors.
    env: Arc<BTreeMap<String, String>>,
    /// The relay senders whose messages go to the agent's main session.
    pub trusted: crate::relay::trusted::TrustedSenders,
    /// What the last Gateway this core connected to can do.
    pub seen: Seen,
}

impl std::fmt::Debug for OpenClawConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenClawConfig")
            .field("config_path", &self.config_path)
            .field("data_dir", &self.data_dir)
            .finish_non_exhaustive()
    }
}

impl OpenClawConfig {
    pub fn new(env: &BTreeMap<String, String>, home: &Path, app_data_dir: &Path) -> Self {
        let set = |key: &str| {
            env.get(key)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(|value| expand_tilde(&value, home))
        };
        let state = set("OPENCLAW_STATE_DIR").unwrap_or_else(|| home.join(".openclaw"));
        OpenClawConfig {
            config_path: set("OPENCLAW_CONFIG_PATH").unwrap_or_else(|| state.join("openclaw.json")),
            data_dir: app_data_dir.join("openclaw"),
            env: Arc::new(env.clone()),
            trusted: crate::relay::trusted::TrustedSenders::new(app_data_dir),
            seen: Seen::default(),
        }
    }

    fn var(&self, key: &str) -> Option<String> {
        self.env.get(key).cloned()
    }

    /// The local history root paired with this configured gateway. A custom
    /// config or profile cannot be silently treated as the default history.
    pub(crate) fn title_history_root(&self, home: &Path) -> Option<(PathBuf, bool)> {
        if ["OPENCLAW_HOME", "OPENCLAW_PROFILE"].iter().any(|key| {
            self.env.get(*key).is_some_and(|v| !v.trim().is_empty())
        }) {
            return None;
        }
        let explicit = self.env.get("OPENCLAW_STATE_DIR")
            .filter(|v| !v.trim().is_empty());
        let state = explicit.map(|v| expand_tilde(v.trim(), home))
            .unwrap_or_else(|| home.join(".openclaw"));
        if !state.is_absolute() || self.config_path != state.join("openclaw.json") {
            return None;
        }
        // Match history storage::namespace, which hashes the database ancestor.
        let database = state.join("agents/_/agent/openclaw-agent.sqlite");
        let state = database.ancestors().nth(4)?.to_path_buf();
        Some((state, explicit.is_some()))
    }

    /// Whether OpenClaw is set up on this computer at all. Never on Windows,
    /// where Agent Relay does not offer OpenClaw (its Gateway route and
    /// relay tools are Unix-only), so it is neither listed nor shown in
    /// Settings there.
    pub fn installed(&self) -> bool {
        platform::SUPPORTED && self.config_path.is_file()
    }

    fn device_path(&self) -> PathBuf {
        self.data_dir.join("device.json")
    }

    fn answers_dir(&self) -> PathBuf {
        self.data_dir.join("answers")
    }

    /// Left when the person turns OpenClaw off in Agent Relay's settings,
    /// so it is not turned on by default again.
    fn off_marker(&self) -> PathBuf {
        self.data_dir.join("off")
    }

    /// Whether `route`'s sender is one the person trusts like themselves
    /// (`relay::trusted`).
    pub fn trusts(&self, route: &DeliveryRoute<'_>) -> bool {
        self.trusted.trusts(route)
    }

    /// Whether Agent Relay lists and delivers to the Gateway's agents: on
    /// wherever OpenClaw is set up, until the person turns it off.
    pub fn enabled(&self) -> bool {
        self.installed() && !self.off_marker().exists()
    }

    /// The connected Gateway's version while it is on and cannot limit
    /// relay sessions: its relay senders then get the agent's usual tools.
    pub fn unlimited_version(&self) -> Option<String> {
        let features = self.seen.get().filter(|f| !f.session_limits)?;
        self.enabled().then(|| features.named_version())
    }
}

fn expand_tilde(value: &str, home: &Path) -> PathBuf {
    match value.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if value == "~" => home.to_path_buf(),
        None => PathBuf::from(value),
    }
}

/// An OpenClaw agent id as the Gateway normalizes them: lowercase letters,
/// digits, `-` and `_`, at most 64 characters.
pub fn is_agent_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase() | bytes[0].is_ascii_digit()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_')
}

/// The person's Gateway, as its config describes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gateway {
    pub port: u16,
    /// The shared secret `connect.params.auth` carries, when the Gateway
    /// asks for one (`gateway.auth.mode` `token` or `password`).
    pub secret: Option<Secret>,
}

#[derive(Clone, PartialEq, Eq)]
pub enum Secret {
    Token(String),
    Password(String),
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Secret::Token(_) => "Token(…)",
            Secret::Password(_) => "Password(…)",
        })
    }
}

impl Secret {
    fn token(&self) -> &str {
        match self {
            Secret::Token(token) => token,
            Secret::Password(_) => "",
        }
    }
}

/// Why the Gateway cannot be used, in words the apps show.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unavailable {
    NotInstalled,
    UnreadableConfig,
    /// `gateway.mode` is `remote`: this computer's OpenClaw talks to a
    /// Gateway elsewhere, which Agent Relay does not reach.
    RemoteGateway,
    /// The token is a secret reference OpenClaw resolves itself.
    UnsupportedSecret,
    NotRunning,
    Refused(String),
}

impl Unavailable {
    pub fn reason(&self) -> String {
        match self {
            Unavailable::NotInstalled => platform::unsupported("OpenClaw")
                .unwrap_or_else(|| "OpenClaw is not set up on this computer.".into()),
            Unavailable::UnreadableConfig => "Could not read OpenClaw's openclaw.json.".into(),
            Unavailable::RemoteGateway => {
                "OpenClaw on this computer uses a remote Gateway; Agent Relay reaches only a Gateway running here.".into()
            }
            Unavailable::UnsupportedSecret => {
                "OpenClaw's Gateway token is a secret reference; set gateway.auth.token in openclaw.json or OPENCLAW_GATEWAY_TOKEN.".into()
            }
            Unavailable::NotRunning => "OpenClaw's Gateway is not running.".into(),
            Unavailable::Refused(reason) => format!("OpenClaw's Gateway refused Agent Relay: {reason}"),
        }
    }
}

/// Reads the Gateway's port and secret from `openclaw.json` (JSON5).
/// The core's environment resolves `${VAR}` values and the `OPENCLAW_GATEWAY_TOKEN` and
/// `OPENCLAW_GATEWAY_PASSWORD` overrides, as OpenClaw's own CLI does.
pub fn gateway(config: &OpenClawConfig) -> Result<Gateway, Unavailable> {
    if !config.installed() {
        return Err(Unavailable::NotInstalled);
    }
    let text =
        std::fs::read_to_string(&config.config_path).map_err(|_| Unavailable::UnreadableConfig)?;
    let file: Value = json5::from_str(&text).map_err(|_| Unavailable::UnreadableConfig)?;
    gateway_from(&file["gateway"], &|key| config.var(key))
}

fn gateway_from(
    section: &Value,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Gateway, Unavailable> {
    if section["mode"].as_str() == Some("remote") {
        return Err(Unavailable::RemoteGateway);
    }
    let port = section["port"]
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PORT);
    let env_value = |key: &str| {
        env(key)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let resolve = |value: &Value| -> Result<Option<String>, Unavailable> {
        match value {
            Value::Null => Ok(None),
            Value::String(text) => {
                let text = text.trim();
                match text
                    .strip_prefix("${")
                    .and_then(|rest| rest.strip_suffix('}'))
                {
                    Some(name) => Ok(env_value(name)),
                    None if text.is_empty() => Ok(None),
                    None => Ok(Some(text.to_string())),
                }
            }
            _ => Err(Unavailable::UnsupportedSecret),
        }
    };
    let auth = &section["auth"];
    let mode = auth["mode"].as_str().unwrap_or("token");
    let secret = match mode {
        "none" | "trusted-proxy" => None,
        "password" => env_value("OPENCLAW_GATEWAY_PASSWORD")
            .or(resolve(&auth["password"])?)
            .map(Secret::Password),
        _ => env_value("OPENCLAW_GATEWAY_TOKEN")
            .or(resolve(&auth["token"])?)
            .map(Secret::Token),
    };
    Ok(Gateway { port, secret })
}

// ---------------------------------------------------------------------------
// Callers

/// Whether `arguments` are an OpenClaw Gateway's: `openclaw gateway …` run
/// by node (`…/openclaw/dist/index.js gateway`, `…/openclaw.mjs gateway`,
/// an `openclaw` launcher), or the process title older Gateways set
/// (`openclaw-gateway`).
pub fn is_gateway_process(arguments: &[String]) -> bool {
    let named = |argument: &String| {
        let argument = argument.replace('\\', "/");
        argument.ends_with("/openclaw/dist/index.js")
            || argument.ends_with("/openclaw.mjs")
            || argument.rsplit('/').next() == Some("openclaw")
    };
    arguments
        .first()
        .is_some_and(|first| first.starts_with("openclaw-gateway"))
        || arguments
            .iter()
            .position(named)
            .is_some_and(|at| arguments.get(at + 1).is_some_and(|next| next == "gateway"))
}

/// The OpenClaw agent a process running under this user's Gateway acts
/// for: the Gateway's one agent. OpenClaw gives a tool process no session
/// or agent id that every platform lets this core read, so with several
/// agents the caller is nobody rather than a guess.
pub fn caller_agent(listed: &[DiscoveredSession]) -> Option<Target> {
    let mut agents = listed
        .iter()
        .filter(|session| session.target.kind == SessionKind::OpenClaw);
    let only = agents.next()?;
    agents.next().is_none().then(|| only.target.clone())
}

// ---------------------------------------------------------------------------
// Discovery

/// How long a Gateway's agent list is reused before it is read again.
const LISTING_TTL: Duration = Duration::from_secs(30);

/// The last agent listing, so a scan of this computer's sessions does not
/// open a Gateway connection every time.
#[derive(Default)]
/// The last listing, when it was read, and whether a read is under way.
pub struct Listing(Mutex<Option<(Instant, Vec<DiscoveredSession>, bool)>>);

impl Listing {
    /// A listing already read, as tests set it.
    #[cfg(test)]
    pub fn seeded(rows: Vec<DiscoveredSession>) -> Listing {
        Listing(Mutex::new(Some((Instant::now(), rows, false))))
    }

    pub fn sessions(&self, config: &OpenClawConfig) -> Vec<DiscoveredSession> {
        // The lock is never held across the network: while one scan reads
        // the gateway, the others get the last listing.
        {
            let mut last = self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match last.as_mut() {
                Some(listed) if listed.0.elapsed() < LISTING_TTL || listed.2 => {
                    return listed.1.clone()
                }
                Some(listed) => listed.2 = true,
                None => *last = Some((Instant::now(), Vec::new(), true)),
            }
        }
        let rows = discover(config);
        let mut last = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *last = Some((Instant::now(), rows.clone(), false));
        rows
    }
}

/// The Gateway's agents, one relay session each.
pub fn discover(config: &OpenClawConfig) -> Vec<DiscoveredSession> {
    let Ok(gateway) = gateway(config) else {
        return Vec::new();
    };
    let Ok(mut connection) = Connection::open(config, &gateway) else {
        return Vec::new();
    };
    let Ok(listed) = connection.call("agents.list", json!({})) else {
        return Vec::new();
    };
    agents_in(&listed)
        .into_iter()
        .map(|(id, name)| DiscoveredSession {
            target: Target::new(SessionKind::OpenClaw, id),
            title: format!("OpenClaw · {name}"),
            directory: None,
            updated_at_ms: None,
            host: None,
            live: true,
            holder: None,
        })
        .collect()
}

/// `(id, display name)` for each agent in an `agents.list` result.
fn agents_in(listed: &Value) -> Vec<(String, String)> {
    let rows = listed["agents"].as_array().or(listed.as_array());
    rows.into_iter()
        .flatten()
        .filter_map(|agent| {
            let id = agent["id"].as_str().or(agent["agentId"].as_str())?;
            is_agent_id(id).then(|| {
                let name = agent["identity"]["name"]
                    .as_str()
                    .or(agent["name"].as_str())
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or(id);
                (id.to_string(), name.trim().chars().take(60).collect())
            })
        })
        .collect()
}

mod answer;
mod delivery;
mod features;
mod gateway;
pub mod relay_tools;
mod settings;

pub use answer::final_answer;
#[cfg(test)]
use answer::*;
#[cfg(test)]
use delivery::*;
pub use delivery::{conversation, main_session_key, send, session_key};
pub use features::{ActiveRun, Features, Release, Seen, LIMITS_FROM};
use gateway::*;
pub use gateway::{Connection, GatewayError};
pub use settings::{OpenClawSettings, SETTING, UNLIMITED_SETTING};

// They exercise an OpenClaw that Agent Relay offers only on Unix.
#[cfg(test)]
#[cfg(unix)]
mod tests;

#[cfg(test)]
#[cfg(windows)]
mod windows_tests {
    use super::*;
    use crate::relay::agents::SettingsExtension;
    use crate::relay::contract::openclaw::OpenClawToolsState;

    #[test]
    fn openclaw_is_not_listed_offered_or_sent_to_on_windows() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join(".openclaw")).unwrap();
        std::fs::write(root.path().join(".openclaw/openclaw.json"), "{}").unwrap();
        let config = OpenClawConfig::new(&BTreeMap::new(), root.path(), &root.path().join("data"));
        let sentence = "OpenClaw is not available on Windows.";
        assert!(!config.installed());
        assert!(discover(&config).is_empty());
        assert_eq!(Unavailable::NotInstalled.reason(), sentence);
        let settings = OpenClawSettings::new(&config);
        assert!(settings.get().is_empty());
        assert_eq!(
            settings.set(SETTING, &Value::Bool(true)),
            Some(Err(sentence.into()))
        );
        assert_eq!(
            send(&config, "main", "w", &DeliveryRoute::default(), "hi"),
            InjectOutcome::Refused(sentence.into())
        );
        let tools = relay_tools::RelayTools::system(
            &config,
            Arc::new(crate::relay::process::FakeProcesses::default()),
            0,
            root.path(),
        );
        let status = tools.status("https://agentrelay.com");
        assert_eq!(status.state, OpenClawToolsState::Unavailable);
        assert_eq!(status.detail.as_deref(), Some(sentence));
        assert_eq!(
            tools.connect("https://agentrelay.com").unwrap_err(),
            sentence
        );
    }
}
