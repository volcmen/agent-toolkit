import Foundation

public struct LauncherConfiguration: Equatable, Sendable {
    public let chromeApplicationURL: URL
    public let chromeExecutableURL: URL
    public let profileURL: URL
    public let host: String
    public let port: Int
    public let readinessTimeout: TimeInterval
    public let pollInterval: TimeInterval
    public let lockTimeout: TimeInterval
    public let lockURL: URL

    @_spi(Testing)
    public init(
        chromeApplicationURL: URL,
        chromeExecutableURL: URL,
        profileURL: URL,
        host: String,
        port: Int,
        readinessTimeout: TimeInterval,
        pollInterval: TimeInterval,
        lockTimeout: TimeInterval,
        lockURL: URL
    ) {
        self.chromeApplicationURL = chromeApplicationURL
        self.chromeExecutableURL = chromeExecutableURL
        self.profileURL = profileURL
        self.host = host
        self.port = port
        self.readinessTimeout = readinessTimeout
        self.pollInterval = pollInterval
        self.lockTimeout = lockTimeout
        self.lockURL = lockURL
    }

    public static func production(homeDirectory: URL) -> LauncherConfiguration {
        LauncherConfiguration(
            chromeApplicationURL: URL(fileURLWithPath: "/Applications/Google Chrome.app"),
            chromeExecutableURL: URL(fileURLWithPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            profileURL: homeDirectory.appendingPathComponent("chrome-cdp-profile"),
            host: "127.0.0.1",
            port: 9333,
            readinessTimeout: 10,
            pollInterval: 0.2,
            lockTimeout: 10,
            lockURL: homeDirectory.appendingPathComponent("Library/Caches/Chrome CDP/launch.lock")
        )
    }

    public static func production() -> LauncherConfiguration {
        production(homeDirectory: FileManager.default.homeDirectoryForCurrentUser)
    }
}
