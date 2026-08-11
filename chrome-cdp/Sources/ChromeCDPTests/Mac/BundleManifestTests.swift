@_spi(Testing) import ChromeCDPMac
import ChromeCDPTestSupport
import Foundation

func bundleManifestIsDeterministicAndContentSensitiveTest() throws {
    let parent = try makeTemporaryDirectory(prefix: "chrome-cdp-manifest-")
    defer { try? FileManager.default.removeItem(at: parent) }
    let first = parent.appendingPathComponent("first.app", isDirectory: true)
    let second = parent.appendingPathComponent("second.app", isDirectory: true)
    try FileManager.default.createDirectory(at: first.appendingPathComponent("nested"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: second.appendingPathComponent("nested"), withIntermediateDirectories: true)
    try "a".write(to: first.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    try "b".write(to: first.appendingPathComponent("nested/b.txt"), atomically: true, encoding: .utf8)
    try "b".write(to: second.appendingPathComponent("nested/b.txt"), atomically: true, encoding: .utf8)
    try "a".write(to: second.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)

    let script = chromeCDPProjectRootForManifest().appendingPathComponent("scripts/bundle-manifest.sh")
    let firstResult = try ProcessInspector.capture(executableURL: script, arguments: [first.path])
    let secondResult = try ProcessInspector.capture(executableURL: script, arguments: [second.path])
    try expectEqual(firstResult.status, 0)
    try expectEqual(firstResult.standardOutput, secondResult.standardOutput)

    try "changed".write(to: second.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
    let changed = try ProcessInspector.capture(executableURL: script, arguments: [second.path])
    guard changed.standardOutput != firstResult.standardOutput else {
        throw TestAssertionFailure("changing a bundle file must change its manifest")
    }
}

private func chromeCDPProjectRootForManifest() -> URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
}

func bundleManifestTests() throws {
    try bundleManifestIsDeterministicAndContentSensitiveTest()
}

func registerBundleManifestTests(_ runner: inout TestRunner) {
    runner.register("BundleManifestTests", bundleManifestTests)
    runner.register("BundleManifestTests.IsDeterministicAndContentSensitive", bundleManifestIsDeterministicAndContentSensitiveTest)
}
