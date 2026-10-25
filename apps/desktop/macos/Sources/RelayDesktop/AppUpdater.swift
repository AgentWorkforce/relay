import AppKit
import CryptoKit
import Foundation
import RelayDesktopCore

enum AppUpdateState: Equatable {
    case idle
    case checking
    case upToDate(Date)
    case available(AppRelease)
    case downloading(AppRelease)
    case installing(AppRelease)
    case unavailable(String)
    case failed(String)
}

@MainActor
final class AppUpdater: ObservableObject {
    static let shared = AppUpdater()

    @Published private(set) var state: AppUpdateState = .idle
    @Published var automaticallyChecksForUpdates: Bool {
        didSet { defaults.set(automaticallyChecksForUpdates, forKey: Self.automaticChecksKey) }
    }

    private static let automaticChecksKey = "automaticallyChecksForAppUpdates"
    private static let lastCheckKey = "lastAppUpdateCheck"
    private static let cachedReleaseKey = "cachedAppUpdateRelease"
    private static let automaticCheckInterval: TimeInterval = 24 * 60 * 60
    private static let automaticCheckPollingInterval: UInt64 = 15 * 60 * 1_000_000_000

    private let defaults: UserDefaults
    private let session: URLSession
    private let now: () -> Date
    private let currentVersion: String
    private let terminate: @MainActor () -> Void

    init(
        defaults: UserDefaults = .standard,
        session: URLSession = .shared,
        currentVersion: String = AppInfo.version,
        now: @escaping () -> Date = Date.init,
        terminate: @escaping @MainActor () -> Void = { NSApp.terminate(nil) }
    ) {
        self.defaults = defaults
        self.session = session
        self.currentVersion = currentVersion
        self.now = now
        self.terminate = terminate
        if defaults.object(forKey: Self.automaticChecksKey) == nil {
            automaticallyChecksForUpdates = true
        } else {
            automaticallyChecksForUpdates = defaults.bool(forKey: Self.automaticChecksKey)
        }
        restoreCachedState()
    }

    var isBusy: Bool {
        switch state {
        case .checking, .downloading, .installing: return true
        default: return false
        }
    }

    /// Polls cheaply while the app is alive. Successful checks remain limited
    /// to once per day; failures retry on the next poll so login-item launches
    /// do not wait for a relaunch when the network was initially unavailable.
    func runAutomaticChecks() async {
        while !Task.isCancelled {
            await checkAutomaticallyIfNeeded()
            do {
                try await Task.sleep(nanoseconds: Self.automaticCheckPollingInterval)
            } catch {
                return
            }
        }
    }

    func checkAutomaticallyIfNeeded() async {
        guard automaticallyChecksForUpdates,
              currentVersion != "development build" else { return }
        if let lastCheck = defaults.object(forKey: Self.lastCheckKey) as? Date {
            let elapsed = now().timeIntervalSince(lastCheck)
            if elapsed >= 0, elapsed < Self.automaticCheckInterval { return }
        }
        await checkForUpdates()
    }

    func checkForUpdates() async {
        guard !isBusy else { return }
        guard currentVersion != "development build" else {
            state = .unavailable("Update checks are available in installed release builds.")
            return
        }

        state = .checking
        do {
            var request = URLRequest(url: AppUpdateMetadata.latestReleaseURL)
            request.timeoutInterval = 15
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("AgentRelay/\(currentVersion)", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw UpdateError.releaseLookupFailed
            }
            let release = try AppUpdateMetadata.release(from: data, architecture: .current)
            let checkedAt = now()
            defaults.set(checkedAt, forKey: Self.lastCheckKey)
            if let encodedRelease = try? JSONEncoder().encode(release) {
                defaults.set(encodedRelease, forKey: Self.cachedReleaseKey)
            }
            state = AppUpdateMetadata.isNewer(release.version, than: currentVersion)
                ? .available(release)
                : .upToDate(checkedAt)
        } catch {
            state = .failed(Self.checkMessage(for: error))
        }
    }

    func downloadAndInstall(_ release: AppRelease) async {
        guard !isBusy else { return }
        state = .downloading(release)
        var temporaryURL: URL?
        do {
            async let checksumRequest = session.data(from: release.checksumURL)
            let (downloadedURL, response) = try await session.download(from: release.downloadURL)
            temporaryURL = downloadedURL
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw UpdateError.downloadFailed
            }
            let (checksumData, checksumResponse) = try await checksumRequest
            guard let http = checksumResponse as? HTTPURLResponse, http.statusCode == 200,
                  let expectedChecksum = AppUpdateMetadata.checksum(from: checksumData) else {
                throw UpdateError.invalidChecksum
            }
            guard try await Self.sha256(of: downloadedURL) == expectedChecksum else {
                throw UpdateError.checksumMismatch
            }
            state = .installing(release)
            let staged = try await Task.detached(priority: .userInitiated) {
                try AppUpdateInstaller.prepare(diskImage: downloadedURL)
            }.value
            do {
                try AppUpdateInstaller.launchReplacement(stagedApp: staged)
            } catch {
                try? FileManager.default.removeItem(at: staged)
                throw error
            }
            temporaryURL = nil
            terminate()
        } catch {
            if let temporaryURL { try? FileManager.default.removeItem(at: temporaryURL) }
            state = .failed(Self.downloadMessage(for: error))
        }
    }

    private func restoreCachedState() {
        guard currentVersion != "development build",
              let lastCheck = defaults.object(forKey: Self.lastCheckKey) as? Date,
              let data = defaults.data(forKey: Self.cachedReleaseKey),
              let release = try? JSONDecoder().decode(AppRelease.self, from: data) else { return }
        state = AppUpdateMetadata.isNewer(release.version, than: currentVersion)
            ? .available(release)
            : .upToDate(lastCheck)
    }

    private static func sha256(of url: URL) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hasher = SHA256()
            while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty {
                hasher.update(data: data)
            }
            return hasher.finalize().map { String(format: "%02x", $0) }.joined()
        }.value
    }

    private static func checkMessage(for error: Error) -> String {
        switch error {
        case AppUpdateMetadataError.missingAsset:
            return "The latest release does not include a compatible update."
        default:
            return "Agent Relay could not read the latest release information. Try again later."
        }
    }

    private static func downloadMessage(for error: Error) -> String {
        switch error {
        case let error as AppUpdateInstallError:
            return error.localizedDescription
        case UpdateError.invalidChecksum, UpdateError.checksumMismatch:
            return "The downloaded update could not be verified and was discarded."
        default:
            return "Agent Relay could not download the update. Check your connection and try again."
        }
    }
}

private enum UpdateError: Error {
    case releaseLookupFailed
    case downloadFailed
    case invalidChecksum
    case checksumMismatch
}
