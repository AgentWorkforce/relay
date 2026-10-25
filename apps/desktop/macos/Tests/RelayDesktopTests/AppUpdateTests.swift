import Foundation
import XCTest
@testable import RelayDesktop
@testable import RelayDesktopCore

final class UpdateURLProtocol: URLProtocol {
    static let lock = NSLock()
    static var responseData = Data()
    static var statusCode = 200
    static var requests = 0

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        Self.requests += 1
        let data = Self.responseData
        let statusCode = Self.statusCode
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func reset(with data: Data, statusCode: Int = 200) {
        lock.lock()
        defer { lock.unlock() }
        responseData = data
        self.statusCode = statusCode
        requests = 0
    }

    static func setResponse(data: Data, statusCode: Int) {
        lock.lock()
        defer { lock.unlock() }
        responseData = data
        self.statusCode = statusCode
    }

    static var requestCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }
}

@MainActor
final class AppUpdateTests: XCTestCase {
    func testParsesVersionedAssetForArchitecture() throws {
        let release = try AppUpdateMetadata.release(
            from: releaseJSON(version: "2026.09.10"),
            architecture: .arm64
        )

        XCTAssertEqual(release.version, "2026.09.10")
        XCTAssertEqual(release.downloadURL.lastPathComponent, "AgentRelay-2026.09.10-macOS-arm64.dmg")
        XCTAssertEqual(release.checksumURL.lastPathComponent, "AgentRelay-2026.09.10-macOS-arm64.dmg.sha256")
    }

    func testRequiresMatchingDiskImageAndChecksum() throws {
        XCTAssertThrowsError(
            try AppUpdateMetadata.release(from: releaseJSON(version: "2026.09.10", omitChecksum: true), architecture: .x64)
        ) { error in
            XCTAssertEqual(
                error as? AppUpdateMetadataError,
                .missingAsset("AgentRelay-2026.09.10-macOS-x64.dmg.sha256")
            )
        }
    }

    func testComparesCalVerNumerically() {
        XCTAssertTrue(AppUpdateMetadata.isNewer("2026.09.10", than: "2026.09.3"))
        XCTAssertFalse(AppUpdateMetadata.isNewer("2026.09.3", than: "2026.09.10"))
        XCTAssertFalse(AppUpdateMetadata.isNewer("2026.09.3", than: "2026.09.3"))
        XCTAssertTrue(AppUpdateMetadata.isNewer("2026.09.3", than: "2026.09.3-rc.1"))
        XCTAssertFalse(AppUpdateMetadata.isNewer("2026.09.3", than: "development build"))
    }

    func testParsesStandardSHA256File() {
        let digest = String(repeating: "a", count: 64)
        let data = Data("\(digest)  AgentRelay-2026.09.10-macOS-arm64.dmg\n".utf8)
        XCTAssertEqual(AppUpdateMetadata.checksum(from: data), digest)
        XCTAssertNil(AppUpdateMetadata.checksum(from: Data("not-a-checksum file.dmg".utf8)))
    }

    func testUpdaterFindsNewReleaseAndThrottlesAutomaticChecks() async throws {
        let data = releaseJSON(version: "2026.09.10")
        UpdateURLProtocol.reset(with: data)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UpdateURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let suite = "app-update-test-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var date = Date(timeIntervalSince1970: 1_000)
        let updater = AppUpdater(
            defaults: defaults,
            session: session,
            currentVersion: "2026.09.3",
            now: { date }
        )

        await updater.checkForUpdates()
        guard case let .available(release) = updater.state else {
            return XCTFail("Expected an available update, got \(updater.state)")
        }
        XCTAssertEqual(release.version, "2026.09.10")
        XCTAssertEqual(UpdateURLProtocol.requestCount, 1)

        date.addTimeInterval(60 * 60)
        let restoredUpdater = AppUpdater(
            defaults: defaults,
            session: session,
            currentVersion: "2026.09.3",
            now: { date }
        )
        guard case let .available(restoredRelease) = restoredUpdater.state else {
            return XCTFail("Expected the cached update after relaunch, got \(restoredUpdater.state)")
        }
        XCTAssertEqual(restoredRelease, release)

        await restoredUpdater.checkAutomaticallyIfNeeded()
        XCTAssertEqual(UpdateURLProtocol.requestCount, 1)
    }

    func testAutomaticChecksCanBeDisabled() async throws {
        UpdateURLProtocol.reset(with: releaseJSON(version: "2026.09.10"))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UpdateURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let suite = "app-update-test-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let updater = AppUpdater(defaults: defaults, session: session, currentVersion: "2026.09.3")
        updater.automaticallyChecksForUpdates = false

        await updater.checkAutomaticallyIfNeeded()

        XCTAssertEqual(UpdateURLProtocol.requestCount, 0)
        XCTAssertEqual(updater.state, .idle)
    }

    func testAutomaticCheckRetriesAfterFailure() async throws {
        let data = releaseJSON(version: "2026.09.10")
        UpdateURLProtocol.reset(with: data, statusCode: 503)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UpdateURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let suite = "app-update-test-\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let updater = AppUpdater(defaults: defaults, session: session, currentVersion: "2026.09.3")

        await updater.checkAutomaticallyIfNeeded()
        guard case .failed = updater.state else {
            return XCTFail("Expected a failed first check, got \(updater.state)")
        }
        XCTAssertEqual(UpdateURLProtocol.requestCount, 1)

        UpdateURLProtocol.setResponse(data: data, statusCode: 200)
        await updater.checkAutomaticallyIfNeeded()
        guard case .available = updater.state else {
            return XCTFail("Expected the retry to find the update, got \(updater.state)")
        }
        XCTAssertEqual(UpdateURLProtocol.requestCount, 2)
    }

    func testInstallerRejectsNonAppDestinationBeforeMounting() {
        let image = URL(fileURLWithPath: "/nonexistent/update.dmg")
        let destination = URL(fileURLWithPath: "/Applications/Other.app")
        XCTAssertThrowsError(try AppUpdateInstaller.prepare(diskImage: image, installedApp: destination)) { error in
            XCTAssertEqual(error as? AppUpdateInstallError, .invalidLocation)
        }
    }

    private func releaseJSON(version: String, omitChecksum: Bool = false) -> Data {
        var assets = [
            asset("AgentRelay-\(version)-macOS-arm64.dmg"),
            asset("AgentRelay-\(version)-macOS-arm64.dmg.sha256"),
            asset("AgentRelay-\(version)-macOS-x64.dmg")
        ]
        if !omitChecksum { assets.append(asset("AgentRelay-\(version)-macOS-x64.dmg.sha256")) }
        return try! JSONSerialization.data(withJSONObject: [
            "tag_name": "v\(version)",
            "draft": false,
            "prerelease": false,
            "assets": assets
        ])
    }

    private func asset(_ name: String) -> [String: String] {
        [
            "name": name,
            "browser_download_url": "https://github.com/AgentWorkforce/relay-desktop-releases/releases/download/latest/\(name)"
        ]
    }
}
