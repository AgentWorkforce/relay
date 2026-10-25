import AppKit
import Foundation

enum AppUpdateInstallError: LocalizedError, Equatable {
    case invalidLocation
    case permissionDenied
    case invalidImage
    case invalidApp

    var errorDescription: String? {
        switch self {
        case .invalidLocation: return "Move Agent Relay to a writable folder such as Applications before updating."
        case .permissionDenied: return "Agent Relay cannot replace the app in its current folder. Check folder permissions and try again."
        case .invalidImage: return "The downloaded disk image could not be mounted."
        case .invalidApp: return "The update does not contain a valid Agent Relay app."
        }
    }
}

/// Prepares and verifies the replacement before the running app quits. A small
/// detached shell process performs the final swap once this process exits.
enum AppUpdateInstaller {
    static func prepare(diskImage: URL, installedApp: URL = Bundle.main.bundleURL) throws -> URL {
        let fileManager = FileManager.default
        let installedApp = installedApp.standardizedFileURL.resolvingSymlinksInPath()
        let parent = installedApp.deletingLastPathComponent()
        guard installedApp.pathExtension == "app", installedApp.lastPathComponent == "Agent Relay.app",
              fileManager.fileExists(atPath: installedApp.path),
              parent.path != "/Volumes", !installedApp.path.hasPrefix("/Volumes/") else {
            throw AppUpdateInstallError.invalidLocation
        }
        guard fileManager.isWritableFile(atPath: parent.path) else {
            throw AppUpdateInstallError.permissionDenied
        }

        let work = fileManager.temporaryDirectory.appendingPathComponent("agent-relay-update-\(UUID().uuidString)")
        let mount = work.appendingPathComponent("mount")
        let staged = parent.appendingPathComponent(".Agent Relay-update-\(UUID().uuidString).app")
        try fileManager.createDirectory(at: mount, withIntermediateDirectories: true)
        var mounted = false
        defer {
            if mounted { try? run("/usr/bin/hdiutil", ["detach", mount.path, "-quiet"]) }
            try? fileManager.removeItem(at: work)
        }
        do {
            try run("/usr/bin/hdiutil", ["attach", diskImage.path, "-readonly", "-nobrowse", "-mountpoint", mount.path, "-quiet"])
            mounted = true
        } catch {
            throw AppUpdateInstallError.invalidImage
        }

        let source = mount.appendingPathComponent("Agent Relay.app")
        guard let bundle = Bundle(url: source), bundle.bundleIdentifier == "com.agentrelay.desktop" else {
            throw AppUpdateInstallError.invalidApp
        }
        do {
            try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", source.path])
            try run("/usr/sbin/spctl", ["--assess", "--type", "execute", source.path])
            try run("/usr/bin/ditto", [source.path, staged.path])
            return staged
        } catch {
            try? fileManager.removeItem(at: staged)
            throw AppUpdateInstallError.invalidApp
        }
    }

    static func launchReplacement(stagedApp: URL, installedApp: URL = Bundle.main.bundleURL) throws {
        let fileManager = FileManager.default
        let work = fileManager.temporaryDirectory.appendingPathComponent("agent-relay-swap-\(UUID().uuidString)")
        try fileManager.createDirectory(at: work, withIntermediateDirectories: true)
        let script = work.appendingPathComponent("install.sh")
        try Self.script.write(to: script, atomically: true, encoding: .utf8)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier),
                             stagedApp.path, installedApp.standardizedFileURL.resolvingSymlinksInPath().path, work.path]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
    }

    private static func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw AppUpdateInstallError.invalidApp }
    }

    private static let script = """
    #!/bin/sh
    pid="$1"
    staged="$2"
    installed="$3"
    work="$4"
    backup="${installed}.previous-update-$$"
    trap 'rm -rf "$work" "$staged"' EXIT
    while kill -0 "$pid" 2>/dev/null; do sleep 1; done
    if ! mv "$installed" "$backup"; then
      open "$installed"
      exit 1
    fi
    if mv "$staged" "$installed"; then
      if open "$installed"; then
        rm -rf "$backup"
      else
        rm -rf "$installed"
        mv "$backup" "$installed"
        open "$installed"
        exit 1
      fi
    else
      mv "$backup" "$installed"
      open "$installed"
      exit 1
    fi
    """
}
