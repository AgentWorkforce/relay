import Foundation

/// Decides when the app shows its own "New message" banner. It is only a
/// fallback for a device without push: once iOS has issued an APNs token,
/// Relaycast pushes each message and iOS shows that push even while the app
/// is open, so a local banner as well would be a second one for one message.
enum LocalMessageNotice {
    static func shouldPost(apnsToken: String?, initialized: Bool, messageID: String,
                           previousMessageID: String?, fromMe: Bool) -> Bool {
        guard apnsToken?.isEmpty ?? true else { return false }
        return initialized && !messageID.isEmpty && previousMessageID != messageID && !fromMe
    }
}

/// The notification cursor advances only when a peer can be shown. The DM
/// cursor may advance first while a concurrent presence request is pending.
struct LocalMessageNotices {
    private var messageIDs: [String: String] = [:]

    mutating func shouldPost(conversationID: String, messageID: String, isCurrentPeer: Bool,
                             apnsToken: String?, initialized: Bool, fromMe: Bool) -> Bool {
        let previous = messageIDs[conversationID]
        if isCurrentPeer || !initialized { messageIDs[conversationID] = messageID }
        guard isCurrentPeer else { return false }
        return LocalMessageNotice.shouldPost(apnsToken: apnsToken, initialized: initialized,
                                             messageID: messageID, previousMessageID: previous,
                                             fromMe: fromMe)
    }
}
