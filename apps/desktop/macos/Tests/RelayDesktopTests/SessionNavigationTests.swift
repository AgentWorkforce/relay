import XCTest
@testable import RelayDesktopCore

final class SessionNavigationTests: XCTestCase {
    func testBuildsCloudSessionURLFromHostAndEncodesSessionAsOneComponent() {
        XCTAssertEqual(
            SessionNavigation.cloudURL(
                siteURL: "https://agentrelay.com/an/ignored/path?old=query",
                sessionId: "session/with spaces"
            )?.absoluteString,
            "https://agentrelay.com/cloud/dashboard/sessions/session%2Fwith%20spaces"
        )
    }

    func testRejectsNonWebAndEmptySessionURLs() {
        XCTAssertNil(SessionNavigation.cloudURL(siteURL: "file:///tmp", sessionId: "session"))
        XCTAssertNil(SessionNavigation.cloudURL(siteURL: "https://agentrelay.com", sessionId: ""))
    }

    func testOnlyUploadedSessionsHaveACloudPage() {
        let uploaded = Fixture.uploadSession(sessionId: "one", status: .uploaded)
        XCTAssertEqual(
            SessionNavigation.cloudURL(siteURL: "https://agentrelay.com", session: uploaded)?.absoluteString,
            "https://agentrelay.com/cloud/dashboard/sessions/one"
        )
        XCTAssertNil(SessionNavigation.cloudURL(siteURL: "https://agentrelay.com",
                                                session: Fixture.uploadSession(sessionId: "one", status: .notShared)))
    }
}
