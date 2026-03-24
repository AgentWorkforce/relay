import Foundation

public enum AgentRuntime: String, Codable, Sendable {
    case pty
    case headless
}

public enum HeadlessProvider: String, Codable, Sendable {
    case claude
    case opencode
}

public struct RestartPolicy: Codable, Sendable {
    public var enabled: Bool?
    public var maxRestarts: Int?
    public var cooldownMs: Int?
    public var maxConsecutiveFailures: Int?

    enum CodingKeys: String, CodingKey {
        case enabled
        case maxRestarts = "max_restarts"
        case cooldownMs = "cooldown_ms"
        case maxConsecutiveFailures = "max_consecutive_failures"
    }

    public init(enabled: Bool? = nil, maxRestarts: Int? = nil, cooldownMs: Int? = nil, maxConsecutiveFailures: Int? = nil) {
        self.enabled = enabled
        self.maxRestarts = maxRestarts
        self.cooldownMs = cooldownMs
        self.maxConsecutiveFailures = maxConsecutiveFailures
    }
}

public struct AgentSpec: Codable, Sendable {
    public var name: String
    public var runtime: AgentRuntime
    public var provider: HeadlessProvider?
    public var cli: String?
    public var args: [String]?
    public var channels: [String]?
    public var model: String?
    public var cwd: String?
    public var team: String?
    public var shadowOf: String?
    public var shadowMode: String?
    public var restartPolicy: RestartPolicy?

    enum CodingKeys: String, CodingKey {
        case name, runtime, provider, cli, args, channels, model, cwd, team
        case shadowOf = "shadow_of"
        case shadowMode = "shadow_mode"
        case restartPolicy = "restart_policy"
    }

    public init(
        name: String,
        runtime: AgentRuntime,
        provider: HeadlessProvider? = nil,
        cli: String? = nil,
        args: [String]? = nil,
        channels: [String]? = nil,
        model: String? = nil,
        cwd: String? = nil,
        team: String? = nil,
        shadowOf: String? = nil,
        shadowMode: String? = nil,
        restartPolicy: RestartPolicy? = nil
    ) {
        self.name = name
        self.runtime = runtime
        self.provider = provider
        self.cli = cli
        self.args = args
        self.channels = channels
        self.model = model
        self.cwd = cwd
        self.team = team
        self.shadowOf = shadowOf
        self.shadowMode = shadowMode
        self.restartPolicy = restartPolicy
    }
}

public struct RelayDelivery: Codable, Sendable {
    public var deliveryId: String
    public var eventId: String
    public var workspaceId: String?
    public var workspaceAlias: String?
    public var from: String
    public var target: String
    public var body: String
    public var threadId: String?
    public var priority: Int?

    enum CodingKeys: String, CodingKey {
        case deliveryId = "delivery_id"
        case eventId = "event_id"
        case workspaceId = "workspace_id"
        case workspaceAlias = "workspace_alias"
        case from, target, body
        case threadId = "thread_id"
        case priority
    }
}

public struct ProtocolErrorPayload: Codable, Sendable, Error {
    public var code: String
    public var message: String
    public var retryable: Bool
    public var data: JSONValue?
}

public struct HelloAck: Codable, Sendable {
    public var brokerVersion: String
    public var protocolVersion: Int

    enum CodingKeys: String, CodingKey {
        case brokerVersion = "broker_version"
        case protocolVersion = "protocol_version"
    }
}

public struct OkResponse: Codable, Sendable {
    public var result: JSONValue?
}

public struct PongPayload: Codable, Sendable {
    public var tsMs: Int64

    enum CodingKeys: String, CodingKey {
        case tsMs = "ts_ms"
    }
}

public struct WorkerStreamPayload: Codable, Sendable {
    public var stream: String
    public var chunk: String
}

public struct WorkerExitedPayload: Codable, Sendable {
    public var code: Int?
    public var signal: String?
}

public struct EmptyPayload: Codable, Sendable {
    public init() {}
}

public struct HelloPayload: Codable, Sendable {
    public var clientName: String
    public var clientVersion: String
    public var apiKey: String?

    enum CodingKeys: String, CodingKey {
        case clientName = "client_name"
        case clientVersion = "client_version"
        case apiKey = "api_key"
    }

    public init(clientName: String, clientVersion: String, apiKey: String? = nil) {
        self.clientName = clientName
        self.clientVersion = clientVersion
        self.apiKey = apiKey
    }
}

public struct SendMessagePayload: Codable, Sendable {
    public var to: String
    public var text: String
    public var from: String?
    public var threadId: String?
    public var workspaceId: String?
    public var workspaceAlias: String?
    public var priority: Int?
    public var data: [String: JSONValue]?

    enum CodingKeys: String, CodingKey {
        case to, text, from, priority, data
        case threadId = "thread_id"
        case workspaceId = "workspace_id"
        case workspaceAlias = "workspace_alias"
    }
}

public struct SpawnAgentPayload: Codable, Sendable {
    public var agent: AgentSpec
    public var initialTask: String?
    public var skipRelayPrompt: Bool?

    enum CodingKeys: String, CodingKey {
        case agent
        case initialTask = "initial_task"
        case skipRelayPrompt = "skip_relay_prompt"
    }
}

public struct ReleaseAgentPayload: Codable, Sendable {
    public var name: String
    public var reason: String?
}

public struct PingPayload: Codable, Sendable {
    public var tsMs: Int64

    enum CodingKeys: String, CodingKey {
        case tsMs = "ts_ms"
    }
}

public enum BrokerEvent: Sendable {
    case agentSpawned(AgentSpawnedEvent)
    case agentReleased(AgentReleasedEvent)
    case agentExit(AgentExitRequestedEvent)
    case agentExited(AgentExitedEvent)
    case relayInbound(RelayInboundEvent)
    case workerStream(WorkerStreamEvent)
    case deliveryRetry(DeliveryRetryEvent)
    case deliveryDropped(DeliveryDroppedEvent)
    case deliveryQueued(DeliveryStateEvent)
    case deliveryInjected(DeliveryStateEvent)
    case deliveryVerified(DeliveryStateEvent)
    case deliveryFailed(DeliveryFailedEvent)
    case deliveryActive(DeliveryStateEvent)
    case deliveryAck(DeliveryStateEvent)
    case workerReady(WorkerReadyEvent)
    case workerError(WorkerErrorEvent)
    case relaycastPublished(RelaycastPublishedEvent)
    case relaycastPublishFailed(RelaycastPublishFailedEvent)
    case aclDenied(ACLDeniedEvent)
    case agentIdle(AgentIdleEvent)
    case agentRestarting(AgentRestartingEvent)
    case agentRestarted(AgentRestartedEvent)
    case agentPermanentlyDead(AgentPermanentlyDeadEvent)
    /// Catch-all for unrecognized broker event kinds, preserving the raw kind string
    /// and the full JSON payload for forward compatibility.
    case unknown(kind: String, rawJSON: Data?)
}

extension BrokerEvent: Codable {
    enum CodingKeys: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "agent_spawned": self = .agentSpawned(try AgentSpawnedEvent(from: decoder))
        case "agent_released": self = .agentReleased(try AgentReleasedEvent(from: decoder))
        case "agent_exit": self = .agentExit(try AgentExitRequestedEvent(from: decoder))
        case "agent_exited": self = .agentExited(try AgentExitedEvent(from: decoder))
        case "relay_inbound": self = .relayInbound(try RelayInboundEvent(from: decoder))
        case "worker_stream": self = .workerStream(try WorkerStreamEvent(from: decoder))
        case "delivery_retry": self = .deliveryRetry(try DeliveryRetryEvent(from: decoder))
        case "delivery_dropped": self = .deliveryDropped(try DeliveryDroppedEvent(from: decoder))
        case "delivery_queued": self = .deliveryQueued(try DeliveryStateEvent(from: decoder))
        case "delivery_injected": self = .deliveryInjected(try DeliveryStateEvent(from: decoder))
        case "delivery_verified": self = .deliveryVerified(try DeliveryStateEvent(from: decoder))
        case "delivery_failed": self = .deliveryFailed(try DeliveryFailedEvent(from: decoder))
        case "delivery_active": self = .deliveryActive(try DeliveryStateEvent(from: decoder))
        case "delivery_ack": self = .deliveryAck(try DeliveryStateEvent(from: decoder))
        case "worker_ready": self = .workerReady(try WorkerReadyEvent(from: decoder))
        case "worker_error": self = .workerError(try WorkerErrorEvent(from: decoder))
        case "relaycast_published": self = .relaycastPublished(try RelaycastPublishedEvent(from: decoder))
        case "relaycast_publish_failed": self = .relaycastPublishFailed(try RelaycastPublishFailedEvent(from: decoder))
        case "acl_denied": self = .aclDenied(try ACLDeniedEvent(from: decoder))
        case "agent_idle": self = .agentIdle(try AgentIdleEvent(from: decoder))
        case "agent_restarting": self = .agentRestarting(try AgentRestartingEvent(from: decoder))
        case "agent_restarted": self = .agentRestarted(try AgentRestartedEvent(from: decoder))
        case "agent_permanently_dead": self = .agentPermanentlyDead(try AgentPermanentlyDeadEvent(from: decoder))
        default:
            // Forward-compatible: preserve unknown event kinds with raw JSON data
            // so consumers can handle new broker events without SDK updates.
            let kind = try container.decode(String.self, forKey: .kind)
            self = .unknown(kind: kind, rawJSON: nil)
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .agentSpawned(let value): try value.encode(to: encoder)
        case .agentReleased(let value): try value.encode(to: encoder)
        case .agentExit(let value): try value.encode(to: encoder)
        case .agentExited(let value): try value.encode(to: encoder)
        case .relayInbound(let value): try value.encode(to: encoder)
        case .workerStream(let value): try value.encode(to: encoder)
        case .deliveryRetry(let value): try value.encode(to: encoder)
        case .deliveryDropped(let value): try value.encode(to: encoder)
        case .deliveryQueued(let value): try value.encode(to: encoder)
        case .deliveryInjected(let value): try value.encode(to: encoder)
        case .deliveryVerified(let value): try value.encode(to: encoder)
        case .deliveryFailed(let value): try value.encode(to: encoder)
        case .deliveryActive(let value): try value.encode(to: encoder)
        case .deliveryAck(let value): try value.encode(to: encoder)
        case .workerReady(let value): try value.encode(to: encoder)
        case .workerError(let value): try value.encode(to: encoder)
        case .relaycastPublished(let value): try value.encode(to: encoder)
        case .relaycastPublishFailed(let value): try value.encode(to: encoder)
        case .aclDenied(let value): try value.encode(to: encoder)
        case .agentIdle(let value): try value.encode(to: encoder)
        case .agentRestarting(let value): try value.encode(to: encoder)
        case .agentRestarted(let value): try value.encode(to: encoder)
        case .agentPermanentlyDead(let value): try value.encode(to: encoder)
        case .unknown(let kind, _):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(kind, forKey: .kind)
        }
    }
}

public enum InboundMessage: Sendable {
    case helloAck(HelloAck)
    case ok(OkResponse)
    case error(ProtocolErrorPayload)
    case event(BrokerEvent)
    case deliverRelay(RelayDelivery)
    case workerStream(WorkerStreamPayload)
    case workerExited(WorkerExitedPayload)
    case pong(PongPayload)
    /// Catch-all for unrecognized inbound message types for forward compatibility.
    case unknown(type: String, rawJSON: Data?)
}

extension InboundMessage: Codable {
    enum CodingKeys: String, CodingKey { case type, payload }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "hello_ack": self = .helloAck(try container.decode(HelloAck.self, forKey: .payload))
        case "ok": self = .ok(try container.decode(OkResponse.self, forKey: .payload))
        case "error": self = .error(try container.decode(ProtocolErrorPayload.self, forKey: .payload))
        case "event": self = .event(try container.decode(BrokerEvent.self, forKey: .payload))
        case "deliver_relay": self = .deliverRelay(try container.decode(RelayDelivery.self, forKey: .payload))
        case "worker_stream": self = .workerStream(try container.decode(WorkerStreamPayload.self, forKey: .payload))
        case "worker_exited": self = .workerExited(try container.decode(WorkerExitedPayload.self, forKey: .payload))
        case "pong", "ping": self = .pong(try container.decode(PongPayload.self, forKey: .payload))
        default:
            // Forward-compatible: preserve unknown message types so consumers
            // can handle new protocol frames without SDK updates.
            self = .unknown(type: type, rawJSON: nil)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .helloAck(let payload): try container.encode("hello_ack", forKey: .type); try container.encode(payload, forKey: .payload)
        case .ok(let payload): try container.encode("ok", forKey: .type); try container.encode(payload, forKey: .payload)
        case .error(let payload): try container.encode("error", forKey: .type); try container.encode(payload, forKey: .payload)
        case .event(let payload): try container.encode("event", forKey: .type); try container.encode(payload, forKey: .payload)
        case .deliverRelay(let payload): try container.encode("deliver_relay", forKey: .type); try container.encode(payload, forKey: .payload)
        case .workerStream(let payload): try container.encode("worker_stream", forKey: .type); try container.encode(payload, forKey: .payload)
        case .workerExited(let payload): try container.encode("worker_exited", forKey: .type); try container.encode(payload, forKey: .payload)
        case .pong(let payload): try container.encode("pong", forKey: .type); try container.encode(payload, forKey: .payload)
        case .unknown(let type, _): try container.encode(type, forKey: .type)
        }
    }
}

public enum OutboundMessage: Sendable {
    case hello(HelloPayload)
    case sendMessage(SendMessagePayload)
    case spawnAgent(SpawnAgentPayload)
    case releaseAgent(ReleaseAgentPayload)
    case ping(PingPayload)
    case listAgents(EmptyPayload)
}

extension OutboundMessage: Encodable {
    enum CodingKeys: String, CodingKey { case v, type, payload }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(1, forKey: .v)
        switch self {
        case .hello(let payload): try container.encode("hello", forKey: .type); try container.encode(payload, forKey: .payload)
        case .sendMessage(let payload): try container.encode("send_message", forKey: .type); try container.encode(payload, forKey: .payload)
        case .spawnAgent(let payload): try container.encode("spawn_agent", forKey: .type); try container.encode(payload, forKey: .payload)
        case .releaseAgent(let payload): try container.encode("release_agent", forKey: .type); try container.encode(payload, forKey: .payload)
        case .ping(let payload): try container.encode("ping", forKey: .type); try container.encode(payload, forKey: .payload)
        case .listAgents(let payload): try container.encode("list_agents", forKey: .type); try container.encode(payload, forKey: .payload)
        }
    }
}

public struct AgentSpawnedEvent: Codable, Sendable { public var kind: String = "agent_spawned"; public var name: String; public var runtime: AgentRuntime; public var provider: HeadlessProvider?; public var cli: String?; public var model: String?; public var parent: String?; public var pid: Int?; public var source: String? }
public struct AgentReleasedEvent: Codable, Sendable { public var kind: String = "agent_released"; public var name: String }
public struct AgentExitRequestedEvent: Codable, Sendable { public var kind: String = "agent_exit"; public var name: String; public var reason: String }
public struct AgentExitedEvent: Codable, Sendable { public var kind: String = "agent_exited"; public var name: String; public var code: Int?; public var signal: String? }
public struct RelayInboundEvent: Codable, Sendable { public var kind: String = "relay_inbound"; public var eventId: String; public var from: String; public var target: String; public var body: String; public var threadId: String?; enum CodingKeys: String, CodingKey { case kind, from, target, body; case eventId = "event_id"; case threadId = "thread_id" } }
public struct WorkerStreamEvent: Codable, Sendable { public var kind: String = "worker_stream"; public var name: String; public var stream: String; public var chunk: String }
public struct DeliveryRetryEvent: Codable, Sendable { public var kind: String = "delivery_retry"; public var name: String; public var deliveryId: String; public var eventId: String; public var attempts: Int; enum CodingKeys: String, CodingKey { case kind, name, attempts; case deliveryId = "delivery_id"; case eventId = "event_id" } }
public struct DeliveryDroppedEvent: Codable, Sendable { public var kind: String = "delivery_dropped"; public var name: String; public var count: Int; public var reason: String }
public struct DeliveryStateEvent: Codable, Sendable { public var kind: String; public var name: String; public var deliveryId: String; public var eventId: String; enum CodingKeys: String, CodingKey { case kind, name; case deliveryId = "delivery_id"; case eventId = "event_id" } }
public struct DeliveryFailedEvent: Codable, Sendable { public var kind: String = "delivery_failed"; public var name: String; public var deliveryId: String; public var eventId: String; public var reason: String; enum CodingKeys: String, CodingKey { case kind, name, reason; case deliveryId = "delivery_id"; case eventId = "event_id" } }
public struct WorkerReadyEvent: Codable, Sendable { public var kind: String = "worker_ready"; public var name: String; public var runtime: AgentRuntime; public var provider: HeadlessProvider?; public var cli: String?; public var model: String? }
public struct WorkerErrorEvent: Codable, Sendable { public var kind: String = "worker_error"; public var name: String; public var code: String; public var message: String }
public struct RelaycastPublishedEvent: Codable, Sendable { public var kind: String = "relaycast_published"; public var eventId: String; public var to: String; public var targetType: String; enum CodingKeys: String, CodingKey { case kind, to; case eventId = "event_id"; case targetType = "target_type" } }
public struct RelaycastPublishFailedEvent: Codable, Sendable { public var kind: String = "relaycast_publish_failed"; public var eventId: String; public var to: String; public var reason: String; enum CodingKeys: String, CodingKey { case kind, to, reason; case eventId = "event_id" } }
public struct ACLDeniedEvent: Codable, Sendable { public var kind: String = "acl_denied"; public var name: String; public var sender: String; public var ownerChain: [String]; enum CodingKeys: String, CodingKey { case kind, name, sender; case ownerChain = "owner_chain" } }
public struct AgentIdleEvent: Codable, Sendable { public var kind: String = "agent_idle"; public var name: String; public var idleSecs: Int; enum CodingKeys: String, CodingKey { case kind, name; case idleSecs = "idle_secs" } }
public struct AgentRestartingEvent: Codable, Sendable { public var kind: String = "agent_restarting"; public var name: String; public var code: Int?; public var signal: String?; public var restartCount: Int; public var delayMs: Int; enum CodingKeys: String, CodingKey { case kind, name, code, signal; case restartCount = "restart_count"; case delayMs = "delay_ms" } }
public struct AgentRestartedEvent: Codable, Sendable { public var kind: String = "agent_restarted"; public var name: String; public var restartCount: Int; enum CodingKeys: String, CodingKey { case kind, name; case restartCount = "restart_count" } }
public struct AgentPermanentlyDeadEvent: Codable, Sendable { public var kind: String = "agent_permanently_dead"; public var name: String; public var reason: String }

public enum JSONValue: Codable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value") }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}
