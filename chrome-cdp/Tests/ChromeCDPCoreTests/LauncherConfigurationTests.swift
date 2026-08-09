import XCTest
@testable import ChromeCDPCore

final class LauncherConfigurationTests: XCTestCase {
    func testProductionConfigurationUsesFixedContract() {
        let home = URL(fileURLWithPath: "/Users/tester", isDirectory: true)
        let configuration = LauncherConfiguration.production(homeDirectory: home)

        XCTAssertEqual(configuration.chromeApplicationURL.path, "/Applications/Google Chrome.app")
        XCTAssertEqual(configuration.chromeExecutableURL.path, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        XCTAssertEqual(configuration.profileURL.path, "/Users/tester/chrome-cdp-profile")
        XCTAssertEqual(configuration.host, "127.0.0.1")
        XCTAssertEqual(configuration.port, 9222)
        XCTAssertEqual(configuration.readinessTimeout, 10)
        XCTAssertEqual(configuration.pollInterval, 0.2)
        XCTAssertEqual(configuration.lockTimeout, 10)
        XCTAssertEqual(configuration.lockURL.path, "/Users/tester/Library/Caches/Chrome CDP/launch.lock")
    }
}
