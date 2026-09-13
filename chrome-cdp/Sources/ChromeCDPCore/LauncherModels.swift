import Foundation

public enum ProfileObservation: Equatable, Sendable {
    case missing
    case valid(mode: UInt16)
    case symlink
    case wrongOwner(owner: UInt32)
    case notDirectory
}

public enum UnsafeProfileReason: Equatable, Sendable {
    case symlink
    case wrongOwner(owner: UInt32)
    case notDirectory
}

public struct ProcessObservation: Equatable, Sendable {
    public let pid: Int32
    public let executablePath: String
    public let arguments: [String]

    public init(pid: Int32, executablePath: String, arguments: [String]) {
        self.pid = pid
        self.executablePath = executablePath
        self.arguments = arguments
    }
}

public struct ListenerBinding: Equatable, Sendable {
    public let pid: Int32?
    public let address: String
    public let port: UInt16

    public init(pid: Int32?, address: String, port: UInt16) {
        self.pid = pid
        self.address = address
        self.port = port
    }
}

public enum EndpointFailure: Equatable, Sendable {
    case unavailable
    case malformedVersion
    case nonChromeBrowser
    case invalidWebSocket
    case nonLoopbackWebSocket
    case wrongWebSocketPort
    case malformedTargetList
}

public enum EndpointObservation: Equatable, Sendable {
    case unavailable
    case invalid(EndpointFailure)
    case healthy(webSocketURL: URL, pageTargetCount: Int)
}

public struct SystemSnapshot: Equatable, Sendable {
    public let profile: ProfileObservation
    public let processes: [ProcessObservation]
    public let listeners: [ListenerBinding]
    public let endpoint: EndpointObservation

    public init(
        profile: ProfileObservation,
        processes: [ProcessObservation],
        listeners: [ListenerBinding],
        endpoint: EndpointObservation
    ) {
        self.profile = profile
        self.processes = processes
        self.listeners = listeners
        self.endpoint = endpoint
    }
}

public enum LauncherDecision: Equatable, Sendable {
    case createProfile
    case repairProfileMode
    case launch
    case waitForReadiness(pid: Int32, lastFailure: EndpointFailure)
    case reuse(pid: Int32, createBlankTarget: Bool)
    case fail(LauncherFailure)
}
