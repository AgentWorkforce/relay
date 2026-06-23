import Foundation
import Relaycast

// MARK: - Type bridging between AgentRelaySDK's public surface and the
// relaycast engine SDK (`Relaycast`). These conversions let AgentRelaySDK keep
// its existing public types while delegating all transport to relaycast.

extension RelayAgentType {
    var relaycastType: Relaycast.AgentType {
        switch self {
        case .agent: return .agent
        case .human: return .human
        case .system: return .system
        }
    }
}

extension RelayAgentStatus {
    init(_ status: Relaycast.AgentStatus) {
        switch status {
        case .online: self = .online
        case .offline: self = .offline
        case .away: self = .away
        }
    }
}

extension JSONValue {
    /// Convert a relaycast `JSONValue` (which distinguishes int/double) into the
    /// AgentRelaySDK `JSONValue` (number-based).
    init(_ value: Relaycast.JSONValue) {
        switch value {
        case .null:
            self = .null
        case .bool(let bool):
            self = .bool(bool)
        case .int(let int):
            self = .number(Double(int))
        case .double(let double):
            self = .number(double)
        case .string(let string):
            self = .string(string)
        case .array(let array):
            self = .array(array.map { JSONValue($0) })
        case .object(let object):
            self = .object(object.mapValues { JSONValue($0) })
        }
    }
}

extension RelayError {
    /// Map a relaycast `RelayError` onto AgentRelaySDK's `RelayError` so callers
    /// continue to see the existing error surface.
    init(_ error: Relaycast.RelayError) {
        switch error {
        case .api(let code, let message, let statusCode, let retryable):
            let normalizedCode = statusCode == 409 ? "agent_already_exists" : code
            self = .protocolError(code: normalizedCode, message: message, retryable: retryable)
        case .transport(let message, _, let retryable, _):
            self = .protocolError(code: "transport_error", message: message, retryable: retryable)
        case .invalidRequest(let message):
            self = .encodingFailed(message)
        case .invalidResponse(let message, _):
            self = .decodingFailed(message)
        case .missingData(let message):
            self = .decodingFailed(message)
        case .notConnected:
            self = .notConnected
        }
    }
}

extension RelayEvent {
    /// Build an AgentRelaySDK `RelayEvent` from a relaycast realtime `WsEvent`.
    ///
    /// relaycast emits flat events (`type` plus payload fields at the top level),
    /// while `RelayEvent` already understands both the flat and nested envelope
    /// shapes via its `Decodable` implementation. Re-encode the relaycast event
    /// to JSON and decode it through that flexible path so every existing field
    /// extraction rule (snake/camel, nested `payload`, `agent.name`, etc.) is
    /// reused verbatim.
    init(_ event: Relaycast.WsEvent) {
        var object: [String: Relaycast.JSONValue] = event.payload
        object["type"] = .string(event.type)

        let encoder = JSONEncoder()
        if let data = try? encoder.encode(Relaycast.JSONValue.object(object)),
           let decoded = try? JSONDecoder().decode(RelayEvent.self, from: data) {
            self = decoded
            return
        }

        // Fallback: preserve at least the type if re-decoding ever fails.
        self = RelayEvent(type: event.type)
    }
}
