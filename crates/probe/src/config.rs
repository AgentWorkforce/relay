use anyhow::{anyhow, bail, Context, Result};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    net::IpAddr,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use url::Url;

pub const CONFIG_VERSION: u32 = 1;
pub const HOSTED_ORIGIN: &str = "https://cast.agentrelay.com";

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    pub version: u32,
    pub origin: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_cert: Option<PathBuf>,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentCredential>,
    pub api: LocalApi,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<LocalEngine>,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Config")
            .field("version", &self.version)
            .field("origin", &self.origin)
            .field("workspace_id", &self.workspace_id)
            .field("workspace_name", &self.workspace_name)
            .field("workspace_key", &"[redacted]")
            .field("ca_cert", &self.ca_cert)
            .field("agents", &self.agents.keys().collect::<Vec<_>>())
            .field("api", &self.api.redacted())
            .field("engine", &self.engine)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentCredential {
    pub id: String,
    pub token: String,
}

impl std::fmt::Debug for AgentCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentCredential")
            .field("id", &self.id)
            .field("token", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LocalApi {
    pub port: u16,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

impl LocalApi {
    fn redacted(&self) -> serde_json::Value {
        serde_json::json!({"port": self.port, "token": "[redacted]", "pid": self.pid})
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LocalEngine {
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub database: PathBuf,
}

impl Config {
    pub fn new(
        origin: String,
        workspace_id: String,
        workspace_name: String,
        workspace_key: String,
        api_port: u16,
        engine: Option<LocalEngine>,
    ) -> Self {
        Self {
            version: CONFIG_VERSION,
            origin,
            workspace_id,
            workspace_name,
            workspace_key,
            ca_cert: None,
            agents: BTreeMap::new(),
            api: LocalApi {
                port: api_port,
                token: random_secret("lp_"),
                pid: None,
            },
            engine,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.version != CONFIG_VERSION {
            bail!(
                "Relay config version {} is unsupported by this build (expected {}).",
                self.version,
                CONFIG_VERSION
            );
        }
        let normalized = normalize_origin(&self.origin)?;
        if normalized != self.origin {
            bail!("Relay config contains a non-canonical origin.");
        }
        if self.workspace_id.trim().is_empty()
            || self.workspace_name.trim().is_empty()
            || self.workspace_key.trim().is_empty()
            || self.api.token.trim().is_empty()
            || self.api.port == 0
        {
            bail!("Relay config is incomplete.");
        }
        if !self.workspace_key.starts_with("rk_") {
            bail!("Relay config contains an invalid workspace key.");
        }
        for (name, agent) in &self.agents {
            if name.trim().is_empty()
                || agent.id.trim().is_empty()
                || !agent.token.starts_with("at_")
            {
                bail!("Relay config contains an invalid agent credential.");
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct ConfigStore {
    root: PathBuf,
}

impl ConfigStore {
    pub fn discover() -> Result<Self> {
        if let Some(root) = std::env::var_os("AGENT_RELAY_HOME").filter(|value| !value.is_empty()) {
            return Ok(Self::new(PathBuf::from(root)));
        }
        let home =
            dirs::home_dir().ok_or_else(|| anyhow!("Your home directory could not be found."))?;
        Ok(Self::new(home.join(".agentworkforce").join("relay")))
    }

    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path(&self) -> PathBuf {
        self.root.join("config.json")
    }

    pub fn inbox_path(&self, workspace_id: &str, agent: &str) -> PathBuf {
        let workspace_digest = sha256_hex(workspace_id.as_bytes());
        let digest = sha256_hex(agent.as_bytes());
        self.root
            .join("inbox")
            .join(workspace_digest)
            .join(format!("{digest}.jsonl"))
    }

    pub fn read(&self) -> Result<Config> {
        let path = self.path();
        let bytes = fs::read(&path).with_context(|| {
            format!(
                "Relay is not initialized at {}. Run `relay init` first.",
                path.display()
            )
        })?;
        let config: Config = serde_json::from_slice(&bytes).with_context(|| {
            format!(
                "Relay config at {} is unreadable; refusing to guess a hosted destination.",
                path.display()
            )
        })?;
        config.validate()?;
        Ok(config)
    }

    pub fn write(&self, config: &Config) -> Result<()> {
        config.validate()?;
        private_dir(&self.root)?;
        let mut temporary = NamedTempFile::new_in(&self.root).with_context(|| {
            format!(
                "Could not create a temporary file in {}.",
                self.root.display()
            )
        })?;
        set_private_file(temporary.path())?;
        let bytes = serde_json::to_vec_pretty(config)?;
        temporary.write_all(&bytes)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(self.path())
            .map_err(|error| error.error)
            .context("Could not replace Relay config atomically.")?;
        set_private_file(&self.path())?;
        sync_dir(&self.root)?;
        Ok(())
    }
}

pub fn normalize_origin(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        bail!("Relaycast URL is required.");
    }
    let mut url = Url::parse(trimmed).context("Relaycast URL is invalid.")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("Relaycast URL must use https (or loopback http for local mode).");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("Relaycast URL must not contain credentials.");
    }
    if url.query().is_some() || url.fragment().is_some() || !matches!(url.path(), "" | "/") {
        bail!("Relaycast URL must be an origin without a path, query, or fragment.");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("Relaycast URL must include a host."))?;
    if url.scheme() == "http" && !is_loopback(host) {
        bail!("Non-loopback Relaycast URLs must use https.");
    }
    if url.port() == Some(0) {
        bail!("Relaycast URL must use a non-zero port.");
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

pub fn random_secret(prefix: &str) -> String {
    let random: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect();
    format!("{prefix}{random}")
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_private_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_canonical_and_fail_closed() {
        assert_eq!(
            normalize_origin(" https://relay.corp.test:8443/ ").unwrap(),
            "https://relay.corp.test:8443"
        );
        assert_eq!(
            normalize_origin("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        for invalid in [
            "",
            "relay.corp.test",
            "ftp://relay.corp.test",
            "http://relay.corp.test",
            "https://user:secret@relay.corp.test",
            "https://relay.corp.test/path",
            "https://relay.corp.test?key=x",
        ] {
            assert!(normalize_origin(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn config_round_trip_is_private_and_does_not_consult_relay_base_url() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("relay"));
        let config = Config::new(
            "https://relay.corp.test:8443".into(),
            "rw_test".into(),
            "corp".into(),
            "rk_live_private".into(),
            32123,
            None,
        );
        store.write(&config).unwrap();
        let read = store.read().unwrap();
        assert_eq!(read.origin, "https://relay.corp.test:8443");
        assert_eq!(read.workspace_key, "rk_live_private");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn corrupt_config_never_falls_back_to_hosted() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("relay"));
        fs::create_dir_all(store.root()).unwrap();
        fs::write(store.path(), b"{not json").unwrap();
        let error = store.read().unwrap_err().to_string();
        assert!(error.contains("refusing to guess a hosted destination"));
    }

    #[test]
    fn inbox_paths_are_partitioned_by_workspace() {
        let store = ConfigStore::new(PathBuf::from("/tmp/relay-home"));
        let first = store.inbox_path("rw_first", "reviewer");
        let second = store.inbox_path("rw_second", "reviewer");

        assert_ne!(first, second);
        assert_eq!(
            first.parent().unwrap().parent(),
            Some(store.root().join("inbox").as_path())
        );
        assert!(!first.to_string_lossy().contains("reviewer"));
    }
}
