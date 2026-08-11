import ChromeCDPMac
import ChromeCDPTestSupport
import Foundation

private func writeBundle(_ url: URL, marker: String) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
    try marker.write(to: url.appendingPathComponent("marker.txt"), atomically: true, encoding: .utf8)
}

func atomicBundleSwapExchangesAndRollsBackExistingBundlesTest() throws {
    let parent = try makeTemporaryDirectory(prefix: "chrome-cdp-swap-")
    defer { try? FileManager.default.removeItem(at: parent) }
    let staged = parent.appendingPathComponent("staged.app", isDirectory: true)
    let installed = parent.appendingPathComponent("installed.app", isDirectory: true)
    try writeBundle(staged, marker: "new")
    try writeBundle(installed, marker: "old")

    try expectEqual(
        try AtomicBundleSwap.publish(staged: staged, installed: installed, allowedParent: parent),
        .swappedExistingDestination
    )
    try expectEqual(try String(contentsOf: installed.appendingPathComponent("marker.txt"), encoding: .utf8), "new")
    try expectEqual(try String(contentsOf: staged.appendingPathComponent("marker.txt"), encoding: .utf8), "old")

    _ = try AtomicBundleSwap.publish(staged: staged, installed: installed, allowedParent: parent)
    try expectEqual(try String(contentsOf: installed.appendingPathComponent("marker.txt"), encoding: .utf8), "old")
}

func atomicBundleSwapMovesIntoMissingDestinationAndRejectsSymlinkTest() throws {
    let parent = try makeTemporaryDirectory(prefix: "chrome-cdp-move-")
    defer { try? FileManager.default.removeItem(at: parent) }
    let staged = parent.appendingPathComponent("staged.app", isDirectory: true)
    let installed = parent.appendingPathComponent("installed.app", isDirectory: true)
    try writeBundle(staged, marker: "new")
    try expectEqual(
        try AtomicBundleSwap.publish(staged: staged, installed: installed, allowedParent: parent),
        .movedIntoEmptyDestination
    )
    try expectEqual(FileManager.default.fileExists(atPath: staged.path), false)

    let target = parent.appendingPathComponent("target.app", isDirectory: true)
    let linked = parent.appendingPathComponent("linked.app")
    try writeBundle(target, marker: "target")
    try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: target)
    do {
        _ = try AtomicBundleSwap.publish(staged: linked, installed: staged, allowedParent: parent)
        throw TestAssertionFailure("symlinked staged bundle must be rejected")
    } catch is AtomicBundleSwapError {}
}

func atomicBundleSwapTests() throws {
    try atomicBundleSwapExchangesAndRollsBackExistingBundlesTest()
    try atomicBundleSwapMovesIntoMissingDestinationAndRejectsSymlinkTest()
}

func registerAtomicBundleSwapTests(_ runner: inout TestRunner) {
    runner.register("AtomicBundleSwapTests", atomicBundleSwapTests)
    runner.register("AtomicBundleSwapTests.ExchangesAndRollsBackExistingBundles", atomicBundleSwapExchangesAndRollsBackExistingBundlesTest)
    runner.register("AtomicBundleSwapTests.MovesIntoMissingDestinationAndRejectsSymlink", atomicBundleSwapMovesIntoMissingDestinationAndRejectsSymlinkTest)
}
