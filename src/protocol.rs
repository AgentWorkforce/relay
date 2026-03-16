use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::supervisor::RestartPolicy;

pub const PROTOCOL_VERSION: u32 = 1;

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
pub struct AgentSpec {
    pub name: String,
    pub runtime: AgentRuntime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<HeadlessProvider>,
    #[serde(default)]
    pub cli: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageInjectionMode {
    Wait,
    Steer,
}

impl Default for MessageInjectionMode {
    fn default() -> Self {
        Self::Wait
    }
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
        agent: AgentSpec,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum BrokerToWorker {
    InitWorker {
        agent: AgentSpec,
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
        AgentRuntime, AgentSpec, BrokerEvent, BrokerToSdk, BrokerToWorker, HeadlessProvider,
        MessageInjectionMode, ProtocolEnvelope, RelayDelivery, WorkerToBroker, PROTOCOL_VERSION,
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
        assert_eq!(decoded.v, 1);
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
}
