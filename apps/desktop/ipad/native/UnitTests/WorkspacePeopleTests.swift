import XCTest
@testable import AgentRelayiPad

final class WorkspacePeopleTests: XCTestCase {
    private let workspace = "00000000-0000-4000-8000-000000000001"
    private let otherWorkspace = "00000000-0000-4000-8000-000000000002"
    private let row: [String: Any] = ["handle": "sam-lee", "displayName": "Sam Lee",
                                      "avatarUrl": "https://images.example/sam.png"]

    func testDecodesProfileAndNullableFields() throws {
        let profile = try XCTUnwrap(WorkspacePerson(row))
        XCTAssertEqual(profile.handle, "sam-lee")
        XCTAssertEqual(profile.displayName, "Sam Lee")
        XCTAssertEqual(profile.avatarURL?.absoluteString, "https://images.example/sam.png")
        let unnamed = try XCTUnwrap(WorkspacePerson(["handle": "sam", "displayName": NSNull(), "avatarUrl": NSNull()]))
        XCTAssertEqual(unnamed.displayName, "")
        XCTAssertNil(unnamed.avatarURL)
        XCTAssertNil(WorkspacePerson(["handle": "sam@machine"]))
        XCTAssertNil(WorkspacePerson(["handle": " sam"]))
        XCTAssertNil(WorkspacePerson(["handle": ""]))
    }

    func testOnlyAcceptsAnonymousHTTPSPhotoURLs() {
        for value in ["", "/sam.png", "http://images.example/sam.png", "file:///tmp/sam.png",
                      "data:image/png;base64,abcd", "https:///sam.png", "https://user@images.example/sam.png",
                      "https://user:secret@images.example/sam.png", "https://images.example:8080/sam.png",
                      "https://images.example/sam.png#fragment"] {
            XCTAssertNil(PersonPhotoURL.parse(value), value)
        }
        XCTAssertNotNil(PersonPhotoURL.parse("https://images.example:443/sam.png?size=96"))
    }

    func testMatchesOnlyExactHumanHandleInCurrentScope() {
        var directory = WorkspacePeopleDirectory()
        let request = directory.begin(workspaceID: workspace, sessionGeneration: 1)
        XCTAssertTrue(directory.finish(["people": [row]], for: request))
        XCTAssertNotNil(directory.person(handle: "sam-lee", isHuman: true, workspaceID: workspace, sessionGeneration: 1))
        XCTAssertNil(directory.person(handle: "sam-lee", isHuman: false, workspaceID: workspace, sessionGeneration: 1))
        XCTAssertNil(directory.person(handle: "sam-lee@machine", isHuman: true, workspaceID: workspace, sessionGeneration: 1))
        XCTAssertNil(directory.person(handle: "Sam-Lee", isHuman: true, workspaceID: workspace, sessionGeneration: 1))
        XCTAssertNil(directory.person(handle: "sam-lee", isHuman: true, workspaceID: otherWorkspace, sessionGeneration: 1))
        XCTAssertNil(directory.person(handle: "sam-lee", isHuman: true, workspaceID: workspace, sessionGeneration: 2))
    }

    func testOverlappingRefreshCannotOverwriteNewerPhoto() {
        var directory = WorkspacePeopleDirectory()
        let old = directory.begin(workspaceID: workspace, sessionGeneration: 1)
        let new = directory.begin(workspaceID: workspace, sessionGeneration: 1)
        let updated: [String: Any] = ["handle": "sam-lee", "avatarUrl": "https://images.example/new.png"]
        XCTAssertTrue(directory.finish(["people": [updated]], for: new))
        XCTAssertFalse(directory.finish(["people": [row]], for: old))
        XCTAssertEqual(directory.people["sam-lee"]?.avatarURL?.lastPathComponent, "new.png")
    }

    func testWorkspaceSwitchClearsImmediatelyAndRejectsLateResponse() {
        var directory = WorkspacePeopleDirectory()
        let old = directory.begin(workspaceID: workspace, sessionGeneration: 1)
        directory.finish(["people": [row]], for: old)
        let new = directory.begin(workspaceID: otherWorkspace, sessionGeneration: 1)
        XCTAssertTrue(directory.people.isEmpty)
        XCTAssertFalse(directory.finish(["people": [row]], for: old))
        XCTAssertTrue(directory.finish(["people": []], for: new))
    }

    func testSignOutAndReturnToSameWorkspaceRejectsOldResponse() {
        var directory = WorkspacePeopleDirectory()
        let old = directory.begin(workspaceID: workspace, sessionGeneration: 1)
        directory.finish(["people": [row]], for: old)
        directory.reset()
        XCTAssertTrue(directory.people.isEmpty)
        XCTAssertFalse(directory.finish(["people": [row]], for: old))
        _ = directory.begin(workspaceID: workspace, sessionGeneration: 2)
        XCTAssertFalse(directory.finish(["people": [row]], for: old))
        XCTAssertTrue(directory.people.isEmpty)
    }

    func testIdentityChangeWithinWorkspaceClearsProfiles() {
        var directory = WorkspacePeopleDirectory()
        let old = directory.begin(workspaceID: workspace, sessionGeneration: 1)
        directory.finish(["people": [row]], for: old)
        _ = directory.begin(workspaceID: workspace, sessionGeneration: 2)
        XCTAssertTrue(directory.people.isEmpty)
    }

    func testFailureOrRemovedMembershipDropsPreviousPhotos() {
        var directory = WorkspacePeopleDirectory()
        let old = directory.begin(workspaceID: workspace, sessionGeneration: 1)
        directory.finish(["people": [row]], for: old)
        let new = directory.begin(workspaceID: workspace, sessionGeneration: 1)
        directory.finish([:], for: new)
        XCTAssertTrue(directory.people.isEmpty)
    }

    func testDuplicateHandlesAreIgnoredAndNeverCrash() {
        var directory = WorkspacePeopleDirectory()
        let request = directory.begin(workspaceID: workspace, sessionGeneration: 1)
        directory.finish(["people": [row, row, ["handle": "other-person"]]], for: request)
        XCTAssertNil(directory.people["sam-lee"])
        XCTAssertNotNil(directory.people["other-person"])
    }
}
