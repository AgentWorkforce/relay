import Foundation

// MARK: - RelayObserverEventType

public enum RelayObserverEventType: String, Codable, Sendable {
    case agentSpawned = "agent_spawned"
    case agentReleased = "agent_released"
    case agentIdle = "agent_idle"
    case agentStatus = "agent_status"
    case workerStream = "worker_stream"
    case delivery = "delivery"
    case channelMessage = "channel_message"
    case stepStarted = "step_started"
    case stepCompleted = "step_completed"
    case runCompleted = "run_completed"
    case relayConfig = "relay_config"
    case relayWorkspace = "relay_workspace"
    case commentPollTick = "comment_poll_tick"
    case commentDetected = "comment_detected"
    case error = "error"
    case ack = "ack"
    case connected = "connected"
    case subscribed = "subscribed"
    case pong = "pong"
}

// MARK: - RelayObserverEvent

public struct RelayObserverEvent: Decodable, Sendable {
    public let type: RelayObserverEventType

    // agent_spawned fields
    public let name: String?
    public let agentName: String?
    public let cli: String?
    public let channels: [String]?

    // agent_released fields
    public let reason: String?

    // agent_idle fields
    public let idleSecs: Int?

    // agent_status fields
    public let status: String?

    // worker_stream fields
    public let agent: String?
    public let data: String?
    public let stream: String?

    // delivery fields
    public let id: String?
    public let from: String?
    public let to: String?
    public let text: String?
    public let state: String?

    // channel_message fields
    public let channel: String?
    public let timestamp: String?

    // step_started / step_completed fields
    public let step: String?
    public let stepName: String?
    public let output: String?

    // run_completed fields
    public let runId: String?

    // relay_config fields
    public let observerUrl: String?

    // relay_workspace fields
    public let workspaceId: String?

    // comment_poll_tick fields
    public let checkedAt: String?
    public let intervalSeconds: Int?

    // comment_detected / error fields
    public let message: String?

    enum CodingKeys: String, CodingKey {
        case type
        case name
        case agentName = "agent_name"
        case cli, channels, reason
        case idleSecs = "idle_secs"
        case status, agent, data, stream
        case id, from, to, text, state
        case channel, timestamp
        case step
        case stepName = "step_name"
        case output
        case runId = "run_id"
        case observerUrl = "observer_url"
        case workspaceId = "workspace_id"
        case checkedAt = "checked_at"
        case intervalSeconds = "interval_seconds"
        case message
    }
}

// MARK: - RelayObserverError

public enum RelayObserverError: LocalizedError, Sendable {
    case notConnected
    case encodingFailed

    public var errorDescription: String? {
        switch self {
        case .notConnected: return "Relay not connected"
        case .encodingFailed: return "Message encoding failed"
        }
    }
}

// MARK: - Outbound Message Structs (internal)

struct ObserverSubscribeMessage: Encodable {
    let type: String = "subscribe"
    let channel: String
}

struct ObserverChannelSendMessage: Encodable {
    let type: String = "channel_send"
    let channel: String
    let text: String
    let personas: [String]?
    let cliPreferences: [String: String]?

    enum CodingKeys: String, CodingKey {
        case type, channel, text, personas
        case cliPreferences = "cli_preferences"
    }
}

struct ObserverDirectSendMessage: Encodable {
    let type: String = "send"
    let to: String
    let text: String
}
