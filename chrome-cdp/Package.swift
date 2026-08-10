// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ChromeCDP",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ChromeCDPCore", targets: ["ChromeCDPCore"]),
        .executable(name: "chrome-cdp-helper", targets: ["ChromeCDPHelper"]),
        .executable(name: "chrome-cdp-tests", targets: ["ChromeCDPTests"])
    ],
    targets: [
        .target(name: "ChromeCDPCore"),
        .target(name: "ChromeCDPTestSupport"),
        .executableTarget(
            name: "ChromeCDPHelper",
            dependencies: ["ChromeCDPCore"]
        ),
        .executableTarget(
            name: "ChromeCDPTests",
            dependencies: ["ChromeCDPCore", "ChromeCDPTestSupport"]
        )
    ]
)
