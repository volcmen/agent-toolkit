import Foundation

public protocol LauncherClock: Sendable {
    var now: TimeInterval { get }
    func sleep(for interval: TimeInterval) async throws
}

public protocol LaunchLockAcquisitionError: Error, Sendable {
    var isTimeout: Bool { get }
}

public protocol LaunchLocking: Sendable {
    func acquire(timeout: TimeInterval, pollInterval: TimeInterval) throws -> any LaunchLockLeasing
}

public protocol LaunchLockLeasing: AnyObject, Sendable {
    func release()
}

public protocol LauncherSystem: Sendable {
    func chromeIsInstalled(configuration: LauncherConfiguration) -> Bool
    func prepareProfile(configuration: LauncherConfiguration) throws
    func snapshot(configuration: LauncherConfiguration) async throws -> SystemSnapshot
    func launchChrome(configuration: LauncherConfiguration) throws
    func createBlankTarget(configuration: LauncherConfiguration) async throws
    func activate(pid: Int32) throws
}

public enum LauncherOutcome: Equatable, Sendable {
    case launched(pid: Int32)
    case reused(pid: Int32)
}
