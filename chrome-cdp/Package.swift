// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ChromeCDP",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ChromeCDPCore", targets: ["ChromeCDPCore"]),
        .library(name: "ChromeCDPMac", targets: ["ChromeCDPMac"]),
        .executable(name: "chrome-cdp-helper", targets: ["ChromeCDPHelper"]),
        .executable(name: "chrome-cdp-tests", targets: ["ChromeCDPTests"])
    ],
    targets: [
        .target(name: "ChromeCDPCore"),
        .target(
            name: "ChromeCDPMac",
            dependencies: ["ChromeCDPCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreServices")
            ]
        ),
        .target(name: "ChromeCDPTestSupport"),
        .executableTarget(
            name: "ChromeCDPHelper",
            dependencies: ["ChromeCDPCore", "ChromeCDPMac"]
        ),
        .executableTarget(
            name: "ChromeCDPTests",
            dependencies: ["ChromeCDPCore", "ChromeCDPMac", "ChromeCDPTestSupport"]
        )
    ]
)
