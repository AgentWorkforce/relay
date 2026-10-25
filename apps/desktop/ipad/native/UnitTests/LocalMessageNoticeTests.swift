import XCTest
@testable import AgentRelayiPad

final class LocalMessageNoticeTests: XCTestCase {
    func testNoBannerWhenPushIsAvailable() {
        XCTAssertFalse(LocalMessageNotice.shouldPost(apnsToken: "abc123", initialized: true, messageID: "m2",
                                                     previousMessageID: "m1", fromMe: false))
    }

    func testBannerForNewMessageWithoutPush() {
        XCTAssertTrue(LocalMessageNotice.shouldPost(apnsToken: nil, initialized: true, messageID: "m2",
                                                    previousMessageID: "m1", fromMe: false))
        XCTAssertTrue(LocalMessageNotice.shouldPost(apnsToken: "", initialized: true, messageID: "m2",
                                                    previousMessageID: nil, fromMe: false))
    }

    func testNoBannerForSeenOwnOrFirstLoadMessages() {
        XCTAssertFalse(LocalMessageNotice.shouldPost(apnsToken: nil, initialized: true, messageID: "m1",
                                                     previousMessageID: "m1", fromMe: false))
        XCTAssertFalse(LocalMessageNotice.shouldPost(apnsToken: nil, initialized: true, messageID: "m2",
                                                     previousMessageID: "m1", fromMe: true))
        XCTAssertFalse(LocalMessageNotice.shouldPost(apnsToken: nil, initialized: false, messageID: "m2",
                                                     previousMessageID: nil, fromMe: false))
        XCTAssertFalse(LocalMessageNotice.shouldPost(apnsToken: nil, initialized: true, messageID: "",
                                                     previousMessageID: "m1", fromMe: false))
    }
    func testNewMessageBeforeRosterResponseStillGetsOneBanner() {
        var notices = LocalMessageNotices()
        XCTAssertFalse(notices.shouldPost(conversationID: "dm_1", messageID: "m1", isCurrentPeer: true,
                                         apnsToken: nil, initialized: false, fromMe: false))
        XCTAssertFalse(notices.shouldPost(conversationID: "dm_1", messageID: "m2", isCurrentPeer: false,
                                         apnsToken: nil, initialized: true, fromMe: false))
        XCTAssertTrue(notices.shouldPost(conversationID: "dm_1", messageID: "m2", isCurrentPeer: true,
                                        apnsToken: nil, initialized: true, fromMe: false))
        XCTAssertFalse(notices.shouldPost(conversationID: "dm_1", messageID: "m2", isCurrentPeer: true,
                                         apnsToken: nil, initialized: true, fromMe: false))
    }

    func testInitialHistoryStaysQuietWhenRosterArrivesAfterThreads() {
        var notices = LocalMessageNotices()
        XCTAssertFalse(notices.shouldPost(conversationID: "dm_1", messageID: "m1", isCurrentPeer: false,
                                         apnsToken: nil, initialized: false, fromMe: false))
        XCTAssertFalse(notices.shouldPost(conversationID: "dm_1", messageID: "m1", isCurrentPeer: true,
                                         apnsToken: nil, initialized: true, fromMe: false))
    }

    func testPushAndOwnMessagesAdvanceTheVisibleCursorWithoutLocalBanners() {
        var notices = LocalMessageNotices()
        XCTAssertFalse(notices.shouldPost(conversationID: "dm_1", messageID: "m1", isCurrentPeer: true,
                                         apnsToken: "apns", initialized: true, fromMe: false))
        XCTAssertFalse(notices.shouldPost(conversationID: "dm_1", messageID: "m1", isCurrentPeer: true,
                                         apnsToken: nil, initialized: true, fromMe: false))
        XCTAssertFalse(notices.shouldPost(conversationID: "dm_1", messageID: "m2", isCurrentPeer: true,
                                         apnsToken: nil, initialized: true, fromMe: true))
    }

}
