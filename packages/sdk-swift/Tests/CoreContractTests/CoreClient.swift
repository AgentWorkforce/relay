import Foundation

// CoreContract.swift (a symlink to crates/relay-node/contract/CoreContract.swift,
// the generated bridge contract) extends the macOS app's `CoreClient` with one
// typed call per method. This stand-in carries only what those calls use, so
// the contract compiles here and its types' decoding can be tested.
public final class CoreClient: @unchecked Sendable {
    struct NotConnected: Error {}

    func call<P: Encodable, R: Decodable>(_ method: String, _ params: P) async throws -> R {
        throw NotConnected()
    }
}
