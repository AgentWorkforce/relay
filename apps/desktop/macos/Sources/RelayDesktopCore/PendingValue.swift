import Foundation

/// A value the person asked for while the core answers: shown in place of
/// the confirmed one and dropped when the answer arrives. A newer request
/// supersedes an older one (the last click wins), so an older answer changes
/// nothing; only the latest request's failure reverts to the confirmed
/// value. The Linux app's `models::PendingValue` matches it.
public struct PendingValue<Value: Equatable>: Equatable {
    public private(set) var wanted: Value?
    /// The latest request's token; `finish` with any other changes nothing.
    public private(set) var token: UInt64 = 0

    public init() {}

    public var isPending: Bool { wanted != nil }

    /// What to show: the value asked for, else the confirmed one.
    public func shown(_ confirmed: Value) -> Value { wanted ?? confirmed }

    /// Records the intent; returns the token its answer must carry.
    @discardableResult
    public mutating func begin(_ value: Value) -> UInt64 {
        token &+= 1
        wanted = value
        return token
    }

    /// The request `token` answered. Returns whether it was the latest, in
    /// which case nothing is pending any more; an older answer is ignored
    /// because a newer request is still on its way.
    @discardableResult
    public mutating func finish(_ token: UInt64) -> Bool {
        guard token == self.token else { return false }
        wanted = nil
        return true
    }

    /// Forgets every request, as when the connection it was made on is gone.
    public mutating func clear() {
        wanted = nil
    }
}
