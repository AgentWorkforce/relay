struct AttachmentUploadState {
    struct Token: Equatable {
        let conversationID: String
        fileprivate let generation: Int
    }

    private(set) var active: Token?
    private var nextGeneration = 0

    func isUploading(for conversationID: String) -> Bool {
        active?.conversationID == conversationID
    }

    func isCurrent(_ token: Token) -> Bool {
        active == token
    }

    mutating func begin(for conversationID: String) -> Token {
        nextGeneration &+= 1
        let token = Token(conversationID: conversationID, generation: nextGeneration)
        active = token
        return token
    }

    @discardableResult
    mutating func finish(_ token: Token) -> Bool {
        guard active == token else { return false }
        active = nil
        return true
    }

    mutating func invalidate() {
        active = nil
    }
}
