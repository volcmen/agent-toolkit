import ChromeCDPCore
import Darwin
import Foundation

public enum ProcessInspectorError: Error, Equatable, Sendable {
    case enumerationFailed
    case malformedArguments
    case observationFailed
}

public struct ProcessInspector: Sendable {
    private let candidatePIDs: @Sendable () throws -> [Int32]
    private let executablePath: @Sendable (Int32) throws -> String
    private let argumentData: @Sendable (Int32) throws -> Data

    public init() {
        candidatePIDs = { try Self.systemCandidatePIDs() }
        executablePath = { try Self.systemExecutablePath(pid: $0) }
        argumentData = { try Self.systemArgumentData(pid: $0) }
    }

    @_spi(Testing)
    public init(
        candidatePIDs: @escaping @Sendable () throws -> [Int32],
        executablePath: @escaping @Sendable (Int32) throws -> String,
        argumentData: @escaping @Sendable (Int32) throws -> Data
    ) {
        self.candidatePIDs = candidatePIDs
        self.executablePath = executablePath
        self.argumentData = argumentData
    }

    public func inspect() throws -> [ProcessObservation] {
        var observations: [ProcessObservation] = []
        for pid in try candidatePIDs() {
            do {
                let path = try executablePath(pid)
                let arguments = try Self.parseKernelProcArgs2(argumentData(pid))
                observations.append(ProcessObservation(pid: pid, executablePath: path, arguments: arguments))
            } catch let error as ProcessInspectorError where error == .malformedArguments {
                throw error
            } catch {
                if Self.isGoneOrInaccessible(error) {
                    continue
                }
                throw ProcessInspectorError.observationFailed
            }
        }
        return observations
    }

    @_spi(Testing)
    public static func parseKernelProcArgs2(_ data: Data) throws -> [String] {
        guard data.count >= MemoryLayout<Int32>.size else {
            throw ProcessInspectorError.malformedArguments
        }
        let argumentCount: Int32 = data.withUnsafeBytes { bytes in
            bytes.loadUnaligned(fromByteOffset: 0, as: Int32.self).littleEndian
        }
        guard argumentCount >= 0 else {
            throw ProcessInspectorError.malformedArguments
        }

        var offset = MemoryLayout<Int32>.size
        guard let executableEnd = data[offset...].firstIndex(of: 0),
              String(data: data[offset..<executableEnd], encoding: .utf8) != nil else {
            throw ProcessInspectorError.malformedArguments
        }
        offset = executableEnd + 1

        // KERN_PROCARGS2 pads between the executable and argv[0].  Once argv starts,
        // NUL is an argument terminator and therefore preserves empty later arguments.
        while offset < data.count, data[offset] == 0 {
            offset += 1
        }

        var arguments: [String] = []
        arguments.reserveCapacity(Int(argumentCount))
        for _ in 0..<argumentCount {
            guard offset < data.count,
                  let end = data[offset...].firstIndex(of: 0),
                  let argument = String(data: data[offset..<end], encoding: .utf8) else {
                throw ProcessInspectorError.malformedArguments
            }
            arguments.append(argument)
            offset = end + 1
        }
        return arguments
    }

    private static func systemCandidatePIDs() throws -> [Int32] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-axo", "pid="]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            throw ProcessInspectorError.enumerationFailed
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw ProcessInspectorError.enumerationFailed
        }
        guard let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) else {
            throw ProcessInspectorError.enumerationFailed
        }
        return try text.split(whereSeparator: \.isNewline).map { field in
            guard let pid = Int32(field.trimmingCharacters(in: .whitespaces)), pid > 0 else {
                throw ProcessInspectorError.enumerationFailed
            }
            return pid
        }
    }

    private static func systemExecutablePath(pid: Int32) throws -> String {
        var buffer = [CChar](repeating: 0, count: 16_384)
        let byteCount = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard byteCount > 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ESRCH)
        }
        let bytes = buffer.prefix(Int(byteCount)).map { UInt8(bitPattern: $0) }
        guard let path = String(bytes: bytes, encoding: .utf8) else {
            throw ProcessInspectorError.observationFailed
        }
        return path
    }

    private static func systemArgumentData(pid: Int32) throws -> Data {
        var mib = [CTL_KERN, KERN_PROCARGS2, pid]
        var size: size_t = 0
        guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size > 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ESRCH)
        }
        var data = Data(count: Int(size))
        let result = data.withUnsafeMutableBytes { bytes in
            sysctl(&mib, u_int(mib.count), bytes.baseAddress, &size, nil, 0)
        }
        guard result == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .ESRCH)
        }
        data.count = Int(size)
        return data
    }

    private static func isGoneOrInaccessible(_ error: Error) -> Bool {
        guard let posix = error as? POSIXError else { return false }
        return posix.code == .ESRCH || posix.code == .EPERM || posix.code == .EACCES
    }
}
