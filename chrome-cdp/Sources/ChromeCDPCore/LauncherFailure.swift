import Foundation

public enum LauncherFailure: Error, Equatable, Sendable, LocalizedError {
    case missingChrome(applicationPath: String)
    case lockTimeout
    case unsafeProfile(UnsafeProfileReason)
    case foreignListener(pid: Int32?, port: UInt16)
    case nonLoopbackListener(address: String, port: UInt16)
    case wrongProfileChrome(pid: Int32, profilePath: String)
    case profileConflict(pid: Int32?, profilePath: String)
    case readinessTimeout(lastFailure: EndpointFailure)
    case invalidWebSocket(EndpointFailure)
    case launchFailed
    case targetCreationFailed
    case activationFailed(pid: Int32)

    public var exitCode: Int32 {
        switch self {
        case .missingChrome:
            return 10
        case .lockTimeout:
            return 11
        case .unsafeProfile:
            return 12
        case .foreignListener:
            return 13
        case .nonLoopbackListener:
            return 14
        case .wrongProfileChrome:
            return 15
        case .profileConflict:
            return 16
        case .readinessTimeout:
            return 17
        case .invalidWebSocket:
            return 18
        case .launchFailed:
            return 19
        case .targetCreationFailed:
            return 20
        case .activationFailed:
            return 21
        }
    }

    public var errorDescription: String? {
        switch self {
        case let .missingChrome(applicationPath):
            return "Google Chrome was not found at \(applicationPath). Install Google Chrome and try again."
        case .lockTimeout:
            return "Another Chrome CDP launch is still in progress. Wait a moment and try again. \(Self.conflictSafetySentence)"
        case let .unsafeProfile(reason):
            return unsafeProfileDescription(reason)
        case let .foreignListener(pid, port):
            let owner = pid.map { "PID \($0)" } ?? "an unknown process"
            return "Port \(port) is already in use by \(owner). Free the port before retrying. \(Self.conflictSafetySentence)"
        case let .nonLoopbackListener(address, port):
            return "CDP listener \(address):\(port) is not restricted to 127.0.0.1. Correct that process before retrying. \(Self.conflictSafetySentence)"
        case let .wrongProfileChrome(pid, profilePath):
            _ = profilePath
            return "Chrome PID \(pid) is serving CDP with a different profile. Close or reconfigure that Chrome instance before retrying. \(Self.conflictSafetySentence)"
        case let .profileConflict(pid, profilePath):
            let owner = pid.map { "Chrome PID \($0)" } ?? "More than one Chrome process"
            return "\(owner) is using the dedicated profile \(profilePath) without the required Chrome CDP configuration. Close or reconfigure the conflicting Chrome instance before retrying. \(Self.conflictSafetySentence)"
        case .readinessTimeout:
            return "Chrome did not become ready for local CDP before the readiness deadline. Check the Chrome window and retry. \(Self.conflictSafetySentence)"
        case .invalidWebSocket:
            return "Chrome returned an unsafe CDP WebSocket endpoint. Correct the Chrome CDP configuration before retrying."
        case .launchFailed:
            return "Chrome could not be launched with the required CDP configuration. Verify Google Chrome is installed and try again."
        case .targetCreationFailed:
            return "Chrome was ready, but a blank page target could not be created. Try again."
        case let .activationFailed(pid):
            return "Chrome PID \(pid) was ready but could not be foregrounded. Bring that Chrome window to the front manually."
        }
    }

    private static let conflictSafetySentence = "Chrome CDP did not terminate or replace another process."

    private func unsafeProfileDescription(_ reason: UnsafeProfileReason) -> String {
        switch reason {
        case .symlink:
            return "The dedicated Chrome profile is a symlink and cannot be used safely. Replace it with a user-owned directory."
        case let .wrongOwner(owner):
            return "The dedicated Chrome profile is owned by UID \(owner), not the current user. Restore ownership before retrying."
        case .notDirectory:
            return "The dedicated Chrome profile path is not a directory. Replace it with a user-owned directory."
        }
    }
}
