import Foundation

/// Where the relay core runs: a launchd LaunchAgent the app registers
/// through SMAppService or, when macOS loses its bundle path, directly.
/// It runs at login with no window, keeps
/// delivering through app crashes and updates, and launchd restarts it
/// when it exits. Behind a protocol so tests never touch launchd.
public protocol CoreService: AnyObject {
    var status: CoreServiceStatus { get }
    /// Why this copy of the app must be moved before registering its agent.
    var installationProblem: String? { get }
    /// Identifies the core binary this bundle carries. launchd admits only
    /// the binary the agent was registered with, so a new one (an update)
    /// is registered again.
    var binaryIdentity: String? { get }
    func register() throws
    func unregister() throws
    /// Repairs the macOS BTM record that loses the bundle containing a
    /// BundleProgram. Other implementations have nothing to repair.
    func recoverSpawnFailure() throws -> Bool
    /// Opens System Settings › General › Login Items.
    func openSystemSettings()
}

public extension CoreService {
    var installationProblem: String? { nil }
    func recoverSpawnFailure() throws -> Bool { false }
}

public enum CoreServiceStatus: Equatable, Sendable {
    /// Registered and allowed to run.
    case enabled
    /// Registered, but the person must allow it in Login Items.
    case requiresApproval
    case notRegistered
    /// This build carries no LaunchAgent (`swift run`): a core started by
    /// hand serves it.
    case notFound
}
