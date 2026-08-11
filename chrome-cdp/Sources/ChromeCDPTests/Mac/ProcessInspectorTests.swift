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

func processInspectorPreservesPaddingEmptyLaterArgumentsAndTrailingEnvironmentTest() throws {
    var fixture = kernelArgumentsFixture(executable: "/bin/example", arguments: ["example", "", "has spaces"])
    fixture.insert(contentsOf: [0, 0, 0], at: MemoryLayout<Int32>.size + "/bin/example".utf8.count + 1)
    fixture.append(contentsOf: "PATH=/usr/bin\0TOKEN=not-an-argument\0".utf8)

    try expectEqual(
        try ProcessInspector.parseKernelProcArgs2(fixture),
        ["example", "", "has spaces"]
    )
}

func processInspectorRejectsZeroArgumentCountTest() throws {
    var zero: Int32 = 0
    try expectProcessArgumentParseFailure {
        _ = try ProcessInspector.parseKernelProcArgs2(Data(bytes: &zero, count: MemoryLayout<Int32>.size))
    }
}

func processInspectorRejectsEmptyExecutableTest() throws {
    var argc = Int32(1).littleEndian
    var fixture = Data(bytes: &argc, count: MemoryLayout<Int32>.size)
    fixture.append(contentsOf: [0, 0, 97, 0])

    try expectProcessArgumentParseFailure { _ = try ProcessInspector.parseKernelProcArgs2(fixture) }
}

func processInspectorRejectsNegativeHugeAndTinyArgumentLayoutsTest() throws {
    for count in [Int32(-1), Int32.max, Int32(2)] {
        var littleEndian = count.littleEndian
        var fixture = Data(bytes: &littleEndian, count: MemoryLayout<Int32>.size)
        fixture.append(contentsOf: "/bin/example\0\0argv0\0".utf8)
        if count == 2 {
            fixture.removeLast()
        }
        try expectProcessArgumentParseFailure { _ = try ProcessInspector.parseKernelProcArgs2(fixture) }
    }
}

func processInspectorRejectsSuccessfulZeroAndUndersizedSysctlSizesTest() throws {
    for size in [0, MemoryLayout<Int32>.size - 1] {
        var readCalled = false
        do {
            _ = try ProcessInspector.readKernelArgumentData(
                sizeQuery: { size },
                dataRead: { _ in
                    readCalled = true
                    return 0
                }
            )
        } catch ProcessInspectorError.observationFailed {
            try expectEqual(readCalled, false)
            continue
        } catch {
            throw TestAssertionFailure("expected semantic sysctl size rejection, got \(error)")
        }
        throw TestAssertionFailure("expected semantic sysctl size rejection")
    }
}

func processInspectorRetriesSysctlAfterENOMEMWithFreshSizeTest() throws {
    var sizeQueries = 0
    var reads = 0
    let expected = Data([1, 0, 0, 0, 47, 98, 105, 110, 0, 0, 97, 0])
    let data = try ProcessInspector.readKernelArgumentData(
        sizeQuery: {
            sizeQueries += 1
            return sizeQueries == 1 ? 4 : expected.count
        },
        dataRead: { buffer in
            reads += 1
            if reads == 1 {
                throw POSIXError(.ENOMEM)
            }
            buffer = expected
            return expected.count
        }
    )

    try expectEqual(data, expected)
    try expectEqual(sizeQueries, 2)
    try expectEqual(reads, 2)
}

func processInspectorPreservesSysctlFailuresForSkippablePIDsTest() throws {
    do {
        _ = try ProcessInspector.readKernelArgumentData(
            sizeQuery: { throw POSIXError(.ESRCH) },
            dataRead: { _ in 0 }
        )
    } catch let error as POSIXError where error.code == .ESRCH {
        return
    } catch {
        throw TestAssertionFailure("expected ESRCH to remain distinguishable, got \(error)")
    }
    throw TestAssertionFailure("expected ESRCH to remain distinguishable")
}

func processInspectorCapturesBothLargeProcessStreamsWithoutDeadlockTest() throws {
    let bytes = 256 * 1024
    let result = try ProcessInspector.capture(
        executableURL: URL(fileURLWithPath: CommandLine.arguments[0]),
        arguments: ["--process-output-child", "\(bytes)"]
    )

    try expectEqual(result.status, 0)
    try expectEqual(result.standardOutput.count, bytes)
    try expectEqual(result.standardError.count, bytes)
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
    try processInspectorPreservesPaddingEmptyLaterArgumentsAndTrailingEnvironmentTest()
    try processInspectorRejectsZeroArgumentCountTest()
    try processInspectorRejectsEmptyExecutableTest()
    try processInspectorRejectsNegativeHugeAndTinyArgumentLayoutsTest()
    try processInspectorRejectsSuccessfulZeroAndUndersizedSysctlSizesTest()
    try processInspectorRetriesSysctlAfterENOMEMWithFreshSizeTest()
    try processInspectorPreservesSysctlFailuresForSkippablePIDsTest()
    try processInspectorCapturesBothLargeProcessStreamsWithoutDeadlockTest()
    try processInspectorRejectsTruncatedKernelArgumentsTest()
    try processInspectorRejectsMalformedUTF8KernelArgumentsTest()
    try processInspectorSkipsVanishedPIDButRejectsAccessibleMalformedArgumentsTest()
}

func registerProcessInspectorTests(_ runner: inout TestRunner) {
    runner.register("ProcessInspectorTests", processInspectorTests)
    runner.register("ProcessInspectorTests.ParsesExactNULDelimitedArguments", processInspectorParsesExactNULDelimitedArgumentsTest)
    runner.register("ProcessInspectorTests.PreservesEmptyArgumentAfterArgumentZero", processInspectorPreservesEmptyArgumentAfterArgumentZeroTest)
    runner.register("ProcessInspectorTests.PreservesPaddingEmptyLaterArgumentsAndTrailingEnvironment", processInspectorPreservesPaddingEmptyLaterArgumentsAndTrailingEnvironmentTest)
    runner.register("ProcessInspectorTests.RejectsZeroArgumentCount", processInspectorRejectsZeroArgumentCountTest)
    runner.register("ProcessInspectorTests.RejectsEmptyExecutable", processInspectorRejectsEmptyExecutableTest)
    runner.register("ProcessInspectorTests.RejectsNegativeHugeAndTinyArgumentLayouts", processInspectorRejectsNegativeHugeAndTinyArgumentLayoutsTest)
    runner.register("ProcessInspectorTests.RejectsSuccessfulZeroAndUndersizedSysctlSizes", processInspectorRejectsSuccessfulZeroAndUndersizedSysctlSizesTest)
    runner.register("ProcessInspectorTests.RetriesSysctlAfterENOMEMWithFreshSize", processInspectorRetriesSysctlAfterENOMEMWithFreshSizeTest)
    runner.register("ProcessInspectorTests.PreservesSysctlFailuresForSkippablePIDs", processInspectorPreservesSysctlFailuresForSkippablePIDsTest)
    runner.register("ProcessInspectorTests.CapturesBothLargeProcessStreamsWithoutDeadlock", processInspectorCapturesBothLargeProcessStreamsWithoutDeadlockTest)
    runner.register("ProcessInspectorTests.RejectsTruncatedKernelArguments", processInspectorRejectsTruncatedKernelArgumentsTest)
    runner.register("ProcessInspectorTests.RejectsMalformedUTF8KernelArguments", processInspectorRejectsMalformedUTF8KernelArgumentsTest)
    runner.register("ProcessInspectorTests.SkipsVanishedPIDButRejectsAccessibleMalformedArguments", processInspectorSkipsVanishedPIDButRejectsAccessibleMalformedArgumentsTest)
}
