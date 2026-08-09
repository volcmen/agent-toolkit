// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ChromeCDP",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ChromeCDPCore", targets: ["ChromeCDPCore"]),
        .executable(name: "chrome-cdp-helper", targets: ["ChromeCDPHelper"])
    ],
    targets: [
        .target(name: "ChromeCDPCore"),
        .executableTarget(
            name: "ChromeCDPHelper",
            dependencies: ["ChromeCDPCore"]
        ),
        .testTarget(name: "ChromeCDPCoreTests", dependencies: ["ChromeCDPCore"])
    ]
)
