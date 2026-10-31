//! Contractor access: a workspace owner grants a contractor's seat scoped
//! access to the workspace's services, and a contractor's computer hands
//! its own grant to the seat-scoped token provider.
//!
//! Every request goes through `CloudAccess` with the signed-in person's
//! session: the members roster through `relay::people`, everything else
//! under `/workspaces/{ws}/access`. Cloud
//! answers 404, 405 or 501 until it serves the access routes; that is
//! `unsupported`, never a failure. A grant is policy (services, read or
//! write) and never credential material; Cloud is authoritative, so a
//! revoke needs nothing scrubbed here.
//!
//! The feature is off unless `RELAY_DESKTOP_CONTRACTOR_ACCESS` or the
//! `contractor_access` setting turns it on, so nothing asks Cloud for
//! routes it does not serve.

use crate::relay::agents::SettingsExtension;
use crate::relay::cloud_session::{segment, CloudAccess, CloudError};
use crate::relay::contract::contractors::{
    AccessGrant, ContractorStatus, GrantResult, PendingSeat, Provisioning,
};
use crate::relay::contract::{answer, method, Done};
use crate::relay::daemon::Core;
use crate::relay::people::{self, Member};
use crate::relay::protocol::{ErrorKind, RpcError};
use futures_util::future::BoxFuture;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Turns the feature on or off for one run; wins over the setting.
pub const ENVIRONMENT_KEY: &str = "RELAY_DESKTOP_CONTRACTOR_ACCESS";
/// The `settings.get`/`settings.set` key.
pub const SETTING_KEY: &str = "contractor_access";
/// The flag and the dismissed seats, in the app data directory.
pub const FILE: &str = "contractor-access.json";

/// The shortest description worth proposing scopes for, in characters.
pub const MINIMUM_DESCRIPTION: usize = 8;
const MAXIMUM_DESCRIPTION: usize = 2_000;

/// Per-service access, ordered `none < read < write`.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "lowercase")]
#[schemars(extend("x-fallback" = "none"))]
pub enum Access {
    None,
    Read,
    Write,
}

impl Access {
    /// Cloud's value; anything unknown grants nothing.
    fn decode(value: &Value) -> Access {
        match value.as_str() {
            Some("read") => Access::Read,
            Some("write") => Access::Write,
            _ => Access::None,
        }
    }
}

/// How a service's credential may be resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "lowercase")]
#[schemars(extend("x-fallback" = "high"))]
pub enum Sensitivity {
    /// The local proxy may resolve it with seat-scoped material.
    Standard,
    /// Always proxied through Cloud; the raw key never reaches a desktop.
    High,
}

/// A service whose credential lives in the workspace's Cloud store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct Service {
    pub id: String,
    pub name: String,
    pub sensitivity: Sensitivity,
    /// Words an owner might use for it ("billing" for Stripe).
    pub keywords: Vec<String>,
}

impl Service {
    fn decode(value: &Value) -> Option<Service> {
        let id = value["id"].as_str().filter(|id| !id.is_empty())?;
        let sensitivity = match &value["sensitivity"] {
            Value::Null => Sensitivity::Standard,
            Value::String(raw) if raw == "standard" => Sensitivity::Standard,
            // Unknown sensitivity is the safe direction.
            _ => Sensitivity::High,
        };
        Some(Service {
            id: id.into(),
            name: value["name"].as_str().unwrap_or(id).into(),
            sensitivity,
            keywords: strings(&value["keywords"]),
        })
    }
}

/// One service's access in a grant.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub struct Scope {
    pub service: String,
    pub access: Access,
}

impl Scope {
    fn decode(value: &Value) -> Option<Scope> {
        Some(Scope {
            service: value["service"].as_str().filter(|s| !s.is_empty())?.into(),
            access: Access::decode(&value["access"]),
        })
    }

    fn cloud(&self) -> Value {
        json!({"service": self.service, "access": self.access})
    }
}

/// An approved grant: one seat's scoped access.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub id: String,
    pub user_id: String,
    pub display_name: Option<String>,
    pub description: String,
    pub scopes: Vec<Scope>,
    pub granted_by: Option<String>,
    pub created_at_ms: Option<i64>,
}

impl Grant {
    fn decode(value: &Value) -> Option<Grant> {
        let text = |key: &str| value[key].as_str().map(str::to_string);
        Some(Grant {
            id: text("id").filter(|id| !id.is_empty())?,
            user_id: text("userId").filter(|id| !id.is_empty())?,
            display_name: text("displayName"),
            description: text("description").unwrap_or_default(),
            // Required, as the macOS app decoded it: a grant whose scopes
            // cannot be read is unreadable, never an empty grant.
            scopes: value["scopes"]
                .as_array()?
                .iter()
                .map(Scope::decode)
                .collect::<Option<Vec<_>>>()?,
            granted_by: text("grantedBy"),
            created_at_ms: timestamp(&value["createdAt"]),
        })
    }

    /// Scopes that grant something, strongest first, then by service.
    pub fn effective_scopes(&self) -> Vec<Scope> {
        let mut scopes: Vec<Scope> = self
            .scopes
            .iter()
            .filter(|scope| scope.access != Access::None)
            .cloned()
            .collect();
        scopes.sort_by(|a, b| b.access.cmp(&a.access).then(a.service.cmp(&b.service)));
        scopes
    }

    /// The bridge shape: only the scopes that grant something.
    pub fn to_bridge(&self) -> AccessGrant {
        AccessGrant {
            id: self.id.clone(),
            user_id: self.user_id.clone(),
            display_name: self.display_name.clone(),
            description: self.description.clone(),
            scopes: self.effective_scopes(),
            granted_by: self.granted_by.clone(),
            created_at_ms: self.created_at_ms,
        }
    }
}

/// This person's standing in the workspace (`access/me`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "lowercase")]
#[schemars(extend("x-fallback" = "contractor"))]
pub enum Role {
    Owner,
    Member,
    Contractor,
}

impl Role {
    /// An unrecognised role gets the least privilege.
    fn decode(value: &Value) -> Role {
        match value.as_str() {
            Some("owner") => Role::Owner,
            Some("member") => Role::Member,
            _ => Role::Contractor,
        }
    }
}

/// Where the proposal came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "lowercase")]
#[schemars(extend("x-fallback" = "heuristic"))]
pub enum ProposalSource {
    Cloud,
    /// Cloud has no proposal agent; [`heuristic`] drafted it.
    Heuristic,
}

/// A suggestion for the owner to review, one row per catalogue service; it
/// grants nothing by itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct Proposal {
    pub scopes: Vec<Scope>,
    /// Cloud's own reasoning, when it sent one.
    pub rationale: Option<String>,
    pub source: ProposalSource,
}

/// The local draft when Cloud has no proposal agent: write to services the
/// description names, read the rest, nothing on a high-sensitivity service.
pub fn heuristic(description: &str, services: &[Service]) -> Proposal {
    let said: HashSet<String> = words(description).collect();
    let scopes = services
        .iter()
        .map(|service| {
            let access = if service.sensitivity != Sensitivity::Standard {
                Access::None
            } else if [&service.id, &service.name]
                .into_iter()
                .chain(&service.keywords)
                .any(|term| {
                    let parts: Vec<String> = words(term).collect();
                    !parts.is_empty() && parts.iter().all(|part| said.contains(part))
                })
            {
                Access::Write
            } else {
                Access::Read
            };
            Scope {
                service: service.id.clone(),
                access,
            }
        })
        .collect();
    Proposal {
        scopes,
        rationale: None,
        source: ProposalSource::Heuristic,
    }
}

fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
}

/// One row per known service in catalogue order (omitted means no access),
/// then any other service the proposal named; a repeated service keeps its
/// strongest access.
pub fn normalize(proposal: Proposal, services: &[Service]) -> Proposal {
    let mut proposed: HashMap<&str, Access> = HashMap::new();
    for scope in &proposal.scopes {
        let entry = proposed.entry(&scope.service).or_insert(Access::None);
        *entry = (*entry).max(scope.access);
    }
    let mut scopes: Vec<Scope> = services
        .iter()
        .map(|service| Scope {
            service: service.id.clone(),
            access: proposed.remove(service.id.as_str()).unwrap_or(Access::None),
        })
        .collect();
    for scope in &proposal.scopes {
        if let Some(access) = proposed.remove(scope.service.as_str()) {
            scopes.push(Scope {
                service: scope.service.clone(),
                access,
            });
        }
    }
    Proposal { scopes, ..proposal }
}

/// Seats the owner has not set up: not an owner, not this person, no
/// grant, not dismissed. Newest first, undated last, then by name.
pub fn pending<'a>(
    members: &'a [Member],
    grants: &[Grant],
    dismissed: &BTreeSet<String>,
    self_user_id: Option<&str>,
) -> Vec<&'a Member> {
    let granted: HashSet<&str> = grants.iter().map(|g| g.user_id.as_str()).collect();
    let mut seats: Vec<&Member> = members
        .iter()
        .filter(|m| {
            m.role != "owner"
                && Some(m.user_id.as_str()) != self_user_id
                && !granted.contains(m.user_id.as_str())
                && !dismissed.contains(&m.user_id)
        })
        .collect();
    seats.sort_by(|a, b| match (a.joined_at_ms, b.joined_at_ms) {
        (Some(x), Some(y)) if x != y => y.cmp(&x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => a
            .person
            .name
            .to_lowercase()
            .cmp(&b.person.name.to_lowercase()),
    });
    seats
}

fn pending_seat(member: &Member) -> PendingSeat {
    PendingSeat {
        user_id: member.user_id.clone(),
        name: member.person.name.clone(),
        avatar_url: member.person.avatar_url.clone(),
        identity_hash: member.person.identity_hash.clone(),
        role: member.role.clone(),
        joined_at_ms: member.joined_at_ms,
    }
}

/// The hand-off to the seat-scoped token provider: provisioning starts
/// minting short-lived, memory-only material for a grant; deprovisioning
/// drops whatever is held. Calls arrive one at a time, in order.
pub trait Provisioner: Send + Sync + 'static {
    fn provision<'a>(&'a self, grant: &'a Grant) -> BoxFuture<'a, Result<(), String>>;
    fn deprovision(&self);
}

/// Holds nothing until the seat-scoped token provider lands: no token is
/// minted and nothing is written.
pub struct PendingSeatTokens;

impl Provisioner for PendingSeatTokens {
    fn provision<'a>(&'a self, _: &'a Grant) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    fn deprovision(&self) {}
}

/// Why a Cloud access request did not succeed.
enum Failure {
    /// Cloud does not serve the route (404, 405, 501).
    Unsupported,
    Error(RpcError),
}

impl From<RpcError> for Failure {
    fn from(error: RpcError) -> Failure {
        Failure::Error(error)
    }
}

fn not_owner() -> RpcError {
    RpcError::new(
        ErrorKind::Refused,
        "Only a workspace owner can change access.",
    )
}

fn unreadable() -> RpcError {
    RpcError::new(
        ErrorKind::CloudFailed,
        "Agent Relay Cloud returned an unreadable response.",
    )
}

fn failure(error: CloudError) -> Failure {
    match error {
        CloudError::Status {
            status: 404 | 405 | 501,
            ..
        } => Failure::Unsupported,
        CloudError::Status { status: 403, .. } => Failure::Error(not_owner()),
        error => Failure::Error(RpcError::cloud(&error)),
    }
}

/// What the cache shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "dormant"))]
pub enum ContractorAvailability {
    /// Nobody is signed in.
    Dormant,
    /// Cloud has not been asked yet.
    #[default]
    Unloaded,
    /// Cloud has no access routes yet.
    Unsupported,
    Ready,
    /// The last refresh failed; `failure` says why.
    Failed,
}

#[derive(Default)]
struct Inner {
    /// Bumped on every account change and reset: late answers are dropped.
    generation: u64,
    /// Bumped per refresh: only the newest may publish its result.
    serial: u64,
    /// `<site>/<workspace>` the cache belongs to.
    account: Option<String>,
    availability: ContractorAvailability,
    failure: Option<RpcError>,
    role: Option<Role>,
    grant: Option<Grant>,
    members: Vec<Member>,
    services: Vec<Service>,
    grants: Vec<Grant>,
    /// What the provider should hold.
    desired: Option<Grant>,
    provisioned: Option<String>,
    provision_failed: bool,
    revoking: HashSet<String>,
}

impl Inner {
    fn clear(&mut self) {
        *self = Inner {
            generation: self.generation + 1,
            serial: self.serial,
            ..Inner::default()
        };
    }
}

/// One refresh's answer from Cloud.
struct Loaded {
    role: Role,
    grant: Option<Grant>,
    /// What only an owner is shown.
    owned: Option<Owned>,
}

struct Owned {
    members: Vec<Member>,
    services: Vec<Service>,
    grants: Vec<Grant>,
}

/// The signed-in account, as contractor access addresses it.
struct Signed {
    key: String,
    workspace_id: String,
    user_id: Option<String>,
}

/// The settings file: the flag and per-workspace dismissals.
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    dismissed: BTreeMap<String, BTreeSet<String>>,
}

/// One read-modify-write of the settings file at a time.
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// A missing or unreadable file is the defaults: nothing here is worth
/// failing a request over.
fn load(file: &Path) -> Saved {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn update(file: &Path, change: impl FnOnce(&mut Saved)) -> Result<(), RpcError> {
    let _guard = FILE_LOCK.lock().unwrap();
    let mut saved = load(file);
    change(&mut saved);
    let bytes = serde_json::to_vec_pretty(&saved).unwrap();
    let saved = file
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .is_ok()
        && atomicwrites::AtomicFile::new(file, atomicwrites::AllowOverwrite)
            .write(|f| std::io::Write::write_all(f, &bytes))
            .is_ok();
    if saved {
        Ok(())
    } else {
        Err(RpcError::new(
            ErrorKind::StoreFailed,
            "The contractor access settings could not be saved.",
        ))
    }
}

/// Whether the feature is on: the environment when set, else the setting.
pub fn enabled(environment: Option<&str>, setting: bool) -> bool {
    match environment
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
    {
        Some(value) => ["1", "true", "yes", "on"].contains(&value.as_str()),
        None => setting,
    }
}

/// `contractor_access` in `settings.get`/`settings.set`.
pub struct Setting {
    file: PathBuf,
}

impl Setting {
    pub fn new(app_data_dir: &Path) -> Setting {
        Setting {
            file: app_data_dir.join(FILE),
        }
    }
}

impl SettingsExtension for Setting {
    fn get(&self) -> Map<String, Value> {
        let mut settings = Map::new();
        settings.insert(SETTING_KEY.into(), json!(load(&self.file).enabled));
        settings
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING_KEY {
            return None;
        }
        let Some(on) = value.as_bool() else {
            return Some(Err("contractor_access must be true or false.".into()));
        };
        Some(update(&self.file, |saved| saved.enabled = on).map_err(|e| e.message))
    }
}

/// Contractor access for one core: the cache of what Cloud last said and
/// the grant the provider holds.
pub struct ContractorAccess {
    file: PathBuf,
    environment: Option<String>,
    provisioner: Arc<dyn Provisioner>,
    inner: Mutex<Inner>,
    /// What the provider holds; locked across each provider call so calls
    /// run in order and always converge on `desired`.
    held: tokio::sync::Mutex<Option<Grant>>,
}

impl ContractorAccess {
    pub fn new(
        app_data_dir: &Path,
        environment: Option<String>,
        provisioner: Arc<dyn Provisioner>,
    ) -> ContractorAccess {
        ContractorAccess {
            file: app_data_dir.join(FILE),
            environment,
            provisioner,
            inner: Mutex::new(Inner::default()),
            held: tokio::sync::Mutex::new(None),
        }
    }

    fn enabled(&self) -> bool {
        enabled(self.environment.as_deref(), load(&self.file).enabled)
    }

    /// The signed-in account when the feature is on.
    fn current(&self, cloud: &dyn CloudAccess) -> Option<Signed> {
        cloud
            .account()
            .filter(|a| !a.workspace_id.is_empty() && self.enabled())
            .map(|a| Signed {
                key: format!("{}/{}", a.site_url, a.workspace_id),
                workspace_id: a.workspace_id,
                user_id: a.user_id,
            })
    }

    /// The signed-in account when the feature is on. A different account
    /// than the cache's clears the cache first and queues a deprovision.
    async fn signed(&self, cloud: &dyn CloudAccess) -> Option<Signed> {
        let signed = self.current(cloud);
        let changed = {
            let mut inner = self.inner.lock().unwrap();
            let key = signed.as_ref().map(|s| s.key.clone());
            let changed = inner.account != key;
            if changed {
                inner.clear();
                inner.account = key;
            }
            changed
        };
        if changed {
            self.converge().await;
        }
        signed
    }

    /// Sign-out or account switch: forgets everything and drops what the
    /// provider holds.
    pub async fn reset(&self) {
        self.inner.lock().unwrap().clear();
        self.converge().await;
    }

    /// After a Cloud sign-in: a contractor is provisioned from here with no
    /// further action.
    pub async fn adopt(&self, cloud: &dyn CloudAccess) -> Result<ContractorStatus, RpcError> {
        self.reset().await;
        self.refresh(cloud).await
    }

    /// One step that brings the provider in line with `desired`. A changed
    /// grant is deprovisioned before the new one is provisioned.
    async fn converge(&self) {
        let mut held = self.held.lock().await;
        let desired = {
            let mut inner = self.inner.lock().unwrap();
            if inner.desired.is_none() {
                // Nothing to set up means nothing failed to set up.
                inner.provision_failed = false;
            }
            inner.desired.clone()
        };
        if desired == *held {
            return;
        }
        if held.take().is_some() {
            self.provisioner.deprovision();
            self.inner.lock().unwrap().provisioned = None;
        }
        let Some(desired) = desired else {
            return;
        };
        let outcome = self.provisioner.provision(&desired).await;
        let mut inner = self.inner.lock().unwrap();
        match outcome {
            Ok(()) => {
                inner.provisioned = Some(desired.id.clone());
                inner.provision_failed = false;
                *held = Some(desired);
            }
            // Retried on the next refresh, since nothing is held.
            Err(_) => inner.provision_failed = true,
        }
    }

    async fn get(&self, cloud: &dyn CloudAccess, path: String) -> Result<Value, Failure> {
        cloud.request("GET", path, None).await.map_err(failure)
    }

    fn access_path(workspace_id: &str, tail: &str) -> String {
        format!("/workspaces/{}/access/{tail}", segment(workspace_id))
    }

    /// Asks Cloud for this person's standing and, for an owner, the seats,
    /// services and grants; then converges the provider on the grant.
    pub async fn refresh(&self, cloud: &dyn CloudAccess) -> Result<ContractorStatus, RpcError> {
        let Some(signed) = self.signed(cloud).await else {
            return Ok(self.status_for(None));
        };
        let (generation, serial) = {
            let mut inner = self.inner.lock().unwrap();
            inner.serial += 1;
            (inner.generation, inner.serial)
        };
        let current = |inner: &Inner| inner.generation == generation && inner.serial == serial;
        match self.load(cloud, &signed).await {
            Ok(Loaded { role, grant, owned }) => {
                {
                    let mut inner = self.inner.lock().unwrap();
                    if !current(&inner) {
                        drop(inner);
                        return Ok(self.status_for(Some(&signed)));
                    }
                    if let Some(owned) = owned {
                        inner.members = owned.members;
                        inner.services = owned.services;
                        inner.grants = owned.grants;
                    }
                    inner.desired = grant
                        .clone()
                        .filter(|g| role != Role::Owner && !g.effective_scopes().is_empty());
                    inner.role = Some(role);
                    inner.grant = grant;
                    inner.failure = None;
                    inner.availability = ContractorAvailability::Ready;
                }
                self.converge().await;
                Ok(self.status_for(Some(&signed)))
            }
            Err(Failure::Unsupported) => {
                let mut inner = self.inner.lock().unwrap();
                if current(&inner) {
                    inner.availability = ContractorAvailability::Unsupported;
                }
                drop(inner);
                Ok(self.status_for(Some(&signed)))
            }
            Err(Failure::Error(error)) => {
                let mut inner = self.inner.lock().unwrap();
                if current(&inner) {
                    inner.availability = ContractorAvailability::Failed;
                    inner.failure = Some(error.clone());
                }
                Err(error)
            }
        }
    }

    async fn load(&self, cloud: &dyn CloudAccess, signed: &Signed) -> Result<Loaded, Failure> {
        let me = self
            .get(cloud, Self::access_path(&signed.workspace_id, "me"))
            .await?;
        let role = Role::decode(&me["role"]);
        let grant = match &me["grant"] {
            Value::Null => None,
            value => Some(Grant::decode(value).ok_or_else(unreadable)?),
        };
        if role != Role::Owner {
            return Ok(Loaded {
                role,
                grant,
                owned: None,
            });
        }
        let (members, services, grants) = futures_util::future::try_join3(
            async {
                people::members_response(cloud)
                    .await
                    .map(|value| people::decode_member_list(&value, signed.user_id.as_deref()))
                    .map_err(Failure::Error)
            },
            async {
                let page = self
                    .get(cloud, Self::access_path(&signed.workspace_id, "services"))
                    .await?;
                Ok(list(&page["services"], Service::decode)?)
            },
            async {
                let page = self
                    .get(cloud, Self::access_path(&signed.workspace_id, "grants"))
                    .await?;
                Ok(list(&page["grants"], Grant::decode)?)
            },
        )
        .await?;
        Ok(Loaded {
            role,
            grant,
            owned: Some(Owned {
                members,
                services,
                grants,
            }),
        })
    }

    /// The cache, as `contractors.status` reports it.
    pub fn status(&self, cloud: &dyn CloudAccess) -> ContractorStatus {
        self.status_for(self.current(cloud).as_ref())
    }

    fn status_for(&self, signed: Option<&Signed>) -> ContractorStatus {
        let enabled = self.enabled();
        let inner = self.inner.lock().unwrap();
        // The cache answers only for the account it was loaded for.
        let matched = signed.filter(|s| inner.account.as_deref() == Some(s.key.as_str()));
        let availability = match (signed, matched) {
            (None, _) => ContractorAvailability::Dormant,
            (Some(_), None) => ContractorAvailability::Unloaded,
            (Some(_), Some(_)) => inner.availability,
        };
        let signed = matched;
        let dismissed = signed
            .and_then(|s| load(&self.file).dismissed.remove(&s.key))
            .unwrap_or_default();
        let owner = signed.is_some() && inner.role == Some(Role::Owner);
        let pending_seats = if owner {
            pending(
                &inner.members,
                &inner.grants,
                &dismissed,
                signed.and_then(|s| s.user_id.as_deref()),
            )
            .into_iter()
            .map(pending_seat)
            .collect()
        } else {
            Vec::new()
        };
        ContractorStatus {
            enabled,
            availability,
            failure: signed.and(inner.failure.clone()),
            role: signed.and(inner.role),
            grant: signed.and(inner.grant.as_ref()).map(Grant::to_bridge),
            pending_seats,
            services: if owner {
                inner.services.clone()
            } else {
                Vec::new()
            },
            grants: if owner {
                inner.grants.iter().map(Grant::to_bridge).collect()
            } else {
                Vec::new()
            },
            provisioning: Provisioning {
                grant_id: inner.provisioned.clone(),
                failed: inner.provision_failed,
            },
        }
    }

    /// The account, with this person known to be an owner; the first owner
    /// action after a start or account change asks Cloud first.
    async fn owner(&self, cloud: &dyn CloudAccess) -> Result<(Signed, u64), RpcError> {
        let signed = self.signed(cloud).await.ok_or_else(signed_out)?;
        let loaded = self.inner.lock().unwrap().role.is_some();
        if !loaded {
            self.refresh(cloud).await?;
        }
        let inner = self.inner.lock().unwrap();
        match (inner.availability, inner.role) {
            (_, Some(Role::Owner)) => Ok((signed, inner.generation)),
            (ContractorAvailability::Unsupported, _) => Err(RpcError::new(
                ErrorKind::Refused,
                "Agent Relay Cloud doesn't support team access for this workspace yet.",
            )),
            _ => Err(not_owner()),
        }
    }

    /// A scope proposal from Cloud's proposal agent, or the local
    /// [`heuristic`] when Cloud has none, normalized to the catalogue.
    pub async fn propose(
        &self,
        cloud: &dyn CloudAccess,
        user_id: &str,
        description: &str,
    ) -> Result<Proposal, RpcError> {
        let description = checked_description(description)?;
        let user_id = checked_id(user_id, "user_id")?;
        let (signed, _) = self.owner(cloud).await?;
        let services = self.inner.lock().unwrap().services.clone();
        let proposal = match cloud
            .request(
                "POST",
                Self::access_path(&signed.workspace_id, "proposals"),
                Some(json!({"userId": user_id, "description": description})),
            )
            .await
            .map_err(failure)
        {
            Ok(value) => Proposal {
                scopes: list(&value["scopes"], Scope::decode)?,
                rationale: value["rationale"].as_str().map(str::to_string),
                source: ProposalSource::Cloud,
            },
            Err(Failure::Unsupported) => heuristic(&description, &services),
            Err(Failure::Error(error)) => return Err(error),
        };
        Ok(normalize(proposal, &services))
    }

    /// Grants the scopes that grant something; nothing reaches Cloud before
    /// this call.
    pub async fn approve(
        &self,
        cloud: &dyn CloudAccess,
        user_id: &str,
        description: &str,
        scopes: &[Scope],
    ) -> Result<Grant, RpcError> {
        let description = checked_description(description)?;
        let user_id = checked_id(user_id, "user_id")?;
        let scopes: Vec<Value> = scopes
            .iter()
            .filter(|scope| scope.access != Access::None)
            .map(|scope| checked_id(&scope.service, "service").map(|_| scope.cloud()))
            .collect::<Result<_, _>>()?;
        if scopes.is_empty() {
            return Err(RpcError::invalid_params(
                "Choose at least one service to grant.",
            ));
        }
        let (signed, generation) = self.owner(cloud).await?;
        let value = cloud
            .request(
                "POST",
                Self::access_path(&signed.workspace_id, "grants"),
                Some(json!({"userId": user_id, "description": description, "scopes": scopes})),
            )
            .await
            .map_err(|error| match failure(error) {
                Failure::Unsupported => unsupported(),
                Failure::Error(error) => error,
            })?;
        let grant = Grant::decode(&value).ok_or_else(unreadable)?;
        let mut inner = self.inner.lock().unwrap();
        if inner.generation == generation {
            inner.grants.retain(|g| g.user_id != grant.user_id);
            inner.grants.insert(0, grant.clone());
        }
        Ok(grant)
    }

    /// Revokes a grant at once. Cloud is authoritative: the seat's next
    /// token refresh fails and nothing on the contractor's computer needs
    /// scrubbing.
    pub async fn revoke(&self, cloud: &dyn CloudAccess, grant_id: &str) -> Result<(), RpcError> {
        let grant_id = checked_id(grant_id, "grant_id")?;
        let (signed, generation) = self.owner(cloud).await?;
        if !self.inner.lock().unwrap().revoking.insert(grant_id.clone()) {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "That access is already being revoked.",
            ));
        }
        let outcome = cloud
            .request(
                "DELETE",
                Self::access_path(
                    &signed.workspace_id,
                    &format!("grants/{}", segment(&grant_id)),
                ),
                None,
            )
            .await;
        let mut inner = self.inner.lock().unwrap();
        if inner.generation == generation {
            inner.revoking.remove(&grant_id);
        }
        match outcome {
            Ok(_) => {
                if inner.generation == generation {
                    inner.grants.retain(|g| g.id != grant_id);
                }
                Ok(())
            }
            Err(error) => Err(match failure(error) {
                Failure::Unsupported => unsupported(),
                Failure::Error(error) => error,
            }),
        }
    }

    /// Hides a seat from the pending list without granting anything,
    /// remembered per Cloud site and workspace.
    pub async fn dismiss(
        &self,
        cloud: &dyn CloudAccess,
        user_id: &str,
    ) -> Result<ContractorStatus, RpcError> {
        let user_id = checked_id(user_id, "user_id")?;
        let signed = self.signed(cloud).await.ok_or_else(signed_out)?;
        update(&self.file, |saved| {
            saved
                .dismissed
                .entry(signed.key.clone())
                .or_default()
                .insert(user_id);
        })?;
        Ok(self.status_for(Some(&signed)))
    }
}

fn signed_out() -> RpcError {
    RpcError::new(
        ErrorKind::NotSignedIn,
        "Sign in to Agent Relay with contractor access turned on first.",
    )
}

fn unsupported() -> RpcError {
    RpcError::new(
        ErrorKind::Refused,
        "Agent Relay Cloud doesn't support team access for this workspace yet.",
    )
}

fn checked_description(description: &str) -> Result<String, RpcError> {
    if description.trim().chars().count() < MINIMUM_DESCRIPTION {
        return Err(RpcError::invalid_params(
            "Describe the work in a few more words.",
        ));
    }
    Ok(description.chars().take(MAXIMUM_DESCRIPTION).collect())
}

fn checked_id(value: &str, name: &str) -> Result<String, RpcError> {
    if value.is_empty() {
        return Err(RpcError::invalid_params(format!("{name} is empty.")));
    }
    Ok(value.into())
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect()
}

fn timestamp(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|d| d.timestamp_millis())
}

/// Cloud's list, all or nothing: one unreadable entry fails the response.
fn list<T>(value: &Value, decode: fn(&Value) -> Option<T>) -> Result<Vec<T>, RpcError> {
    value
        .as_array()
        .and_then(|all| all.iter().map(decode).collect())
        .ok_or_else(unreadable)
}

/// This core's contractor access, made on first use.
pub fn of(core: &Arc<Core>) -> Arc<ContractorAccess> {
    core.contractors
        .get_or_init(|| {
            let config = core.config();
            Arc::new(ContractorAccess::new(
                &config.app_data_dir,
                config.env.get(ENVIRONMENT_KEY).cloned(),
                Arc::new(PendingSeatTokens),
            ))
        })
        .clone()
}

/// After a Cloud sign-in.
pub async fn adopt(core: &Arc<Core>) -> Result<ContractorStatus, RpcError> {
    of(core).adopt(core.plugins.cloud.as_ref()).await
}

/// On sign-out: forgets the cache and drops what the provider holds.
pub async fn reset(core: &Arc<Core>) {
    of(core).reset().await
}

/// Answers `method`, or `None` when this module has no such method.
pub async fn call(core: &Arc<Core>, method: &str, raw: Value) -> Option<Result<Value, RpcError>> {
    let access = || of(core);
    let cloud = core.plugins.cloud.as_ref();
    Some(match method {
        method::ContractorsStatus::NAME => {
            answer::<method::ContractorsStatus, _>(raw, |_| async { Ok(access().status(cloud)) })
                .await
        }
        method::ContractorsRefresh::NAME => {
            answer::<method::ContractorsRefresh, _>(raw, |_| async {
                access().refresh(cloud).await
            })
            .await
        }
        method::ContractorsPropose::NAME => {
            answer::<method::ContractorsPropose, _>(raw, |r| async move {
                access().propose(cloud, &r.user_id, &r.description).await
            })
            .await
        }
        method::ContractorsApprove::NAME => {
            answer::<method::ContractorsApprove, _>(raw, |r| async move {
                access()
                    .approve(cloud, &r.user_id, &r.description, &r.scopes)
                    .await
                    .map(|grant| GrantResult {
                        grant: grant.to_bridge(),
                    })
            })
            .await
        }
        method::ContractorsRevoke::NAME => {
            answer::<method::ContractorsRevoke, _>(raw, |r| async move {
                access().revoke(cloud, &r.grant_id).await.map(|_| Done {})
            })
            .await
        }
        method::ContractorsDismiss::NAME => {
            answer::<method::ContractorsDismiss, _>(raw, |r| async move {
                access().dismiss(cloud, &r.user_id).await
            })
            .await
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(status: ContractorStatus) -> Value {
        serde_json::to_value(status).unwrap()
    }
    use crate::relay::cloud_session::CloudAccount;
    use std::collections::VecDeque;
    use std::time::Duration;

    type Answer = (Duration, Result<Value, CloudError>);
    type Handler = Box<dyn Fn(&str, &str, Option<&Value>) -> Answer + Send + Sync>;

    /// Cloud as a function of `(method, path, body)`, recording every request.
    struct FakeCloud {
        account: Mutex<Option<CloudAccount>>,
        handler: Mutex<Arc<Handler>>,
        /// Per-call answers for `access/me`, consumed before `handler`.
        me_script: Mutex<VecDeque<Answer>>,
        requests: Mutex<Vec<(String, String, Option<Value>)>>,
    }

    impl FakeCloud {
        fn new(workspace: &str) -> Arc<FakeCloud> {
            let cloud = Arc::new(FakeCloud {
                account: Mutex::new(None),
                handler: Mutex::new(Arc::new(Box::new(|_, _, _| {
                    (Duration::ZERO, Err(CloudError::Unreachable))
                }))),
                me_script: Mutex::default(),
                requests: Mutex::default(),
            });
            cloud.sign_in(workspace);
            cloud
        }

        fn sign_in(&self, workspace: &str) {
            *self.account.lock().unwrap() = Some(CloudAccount {
                site_url: "https://agentrelay.com".into(),
                workspace_id: workspace.into(),
                user_id: Some("me".into()),
            });
        }

        fn answer(
            &self,
            handler: impl Fn(&str, &str, Option<&Value>) -> Answer + Send + Sync + 'static,
        ) {
            *self.handler.lock().unwrap() = Arc::new(Box::new(handler));
        }

        /// `access/me` answers `me`; the owner routes answer from `seats`,
        /// `grants` and the service catalogue; proposals are unsupported;
        /// grants and revokes succeed.
        fn serve(&self, me: Value, seats: Value, grants: Value) {
            self.answer(move |method, path, body| {
                let ok = |v: Value| (Duration::ZERO, Ok(v));
                match (method, path.rsplit("/access/").next().unwrap_or(path)) {
                    ("GET", "/members") => ok(json!({ "members": seats })),
                    ("GET", "me") => ok(me.clone()),
                    ("GET", "services") => ok(json!({ "services": catalogue() })),
                    ("GET", "grants") => ok(json!({ "grants": grants })),
                    ("POST", "grants") => {
                        let body = body.unwrap();
                        let user = body["userId"].as_str().unwrap();
                        ok(
                            json!({"id": format!("new-{user}"), "userId": user, "displayName": null,
                            "description": body["description"], "scopes": body["scopes"],
                            "grantedBy": "Owner", "createdAt": null}),
                        )
                    }
                    ("DELETE", _) => ok(Value::Null),
                    _ => (Duration::ZERO, Err(http(404))),
                }
            });
        }

        fn requests(&self) -> Vec<(String, String, Option<Value>)> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl CloudAccess for FakeCloud {
        fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
            None
        }

        fn account(&self) -> Option<CloudAccount> {
            self.account.lock().unwrap().clone()
        }

        fn request(
            &self,
            method: &'static str,
            path: String,
            body: Option<Value>,
        ) -> BoxFuture<'_, Result<Value, CloudError>> {
            self.requests
                .lock()
                .unwrap()
                .push((method.into(), path.clone(), body.clone()));
            let scripted = if path.ends_with("/access/me") {
                self.me_script.lock().unwrap().pop_front()
            } else {
                None
            };
            let handler = self.handler.lock().unwrap().clone();
            let (delay, result) = scripted.unwrap_or_else(|| handler(method, &path, body.as_ref()));
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                result
            })
        }
    }

    fn http(code: u16) -> CloudError {
        CloudError::Status {
            status: code,
            message: Some("boom".into()),
        }
    }

    #[derive(Default)]
    struct Recording {
        events: Mutex<Vec<String>>,
        held: Mutex<Option<String>>,
        delays: Mutex<VecDeque<Duration>>,
        fails: std::sync::atomic::AtomicBool,
    }

    impl Recording {
        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }

        fn deprovisions(&self) -> usize {
            self.events().iter().filter(|e| *e == "deprovision").count()
        }
    }

    impl Provisioner for Recording {
        fn provision<'a>(&'a self, grant: &'a Grant) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                let delay = self.delays.lock().unwrap().pop_front().unwrap_or_default();
                tokio::time::sleep(delay).await;
                if self.fails.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("failed".into());
                }
                self.events
                    .lock()
                    .unwrap()
                    .push(format!("provision {}", grant.id));
                *self.held.lock().unwrap() = Some(grant.id.clone());
                Ok(())
            })
        }

        fn deprovision(&self) {
            self.events.lock().unwrap().push("deprovision".into());
            *self.held.lock().unwrap() = None;
        }
    }

    fn catalogue() -> Value {
        json!([
            {"id": "github", "name": "GitHub", "keywords": ["repo", "pull request"]},
            {"id": "linear", "name": "Linear", "keywords": ["tickets"]},
            {"id": "stripe", "name": "Stripe", "sensitivity": "high", "keywords": ["billing"]},
        ])
    }

    fn services() -> Vec<Service> {
        list(&catalogue(), Service::decode).ok().unwrap()
    }

    fn seat(id: &str, role: &str, joined: Option<&str>) -> Value {
        json!({"userId": id, "name": id.to_uppercase(), "email": format!("{id}@example.com"),
            "role": role, "joinedAt": joined})
    }

    fn grant(id: &str, user: &str, scopes: Value) -> Value {
        json!({"id": id, "userId": user, "displayName": user, "description": "work",
            "scopes": scopes, "grantedBy": "Owner", "createdAt": null})
    }

    fn owner() -> Value {
        json!({"role": "owner", "grant": null})
    }

    fn contractor(grant: Value) -> Value {
        json!({"role": "contractor", "grant": grant})
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        cloud: Arc<FakeCloud>,
        provider: Arc<Recording>,
        access: ContractorAccess,
    }

    fn fixture(environment: Option<&str>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let provider = Arc::new(Recording::default());
        let access = ContractorAccess::new(
            dir.path(),
            environment.map(str::to_string),
            provider.clone(),
        );
        Fixture {
            _dir: dir,
            cloud: FakeCloud::new("ws"),
            provider,
            access,
        }
    }

    fn on() -> Fixture {
        fixture(Some("1"))
    }

    // testFeatureFlagIsOffByDefaultAndEnvironmentWins
    #[test]
    fn a_grant_without_readable_scopes_is_unreadable() {
        let grant = |scopes: Value| {
            let mut value = json!({"id": "g1", "userId": "sam", "description": "d"});
            if !scopes.is_null() {
                value["scopes"] = scopes;
            }
            Grant::decode(&value)
        };
        assert!(grant(Value::Null).is_none());
        assert!(grant(json!("all")).is_none());
        assert!(grant(json!([{"nope": 1}])).is_none());
        assert_eq!(grant(json!([])).unwrap().scopes.len(), 0);
    }

    #[test]
    fn the_flag_is_off_by_default_and_the_environment_wins() {
        assert!(!enabled(None, false));
        assert!(enabled(None, true));
        assert!(!enabled(Some("0"), true));
        assert!(enabled(Some(" TRUE "), false));
        assert!(enabled(Some(""), true), "an empty variable is unset");

        let dir = tempfile::tempdir().unwrap();
        let setting = Setting::new(dir.path());
        assert_eq!(setting.get()[SETTING_KEY], json!(false));
        assert_eq!(setting.set("other", &json!(true)), None);
        assert!(setting.set(SETTING_KEY, &json!("yes")).unwrap().is_err());
        assert_eq!(setting.set(SETTING_KEY, &json!(true)), Some(Ok(())));
        assert_eq!(setting.get()[SETTING_KEY], json!(true));
        let access = ContractorAccess::new(dir.path(), None, Arc::new(PendingSeatTokens));
        assert!(access.enabled());
    }

    // testHeuristicWritesNamedServicesReadsTheRestAndNeverTouchesSensitive
    #[test]
    fn the_heuristic_writes_named_services_and_never_touches_sensitive_ones() {
        let proposal = heuristic(
            "Fixing the billing page; will open a pull request against our repo.",
            &services(),
        );
        assert_eq!(
            proposal.scopes,
            [
                Scope {
                    service: "github".into(),
                    access: Access::Write
                },
                Scope {
                    service: "linear".into(),
                    access: Access::Read
                },
                Scope {
                    service: "stripe".into(),
                    access: Access::None
                },
            ]
        );
        assert_eq!(proposal.source, ProposalSource::Heuristic);
    }

    // testHeuristicWithNothingNamedIsReadOnly
    #[test]
    fn the_heuristic_with_nothing_named_is_read_only() {
        let proposal = heuristic("General help around the codebase", &services());
        assert_eq!(
            proposal.scopes.iter().map(|s| s.access).collect::<Vec<_>>(),
            [Access::Read, Access::Read, Access::None]
        );
    }

    // testPendingSeatsExcludeOwnersGrantedDismissedAndSelfNewestFirst
    #[test]
    fn pending_seats_exclude_owners_granted_dismissed_and_self_newest_first() {
        let at = |s: u32| format!("2026-09-28T10:00:{s:02}.000Z");
        let members = people::decode_member_list(
            &json!({"members": [
                seat("owner", "Owner", Some(&at(1))), seat("old", "member", Some(&at(10))),
                seat("new", "member", Some(&at(20))), seat("granted", "member", Some(&at(30))),
                seat("hidden", "member", Some(&at(40))), seat("me", "member", Some(&at(50))),
                seat("undated", "member", None),
            ]}),
            Some("me"),
        );
        let grants = vec![Grant::decode(&grant("g", "granted", json!([]))).unwrap()];
        let dismissed: BTreeSet<String> = ["hidden".to_string()].into();
        let ids: Vec<&str> = pending(&members, &grants, &dismissed, Some("me"))
            .into_iter()
            .map(|m| m.user_id.as_str())
            .collect();
        assert_eq!(ids, ["new", "old", "undated"]);
    }

    // testDecodingFailsSafe
    #[test]
    fn decoding_fails_safe() {
        let me = json!({"role": "superuser", "grant": {"id": "g", "userId": "u", "displayName": null,
            "description": "d", "grantedBy": "Kay", "createdAt": "2026-09-28T10:00:00.000Z",
            "scopes": [{"service": "linear", "access": "read"}, {"service": "github", "access": "write"},
                       {"service": "x", "access": "none"}, {"service": "y", "access": "admin"}]}});
        assert_eq!(
            Role::decode(&me["role"]),
            Role::Contractor,
            "unknown roles get least privilege"
        );
        let grant = Grant::decode(&me["grant"]).unwrap();
        assert_eq!(
            serde_json::to_value(grant.to_bridge()).unwrap()["scopes"],
            json!([{"service": "github", "access": "write"}, {"service": "linear", "access": "read"}])
        );
        assert_eq!(grant.created_at_ms, Some(1_790_589_600_000));
        let service = Service::decode(&json!({"id": "fedex", "sensitivity": "extreme"})).unwrap();
        assert_eq!(
            service.sensitivity,
            Sensitivity::High,
            "unknown sensitivity is high"
        );
        assert_eq!(service.name, "fedex");
        assert_eq!(
            Service::decode(&json!({"id": "a"})).unwrap().sensitivity,
            Sensitivity::Standard
        );
    }

    // testRoutesMethodsAndAuth: the bearer, origin and redirect refusal are
    // CloudAccess's; this checks routes and bodies.
    #[tokio::test]
    async fn requests_name_the_workspace_scoped_routes() {
        let f = on();
        f.cloud.sign_in("ws/1");
        f.cloud
            .serve(owner(), json!([seat("u1", "member", None)]), json!([]));
        json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        let granted = f
            .access
            .approve(
                f.cloud.as_ref(),
                "u1",
                "Shipping the repo migration",
                &[
                    Scope {
                        service: "github".into(),
                        access: Access::Write,
                    },
                    Scope {
                        service: "linear".into(),
                        access: Access::None,
                    },
                ],
            )
            .await
            .unwrap();
        assert_eq!(granted.id, "new-u1");
        f.access.revoke(f.cloud.as_ref(), "g/1").await.unwrap();

        let mut paths: Vec<(String, String)> = f
            .cloud
            .requests()
            .into_iter()
            .map(|(m, p, _)| (m, p))
            .collect();
        paths[1..4].sort();
        assert_eq!(
            paths,
            [
                ("GET", "/workspaces/ws%2F1/access/me"),
                ("GET", "/members"),
                ("GET", "/workspaces/ws%2F1/access/grants"),
                ("GET", "/workspaces/ws%2F1/access/services"),
                ("POST", "/workspaces/ws%2F1/access/grants"),
                ("DELETE", "/workspaces/ws%2F1/access/grants/g%2F1"),
            ]
            .map(|(m, p)| (m.to_string(), p.to_string()))
        );
        let body = f.cloud.requests()[4].2.clone().unwrap();
        assert_eq!(
            body,
            json!({"userId": "u1", "description": "Shipping the repo migration",
                "scopes": [{"service": "github", "access": "write"}]})
        );
    }

    // testStatusMapping
    #[tokio::test]
    async fn cloud_statuses_map_to_unsupported_refused_or_cloud_failed() {
        for code in [404, 405, 501] {
            let f = on();
            f.cloud
                .answer(move |_, _, _| (Duration::ZERO, Err(http(code))));
            let status = json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
            assert_eq!(status["availability"], "unsupported", "status {code}");
        }
        let cases = [
            (
                http(403),
                ErrorKind::Refused,
                "Only a workspace owner can change access.",
            ),
            (http(500), ErrorKind::CloudFailed, "boom"),
            (
                CloudError::Rejected,
                ErrorKind::NotSignedIn,
                "Agent Relay needs you to sign in again.",
            ),
        ];
        for (error, kind, message) in cases {
            let f = on();
            f.cloud
                .answer(move |_, _, _| (Duration::ZERO, Err(error.clone())));
            let failed = f.access.refresh(f.cloud.as_ref()).await.unwrap_err();
            assert_eq!((failed.data.kind, failed.message.as_str()), (kind, message));
        }
        let f = on();
        f.cloud.answer(|_, _, _| {
            (
                Duration::ZERO,
                Ok(json!({"role": "owner", "grant": {"id": 1}})),
            )
        });
        assert_eq!(
            f.access
                .refresh(f.cloud.as_ref())
                .await
                .unwrap_err()
                .message,
            "Agent Relay Cloud returned an unreadable response."
        );
    }

    // testDormantWhenFlagOffOrCloudUnsupported
    #[tokio::test]
    async fn dormant_when_off_or_signed_out_and_unsupported_without_routes() {
        let off = fixture(None);
        off.cloud.serve(owner(), json!([]), json!([]));
        let status = json(off.access.adopt(off.cloud.as_ref()).await.unwrap());
        assert_eq!(status["availability"], "dormant");
        assert!(
            off.cloud.requests().is_empty(),
            "nothing asks Cloud while off"
        );

        let f = on();
        *f.cloud.account.lock().unwrap() = None;
        assert_eq!(
            json(f.access.refresh(f.cloud.as_ref()).await.unwrap())["availability"],
            "dormant"
        );
        assert_eq!(
            f.access
                .propose(f.cloud.as_ref(), "u", "Something long enough")
                .await
                .unwrap_err()
                .data
                .kind,
            ErrorKind::NotSignedIn
        );

        let f = on();
        assert_eq!(
            json(f.access.status(f.cloud.as_ref()))["availability"],
            "unloaded"
        );
        f.cloud.answer(|_, _, _| (Duration::ZERO, Err(http(404))));
        assert_eq!(
            json(f.access.adopt(f.cloud.as_ref()).await.unwrap())["availability"],
            "unsupported"
        );
        assert_eq!(
            f.access
                .propose(f.cloud.as_ref(), "u", "Something long enough")
                .await
                .unwrap_err()
                .message,
            "Agent Relay Cloud doesn't support team access for this workspace yet."
        );
    }

    // testOwnerOnboardsWithLocalProposalFallbackAndRevokes
    #[tokio::test]
    async fn an_owner_onboards_with_the_local_fallback_and_revokes() {
        let f = on();
        f.cloud.serve(
            owner(),
            json!([
                seat("sam", "member", Some("2026-09-28T10:00:00Z")),
                seat("kay", "owner", None)
            ]),
            json!([grant(
                "g0",
                "old",
                json!([{"service": "linear", "access": "read"}])
            )]),
        );
        let status = json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        assert_eq!(status["availability"], "ready");
        assert_eq!(status["role"], "owner");
        assert_eq!(status["pending_seats"][0]["user_id"], "sam");
        assert_eq!(status["pending_seats"].as_array().unwrap().len(), 1);
        assert_eq!(status["services"].as_array().unwrap().len(), 3);

        assert_eq!(
            f.access
                .propose(f.cloud.as_ref(), "sam", "short")
                .await
                .unwrap_err()
                .data
                .kind,
            ErrorKind::InvalidParams
        );
        let proposal = f
            .access
            .propose(f.cloud.as_ref(), "sam", "Shipping the repo migration")
            .await
            .unwrap();
        assert_eq!(proposal.source, ProposalSource::Heuristic);
        assert_eq!(
            proposal.scopes.iter().map(|s| s.access).collect::<Vec<_>>(),
            [Access::Write, Access::Read, Access::None]
        );

        let all_off: Vec<Scope> = proposal
            .scopes
            .iter()
            .map(|s| Scope {
                access: Access::None,
                ..s.clone()
            })
            .collect();
        assert_eq!(
            f.access
                .approve(
                    f.cloud.as_ref(),
                    "sam",
                    "Shipping the repo migration",
                    &all_off
                )
                .await
                .unwrap_err()
                .data
                .kind,
            ErrorKind::InvalidParams,
            "an all-off proposal grants nothing"
        );
        let mut scopes = proposal.scopes.clone();
        scopes[1].access = Access::None;
        let granted = f
            .access
            .approve(
                f.cloud.as_ref(),
                "sam",
                "Shipping the repo migration",
                &scopes,
            )
            .await
            .unwrap();
        assert_eq!(
            f.cloud.requests().last().unwrap().2.as_ref().unwrap()["scopes"],
            json!([{"service": "github", "access": "write"}])
        );
        let status = json(f.access.status(f.cloud.as_ref()));
        assert_eq!(status["grants"][0]["user_id"], "sam");
        assert!(status["pending_seats"].as_array().unwrap().is_empty());

        f.access
            .revoke(f.cloud.as_ref(), &granted.id)
            .await
            .unwrap();
        let status = json(f.access.status(f.cloud.as_ref()));
        assert_eq!(status["grants"].as_array().unwrap().len(), 1);
        assert_eq!(status["grants"][0]["id"], "g0");
    }

    // testCloudProposalIsNormalizedAgainstServiceCatalogue
    #[tokio::test]
    async fn a_cloud_proposal_is_normalized_against_the_catalogue() {
        let f = on();
        f.cloud
            .serve(owner(), json!([seat("sam", "member", None)]), json!([]));
        json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        let served = f.cloud.handler.lock().unwrap().clone();
        f.cloud.answer(move |method, path, body| {
            if path.ends_with("/proposals") {
                assert_eq!(body.unwrap()["userId"], "sam");
                return (Duration::ZERO, Ok(json!({"rationale": "from agent", "scopes": [
                    {"service": "linear", "access": "write"}, {"service": "notion", "access": "read"},
                    {"service": "linear", "access": "read"}]})));
            }
            served(method, path, body)
        });
        let proposal = f
            .access
            .propose(f.cloud.as_ref(), "sam", "Anything at all here")
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&proposal).unwrap(),
            json!({"source": "cloud", "rationale": "from agent", "scopes": [
                {"service": "github", "access": "none"}, {"service": "linear", "access": "write"},
                {"service": "stripe", "access": "none"}, {"service": "notion", "access": "read"}]})
        );
    }

    // testFailedRevokeKeepsGrantAndReports
    #[tokio::test]
    async fn a_failed_revoke_keeps_the_grant_and_reports() {
        let f = on();
        f.cloud
            .serve(owner(), json!([]), json!([grant("g0", "old", json!([]))]));
        json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        let served = f.cloud.handler.lock().unwrap().clone();
        f.cloud.answer(move |method, path, body| match method {
            "DELETE" => (Duration::ZERO, Err(http(500))),
            _ => served(method, path, body),
        });
        let error = f.access.revoke(f.cloud.as_ref(), "g0").await.unwrap_err();
        assert_eq!(error.message, "boom");
        assert_eq!(
            json(f.access.status(f.cloud.as_ref()))["grants"][0]["id"],
            "g0"
        );
        assert!(f.access.inner.lock().unwrap().revoking.is_empty());
    }

    // testContractorIsProvisionedAfterSignInAndDroppedOnRevokeAndSignOut
    #[tokio::test]
    async fn a_contractor_is_provisioned_on_adopt_and_dropped_on_revoke_and_reset() {
        let f = on();
        let g1 = grant(
            "g1",
            "me",
            json!([{"service": "github", "access": "write"}]),
        );
        f.cloud.serve(contractor(g1.clone()), json!([]), json!([]));
        let status = json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        assert_eq!(f.provider.events(), ["provision g1"]);
        assert_eq!(
            status["provisioning"],
            json!({"grant_id": "g1", "failed": false})
        );
        assert_eq!(status["role"], "contractor");
        assert_eq!(status["grant"]["id"], "g1");
        assert!(
            f.cloud
                .requests()
                .iter()
                .all(|(_, p, _)| p.ends_with("/me")),
            "no owner routes"
        );

        json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert_eq!(
            f.provider.events(),
            ["provision g1"],
            "an unchanged grant is not re-provisioned"
        );

        f.cloud.serve(contractor(Value::Null), json!([]), json!([]));
        let status = json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert_eq!(f.provider.deprovisions(), 1);
        assert_eq!(status["provisioning"]["grant_id"], Value::Null);

        f.cloud.serve(contractor(g1), json!([]), json!([]));
        json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        f.access.reset().await;
        assert_eq!(f.provider.deprovisions(), 2);
        assert_eq!(*f.provider.held.lock().unwrap(), None);
        assert_eq!(
            json(f.access.status(f.cloud.as_ref()))["availability"],
            "unloaded"
        );
    }

    // A member with a grant is provisioned too; an owner never is.
    #[tokio::test]
    async fn only_non_owners_with_an_effective_grant_are_provisioned() {
        let f = on();
        let none = grant("g1", "me", json!([{"service": "github", "access": "none"}]));
        f.cloud.serve(contractor(none), json!([]), json!([]));
        json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        let mine = grant("g2", "me", json!([{"service": "github", "access": "read"}]));
        f.cloud.serve(
            json!({"role": "owner", "grant": mine.clone()}),
            json!([]),
            json!([]),
        );
        json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert!(f.provider.events().is_empty());
        f.cloud.serve(
            json!({"role": "member", "grant": mine}),
            json!([]),
            json!([]),
        );
        json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert_eq!(f.provider.events(), ["provision g2"]);
    }

    // testDismissPersistsAndOnlyOwnersOnboard
    #[tokio::test]
    async fn dismissals_persist_and_only_owners_onboard() {
        let f = on();
        f.cloud
            .serve(owner(), json!([seat("sam", "member", None)]), json!([]));
        json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        let status = json(f.access.dismiss(f.cloud.as_ref(), "sam").await.unwrap());
        assert!(status["pending_seats"].as_array().unwrap().is_empty());
        let status = json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert!(
            status["pending_seats"].as_array().unwrap().is_empty(),
            "a dismissal survives refresh"
        );

        let member = on();
        member.cloud.serve(
            json!({"role": "member", "grant": null}),
            json!([]),
            json!([]),
        );
        json(member.access.adopt(member.cloud.as_ref()).await.unwrap());
        let refused = member
            .access
            .propose(member.cloud.as_ref(), "sam", "Anything at all here")
            .await
            .unwrap_err();
        assert_eq!(refused.data.kind, ErrorKind::Refused);
        assert!(!member
            .cloud
            .requests()
            .iter()
            .any(|(_, p, _)| p.ends_with("/proposals")));
    }

    // testDismissalsAreScopedToTheWorkspace
    #[tokio::test]
    async fn dismissals_are_scoped_to_the_workspace() {
        let f = on();
        f.cloud
            .serve(owner(), json!([seat("sam", "member", None)]), json!([]));
        f.cloud.sign_in("one");
        json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        json(f.access.dismiss(f.cloud.as_ref(), "sam").await.unwrap());

        f.cloud.sign_in("two");
        assert_eq!(
            json(f.access.status(f.cloud.as_ref()))["availability"],
            "unloaded"
        );
        let status = json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert_eq!(
            status["pending_seats"][0]["user_id"], "sam",
            "hidden in one workspace only"
        );

        f.cloud.sign_in("one");
        let status = json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert!(
            status["pending_seats"].as_array().unwrap().is_empty(),
            "remembered on return"
        );
    }

    // testRefreshFailureStaysVisibleWithReason
    #[tokio::test]
    async fn a_refresh_failure_is_kept_with_its_reason_until_one_succeeds() {
        let f = on();
        f.cloud.answer(|_, _, _| (Duration::ZERO, Err(http(500))));
        assert!(f.access.adopt(f.cloud.as_ref()).await.is_err());
        let status = json(f.access.status(f.cloud.as_ref()));
        assert_eq!(status["availability"], "failed");
        assert_eq!(status["failure"]["message"], "boom");

        f.cloud.serve(owner(), json!([]), json!([]));
        let status = json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert_eq!(status["availability"], "ready");
        assert_eq!(status["failure"], Value::Null);
    }

    // testProvisioningErrorSurvivesTheRefreshThatReportedIt
    #[tokio::test]
    async fn a_provisioning_failure_is_reported_and_retried_on_the_next_refresh() {
        let f = on();
        let g1 = grant(
            "g1",
            "me",
            json!([{"service": "github", "access": "write"}]),
        );
        f.cloud.serve(contractor(g1), json!([]), json!([]));
        f.provider
            .fails
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let status = json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        assert_eq!(status["availability"], "ready");
        assert_eq!(
            status["provisioning"],
            json!({"grant_id": null, "failed": true})
        );

        f.provider
            .fails
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let status = json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert_eq!(
            status["provisioning"],
            json!({"grant_id": "g1", "failed": false})
        );
    }

    // testFailedProvisionErrorClearsWhenGrantGoesAwayOrOnReset
    #[tokio::test]
    async fn a_provisioning_failure_clears_when_the_grant_goes_or_on_reset() {
        let f = on();
        let g1 = grant(
            "g1",
            "me",
            json!([{"service": "github", "access": "write"}]),
        );
        f.provider
            .fails
            .store(true, std::sync::atomic::Ordering::SeqCst);
        f.cloud.serve(contractor(g1.clone()), json!([]), json!([]));
        json(f.access.adopt(f.cloud.as_ref()).await.unwrap());

        f.cloud.serve(contractor(Value::Null), json!([]), json!([]));
        let status = json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert_eq!(
            status["provisioning"]["failed"], false,
            "no grant left, nothing failed"
        );

        f.cloud.serve(contractor(g1), json!([]), json!([]));
        let status = json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert_eq!(status["provisioning"]["failed"], true);
        f.access.reset().await;
        assert_eq!(
            json(f.access.status(f.cloud.as_ref()))["provisioning"]["failed"],
            false
        );
        assert_eq!(f.provider.deprovisions(), 0, "nothing was ever held");
    }

    // testSlowStaleProvisionCannotUndoANewerSession
    #[tokio::test]
    async fn a_slow_stale_provision_cannot_undo_a_newer_session() {
        let f = Arc::new(on());
        f.provider
            .delays
            .lock()
            .unwrap()
            .push_back(Duration::from_millis(200));
        let g1 = grant(
            "g1",
            "me",
            json!([{"service": "github", "access": "write"}]),
        );
        let g2 = grant("g2", "me", json!([{"service": "linear", "access": "read"}]));
        f.cloud.serve(contractor(g1), json!([]), json!([]));
        let slow = {
            let f = f.clone();
            tokio::spawn(async move { f.access.adopt(f.cloud.as_ref()).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        f.cloud.serve(contractor(g2), json!([]), json!([]));
        json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        slow.await.unwrap().unwrap();
        assert_eq!(
            f.provider.events(),
            ["provision g1", "deprovision", "provision g2"]
        );
        assert_eq!(f.provider.held.lock().unwrap().as_deref(), Some("g2"));
        assert_eq!(
            json(f.access.status(f.cloud.as_ref()))["provisioning"]["grant_id"],
            "g2"
        );
    }

    // testChangedGrantIsDeprovisionedBeforeTheNewOne
    #[tokio::test]
    async fn a_changed_grant_is_deprovisioned_before_the_new_one() {
        let f = on();
        for g in [
            grant(
                "g1",
                "me",
                json!([{"service": "github", "access": "write"}]),
            ),
            grant("g1", "me", json!([{"service": "github", "access": "read"}])),
            grant("g2", "me", json!([{"service": "linear", "access": "read"}])),
        ] {
            f.cloud.serve(contractor(g), json!([]), json!([]));
            json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        }
        assert_eq!(
            f.provider.events(),
            [
                "provision g1",
                "deprovision",
                "provision g1",
                "deprovision",
                "provision g2"
            ]
        );
    }

    // testOverlappingRefreshesKeepTheNewestResult
    #[tokio::test]
    async fn overlapping_refreshes_keep_the_newest_result() {
        let f = Arc::new(on());
        f.cloud.serve(owner(), json!([]), json!([]));
        json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        f.cloud.me_script.lock().unwrap().extend([
            (Duration::from_millis(200), Err(http(500))),
            (Duration::ZERO, Ok(owner())),
        ]);
        let slow = {
            let f = f.clone();
            tokio::spawn(async move { f.access.refresh(f.cloud.as_ref()).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        json(f.access.refresh(f.cloud.as_ref()).await.unwrap());
        assert!(
            slow.await.unwrap().is_err(),
            "the stale call still reports its own failure"
        );
        let status = json(f.access.status(f.cloud.as_ref()));
        assert_eq!(status["availability"], "ready");
        assert_eq!(status["failure"], Value::Null);
    }

    #[tokio::test]
    async fn a_revoke_already_running_is_busy() {
        let f = Arc::new(on());
        f.cloud
            .serve(owner(), json!([]), json!([grant("g0", "old", json!([]))]));
        json(f.access.adopt(f.cloud.as_ref()).await.unwrap());
        let served = f.cloud.handler.lock().unwrap().clone();
        f.cloud.answer(move |method, path, body| match method {
            "DELETE" => (Duration::from_millis(100), Ok(Value::Null)),
            _ => served(method, path, body),
        });
        let first = {
            let f = f.clone();
            tokio::spawn(async move { f.access.revoke(f.cloud.as_ref(), "g0").await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let second = f.access.revoke(f.cloud.as_ref(), "g0").await.unwrap_err();
        assert_eq!(second.data.kind, ErrorKind::Busy);
        first.await.unwrap().unwrap();
    }

    fn core_with(cloud: Arc<FakeCloud>, dir: &Path) -> Arc<Core> {
        use crate::relay::daemon::{Config, Plugins};
        use crate::relay::paths::CorePaths;
        let mut env = std::collections::BTreeMap::new();
        env.insert(ENVIRONMENT_KEY.to_string(), "1".to_string());
        let config = Config {
            paths: CorePaths::for_socket(dir.join("core.sock")).unwrap(),
            home: dir.to_path_buf(),
            app_data_dir: dir.join("app-data"),
            env,
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: Default::default(),
            delivery_timing: Default::default(),
        };
        let plugins = Plugins {
            cloud,
            ..Plugins::default()
        };
        Core::with_plugins(config, plugins).0
    }

    #[tokio::test]
    async fn bridge_methods_take_typed_params_and_keep_state_per_core() {
        let dir = tempfile::tempdir().unwrap();
        let cloud = FakeCloud::new("ws");
        cloud.serve(owner(), json!([seat("sam", "member", None)]), json!([]));
        let core = core_with(cloud.clone(), dir.path());

        assert!(call(&core, "contractors.nope", json!({})).await.is_none());
        let status = call(&core, "contractors.refresh", Value::Null)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status["pending_seats"][0]["user_id"], "sam");
        let status = call(&core, "contractors.status", Value::Null)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            status["availability"], "ready",
            "the cache outlives the call"
        );

        let bad = call(&core, "contractors.approve", json!({"user_id": "sam", "description": "x", "scopes": [{"service": "github", "access": "admin"}]}))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(bad.data.kind, ErrorKind::InvalidParams);
        let granted = call(&core, "contractors.approve", json!({"user_id": "sam",
            "description": "Shipping the repo migration", "scopes": [{"service": "github", "access": "write"}]}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(granted["grant"]["id"], "new-sam");
        let proposal = call(
            &core,
            "contractors.propose",
            json!({"user_id": "sam", "description": "Shipping the repo migration"}),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(proposal["source"], "heuristic");
        let revoked = call(&core, "contractors.revoke", json!({"grant_id": "new-sam"}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(revoked, json!({}));
        let dismissed = call(&core, "contractors.dismiss", json!({"user_id": "sam"}))
            .await
            .unwrap()
            .unwrap();
        assert!(dismissed["pending_seats"].as_array().unwrap().is_empty());
        assert!(dir.path().join("app-data").join(FILE).exists());

        reset(&core).await;
        let other = core_with(cloud, dir.path());
        assert_eq!(
            call(&other, "contractors.status", Value::Null)
                .await
                .unwrap()
                .unwrap()["availability"],
            "unloaded",
            "another core has its own cache"
        );
    }
}
