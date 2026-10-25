//! Provider bindings and the evidence required before a route can be used.
use super::{grok, printable};
use crate::relay::harness::muse::courier;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Muse,
    OpenCode,
    Grok,
    Devin,
}

impl Provider {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::Muse => "muse",
            Self::OpenCode => "opencode",
            Self::Grok => "grok",
            Self::Devin => "devin",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    LegacyTui,
    AuthenticatedServer,
    OfficialApi,
    Acp,
    /// A courier for a Muse session started and owned by Relay.
    Courier,
}

impl Transport {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::LegacyTui => "legacy-tui",
            Self::AuthenticatedServer => "authenticated-server",
            Self::OfficialApi => "official-api",
            Self::Acp => "acp",
            Self::Courier => "courier",
        }
    }
}

/// No bearer is stored here. The credential reference is resolved in the
/// desktop core, and the adapter must recheck identity before sending.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub provider: Provider,
    pub transport: Transport,
    /// Relaycast workspace of the agent registration that owns this route.
    pub workspace_id: String,
    pub session_id: String,
    pub endpoint_id: String,
    pub owner_id: String,
    pub credential_reference: String,
    /// Native provider host evidence. Empty/zero for API-backed providers.
    pub owner_uid: u32,
    /// Stable, non-secret identity of the exact app-owned provider host.
    /// Empty for providers that authenticate through `credential_reference`.
    #[serde(default)]
    pub auth_id: String,
    /// Protocol/schema identity reported by the bound provider host.
    #[serde(default)]
    pub protocol_id: String,
    pub cwd: PathBuf,
    pub model_id: String,
    pub agent_version: String,
    pub executable: PathBuf,
    pub leader_pid: i32,
    pub leader_start: u64,
    pub socket_path: PathBuf,
    pub socket_device: u64,
    pub socket_inode: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eligibility {
    Eligible,
    Disabled,
    UnsupportedTransport,
    AmbiguousIdentity,
    MissingAuthentication,
}

#[derive(Default)]
pub struct Gate {
    enabled: HashSet<Provider>,
}

impl Gate {
    pub fn enabled(providers: impl IntoIterator<Item = Provider>) -> Self {
        Self {
            enabled: providers.into_iter().collect(),
        }
    }

    pub fn eligibility(&self, binding: &Binding) -> Eligibility {
        if !binding.supported_route() {
            return Eligibility::UnsupportedTransport;
        }
        if ![
            &binding.workspace_id,
            &binding.session_id,
            &binding.owner_id,
        ]
        .iter()
        .all(|field| printable(field, 256))
            || !binding.valid_identity()
        {
            return Eligibility::AmbiguousIdentity;
        }
        if matches!(binding.provider, Provider::OpenCode | Provider::Devin)
            && !binding.api_credential()
        {
            return Eligibility::MissingAuthentication;
        }
        if !self.enabled.contains(&binding.provider) {
            return Eligibility::Disabled;
        }
        Eligibility::Eligible
    }
}

impl Binding {
    fn supported_route(&self) -> bool {
        matches!(
            (self.provider, self.transport),
            (Provider::Grok, Transport::Acp)
                | (Provider::Muse, Transport::Courier)
                | (Provider::OpenCode, Transport::AuthenticatedServer)
                | (Provider::Devin, Transport::OfficialApi)
        )
    }

    fn valid_identity(&self) -> bool {
        match self.provider {
            Provider::Grok => self.grok_identity(),
            Provider::Muse => self.courier_identity(),
            Provider::OpenCode | Provider::Devin => self.api_identity(),
        }
    }

    /// Both native protocols bind to an exact process and socket in an
    /// absolute workspace; their authentication evidence differs.
    fn native_identity(&self) -> bool {
        self.owner_uid != 0
            && self.leader_pid > 1
            && self.leader_start != 0
            && self.socket_device != 0
            && self.socket_inode != 0
            && absolute_plain_path(&self.cwd)
            && absolute_plain_path(&self.executable)
            && absolute_plain_path(&self.socket_path)
            && printable(&self.model_id, 256)
            && printable(&self.agent_version, 256)
    }

    fn grok_identity(&self) -> bool {
        self.endpoint_id.is_empty()
            && self.auth_id.is_empty()
            && self.protocol_id.is_empty()
            && grok::is_credential_reference(&self.credential_reference)
            && self.native_identity()
    }

    // The courier is permitted only after the caller proves the target is a
    // live Relay-owned spawn. This binding records the owner and workspace.
    fn courier_identity(&self) -> bool {
        courier::is_courier_reference(&self.credential_reference)
            && self.endpoint_id.is_empty()
            && self.auth_id.is_empty()
            && self.protocol_id.is_empty()
            && self.model_id.is_empty()
            && self.agent_version.is_empty()
            && self.owner_uid != 0
            && self.leader_pid == 0
            && self.leader_start == 0
            && self.socket_device == 0
            && self.socket_inode == 0
            && self.executable.as_os_str().is_empty()
            && self.socket_path.as_os_str().is_empty()
            && absolute_plain_path(&self.cwd)
    }

    fn api_identity(&self) -> bool {
        printable(&self.endpoint_id, 256)
            && self.auth_id.is_empty()
            && self.protocol_id.is_empty()
            && self.owner_uid == 0
            && self.cwd.as_os_str().is_empty()
            && self.model_id.is_empty()
            && self.agent_version.is_empty()
            && self.executable.as_os_str().is_empty()
            && self.leader_pid == 0
            && self.leader_start == 0
            && self.socket_path.as_os_str().is_empty()
            && self.socket_device == 0
            && self.socket_inode == 0
    }

    fn api_credential(&self) -> bool {
        let reference = &self.credential_reference;
        ["keychain:", "probe:"].iter().any(|prefix| {
            reference.starts_with(prefix)
                && reference.len() > prefix.len()
                && printable(reference, 256)
        })
    }
}

fn absolute_plain_path(path: &Path) -> bool {
    path.is_absolute()
        && !path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        && path.to_str().is_some_and(|value| {
            (1..=4096).contains(&value.len())
                && value.chars().all(|character| !character.is_control())
        })
}
