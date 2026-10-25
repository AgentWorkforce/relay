import Foundation

public enum AppUpdateArchitecture: String, Sendable {
    case arm64
    case x64

    public static var current: AppUpdateArchitecture {
        #if arch(arm64)
        return .arm64
        #else
        return .x64
        #endif
    }
}

public struct AppRelease: Codable, Equatable, Sendable {
    public let version: String
    public let downloadURL: URL
    public let checksumURL: URL

    public init(version: String, downloadURL: URL, checksumURL: URL) {
        self.version = version
        self.downloadURL = downloadURL
        self.checksumURL = checksumURL
    }
}

public enum AppUpdateMetadataError: Error, Equatable {
    case invalidResponse
    case invalidVersion
    case missingAsset(String)
    case insecureAssetURL
}

/// Parses the public GitHub release used by both the website download links and
/// the desktop updater. Keeping this logic in Core makes release selection and
/// version comparison testable without launching AppKit.
public enum AppUpdateMetadata {
    public static let latestReleaseURL = URL(
        string: "https://api.github.com/repos/AgentWorkforce/relay-desktop-releases/releases/latest"
    )!

    public static func release(
        from data: Data,
        architecture: AppUpdateArchitecture
    ) throws -> AppRelease {
        let response: GitHubRelease
        do {
            response = try JSONDecoder().decode(GitHubRelease.self, from: data)
        } catch {
            throw AppUpdateMetadataError.invalidResponse
        }

        guard !response.draft, !response.prerelease else {
            throw AppUpdateMetadataError.invalidResponse
        }

        let version = response.tagName.hasPrefix("v")
            ? String(response.tagName.dropFirst())
            : response.tagName
        guard AppVersion(version) != nil else {
            throw AppUpdateMetadataError.invalidVersion
        }

        let filename = "AgentRelay-\(version)-macOS-\(architecture.rawValue).dmg"
        guard let downloadURL = response.assets.first(where: { $0.name == filename })?.browserDownloadURL else {
            throw AppUpdateMetadataError.missingAsset(filename)
        }
        guard let checksumURL = response.assets.first(where: { $0.name == "\(filename).sha256" })?.browserDownloadURL else {
            throw AppUpdateMetadataError.missingAsset("\(filename).sha256")
        }
        guard downloadURL.scheme == "https", downloadURL.host == "github.com",
              checksumURL.scheme == "https", checksumURL.host == "github.com" else {
            throw AppUpdateMetadataError.insecureAssetURL
        }

        return AppRelease(version: version, downloadURL: downloadURL, checksumURL: checksumURL)
    }

    public static func isNewer(_ candidate: String, than installed: String) -> Bool {
        guard let candidateVersion = AppVersion(candidate),
              let installedVersion = AppVersion(installed) else { return false }
        return candidateVersion > installedVersion
    }

    /// GitHub checksum assets use the standard `<digest>  <filename>` format.
    public static func checksum(from data: Data) -> String? {
        guard let text = String(data: data, encoding: .utf8),
              let token = text.split(whereSeparator: \Character.isWhitespace).first else { return nil }
        let value = token.lowercased()
        guard value.count == 64, value.allSatisfy({ $0.isHexDigit }) else { return nil }
        return value
    }
}

private struct GitHubRelease: Decodable {
    let tagName: String
    let draft: Bool
    let prerelease: Bool
    let assets: [GitHubAsset]

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case draft
        case prerelease
        case assets
    }
}

private struct GitHubAsset: Decodable {
    let name: String
    let browserDownloadURL: URL

    enum CodingKeys: String, CodingKey {
        case name
        case browserDownloadURL = "browser_download_url"
    }
}

private struct AppVersion: Comparable {
    let components: [Int]
    let prerelease: String?

    init?(_ value: String) {
        let versionAndBuild = value.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
        let versionAndPrerelease = versionAndBuild[0].split(
            separator: "-",
            maxSplits: 1,
            omittingEmptySubsequences: false
        )
        let pieces = versionAndPrerelease[0].split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count == 3 else { return nil }
        let components = pieces.compactMap { Int($0) }
        guard components.count == 3, components.allSatisfy({ $0 >= 0 }) else { return nil }
        self.components = components
        if versionAndPrerelease.count == 2, !versionAndPrerelease[1].isEmpty {
            prerelease = String(versionAndPrerelease[1])
        } else {
            prerelease = nil
        }
    }

    static func < (lhs: AppVersion, rhs: AppVersion) -> Bool {
        if lhs.components != rhs.components {
            return lhs.components.lexicographicallyPrecedes(rhs.components)
        }
        switch (lhs.prerelease, rhs.prerelease) {
        case (nil, nil): return false
        case (nil, _): return false
        case (_, nil): return true
        case let (left?, right?): return left.localizedStandardCompare(right) == .orderedAscending
        }
    }
}
