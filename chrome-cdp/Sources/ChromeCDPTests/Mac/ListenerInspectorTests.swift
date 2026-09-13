@_spi(Testing) import ChromeCDPMac
import ChromeCDPCore
import ChromeCDPTestSupport
import Foundation

func listenerInspectorParsesMachineRecordsWithoutNormalizingAddressesTest() throws {
    let fixture = Data("p42\nf9\nn127.0.0.1:9222\nf10\nn*:9222\np88\nf4\nn[::1]:9222\np\nf2\nn[::]:9222\n".utf8)

    try expectEqual(
        try ListenerInspector.parseLsofRecords(fixture, port: 9222),
        [
            ListenerBinding(pid: 42, address: "127.0.0.1", port: 9222),
            ListenerBinding(pid: 42, address: "*", port: 9222),
            ListenerBinding(pid: 88, address: "::1", port: 9222),
            ListenerBinding(pid: nil, address: "::", port: 9222)
        ]
    )
}

func listenerInspectorRetainsOnlyExactConfiguredPortTest() throws {
    let fixture = Data("p42\nf9\nn127.0.0.1:9223\nf10\nn127.0.0.1:9222\n".utf8)

    try expectEqual(
        try ListenerInspector.parseLsofRecords(fixture, port: 9222),
        [ListenerBinding(pid: 42, address: "127.0.0.1", port: 9222)]
    )
}

func listenerInspectorRejectsNonemptyMalformedMachineRecordsTest() throws {
    try expectListenerParseFailure {
        _ = try ListenerInspector.parseLsofRecords(Data("pnot-a-pid\nf1\nn127.0.0.1:9222\n".utf8), port: 9222)
    }
}

func listenerInspectorAcceptsOnlyExactIPv4LoopbackBindingTest() throws {
    let fixture = Data("p42\nf1\nn127.0.0.1:9222\nf2\nnlocalhost:9222\nf3\nn[::1]:9222\nf4\nn*:9222\n".utf8)
    let bindings = try ListenerInspector.parseLsofRecords(fixture, port: 9222)

    try expectEqual(bindings.filter { $0.address == "127.0.0.1" }.count, 1)
    try expectEqual(bindings.filter { $0.address != "127.0.0.1" }.map(\.address), ["localhost", "::1", "*"])
}

func listenerInspectorTreatsEmptyNonzeroLsofOutputAsNoListenerTest() throws {
    let inspector = ListenerInspector { _ in LsofCommandResult(status: 1, output: Data()) }

    try expectEqual(try inspector.inspect(configuration: .production(homeDirectory: URL(fileURLWithPath: "/tmp"))), [])
}

func listenerInspectorRejectsNonemptyNonzeroLsofOutputTest() throws {
    let inspector = ListenerInspector { _ in LsofCommandResult(status: 1, output: Data("p42\\n".utf8)) }

    do {
        _ = try inspector.inspect(configuration: .production(homeDirectory: URL(fileURLWithPath: "/tmp")))
    } catch ListenerInspectorError.commandFailed {
        return
    } catch {
        throw TestAssertionFailure("expected nonempty failed lsof output to be an observation error, got \(error)")
    }
    throw TestAssertionFailure("expected nonempty failed lsof output to be an observation error")
}

private func expectListenerParseFailure(_ operation: () throws -> Void) throws {
    do {
        try operation()
    } catch ListenerInspectorError.malformedRecords {
        return
    } catch {
        throw TestAssertionFailure("expected malformed listener records, got \(error)")
    }
    throw TestAssertionFailure("expected malformed listener records")
}

func listenerInspectorTests() throws {
    try listenerInspectorParsesMachineRecordsWithoutNormalizingAddressesTest()
    try listenerInspectorRetainsOnlyExactConfiguredPortTest()
    try listenerInspectorRejectsNonemptyMalformedMachineRecordsTest()
    try listenerInspectorAcceptsOnlyExactIPv4LoopbackBindingTest()
    try listenerInspectorTreatsEmptyNonzeroLsofOutputAsNoListenerTest()
    try listenerInspectorRejectsNonemptyNonzeroLsofOutputTest()
}

func listenerInspectorRejectsErrorsWithNoRecordsTest() throws {
    for result in [LsofCommandResult(status: 2, output: Data()), LsofCommandResult(status: 1, output: Data(), diagnostics: Data("permission denied".utf8))] {
        do {
            _ = try ListenerInspector { _ in result }.inspect(configuration: .production())
        } catch ListenerInspectorError.commandFailed {
            continue
        }
        throw TestAssertionFailure("lsof error was mistaken for no listener")
    }
}

func registerListenerInspectorTests(_ runner: inout TestRunner) {
    runner.register("ListenerInspectorTests.ErrorsWithoutRecords", listenerInspectorRejectsErrorsWithNoRecordsTest)
    runner.register("ListenerInspectorTests", listenerInspectorTests)
    runner.register("ListenerInspectorTests.ParsesMachineRecordsWithoutNormalizingAddresses", listenerInspectorParsesMachineRecordsWithoutNormalizingAddressesTest)
    runner.register("ListenerInspectorTests.RetainsOnlyExactConfiguredPort", listenerInspectorRetainsOnlyExactConfiguredPortTest)
    runner.register("ListenerInspectorTests.RejectsNonemptyMalformedMachineRecords", listenerInspectorRejectsNonemptyMalformedMachineRecordsTest)
    runner.register("ListenerInspectorTests.AcceptsOnlyExactIPv4LoopbackBinding", listenerInspectorAcceptsOnlyExactIPv4LoopbackBindingTest)
    runner.register("ListenerInspectorTests.TreatsEmptyNonzeroLsofOutputAsNoListener", listenerInspectorTreatsEmptyNonzeroLsofOutputAsNoListenerTest)
    runner.register("ListenerInspectorTests.RejectsNonemptyNonzeroLsofOutput", listenerInspectorRejectsNonemptyNonzeroLsofOutputTest)
}
