import Foundation

/// A token renewal may finish after sign-out or a replacement sign-in. Only
/// the request that still owns the current credential can write or remove it.
struct CloudCredentialRefresh {
    let id = UUID()
    let sessionGeneration: Int
    let refreshToken: String

    func isCurrent(requestID: UUID?, sessionGeneration: Int, refreshToken: String?, signingOut: Bool) -> Bool {
        !signingOut && requestID == id &&
            sessionGeneration == self.sessionGeneration && refreshToken == self.refreshToken
    }
}
