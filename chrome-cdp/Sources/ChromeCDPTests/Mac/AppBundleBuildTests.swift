@_spi(Testing) import ChromeCDPMac
import ChromeCDPTestSupport
import Foundation

private func chromeCDPProjectRoot() -> URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
}

func appBundleBuildProducesVerifiedSignedArtifactTest() throws {
    let temporaryDirectory = try makeTemporaryDirectory(prefix: "chrome-cdp-app-build-")
    defer { try? FileManager.default.removeItem(at: temporaryDirectory) }
    let projectRoot = chromeCDPProjectRoot()
    let build = try ProcessInspector.capture(
        executableURL: URL(fileURLWithPath: "/usr/bin/env"),
        arguments: [
            "CHROME_CDP_DIST_ROOT=\(temporaryDirectory.path)",
            projectRoot.appendingPathComponent("scripts/build.sh").path,
        ]
    )
    guard build.status == 0 else {
        throw TestAssertionFailure("staged app build failed: \(String(data: build.standardError, encoding: .utf8) ?? "unknown error")")
    }

    let app = temporaryDirectory.appendingPathComponent("Chrome CDP.app", isDirectory: true)
    let verify = try ProcessInspector.capture(
        executableURL: projectRoot.appendingPathComponent("scripts/verify.sh"),
        arguments: ["--app", app.path, "--staged"]
    )
    try expectEqual(verify.status, 0)

    let installerStage = temporaryDirectory.appendingPathComponent(".Chrome CDP.app.stage-test", isDirectory: true)
    try FileManager.default.copyItem(at: app, to: installerStage)
    let stagedVerify = try ProcessInspector.capture(
        executableURL: projectRoot.appendingPathComponent("scripts/verify.sh"),
        arguments: ["--app", installerStage.path, "--staged"]
    )
    try expectEqual(stagedVerify.status, 0)

    let helper = app.appendingPathComponent("Contents/Resources/chrome-cdp-helper")
    let version = try ProcessInspector.capture(executableURL: helper, arguments: ["--version"])
    try expectEqual(String(data: version.standardOutput, encoding: .utf8), "chrome-cdp-helper 1.0.0\n")
    let selfCheck = try ProcessInspector.capture(executableURL: helper, arguments: ["--self-check"])
    try expectEqual(selfCheck.status, 0)
    try expectEqual(FileManager.default.fileExists(atPath: app.appendingPathComponent("Contents/Resources/Scripts/main.scpt").path), true)
}

func appBundleBuildTests() throws {
    try appBundleBuildProducesVerifiedSignedArtifactTest()
}

func registerAppBundleBuildTests(_ runner: inout TestRunner) {
    runner.register("AppBundleBuildTests", appBundleBuildTests)
    runner.register("AppBundleBuildTests.ProducesVerifiedSignedArtifact", appBundleBuildProducesVerifiedSignedArtifactTest)
}
