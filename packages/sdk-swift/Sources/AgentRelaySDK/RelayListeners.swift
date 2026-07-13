import Foundation

// MARK: - Typed listener hub (#1159)
//
// Swift counterpart to the TypeScript SDK's `listeners.ts`: a single
// `addListener(selector, handler)` entry point that accepts a typed event
// selector (exact dotted name, `*`/prefix wildcard, or a predicate), plus
// `once(...)` and an `onError` hook. This augments — it does not replace — the
// back-compat `events`/`inboundMessages` AsyncStreams on `AgentClient`.

/// Selects which realtime events a listener receives. String literals map onto
/// the same rules as the TS SDK: `"*"` matches everything, `"message.*"`
/// matches by dotted prefix, and any other string matches an exact event type.
public enum RelayEventSelector: Sendable, ExpressibleByStringLiteral {
    /// Match every event.
    case any
    /// Match an exact dotted event type (e.g. `message.created`).
    case type(String)
    /// Match a dotted prefix (stored WITH the trailing dot, e.g. `message.`).
    case prefix(String)
    /// Match with an arbitrary predicate over the event.
    case predicate(@Sendable (RelayEvent) -> Bool)

    public init(stringLiteral value: String) {
        if value == "*" {
            self = .any
        } else if value.hasSuffix(".*") {
            // Retain the trailing dot so `message.*` matches `message.created`
            // but not `messages.created`, mirroring the TS `startsWith` rule.
            self = .prefix(String(value.dropLast(1)))
        } else {
            self = .type(value)
        }
    }

    /// Build a wildcard-prefix selector from a bare namespace (e.g. `"message"`).
    public static func namespace(_ value: String) -> RelayEventSelector {
        .prefix(value.hasSuffix(".") ? value : value + ".")
    }

    func matches(_ event: RelayEvent) -> Bool {
        switch self {
        case .any:
            return true
        case .type(let type):
            return event.type == type
        case .prefix(let prefix):
            return event.type.hasPrefix(prefix)
        case .predicate(let predicate):
            return predicate(event)
        }
    }
}

/// Context describing which listener raised a handler error.
public struct RelayListenerErrorContext: Sendable {
    public let selectorDescription: String
    public let error: Error
}

/// Hook invoked when a typed listener handler throws. Errors are isolated from
/// the event pipeline and routed here (or logged when no hook is registered).
public typealias RelayErrorHook = @Sendable (RelayListenerErrorContext) -> Void

/// Handler run for each matching event. Throwing routes the error to the
/// registered `onError` hook rather than into the event pipeline.
public typealias RelayEventHandler = @Sendable (RelayEvent) throws -> Void

struct TypedListenerRegistration: Sendable {
    let id: UUID
    let selector: RelayEventSelector
    let handler: RelayEventHandler
    /// When true the registration removes itself after its first match (`once`).
    let once: Bool
    let selectorDescription: String
}

/// Handle returned by `addListener`/`once`/`onError`. Call `cancel()` to
/// unsubscribe; idempotent and safe to drop.
public final class RelayListenerToken: @unchecked Sendable {
    private let onCancel: @Sendable () -> Void
    private let lock = NSLock()
    private var cancelled = false

    init(onCancel: @escaping @Sendable () -> Void) {
        self.onCancel = onCancel
    }

    public func cancel() {
        lock.lock()
        let alreadyCancelled = cancelled
        cancelled = true
        lock.unlock()
        guard !alreadyCancelled else { return }
        onCancel()
    }
}

extension HostedParticipantCore {
    /// Register a listener. Returns the id used to remove it.
    func registerTypedListener(
        selector: RelayEventSelector,
        once: Bool,
        handler: @escaping RelayEventHandler
    ) -> UUID {
        let id = UUID()
        typedListeners[id] = TypedListenerRegistration(
            id: id,
            selector: selector,
            handler: handler,
            once: once,
            selectorDescription: Self.describe(selector: selector)
        )
        return id
    }

    func removeTypedListener(_ id: UUID) {
        typedListeners.removeValue(forKey: id)
    }

    func registerErrorHook(_ hook: @escaping RelayErrorHook) -> UUID {
        let id = UUID()
        listenerErrorHooks[id] = hook
        return id
    }

    func removeErrorHook(_ id: UUID) {
        listenerErrorHooks.removeValue(forKey: id)
    }

    /// Dispatch an event to every matching typed listener. Called from the
    /// serialized event pump so ordering is preserved. `once` listeners are
    /// removed after firing; handler errors are isolated and routed to the
    /// `onError` hooks (or logged when none are registered).
    func dispatchToTypedListeners(_ event: RelayEvent) {
        guard !typedListeners.isEmpty else { return }
        // Snapshot so a handler that (un)registers listeners cannot mutate the
        // collection mid-iteration.
        let registrations = typedListeners.values.sorted { $0.id.uuidString < $1.id.uuidString }
        for registration in registrations {
            guard registration.selector.matches(event) else { continue }
            if registration.once {
                typedListeners.removeValue(forKey: registration.id)
            }
            do {
                try registration.handler(event)
            } catch {
                reportListenerError(error, selectorDescription: registration.selectorDescription)
            }
        }
    }

    private func reportListenerError(_ error: Error, selectorDescription: String) {
        let context = RelayListenerErrorContext(selectorDescription: selectorDescription, error: error)
        if listenerErrorHooks.isEmpty {
            print("[agent-relay] listener handler for \(selectorDescription) threw: \(error)")
            return
        }
        for hook in listenerErrorHooks.values {
            hook(context)
        }
    }

    private static func describe(selector: RelayEventSelector) -> String {
        switch selector {
        case .any: return "*"
        case .type(let type): return type
        case .prefix(let prefix): return "\(prefix)*"
        case .predicate: return "<predicate>"
        }
    }
}
