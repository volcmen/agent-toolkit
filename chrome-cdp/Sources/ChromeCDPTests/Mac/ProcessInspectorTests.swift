@_spi(Testing) import ChromeCDPMac
import ChromeCDPTestSupport
import Foundation

private func kernelArgumentsFixture(executable: String, arguments: [String]) -> Data {
    var argc = Int32(arguments.count).littleEndian
    var data = Data(bytes: &argc, count: MemoryLayout<Int32>.size)
    data.append(contentsOf: executable.utf8)
    data.append(0)
    data.append(0)
    for argument in arguments {
        data.append(contentsOf: argument.utf8)
        data.append(0)
    }
    return data
}

func processInspectorParsesExactNULDelimitedArgumentsTest() throws {
    let arguments = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "--user-data-dir=/Users/tester/Chrome CDP Profile",
        "--remote-debugging-port=9222",
        "--remote-debugging-port=9222",
        "--type=renderer",
        "--field-trial-handle=123,456,789,131072"
    ]
    let fixture = kernelArgumentsFixture(
        executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        arguments: arguments
    )

    try expectEqual(try ProcessInspector.parseKernelProcArgs2(fixture), arguments)
}

func processInspectorPreservesEmptyArgumentAfterArgumentZeroTest() throws {
    let fixture = kernelArgumentsFixture(executable: "/bin/example", arguments: ["example", "", "has spaces"])

    try expectEqual(try ProcessInspector.parseKernelProcArgs2(fixture), ["example", "", "has spaces"])
}

func processInspectorRejectsTruncatedKernelArgumentsTest() throws {
    let fixture = kernelArgumentsFixture(executable: "/bin/example", arguments: ["example", "--missing-terminator"])
        .dropLast()

    try expectProcessArgumentParseFailure { _ = try ProcessInspector.parseKernelProcArgs2(Data(fixture)) }
}

func processInspectorRejectsMalformedUTF8KernelArgumentsTest() throws {
    var argc = Int32(1).littleEndian
    var fixture = Data(bytes: &argc, count: MemoryLayout<Int32>.size)
    fixture.append(contentsOf: "/bin/example".utf8)
    fixture.append(contentsOf: [0, 0, 0xFF, 0])

    try expectProcessArgumentParseFailure { _ = try ProcessInspector.parseKernelProcArgs2(fixture) }
}

func processInspectorSkipsVanishedPIDButRejectsAccessibleMalformedArgumentsTest() throws {
    let inspector = ProcessInspector(
        candidatePIDs: { [41, 42] },
        executablePath: { pid in
            if pid == 41 {
                throw POSIXError(.ESRCH)
            }
            return "/bin/example"
        },
        argumentData: { _ in Data([1, 0, 0, 0, 47, 98, 105, 110]) }
    )

    try expectProcessArgumentParseFailure { _ = try inspector.inspect() }
}

private func expectProcessArgumentParseFailure(_ operation: () throws -> Void) throws {
    do {
        try operation()
    } catch ProcessInspectorError.malformedArguments {
        return
    } catch {
        throw TestAssertionFailure("expected malformed process arguments, got \(error)")
    }
    throw TestAssertionFailure("expected malformed process arguments")
}

func processInspectorTests() throws {
    try processInspectorParsesExactNULDelimitedArgumentsTest()
    try processInspectorPreservesEmptyArgumentAfterArgumentZeroTest()
    try processInspectorRejectsTruncatedKernelArgumentsTest()
    try processInspectorRejectsMalformedUTF8KernelArgumentsTest()
    try processInspectorSkipsVanishedPIDButRejectsAccessibleMalformedArgumentsTest()
}

func registerProcessInspectorTests(_ runner: inout TestRunner) {
    runner.register("ProcessInspectorTests", processInspectorTests)
    runner.register("ProcessInspectorTests.ParsesExactNULDelimitedArguments", processInspectorParsesExactNULDelimitedArgumentsTest)
    runner.register("ProcessInspectorTests.PreservesEmptyArgumentAfterArgumentZero", processInspectorPreservesEmptyArgumentAfterArgumentZeroTest)
    runner.register("ProcessInspectorTests.RejectsTruncatedKernelArguments", processInspectorRejectsTruncatedKernelArgumentsTest)
    runner.register("ProcessInspectorTests.RejectsMalformedUTF8KernelArguments", processInspectorRejectsMalformedUTF8KernelArgumentsTest)
    runner.register("ProcessInspectorTests.SkipsVanishedPIDButRejectsAccessibleMalformedArguments", processInspectorSkipsVanishedPIDButRejectsAccessibleMalformedArgumentsTest)
}
