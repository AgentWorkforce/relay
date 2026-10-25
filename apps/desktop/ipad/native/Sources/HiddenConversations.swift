import Foundation

/// Conversations hidden from the Messages list on this device. Hiding is a
/// local view preference: nothing is deleted from Relaycast. Each entry keeps
/// the conversation's newest message ID when it was hidden ("" if there was
/// none), so any newer message brings it back on its own. Relaycast reports only
/// a conversation's last message, so a reply followed by your own message from
/// another device must still count: a later message in either direction does.
struct HiddenConversations: Equatable {
    private(set) var entries: [String: String]

    init(_ entries: [String: String] = [:]) {
        self.entries = entries
    }

    var isEmpty: Bool { entries.isEmpty }

    func contains(_ conversationID: String) -> Bool {
        entries[conversationID] != nil
    }

    mutating func hide(_ conversationID: String, latestMessageID: String?) {
        guard !conversationID.isEmpty else { return }
        entries[conversationID] = latestMessageID ?? ""
    }

    mutating func unhide(_ conversationID: String) {
        entries.removeValue(forKey: conversationID)
    }

    /// Unhides every conversation whose newest message differs from the one it
    /// was hidden at. Conversations missing from `latest` stay hidden. Returns
    /// whether anything changed.
    @discardableResult
    mutating func reveal(newerThan latest: [String: String]) -> Bool {
        let revealed = entries.filter { id, hiddenAt in
            guard let newest = latest[id], !newest.isEmpty else { return false }
            return newest != hiddenAt
        }.keys
        for id in revealed { entries.removeValue(forKey: id) }
        return !revealed.isEmpty
    }
}
