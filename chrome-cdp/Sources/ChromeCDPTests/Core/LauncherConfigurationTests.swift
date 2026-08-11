@_spi(Testing) import ChromeCDPCore
import ChromeCDPTestSupport
import Foundation

func launcherConfigurationProductionTest() throws {
    let home = URL(fileURLWithPath: "/Users/tester", isDirectory: true)
    let configuration = LauncherConfiguration.production(homeDirectory: home)
    try expectEqual(configuration.chromeApplicationURL.path, "/Applications/Google Chrome.app")
    try expectEqual(configuration.chromeExecutableURL.path, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    try expectEqual(configuration.profileURL.path, "/Users/tester/chrome-cdp-profile")
    try expectEqual(configuration.host, "127.0.0.1")
    try expectEqual(configuration.port, 9222)
    try expectEqual(configuration.readinessTimeout, 10)
    try expectEqual(configuration.pollInterval, 0.2)
    try expectEqual(configuration.lockTimeout, 10)
    try expectEqual(configuration.lockURL.path, "/Users/tester/Library/Caches/Chrome CDP/launch.lock")
}

func launcherConfigurationTestingInitializerPreservesEveryFieldTest() throws {
    let configuration = LauncherConfiguration(
        chromeApplicationURL: URL(fileURLWithPath: "/Testing/Chrome.app"),
        chromeExecutableURL: URL(fileURLWithPath: "/Testing/Chrome.app/Contents/MacOS/Chrome"),
        profileURL: URL(fileURLWithPath: "/Testing/profile"),
        host: "localhost",
        port: 9333,
        readinessTimeout: 12,
        pollInterval: 0.4,
        lockTimeout: 8,
        lockURL: URL(fileURLWithPath: "/Testing/launch.lock")
    )

    try expectEqual(configuration.chromeApplicationURL.path, "/Testing/Chrome.app")
    try expectEqual(configuration.chromeExecutableURL.path, "/Testing/Chrome.app/Contents/MacOS/Chrome")
    try expectEqual(configuration.profileURL.path, "/Testing/profile")
    try expectEqual(configuration.host, "localhost")
    try expectEqual(configuration.port, 9333)
    try expectEqual(configuration.readinessTimeout, 12)
    try expectEqual(configuration.pollInterval, 0.4)
    try expectEqual(configuration.lockTimeout, 8)
    try expectEqual(configuration.lockURL.path, "/Testing/launch.lock")
}

func registerLauncherConfigurationTests(_ runner: inout TestRunner) {
    runner.register("LauncherConfigurationTests", launcherConfigurationProductionTest)
    runner.register("LauncherConfigurationTests.TestingInitializerPreservesEveryField", launcherConfigurationTestingInitializerPreservesEveryFieldTest)
}
