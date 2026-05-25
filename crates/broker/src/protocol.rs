use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::supervisor::RestartPolicy;

pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntime {
    Pty,
    Headless,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeadlessProvider {
    Claude,
    Opencode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PtyHarnessDeliveryMode {
    PtyInjection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PtyHarnessDeliveryFormat {
    RelayBlock,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyHarnessDelivery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<PtyHarnessDeliveryMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<PtyHarnessDeliveryFormat>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyHarnessConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<PtyHarnessDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppServerAuthType {
    Bearer,
    Basic,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppServerHarnessAuth {
    #[serde(rename = "type")]
    pub auth_type: AppServerAuthType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AppServerHostOwnership {
    BrokerOwned,
    Attached,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppServerHarnessHost {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ownership: Option<AppServerHostOwnership>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum HarnessReleasePolicy {
    Abort,
    #[default]
    Detach,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeadlessHarnessDriver {
    AppServer,
}

fn default_headless_harness_driver() -> HeadlessHarnessDriver {
    HeadlessHarnessDriver::AppServer
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadlessHarnessConfig {
    #[serde(default = "default_headless_harness_driver")]
    pub driver: HeadlessHarnessDriver,
    pub protocol: String,
    pub endpoint: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<AppServerHarnessAuth>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<AppServerHarnessHost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<HarnessReleasePolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "runtime", rename_all = "snake_case")]
pub enum ResolvedHarnessConfig {
    Pty(PtyHarnessConfig),
    Headless(HeadlessHarnessConfig),
}

impl<'de> Deserialize<'de> for ResolvedHarnessConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut value = Value::deserialize(deserializer)?;
        let runtime = value
            .get("runtime")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| serde::de::Error::missing_field("runtime"))?;

        match runtime.as_str() {
            "pty" => serde_json::from_value(value)
                .map(Self::Pty)
                .map_err(serde::de::Error::custom),
            "headless" => serde_json::from_value(value)
                .map(Self::Headless)
                .map_err(serde::de::Error::custom),
            "app_server" => {
                if let Some(object) = value.as_object_mut() {
                    object.insert(
                        "driver".to_string(),
                        Value::String("app_server".to_string()),
                    );
                }
                serde_json::from_value(value)
                    .map(Self::Headless)
                    .map_err(serde::de::Error::custom)
            }
            other => Err(serde::de::Error::unknown_variant(
                other,
                &["pty", "headless", "app_server"],
            )),
        }
    }
}

impl ResolvedHarnessConfig {
    pub(crate) fn runtime(&self) -> AgentRuntime {
        match self {
            Self::Pty(_) => AgentRuntime::Pty,
            Self::Headless(_) => AgentRuntime::Headless,
        }
    }

    pub(crate) fn session_id(&self) -> Option<&str> {
        match self {
            Self::Pty(config) => config.session_id.as_deref(),
            Self::Headless(config) => Some(config.session_id.as_str()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSpec {
    pub name: String,
    pub runtime: AgentRuntime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<HeadlessProvider>,
    #[serde(default)]
    pub cli: Option<String>,
    #[serde(default, alias = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(
        default,
        rename = "harnessConfig",
        alias = "harness_config",
        alias = "harnessPlan",
        alias = "harness_plan",
        skip_serializing_if = "Option::is_none"
    )]
    pub harness_config: Option<ResolvedHarnessConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shadow_mode: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_policy: Option<RestartPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MessageInjectionMode {
    #[default]
    Wait,
    Steer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayDelivery {
    pub delivery_id: String,
    pub event_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_alias: Option<String>,
    pub from: String,
    pub target: String,
    pub body: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub injection_mode: MessageInjectionMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProtocolEnvelope<T> {
    pub v: u32,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default)]
    pub request_id: Option<String>,
    pub payload: T,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum SdkToBroker {
    Hello {
        client_name: String,
        client_version: String,
    },
    SpawnAgent {
        agent: Box<AgentSpec>,
    },
    SendMessage {
        to: String,
        text: String,
        #[serde(default)]
        from: Option<String>,
        #[serde(default)]
        thread_id: Option<String>,
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        workspace_alias: Option<String>,
        #[serde(default)]
        priority: Option<u8>,
        #[serde(default)]
        mode: MessageInjectionMode,
    },
    ReleaseAgent {
        name: String,
    },
    SubscribeChannels {
        name: String,
        channels: Vec<String>,
    },
    UnsubscribeChannels {
        name: String,
        channels: Vec<String>,
    },
    ListAgents {},
    Shutdown {},
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum BrokerToSdk {
    HelloAck {
        broker_version: String,
        protocol_version: u32,
    },
    Ok {
        result: Value,
    },
    Error(ProtocolError),
    Event(BrokerEvent),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BrokerEvent {
    AgentSpawned {
        name: String,
        runtime: AgentRuntime,
        #[serde(default)]
        provider: Option<HeadlessProvider>,
        parent: Option<String>,
        cli: Option<String>,
        model: Option<String>,
        pid: Option<u32>,
        #[serde(default)]
        session_id: Option<String>,
        source: Option<String>,
    },
    AgentReleased {
        name: String,
    },
    AgentExit {
        name: String,
        reason: String,
    },
    AgentExited {
        name: String,
        code: Option<i32>,
        signal: Option<String>,
        #[serde(default)]
        reason: Option<String>,
    },
    AgentContextLow {
        name: String,
        pct: u8,
    },
    RelayInbound {
        event_id: String,
        from: String,
        target: String,
        body: String,
        thread_id: Option<String>,
    },
    WorkerStream {
        name: String,
        stream: String,
        chunk: String,
    },
    DeliveryRetry {
        name: String,
        delivery_id: String,
        event_id: String,
        attempts: u32,
    },
    DeliveryDropped {
        name: String,
        count: usize,
        reason: String,
    },
    DeliveryVerified {
        name: String,
        delivery_id: String,
        event_id: String,
    },
    DeliveryFailed {
        name: String,
        delivery_id: String,
        event_id: String,
        reason: String,
    },
    MessageDeliveryConfirmed {
        name: String,
        delivery_id: String,
        event_id: String,
        from: String,
        to: String,
    },
    MessageDeliveryFailed {
        name: String,
        #[serde(default)]
        delivery_id: Option<String>,
        #[serde(default)]
        event_id: Option<String>,
        from: String,
        to: String,
        attempts: u32,
        #[serde(rename = "lastError")]
        last_error: String,
    },
    DeliveryQueued {
        delivery_id: String,
        agent: String,
    },
    DeliveryInjected {
        delivery_id: String,
        agent: String,
    },
    DeliveryActive {
        delivery_id: String,
        agent: String,
    },
    DeliveryAck {
        delivery_id: String,
        agent: String,
    },
    AclDenied {
        name: String,
        sender: String,
        owner_chain: Vec<String>,
    },
    RelaycastPublished {
        event_id: String,
        to: String,
        target_type: String,
    },
    RelaycastPublishFailed {
        event_id: String,
        to: String,
        reason: String,
    },
    AgentIdle {
        name: String,
        idle_secs: u64,
        #[serde(default)]
        since: Option<String>,
    },
    AgentResult {
        name: String,
        result_id: String,
        data: Value,
        #[serde(rename = "final")]
        final_result: bool,
        #[serde(default)]
        metadata: Option<Value>,
    },
    AgentBlockedOnSend {
        name: String,
        blocked_secs: u64,
        pending_delivery_count: usize,
    },
    AgentRestarting {
        name: String,
        #[serde(rename = "code")]
        exit_code: Option<i32>,
        signal: Option<String>,
        restart_count: u32,
        delay_ms: u64,
    },
    AgentRestarted {
        name: String,
        restart_count: u32,
    },
    AgentPermanentlyDead {
        name: String,
        reason: String,
    },
    ChannelSubscribed {
        name: String,
        channels: Vec<String>,
    },
    ChannelUnsubscribed {
        name: String,
        channels: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum BrokerToWorker {
    InitWorker {
        agent: Box<AgentSpec>,
    },
    DeliverRelay(RelayDelivery),
    ShutdownWorker {
        reason: String,
        #[serde(default)]
        grace_ms: Option<u64>,
    },
    Ping {
        ts_ms: u64,
    },
    ResizePty {
        rows: u16,
        cols: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum WorkerToBroker {
    WorkerReady {
        name: String,
        runtime: AgentRuntime,
    },
    DeliveryAck {
        delivery_id: String,
        event_id: String,
    },
    DeliveryVerified {
        delivery_id: String,
        event_id: String,
    },
    DeliveryFailed {
        delivery_id: String,
        event_id: String,
        reason: String,
    },
    WorkerStream {
        stream: String,
        chunk: String,
    },
    WorkerError(ProtocolError),
    WorkerExited {
        code: Option<i32>,
        signal: Option<String>,
    },
    Pong {
        ts_ms: u64,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{
        AgentRuntime, AgentSpec, BrokerEvent, BrokerToSdk, BrokerToWorker, HeadlessHarnessDriver,
        HeadlessProvider, MessageInjectionMode, ProtocolEnvelope, RelayDelivery,
        ResolvedHarnessConfig, WorkerToBroker, PROTOCOL_VERSION,
    };

    #[test]
    fn sdk_envelope_round_trip() {
        let frame = ProtocolEnvelope {
            v: PROTOCOL_VERSION,
            msg_type: "spawn_agent".to_string(),
            request_id: Some("req_1".to_string()),
            payload: json!({
                "agent": {
                    "name": "Worker1",
                    "runtime": "pty",
                    "cli": "codex",
                    "args": ["--model", "gpt-5"],
                    "channels": ["general"]
                }
            }),
        };

        let encoded = serde_json::to_string(&frame).unwrap();
        let decoded: ProtocolEnvelope<Value> = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.v, PROTOCOL_VERSION);
        assert_eq!(decoded.msg_type, "spawn_agent");
        assert_eq!(decoded.request_id.as_deref(), Some("req_1"));
    }

    #[test]
    fn broker_to_worker_delivery_round_trip() {
        let msg = BrokerToWorker::DeliverRelay(RelayDelivery {
            delivery_id: "del_1".into(),
            event_id: "evt_1".into(),
            workspace_id: Some("ws_test".into()),
            workspace_alias: Some("test".into()),
            from: "Lead".into(),
            target: "#general".into(),
            body: "hello".into(),
            thread_id: Some("thr_1".into()),
            priority: Some(2),
            injection_mode: MessageInjectionMode::Wait,
        });

        let encoded = serde_json::to_string(&msg).unwrap();
        let decoded: BrokerToWorker = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn relay_delivery_defaults_injection_mode_to_wait_when_omitted() {
        let payload = json!({
            "delivery_id": "del_1",
            "event_id": "evt_1",
            "workspace_id": "ws_test",
            "workspace_alias": "test",
            "from": "Lead",
            "target": "#general",
            "body": "hello",
            "thread_id": "thr_1",
            "priority": 2
        });

        let decoded: RelayDelivery = serde_json::from_value(payload).unwrap();
        assert!(matches!(decoded.injection_mode, MessageInjectionMode::Wait));
    }

    #[test]
    fn worker_to_broker_ack_round_trip() {
        let msg = WorkerToBroker::DeliveryAck {
            delivery_id: "del_9".into(),
            event_id: "evt_9".into(),
        };
        let encoded = serde_json::to_string(&msg).unwrap();
        let decoded: WorkerToBroker = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn broker_event_round_trip() {
        let event = BrokerToSdk::Event(BrokerEvent::AgentSpawned {
            name: "Worker2".into(),
            runtime: AgentRuntime::Headless,
            provider: Some(HeadlessProvider::Claude),
            parent: Some("Lead".into()),
            cli: None,
            model: None,
            pid: None,
            session_id: None,
            source: None,
        });
        let encoded = serde_json::to_string(&event).unwrap();
        let decoded: BrokerToSdk = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, event);
    }

    #[test]
    fn worker_to_broker_delivery_verified_round_trip() {
        let msg = WorkerToBroker::DeliveryVerified {
            delivery_id: "del_v1".into(),
            event_id: "evt_v1".into(),
        };
        let encoded = serde_json::to_string(&msg).unwrap();
        let decoded: WorkerToBroker = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn worker_to_broker_delivery_failed_round_trip() {
        let msg = WorkerToBroker::DeliveryFailed {
            delivery_id: "del_f1".into(),
            event_id: "evt_f1".into(),
            reason: "echo timeout after 3 attempts".into(),
        };
        let encoded = serde_json::to_string(&msg).unwrap();
        let decoded: WorkerToBroker = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn broker_event_delivery_verified_round_trip() {
        let event = BrokerToSdk::Event(BrokerEvent::DeliveryVerified {
            name: "Worker1".into(),
            delivery_id: "del_v2".into(),
            event_id: "evt_v2".into(),
        });
        let encoded = serde_json::to_string(&event).unwrap();
        let decoded: BrokerToSdk = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, event);
    }

    #[test]
    fn agent_result_event_round_trip_with_metadata() {
        let event = BrokerToSdk::Event(BrokerEvent::AgentResult {
            name: "Worker1".into(),
            result_id: "res_42".into(),
            data: json!({"answer": 42}),
            final_result: true,
            metadata: Some(json!({"latency_ms": 123})),
        });
        let encoded = serde_json::to_string(&event).unwrap();
        // The `final_result` field MUST serialize as `final` per the SDK wire contract.
        assert!(encoded.contains("\"final\":true"));
        let decoded: BrokerToSdk = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, event);
    }

    #[test]
    fn agent_result_event_round_trip_without_metadata() {
        let event = BrokerToSdk::Event(BrokerEvent::AgentResult {
            name: "Worker2".into(),
            result_id: "res_7".into(),
            data: json!("partial"),
            final_result: false,
            metadata: None,
        });
        let encoded = serde_json::to_string(&event).unwrap();
        let decoded: BrokerToSdk = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, event);
    }

    #[test]
    fn broker_event_delivery_failed_round_trip() {
        let event = BrokerToSdk::Event(BrokerEvent::DeliveryFailed {
            name: "Worker1".into(),
            delivery_id: "del_f2".into(),
            event_id: "evt_f2".into(),
            reason: "max retries exceeded".into(),
        });
        let encoded = serde_json::to_string(&event).unwrap();
        let decoded: BrokerToSdk = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, event);
    }

    #[test]
    fn agent_spec_defaults_optional_fields() {
        let raw = r#"{"name":"Worker3","runtime":"pty"}"#;
        let spec: AgentSpec = serde_json::from_str(raw).unwrap();
        assert_eq!(spec.name, "Worker3");
        assert_eq!(spec.runtime, AgentRuntime::Pty);
        assert_eq!(spec.provider, None);
        assert_eq!(spec.cli, None);
        assert_eq!(spec.session_id, None);
        assert_eq!(spec.harness_config, None);
        assert_eq!(spec.model, None);
        assert_eq!(spec.cwd, None);
        assert_eq!(spec.team, None);
        assert_eq!(spec.shadow_of, None);
        assert_eq!(spec.shadow_mode, None);
        assert!(spec.args.is_empty());
        assert!(spec.channels.is_empty());
    }

    #[test]
    fn agent_spec_headless_provider_round_trip() {
        let raw = r#"{"name":"Worker4","runtime":"headless","provider":"opencode"}"#;
        let spec: AgentSpec = serde_json::from_str(raw).unwrap();
        assert_eq!(spec.runtime, AgentRuntime::Headless);
        assert_eq!(spec.provider, Some(HeadlessProvider::Opencode));

        let encoded = serde_json::to_string(&spec).unwrap();
        let decoded: AgentSpec = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.provider, Some(HeadlessProvider::Opencode));
    }

    #[test]
    fn agent_spec_accepts_camel_case_harness_config() {
        let raw = r#"{
          "name": "QwenWorker",
          "runtime": "pty",
          "cli": "qwen",
          "sessionId": "native-session",
          "harnessConfig": {
            "runtime": "pty",
            "command": "qwen",
            "args": ["run", "-m", "qwen3-coder"],
            "cwd": "/tmp/project",
            "env": { "QWEN_MODE": "code" },
            "sessionId": "native-session"
          }
        }"#;

        let spec: AgentSpec = serde_json::from_str(raw).unwrap();
        assert_eq!(spec.runtime, AgentRuntime::Pty);
        assert_eq!(spec.session_id.as_deref(), Some("native-session"));
        let Some(ResolvedHarnessConfig::Pty(config)) = spec.harness_config else {
            panic!("expected pty harness config");
        };
        assert_eq!(config.command, "qwen");
        assert_eq!(
            config.args,
            vec![
                "run".to_string(),
                "-m".to_string(),
                "qwen3-coder".to_string()
            ]
        );
        assert_eq!(config.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(
            config
                .env
                .as_ref()
                .and_then(|env| env.get("QWEN_MODE"))
                .map(String::as_str),
            Some("code")
        );
        assert_eq!(config.session_id.as_deref(), Some("native-session"));
    }

    #[test]
    fn agent_spec_accepts_legacy_camel_case_harness_plan() {
        let raw = r#"{
          "name": "LegacyHarnessWorker",
          "runtime": "pty",
          "cli": "codex",
          "harnessPlan": {
            "runtime": "pty",
            "command": "codex",
            "args": ["--model", "gpt-5.4"]
          }
        }"#;

        let spec: AgentSpec = serde_json::from_str(raw).unwrap();
        assert!(matches!(
            spec.harness_config,
            Some(ResolvedHarnessConfig::Pty(_))
        ));
    }

    #[test]
    fn headless_app_server_harness_config_round_trips() {
        let raw = json!({
            "runtime": "headless",
            "protocol": "opencode",
            "endpoint": "http://127.0.0.1:4096",
            "sessionId": "ses_123",
            "auth": {
                "type": "basic",
                "username": "opencode",
                "password": "secret"
            },
            "release": "abort"
        });

        let config: ResolvedHarnessConfig = serde_json::from_value(raw).unwrap();
        assert_eq!(config.runtime(), AgentRuntime::Headless);
        assert_eq!(config.session_id(), Some("ses_123"));
        let ResolvedHarnessConfig::Headless(headless) = &config else {
            panic!("expected headless harness config");
        };
        assert_eq!(headless.driver, HeadlessHarnessDriver::AppServer);

        let encoded = serde_json::to_string(&config).unwrap();
        assert!(encoded.contains("\"runtime\":\"headless\""));
        assert!(encoded.contains("\"driver\":\"app_server\""));
        assert!(encoded.contains("\"sessionId\":\"ses_123\""));
        let decoded: ResolvedHarnessConfig = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.session_id(), Some("ses_123"));
    }

    #[test]
    fn legacy_app_server_harness_config_deserializes_as_headless() {
        let raw = json!({
            "runtime": "app_server",
            "protocol": "opencode",
            "endpoint": "http://127.0.0.1:4096",
            "sessionId": "ses_legacy"
        });

        let config: ResolvedHarnessConfig = serde_json::from_value(raw).unwrap();
        assert_eq!(config.runtime(), AgentRuntime::Headless);
        assert_eq!(config.session_id(), Some("ses_legacy"));
        let ResolvedHarnessConfig::Headless(config) = config else {
            panic!("expected headless harness config");
        };
        assert_eq!(config.driver, HeadlessHarnessDriver::AppServer);
    }

    #[test]
    fn broker_to_worker_resize_pty_round_trip() {
        let msg = BrokerToWorker::ResizePty {
            rows: 40,
            cols: 120,
        };
        let encoded = serde_json::to_string(&msg).unwrap();
        let decoded: BrokerToWorker = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, msg);

        // Verify wire format uses snake_case tag
        let raw: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(raw["type"], "resize_pty");
        assert_eq!(raw["payload"]["rows"], 40);
        assert_eq!(raw["payload"]["cols"], 120);
    }

    #[test]
    fn sdk_subscribe_channels_round_trip() {
        use super::SdkToBroker;
        let msg = SdkToBroker::SubscribeChannels {
            name: "Worker1".into(),
            channels: vec!["ops".into(), "alerts".into()],
        };
        let encoded = serde_json::to_string(&msg).unwrap();
        let decoded: SdkToBroker = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, msg);

        let raw: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(raw["type"], "subscribe_channels");
    }

    #[test]
    fn sdk_unsubscribe_channels_round_trip() {
        use super::SdkToBroker;
        let msg = SdkToBroker::UnsubscribeChannels {
            name: "Worker1".into(),
            channels: vec!["ops".into()],
        };
        let encoded = serde_json::to_string(&msg).unwrap();
        let decoded: SdkToBroker = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, msg);

        let raw: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(raw["type"], "unsubscribe_channels");
    }

    #[test]
    fn broker_event_channel_subscribed_round_trip() {
        let event = BrokerToSdk::Event(BrokerEvent::ChannelSubscribed {
            name: "Worker1".into(),
            channels: vec!["ops".into(), "alerts".into()],
        });
        let encoded = serde_json::to_string(&event).unwrap();
        let decoded: BrokerToSdk = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, event);
    }

    #[test]
    fn broker_event_channel_unsubscribed_round_trip() {
        let event = BrokerToSdk::Event(BrokerEvent::ChannelUnsubscribed {
            name: "Worker1".into(),
            channels: vec!["ops".into()],
        });
        let encoded = serde_json::to_string(&event).unwrap();
        let decoded: BrokerToSdk = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, event);
    }
}
