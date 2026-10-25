//! The bridge contract's single source of truth: every method with its
//! parameter and result types, and every event topic with its payload.
//!
//! The server answers a method only through [`answer`], typed by the
//! method's [`Method`] marker, so a handler cannot drift from what is
//! registered here. The Swift client's contract types are
//! generated from this registry (`relay-contract-codegen`, run by
//! `scripts/generate-contract.sh`); a Rust client (the Linux app) sends and
//! reads the registry's own types, through [`reader`] for what it reads.
//! Every type therefore serializes and deserializes. `docs/relay-core.md`'s
//! tables are checked against the registry.
//!
//! Types are named as clients see them, so a generated name never needs a
//! second spelling: no two contract types share a name.

pub mod account;
pub mod agents;
pub mod capy;
pub mod chat;
pub mod claude_delivery;
pub mod codegen;
pub mod connection;
pub mod contractors;
pub mod cursor_cloud;
pub mod directory;
pub mod incoming;
pub mod openclaw;
pub mod platform;
pub mod reader;
pub mod replicas;
pub mod spawn_control;
pub mod spawned;
pub mod transcript;

use crate::relay::protocol::{ErrorKind, RpcError, Topic};
use schemars::generate::SchemaGenerator;
use schemars::{JsonSchema, Schema};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;

/// One bridge method: its wire name and its parameter and result types.
pub trait Method {
    const NAME: &'static str;
    type Params: Serialize + DeserializeOwned + JsonSchema;
    type Result: Serialize + DeserializeOwned + JsonSchema;
}

/// Who answers a method.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    /// Every core.
    Always,
    /// Only a core built with an account (`relay serve`'s own plugins).
    Account,
}

/// A registered method, as the server's `hello` and the generator read it.
pub struct MethodSpec {
    pub name: &'static str,
    pub availability: Availability,
    pub params: fn(&mut SchemaGenerator) -> Schema,
    pub result: fn(&mut SchemaGenerator) -> Schema,
}

impl MethodSpec {
    const fn of<M: Method>(availability: Availability) -> MethodSpec {
        MethodSpec {
            name: M::NAME,
            availability,
            params: subschema::<M::Params>,
            result: subschema::<M::Result>,
        }
    }
}

fn subschema<T: JsonSchema>(generator: &mut SchemaGenerator) -> Schema {
    generator.subschema_for::<T>()
}

/// A method that takes no parameters: anything but an object is refused.
#[derive(Clone, Debug, Default, Deserialize, JsonSchema, Serialize)]
pub struct NoParams {}

/// A result that carries nothing beyond success.
#[derive(Clone, Debug, Default, PartialEq, Serialize, JsonSchema, Deserialize)]
pub struct Done {}

macro_rules! methods {
    ($($(#[$doc:meta])* $marker:ident = $name:literal, $availability:ident, $params:ty => $result:ty;)*) => {
        /// One marker per method; `<Marker>::NAME` is its wire name.
        pub mod method {
            use super::*;
            $(
                $(#[$doc])*
                pub struct $marker;
                impl $marker {
                    pub const NAME: &'static str = $name;
                }
                impl Method for $marker {
                    const NAME: &'static str = $name;
                    type Params = $params;
                    type Result = $result;
                }
            )*
        }

        /// Every method, in the order `hello` lists them.
        pub const METHODS: &[MethodSpec] = &[
            $(MethodSpec::of::<method::$marker>(Availability::$availability),)*
        ];
    };
}

use account::*;
use agents::*;
use capy::*;
use chat::*;
use claude_delivery::*;
use connection::*;
use contractors::*;
use cursor_cloud::*;
use directory::*;
use incoming::*;
use openclaw::*;
use platform::*;
use replicas::*;
use spawned::*;

methods! {
    // Core.
    Hello = "hello", Always, HelloParams => HelloResult;
    DiagnosticsRequests = "diagnostics.requests", Always, NoParams => crate::relay::request_log::RequestLog;
    StatusGet = "status.get", Always, NoParams => crate::relay::state::Status;
    Subscribe = "subscribe", Always, TopicsParams => Subscribed;
    Unsubscribe = "unsubscribe", Always, TopicsParams => Unsubscribed;
    WorkspaceRefresh = "workspace.refresh", Always, NoParams => crate::relay::state::WorkspaceStatus;
    WorkspaceVerify = "workspace.verify", Always, NoParams => crate::relay::state::WorkspaceStatus;
    DaemonShutdown = "daemon.shutdown", Always, NoParams => Stopping;

    // Workspace and account.
    AccountStatus = "account.status", Account, NoParams => SignInReport;
    AccountSignIn = "account.sign_in", Account, crate::relay::account::SignInRequest => SignInReport;
    AccountSelectWorkspace = "account.select_workspace", Account, ConnectWorkspaceParams => Done;
    AccountSignInCancel = "account.sign_in.cancel", Account, NoParams => Done;
    AccountSignOut = "account.sign_out", Account, NoParams => Done;
    AccountConnectWorkspace = "account.connect_workspace", Account, ConnectWorkspaceParams => crate::relay::state::WorkspaceStatus;

    // The uploader.
    UploaderStatus = "uploader.status", Account, NoParams => account::UploaderStatus;
    UploaderStart = "uploader.start", Account, NoParams => UploaderStarted;
    UploaderPause = "uploader.pause", Account, NoParams => UploaderPaused;
    UploaderResume = "uploader.resume", Account, NoParams => UploaderPaused;
    UploaderRetry = "uploader.retry", Account, NoParams => UploadsRetried;
    UploaderCompact = "uploader.compact", Account, NoParams => JournalCompacted;
    UploaderDisconnect = "uploader.disconnect", Account, NoParams => UploaderDisconnected;
    UploaderSharingSet = "uploader.sharing.set", Account, SharingParams => SharingChanged;
    UploaderSessionsList = "uploader.sessions.list", Account, LimitParams => UploadSessions;
    UploaderSessionsPreview = "uploader.sessions.preview", Account, PreviewParams => UploadPreview;
    UploaderSessionsInclude = "uploader.sessions.include", Account, SessionKeysParams => SessionsUpdated;
    UploaderSessionsReset = "uploader.sessions.reset", Account, ResetSessionsParams => SessionsReset;
    UploaderSessionsDelete = "uploader.sessions.delete", Account, SessionKeysParams => SessionsUpdated;
    UploaderSessionsExclude = "uploader.sessions.exclude", Account, SessionKeysParams => SessionsUpdated;

    // Agents on this computer.
    SessionsTranscript = "sessions.transcript", Account, transcript::LocalTranscriptParams => transcript::LocalTranscriptPage;
    SessionsList = "sessions.list", Always, NoParams => LocalSessions;
    SessionsTitleCapability = "sessions.title.capability", Always, SessionTitleIdentity => SessionTitleCapability;
    SessionsTitleSet = "sessions.title.set", Always, SessionTitleSetParams => SessionTitleUpdated;
    SessionsManagedLaunch = "sessions.managed.launch", Always, ManagedLaunchParams => ManagedSessionStarted;
    SessionsExistingRegister = "sessions.existing.register", Always, ExistingRegisterParams => ManagedSessionStarted;
    SpawnTargets = "spawn.targets", Always, NoParams => spawn_control::SpawnTargets;
    SpawnInvoke = "spawn.invoke", Always, spawn_control::SpawnInvokeParams => spawn_control::SpawnControlInvocation;
    SpawnInvocation = "spawn.status", Always, spawn_control::SpawnInvocationParams => spawn_control::SpawnControlInvocation;
    SpawnRelease = "spawn.release", Always, spawn_control::SpawnReleaseParams => spawn_control::SpawnControlInvocation;
    SpawnClaimRetry = "spawn.claim.retry", Always, NoParams => Done;
    AgentsList = "agents.list", Always, NoParams => Agents;
    AgentsRegister = "agents.register", Always, RegisterParams => crate::relay::agents::Registered;
    AgentsUnregister = "agents.unregister", Always, NameParams => Done;
    AgentsRename = "agents.rename", Always, RenameParams => Renamed;
    AgentsTestMessage = "agents.test_message", Always, TestMessageParams => TestMessageSent;
    AgentsReplySetting = "agents.reply_setting", Always, ReplySettingParams => Done;
    AgentsTranscript = "agents.transcript", Always, AgentTranscriptParams => transcript::LocalTranscriptPage;
    AgentsTakeOver = "agents.take_over", Always, TakeOverParams => TakenOver;
    AgentsWebhookCreate = "agents.webhook.create", Always, NameParams => CreatedWebhook;
    AgentsWebhookRevoke = "agents.webhook.revoke", Always, NameParams => RevokedWebhook;
    AgentsIntegrationsSubscribe = "agents.integrations.subscribe", Always, IntegrationParams => IntegrationChange;
    AgentsIntegrationsUnsubscribe = "agents.integrations.unsubscribe", Always, IntegrationParams => IntegrationChange;
    AgentsIntegrationsCleanUp = "agents.integrations.clean_up", Always, IntegrationParams => IntegrationChange;
    SettingsGet = "settings.get", Always, NoParams => SettingsValues;
    SettingsSet = "settings.set", Always, SettingsChange => SettingsValues;
    ActivityList = "activity.list", Always, LimitParams => ActivityLog;
    ClaudeDeliveryStatus = "claude_delivery.status", Always, NoParams => claude_delivery::ClaudeDeliveryStatus;
    ClaudeDeliveryRestrict = "claude_delivery.restrict", Always, ClaudeRestrictionParams => Done;
    ClaudeDeliverySession = "claude_delivery.session", Always, ClaudeSessionDeliveryParams => Done;
    ClaudeDeliverySender = "claude_delivery.sender", Always, ClaudeSenderDeliveryParams => Done;
    ClaudeDeliveryApprove = "claude_delivery.approve", Always, ClaudeHeldParams => ClaudeDeliveryChanged;
    ClaudeDeliveryDismiss = "claude_delivery.dismiss", Always, ClaudeHeldParams => ClaudeDeliveryChanged;
    OpenclawRelayToolsStatus = "openclaw.relay_tools.status", Always, NoParams => OpenClawToolsStatus;
    OpenclawRelayToolsConnect = "openclaw.relay_tools.connect", Always, NoParams => OpenClawToolsConnect;

    // The workspace directory and messaging.
    RosterList = "roster.list", Always, RosterParams => Roster;
    RosterGet = "roster.get", Always, RecipientParams => Recipient;
    FleetList = "fleet.list", Always, NoParams => crate::relay::fleet::FleetListing;
    FleetRelease = "fleet.release", Always, ReleaseParams => Done;
    CursorCloudModelsList = "cursor_cloud.models.list", Account, NoParams => CursorCloudModels;
    CursorCloudRepositoriesList = "cursor_cloud.repositories.list", Account, NoParams => CursorCloudRepositories;
    CursorCloudEnvironmentsList = "cursor_cloud.environments.list", Account, CursorCloudEnvironmentsListParams => CursorCloudEnvironments;
    CursorCloudAgentsList = "cursor_cloud.agents.list", Account, CursorCloudAgentsListParams => CursorCloudAgents;
    CursorCloudAgentsSpawn = "cursor_cloud.agents.spawn", Account, CursorCloudAgentSpawnParams => CursorCloudAgent;
    CursorCloudAgentsGet = "cursor_cloud.agents.get", Account, CursorCloudAgentParams => CursorCloudAgent;
    CursorCloudRunsCreate = "cursor_cloud.runs.create", Account, CursorCloudRunCreateParams => CursorCloudRun;
    CursorCloudRunsList = "cursor_cloud.runs.list", Account, CursorCloudRunsListParams => CursorCloudRuns;
    CursorCloudRunsGet = "cursor_cloud.runs.get", Account, CursorCloudRunParams => CursorCloudRun;
    CursorCloudRunsCancel = "cursor_cloud.runs.cancel", Account, CursorCloudRunParams => CursorCloudRun;
    CursorCloudAgentsArchive = "cursor_cloud.agents.archive", Account, CursorCloudAgentParams => CursorCloudLifecycle;
    CursorCloudAgentsUnarchive = "cursor_cloud.agents.unarchive", Account, CursorCloudAgentParams => CursorCloudLifecycle;
    ReplicasEnvironmentsList = "replicas.environments.list", Account, NoParams => ReplicasEnvironments;
    ReplicasSpawn = "replicas.spawn", Account, ReplicasSpawnParams => crate::relay::contract::replicas::ReplicasSpawn;
    ReplicasSpawnGet = "replicas.spawn.get", Account, ReplicasSpawnGetParams => crate::relay::contract::replicas::ReplicasSpawn;
    ReplicasRelease = "replicas.release", Account, ReplicasSpawnGetParams => ReplicasReleased;
    CapyProjectsList = "capy.projects.list", Account, CapyProjectsParams => CapyProjects;
    CapyThreadsSpawn = "capy.threads.spawn", Account, CapyThreadSpawnParams => CapyThreadSpawn;
    CapyThreadsGet = "capy.threads.get", Account, CapyThreadSpawnGetParams => CapyThreadSpawn;
    MessagesConversations = "messages.conversations", Always, NoParams => Conversations;
    MessagesHistory = "messages.history", Always, HistoryParams => History;
    MessagesSend = "messages.send", Always, SendParams => SentMessage;
    SessionsOverviewGet = "sessions.overview.get", Account, SessionOverviewParams => serde_json::Value;
    SessionsOverviewRequest = "sessions.overview.request", Account, SessionOverviewParams => serde_json::Value;
    SessionsOverviewEvents = "sessions.overview.events", Account, SessionOverviewParams => serde_json::Value;
    PeopleList = "people.list", Always, NoParams => People;

    // Platform services.
    LinksParse = "links.parse", Always, LinkParams => crate::relay::links::DeepLink;
    TelemetryRecord = "telemetry.record", Account, crate::relay::telemetry::TelemetryEvent => Done;
    LoginItemSet = "login_item.set", Always, LoginItemParams => Done;
    LoginItemStatus = "login_item.status", Always, NoParams => LoginItemState;

    // Incoming messages.
    IncomingStatus = "incoming.status", Account, NoParams => incoming::IncomingStatus;
    IncomingShare = "incoming.share", Account, ShareParams => Done;
    IncomingApprove = "incoming.approve", Account, HeldMessageParams => Approved;
    IncomingReject = "incoming.reject", Account, HeldMessageParams => Rejected;

    // Skip chat.
    ChatConversation = "chat.conversation", Always, NoParams => chat::ChatConversation;
    ChatSend = "chat.send", Always, ChatSendParams => ChatAnswer;
    ChatClear = "chat.clear", Always, NoParams => chat::ChatConversation;
    ChatAct = "chat.act", Always, ActParams => ActResult;
    ChatHistory = "chat.history", Always, ChatHistoryParams => HistoryPage;
    ChatProjects = "chat.projects", Always, NoParams => ProjectsState;
    ChatProjectsRefresh = "chat.projects.refresh", Always, NoParams => ProjectsState;
    ChatPush = "chat.push", Always, PushParams => PushResult;

    // Contractor access.
    ContractorsStatus = "contractors.status", Always, NoParams => ContractorStatus;
    ContractorsRefresh = "contractors.refresh", Always, NoParams => ContractorStatus;
    ContractorsPropose = "contractors.propose", Always, ProposeParams => crate::relay::contractor_access::Proposal;
    ContractorsApprove = "contractors.approve", Always, ApproveParams => GrantResult;
    ContractorsRevoke = "contractors.revoke", Always, RevokeParams => Done;
    ContractorsDismiss = "contractors.dismiss", Always, DismissParams => ContractorStatus;
}

/// Methods a connection answers about itself (its handshake, its topics,
/// and retiring a daemon of another version); clients send them on one
/// connection, never through a pool.
pub const CONNECTION_METHODS: &[&str] = &[
    method::Hello::NAME,
    method::Subscribe::NAME,
    method::Unsubscribe::NAME,
    method::DaemonShutdown::NAME,
];

/// One event topic's payload type.
pub trait EventData: Serialize + DeserializeOwned {
    const TOPIC: Topic;
}

/// A registered topic, as the generator reads it.
pub struct EventSpec {
    pub topic: Topic,
    pub data: fn(&mut SchemaGenerator) -> Schema,
}

macro_rules! events {
    ($($topic:ident => $data:ty;)*) => {
        $(impl EventData for $data {
            const TOPIC: Topic = Topic::$topic;
        })*

        /// Every topic with its payload.
        pub const EVENTS: &[EventSpec] = &[
            $(EventSpec { topic: Topic::$topic, data: subschema::<$data> },)*
        ];
    };
}

events! {
    Status => crate::relay::state::Status;
    Activity => ActivityLine;
    Shutdown => ShutdownNotice;
    Invalidated => Invalidation;
    Notify => CoreNotification;
    SignIn => SignInReport;
}

/// `method`'s parameters, `null` read as `{}`.
pub fn params<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params)
        .map_err(|_| RpcError::invalid_params("The parameters do not match this method."))
}

/// Answers method `M`: reads its parameters, runs `handler`, and returns
/// its typed result as JSON. Parameters are read before anything runs.
pub async fn answer<M: Method, F>(
    raw: Value,
    handler: impl FnOnce(M::Params) -> F,
) -> Result<Value, RpcError>
where
    F: Future<Output = Result<M::Result, RpcError>>,
{
    let request = params::<M::Params>(raw)?;
    let result = handler(request).await?;
    serde_json::to_value(result)
        .map_err(|_| RpcError::new(ErrorKind::Internal, "The answer could not be written."))
}

/// The names `hello` lists for a core built with (or without) an account.
pub fn method_names(with_account: bool) -> Vec<&'static str> {
    METHODS
        .iter()
        .filter(|spec| with_account || spec.availability == Availability::Always)
        .map(|spec| spec.name)
        .collect()
}

/// Every topic a client can subscribe to.
pub fn topics() -> Vec<Topic> {
    EVENTS.iter().map(|spec| spec.topic).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn document() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/relay-core.md");
        std::fs::read_to_string(path).unwrap()
    }

    /// The lines of the section that starts with `heading`, up to the next
    /// heading of the same or a higher level.
    fn section<'a>(document: &'a str, heading: &str) -> Vec<&'a str> {
        let level = heading.chars().take_while(|c| *c == '#').count();
        document
            .lines()
            .skip_while(|line| *line != heading)
            .skip(1)
            .take_while(|line| {
                let hashes = line.chars().take_while(|c| *c == '#').count();
                hashes == 0 || hashes > level || !line[hashes..].starts_with(' ')
            })
            .collect()
    }

    /// Each table row's cells, without the header and the rule.
    fn rows<'a>(lines: &[&'a str]) -> Vec<Vec<&'a str>> {
        lines
            .iter()
            .filter(|line| line.starts_with("| `"))
            .map(|line| line.trim_matches('|').split(" | ").map(str::trim).collect())
            .collect()
    }

    /// The names a table cell lists: "`a.b` / `.c` (Linux)" is `a.b`, `a.c`.
    fn names(cell: &str) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for part in cell.split(" / ") {
            let name = part.split('`').nth(1).unwrap_or_default();
            match (name.strip_prefix('.'), names.last()) {
                (Some(suffix), Some(previous)) => {
                    let parent = previous.rsplit_once('.').map_or("", |(parent, _)| parent);
                    names.push(format!("{parent}.{suffix}"));
                }
                _ => names.push(name.to_string()),
            }
        }
        names
    }

    fn wire<T: Serialize>(value: T) -> String {
        serde_json::to_value(value)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn the_method_tables_list_exactly_the_registry() {
        let document = document();
        let documented: BTreeSet<String> = rows(&section(&document, "### Methods"))
            .iter()
            .flat_map(|row| names(row[0]))
            .collect();
        let registered: BTreeSet<String> = METHODS.iter().map(|m| m.name.to_string()).collect();
        assert_eq!(documented, registered);
        assert_eq!(
            registered.len(),
            METHODS.len(),
            "a method is registered twice"
        );
    }

    #[test]
    fn the_error_table_matches_every_kind() {
        let document = document();
        let documented: Vec<(String, i64, bool)> = rows(&section(&document, "### Errors"))
            .iter()
            .map(|row| {
                (
                    names(row[0]).remove(0),
                    row[1].parse().unwrap(),
                    row[2] == "yes",
                )
            })
            .collect();
        let schema = schemars::schema_for!(ErrorKind);
        let mut kinds: Vec<String> = Vec::new();
        for variant in schema
            .get("oneOf")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            kinds.extend(
                variant
                    .get("const")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            );
            kinds.extend(
                variant
                    .get("enum")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string),
            );
        }
        assert_eq!(
            documented.iter().map(|d| &d.0).collect::<BTreeSet<_>>(),
            kinds.iter().collect::<BTreeSet<_>>()
        );
        for (name, code, retryable) in documented {
            let kind: ErrorKind = serde_json::from_value(json!(name)).unwrap();
            assert_eq!((kind.code(), kind.retryable()), (code, retryable), "{name}");
        }
    }

    #[test]
    fn the_topic_table_lists_every_topic() {
        let document = document();
        let documented: BTreeSet<String> = rows(&section(&document, "### State and events"))
            .iter()
            .flat_map(|row| names(row[0]))
            .collect();
        let registered: BTreeSet<String> = topics().into_iter().map(wire).collect();
        assert_eq!(documented, registered);
    }

    /// Every object's required fields, by definition name and position.
    fn required(generator: &SchemaGenerator) -> BTreeSet<(String, String)> {
        fn walk(path: &str, schema: &Value, out: &mut BTreeSet<(String, String)>) {
            for field in schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                out.insert((path.to_string(), field.to_string()));
            }
            for (index, variant) in schema
                .get("oneOf")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                walk(&format!("{path}/{index}"), variant, out);
            }
        }
        let mut out = BTreeSet::new();
        for (name, schema) in generator.definitions() {
            walk(name, schema, &mut out);
        }
        out
    }

    fn generator(serialize: bool) -> SchemaGenerator {
        let settings = schemars::generate::SchemaSettings::draft2020_12();
        if serialize {
            settings.for_serialize().into_generator()
        } else {
            settings.for_deserialize().into_generator()
        }
    }

    /// Results and events are written by the core and read by clients,
    /// parameters the other way; whatever the reading side demands, the
    /// writing side always writes.
    #[test]
    fn every_type_reads_what_its_writer_always_writes() {
        let (mut written, mut read) = (generator(true), generator(false));
        let (mut sent, mut received) = (generator(true), generator(false));
        for spec in METHODS {
            (spec.result)(&mut written);
            (spec.result)(&mut read);
            (spec.params)(&mut sent);
            (spec.params)(&mut received);
        }
        for spec in EVENTS {
            (spec.data)(&mut written);
            (spec.data)(&mut read);
        }
        for (writer, reader) in [(&written, &read), (&sent, &received)] {
            // A type read through another (`serde(from)`) has reader-only
            // definitions; its own definition is compared.
            let writes = required(writer);
            let missing: Vec<_> = required(reader)
                .into_iter()
                .filter(|(path, _)| {
                    let name = path.split('/').next().unwrap_or_default();
                    writer.definitions().contains_key(name)
                })
                .filter(|entry| !writes.contains(entry))
                .collect();
            assert!(
                missing.is_empty(),
                "read as required but not always written: {missing:?}"
            );
        }
    }

    #[test]
    fn names_in_cells_expand_shorthand() {
        assert_eq!(
            names("`agents.integrations.unsubscribe` / `.clean_up`"),
            [
                "agents.integrations.unsubscribe",
                "agents.integrations.clean_up"
            ]
        );
        assert_eq!(names("`login_item.set` (Linux)"), ["login_item.set"]);
        assert_eq!(
            names("`uploader.start` / `uploader.pause`"),
            ["uploader.start", "uploader.pause"]
        );
    }
}
