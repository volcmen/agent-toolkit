import Foundation

public struct TestAssertionFailure: Error, CustomStringConvertible {
    public let description: String

    public init(_ description: String) {
        self.description = description
    }
}

public struct TestSkip: Error, CustomStringConvertible {
    public let description: String

    public init(_ description: String) {
        self.description = description
    }
}

public func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String? = nil) throws {
    guard actual == expected else {
        let detail = message.map { "\($0): " } ?? ""
        throw TestAssertionFailure("\(detail)expected \(String(describing: expected)), got \(String(describing: actual))")
    }
}

public func skip(_ reason: String) throws -> Never {
    throw TestSkip(reason)
}

public func skipUnlessEnvironment(_ variable: String, equals expected: String) throws {
    guard ProcessInfo.processInfo.environment[variable] == expected else {
        try skip("requires \(variable)=\(expected)")
    }
}

public func makeTemporaryDirectory(prefix: String = "chrome-cdp-test-") throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("\(prefix)\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

public struct TestRunner {
    public typealias TestBody = () throws -> Void

    private struct TestCase {
        let name: String
        let body: TestBody
    }

    private var tests: [TestCase] = []

    public init() {}

    public mutating func register(_ name: String, _ body: @escaping TestBody) {
        tests.append(TestCase(name: name, body: body))
    }

    @discardableResult
    public func run(arguments: [String]) -> Int {
        let invocation = Array(arguments.dropFirst())
        let selected: [TestCase]

        if invocation.isEmpty {
            selected = tests
        } else if invocation.count == 2, invocation[0] == "--filter", !invocation[1].isEmpty {
            selected = tests.filter { $0.name == invocation[1] }
            if selected.isEmpty {
                print("No tests matched filter '\(invocation[1])'.")
                return 2
            }
        } else {
            print("Invalid arguments. Use no arguments or --filter NAME.")
            return 2
        }

        var passed = 0
        var failed = 0
        var skipped = 0

        for test in selected {
            do {
                try test.body()
                passed += 1
                print("PASS \(test.name)")
            } catch let error as TestSkip {
                skipped += 1
                print("SKIP \(test.name): \(error.description)")
            } catch {
                failed += 1
                print("FAIL \(test.name): \(error)")
            }
        }

        print("Summary: \(passed) passed, \(failed) failed, \(skipped) skipped")
        return failed == 0 ? 0 : 1
    }
}
