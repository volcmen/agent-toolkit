import ChromeCDPCore
import Foundation

public enum ListenerInspectorError: Error, Equatable, Sendable {
    case commandFailed
    case malformedRecords
}

@_spi(Testing)
public struct LsofCommandResult: Sendable {
    public let status: Int32
    public let output: Data

    public init(status: Int32, output: Data) {
        self.status = status
        self.output = output
    }
}

public struct ListenerInspector: Sendable {
    private let runLsof: @Sendable (UInt16) throws -> LsofCommandResult

    public init() {
        runLsof = { try Self.systemLsof(port: $0) }
    }

    @_spi(Testing)
    public init(runLsof: @escaping @Sendable (UInt16) throws -> LsofCommandResult) {
        self.runLsof = runLsof
    }

    public func inspect(configuration: LauncherConfiguration) throws -> [ListenerBinding] {
        guard let port = UInt16(exactly: configuration.port) else {
            throw ListenerInspectorError.malformedRecords
        }
        let result: LsofCommandResult
        do {
            result = try runLsof(port)
        } catch {
            throw ListenerInspectorError.commandFailed
        }
        if result.status != 0 {
            guard result.output.isEmpty else {
                throw ListenerInspectorError.commandFailed
            }
            return []
        }
        return try Self.parseLsofRecords(result.output, port: port)
    }

    @_spi(Testing)
    public static func parseLsofRecords(_ data: Data, port: UInt16) throws -> [ListenerBinding] {
        guard !data.isEmpty else { return [] }
        guard let output = String(data: data, encoding: .utf8) else {
            throw ListenerInspectorError.malformedRecords
        }

        var currentPID: Int32?
        var bindings: [ListenerBinding] = []
        var sawAddress = false
        for line in output.split(separator: "\n", omittingEmptySubsequences: false) {
            guard !line.isEmpty else { continue }
            guard let tag = line.first else {
                throw ListenerInspectorError.malformedRecords
            }
            let value = String(line.dropFirst())
            switch tag {
            case "p":
                if value.isEmpty {
                    currentPID = nil
                } else if let pid = Int32(value), pid > 0 {
                    currentPID = pid
                } else {
                    throw ListenerInspectorError.malformedRecords
                }
            case "f":
                continue
            case "n":
                let endpoint = try parseEndpoint(value)
                sawAddress = true
                if endpoint.port == port {
                    bindings.append(ListenerBinding(pid: currentPID, address: endpoint.address, port: endpoint.port))
                }
            default:
                throw ListenerInspectorError.malformedRecords
            }
        }
        guard sawAddress else {
            throw ListenerInspectorError.malformedRecords
        }
        return bindings
    }

    private static func systemLsof(port: UInt16) throws -> LsofCommandResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-nP", "-a", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpn"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            throw ListenerInspectorError.commandFailed
        }
        process.waitUntilExit()
        return LsofCommandResult(
            status: process.terminationStatus,
            output: output.fileHandleForReading.readDataToEndOfFile()
        )
    }

    private static func parseEndpoint(_ value: String) throws -> (address: String, port: UInt16) {
        let endpoint = value.hasSuffix(" (LISTEN)") ? String(value.dropLast(" (LISTEN)".count)) : value
        let address: String
        let portText: String
        if endpoint.hasPrefix("[") {
            guard let closeBracket = endpoint.firstIndex(of: "]"),
                  endpoint.index(after: closeBracket) < endpoint.endIndex,
                  endpoint[endpoint.index(after: closeBracket)] == ":" else {
                throw ListenerInspectorError.malformedRecords
            }
            address = String(endpoint[endpoint.index(after: endpoint.startIndex)..<closeBracket])
            portText = String(endpoint[endpoint.index(closeBracket, offsetBy: 2)...])
        } else {
            guard let separator = endpoint.lastIndex(of: ":") else {
                throw ListenerInspectorError.malformedRecords
            }
            address = String(endpoint[..<separator])
            portText = String(endpoint[endpoint.index(after: separator)...])
        }
        guard !address.isEmpty, let port = UInt16(portText) else {
            throw ListenerInspectorError.malformedRecords
        }
        return (address, port)
    }
}
