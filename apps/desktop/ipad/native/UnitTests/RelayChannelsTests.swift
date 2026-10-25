import XCTest
@testable import AgentRelayiPad

final class RelayChannelsTests: XCTestCase {
    func testJoinedChannelsComeFirstAndArchivedOrDuplicateRowsAreDropped() {
        let channels = RelayChannels.list([
            ["name": "general", "member_count": 12],
            ["name": "Launch", "topic": "Launch prep", "member_count": 3],
            ["name": "old", "is_archived": true],
            ["name": "general", "member_count": 1],
            ["name": "  "],
        ], joined: ["Launch"])
        XCTAssertEqual(channels.map(\.name), ["Launch", "general"])
        XCTAssertEqual(channels.map(\.isJoined), [true, false])
        XCTAssertEqual(channels[0].id, "channel:Launch")
        XCTAssertEqual(channels[0].address, "#Launch")
        XCTAssertEqual(channels[0].objective, "Launch prep")
        XCTAssertEqual(channels[0].subtitle, "3 members")
        XCTAssertEqual(channels[1].subtitle, "Not joined · 12 members")
        XCTAssertEqual(channels[0].source, .channel)
        XCTAssertFalse(channels[0].isReachable())
    }

    func testJoinedNamesComeFromThePersonsOwnRecord() {
        let record: JSONObject = ["name": "ada", "channels": [["name": "launch", "role": "member"], ["name": ""]]]
        XCTAssertEqual(RelayChannels.joinedNames(record), ["launch"])
        XCTAssertEqual(RelayChannels.joinedNames([:]), [])
    }

    func testSenderUsesRosterIdentityForPeopleAndAgents() {
        let person = RelayAgent(relay: ["name": "will-washburn", "type": "human", "persona": "Will Washburn"])
        let bot = RelayAgent(relay: ["name": "awsexitgrok", "address": "awsexitgrok@cloud-123", "status": "active"])
        XCTAssertTrue(RelayChannels.sender(named: "will-washburn", in: [bot, person]).isHuman)
        XCTAssertEqual(RelayChannels.sender(named: "awsexitgrok", in: [bot, person]).cli, "grok")
        let departed = RelayChannels.sender(named: "gone", in: [bot, person])
        XCTAssertEqual(departed.name, "gone")
        XCTAssertFalse(departed.isHuman)
    }

    func testChannelNamesAreOnePathSegment() {
        XCTAssertEqual(RelayChannels.pathComponent("launch"), "launch")
        XCTAssertEqual(RelayChannels.pathComponent("a/b?c#d"), "a%2Fb%3Fc%23d")
    }
}
