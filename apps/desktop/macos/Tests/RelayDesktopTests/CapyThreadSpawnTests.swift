import XCTest
@testable import RelayDesktopCore

final class CapyThreadSpawnTests: XCTestCase {
    func testOperationIsSavedBeforeRetryAndReused() throws {
        let suite = "capy-spawn-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = CapySpawnStore(defaults: defaults)

        let first = try store.prepare(
            workspaceID: "workspace",
            projectID: "project",
            task: "Review the pull request",
            model: "capy-model",
            pullRequestAuthor: "capy",
            reportTo: nil
        )
        let restored = CapySpawnStore(defaults: defaults).operation(workspaceID: "workspace")
        XCTAssertEqual(restored, first)

        let retry = try store.prepare(
            workspaceID: "workspace",
            projectID: "project",
            task: "Review the pull request",
            model: "capy-model",
            pullRequestAuthor: "capy",
            reportTo: nil
        )
        XCTAssertEqual(retry.clientRequestID, first.clientRequestID)
        XCTAssertTrue(retry.clientRequestID.hasPrefix("relay-desktop-"))
    }

    func testCreatedOperationIsReusedUntilStartAnotherClearsIt() throws {
        let suite = "capy-spawn-created-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = CapySpawnStore(defaults: defaults)
        let first = try store.prepare(workspaceID: "workspace", projectID: "project", task: "Task",
                                      model: nil, pullRequestAuthor: nil, reportTo: nil)
        let created = try store.markCreated(first, threadID: "jam_01THREAD")
        XCTAssertEqual(store.operation(workspaceID: "workspace"), created)
        XCTAssertNil(store.operation(workspaceID: "another"))

        let statusRetry = try store.prepare(workspaceID: "workspace", projectID: "project", task: "Task",
                                            model: nil, pullRequestAuthor: nil, reportTo: nil)
        XCTAssertEqual(statusRetry, created)

        store.clear()
        let next = try store.prepare(workspaceID: "workspace", projectID: "project", task: "Task",
                                     model: nil, pullRequestAuthor: nil, reportTo: nil)
        XCTAssertNotEqual(next.clientRequestID, first.clientRequestID)
        XCTAssertNil(next.threadID)
    }

    func testPresentationWordsAndSettingsURL() {
        XCTAssertEqual(CapySpawnPresentation.starting, "Starting Capy thread…")
        XCTAssertEqual(CapySpawnPresentation.waiting,
                       "Thread started · Waiting for Capy to join the relay")
        XCTAssertEqual(
            CapySpawnPresentation.cloudSettingsURL(
                siteURL: "https://user:secret@agentrelay.com/other?q=1#old"
            )?.absoluteString,
            "https://agentrelay.com/cloud/dashboard/settings#capy"
        )
        XCTAssertNil(CapySpawnPresentation.cloudSettingsURL(siteURL: "file:///tmp"))
    }
}
